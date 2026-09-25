// Chromium creates the input; the Rust analyzer consumes it offline.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'
import {pathToFileURL} from 'node:url'

import {readMap} from './maps.mjs'

// Playwright is an optional peer: only collection needs it.
function loadPlaywright() {
  for (const base of [import.meta.url, pathToFileURL(resolve('package.json')).href]) {
    const require = createRequire(base)
    for (const name of ['playwright', '@playwright/test']) {
      try {
        return {chromium: require(name).chromium, version: require(`${name}/package.json`).version}
      } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error
      }
    }
  }
  throw new Error('coldpath collect requires Playwright: npm install --save-dev playwright && npx playwright install chromium')
}

export async function collect({url, dir, out, prefix = '/', scenario = 'initial', actions, waitMs = 1000}) {
  assert(url && dir && out, 'url, dir and out are required')
  assert(
    prefix.startsWith('/') && prefix.endsWith('/') && !/[?#\\]/.test(prefix),
    '--prefix must be a URL path starting and ending with /',
  )
  assert(Number.isSafeInteger(waitMs) && waitMs >= 0, '--wait-ms must be a nonnegative integer')
  assert(scenario.trim(), '--scenario must not be empty')
  const target = new URL(url)
  assert(['http:', 'https:'].includes(target.protocol), '--url must use http or https')
  const root = await realpath(resolve(dir))
  let action
  if (actions) {
    action = (await import(pathToFileURL(resolve(actions)).href)).default
    assert.equal(typeof action, 'function', '--actions must default-export a function')
  }
  const playwright = loadPlaywright()
  const digest = (data) => createHash('sha256').update(data).digest('hex')
  const browser = await playwright.chromium.launch({headless: true})
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: {width: 1280, height: 900},
    })
    const blocked = new Set()
    const requests = []
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin === target.origin) {
        requests.push({
          path: url.pathname + url.search,
          type: route.request().resourceType(),
        })
        return route.continue()
      }
      blocked.add(url.origin)
      return route.abort()
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const cdp = await context.newCDPSession(page)
    await cdp.send('Debugger.enable')
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.startPreciseCoverage', {callCount: true, detailed: true})
    const response = await page.goto(target.href, {waitUntil: 'networkidle'})
    assert(response?.ok(), `navigation failed: ${response?.status()}`)
    // A fixed observation window, not a performance measurement.
    await page.waitForTimeout(waitMs)
    if (action) await action({page, context})
    const {result} = await cdp.send('Profiler.takePreciseCoverage')
    await cdp.send('Profiler.stopPreciseCoverage')
    assert.deepEqual(errors, [], 'page threw runtime errors')
    const scripts = []
    const excluded = []
    for (const script of result) {
      let url
      try {
        url = new URL(script.url)
      } catch {
        continue
      }
      if (url.origin !== target.origin || !url.pathname.startsWith(prefix)) {
        if (script.url) excluded.push(script.url)
        continue
      }
      const path = decodeURIComponent(url.pathname.slice(prefix.length))
      // Inline/eval scripts have no matching generated file under --dir.
      if (!/\.(?:js|mjs|cjs)$/i.test(path)) {
        excluded.push(script.url)
        continue
      }
      assert(!path.includes('\\') && !path.split('/').includes('..'), 'script path escapes --dir')
      const diskPath = await realpath(resolve(root, path))
      const local = relative(root, diskPath)
      assert(
        local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local),
        'script path escapes --dir',
      )
      const source = await readFile(diskPath)
      const {scriptSource} = await cdp.send('Debugger.getScriptSource', {
        scriptId: script.scriptId,
      })
      assert.equal(digest(source), digest(scriptSource), `browser/disk source mismatch: ${path}`)
      const map = await readMap(diskPath, scriptSource, root)
      scripts.push({
        path,
        sha256: digest(source),
        sourceMapSha256: map ? digest(map) : null,
        functions: script.functions,
      })
    }
    assert(scripts.length > 0, 'no scripts matched --prefix')
    scripts.sort((a, b) => a.path.localeCompare(b.path))
    const artifact = {
      schemaVersion: 1,
      scenario,
      capturedAt: new Date().toISOString(),
      environment: {
        browser: browser.version(),
        node: process.version,
        platform: process.platform,
        playwright: playwright.version,
        viewport: {width: 1280, height: 900},
        serviceWorkers: 'blocked',
        externalRequests: 'blocked',
        scope: 'page CDP target only; no worker coverage',
        observation: `navigation networkidle + ${waitMs}ms${action ? '; then custom actions' : ''}`,
      },
      url: target.href,
      requests,
      blockedOrigins: [...blocked].sort(),
      excludedScripts: [...new Set(excluded)].sort(),
      scripts,
    }
    await mkdir(dirname(resolve(out)), {recursive: true})
    await writeFile(out, JSON.stringify(artifact, null, 2) + '\n')
    console.log(`${scenario}: ${scripts.length} scripts -> ${out}`)
    return artifact
  } finally {
    await browser.close()
  }
}
