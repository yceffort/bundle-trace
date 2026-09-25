// Record a deployed site you do not build: the scripts it served, their V8 coverage, and what caused each load.
// The saved script text is the evidence; the analyzer compares coverage against it offline.
import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

import {loadPlaywright} from './collect.mjs'

const EMPTY_MAP = JSON.stringify({version: 3, sources: [], names: [], mappings: ''})

// Analysis-root-relative path, matching the analyzer's `--url-prefix https://` mapping.
const bundlePath = (url) => {
  const {host, pathname} = new URL(url)
  return host + decodeURIComponent(pathname)
}

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

// With `scenario`, repeated visits share one directory: coverage/<scenario>.json per visit, and scripts,
// maps and load causes accumulate. A script that differs from an earlier visit's copy is an error.
export async function snapshot({url, out, waitMs = 5000, actions, scenario}) {
  assert(url && out, 'Usage: coldpath snapshot --url URL --out DIRECTORY [--wait-ms N] [--actions FILE] [--scenario NAME]')
  assert(scenario === undefined || /^[\w.-]+$/.test(scenario), '--scenario may contain letters, digits, _, . and -')
  assert(Number.isSafeInteger(waitMs) && waitMs >= 0, '--wait-ms must be a nonnegative integer')
  const target = new URL(url)
  assert(['http:', 'https:'].includes(target.protocol), '--url must use http or https')
  let action
  if (actions) {
    action = (await import(pathToFileURL(resolve(actions)).href)).default
    assert.equal(typeof action, 'function', '--actions must default-export a function')
  }
  const {chromium} = loadPlaywright('snapshot')
  const browser = await chromium.launch()
  let entries, html
  const requests = new Map()
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}})
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    let origin
    cdp.on('Network.requestWillBeSent', ({request, initiator, timestamp}) => {
      origin ??= timestamp
      const key = request.url.split(/[?#]/)[0]
      if (!requests.has(key)) requests.set(key, {initiator: initiator.type, startMs: Math.round((timestamp - origin) * 1000)})
    })
    await page.coverage.startJSCoverage({resetOnNavigation: false})
    const response = await page.goto(target.href, {waitUntil: 'load', timeout: 60000})
    assert(response?.ok(), `navigation failed: ${response?.status()}`)
    html = await response.text()
    await page.waitForTimeout(waitMs)
    if (action) await action({page, context: page.context()})
    entries = await page.coverage.stopJSCoverage()
  } finally {
    await browser.close()
  }

  out = resolve(out)
  const files = join(out, 'files')
  const bindings = await readJson(join(out, 'maps.json'), {})
  const loading = (await readJson(join(out, 'loading.json'), {bundles: {}})).bundles
  const coverage = [], seen = new Set()
  const inHtml = new Set([...html.matchAll(/<(?:script\b[^>]*\ssrc|link\b[^>]*\shref)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => new URL(m[1].replaceAll('&amp;', '&'), target).href.split(/[?#]/)[0]))
  for (const entry of entries) {
    let scriptUrl
    try {
      scriptUrl = new URL(entry.url)
    } catch {
      continue
    }
    if (!['http:', 'https:'].includes(scriptUrl.protocol) || !/\.(m|c)?js$/.test(scriptUrl.pathname)) continue
    const path = bundlePath(scriptUrl)
    if (seen.has(path)) continue
    seen.add(path)
    coverage.push(entry)
    const earlier = await readFile(join(files, path), 'utf8').catch(() => undefined)
    assert(earlier === undefined || earlier === entry.source, `${path} differs from the copy an earlier snapshot saved in ${out}`)
    if (earlier !== undefined) continue
    await mkdir(dirname(join(files, path)), {recursive: true})
    await writeFile(join(files, path), entry.source)

    const key = scriptUrl.href.split(/[?#]/)[0]
    const name = scriptUrl.pathname.split('/').pop()
    loading[path] = {
      load: inHtml.has(key) ? 'html' : html.includes(name) ? 'inline' : 'dynamic',
      ...requests.get(key),
    }

    // The analyzer never fetches maps. A reachable map is saved at its own URL path under files/, so its
    // relative source paths resolve as they would on the site; an unreachable one is bound to an empty map.
    const reference = entry.source.trimEnd().split(/\r\n|[\r\n\u2028\u2029]/).at(-1).match(/^\/\/[#@]\s*sourceMappingURL=(\S+)$/)?.[1]
    if (!reference || reference.startsWith('data:')) continue
    const mapUrl = new URL(reference, scriptUrl)
    let text
    try {
      const fetched = await fetch(mapUrl)
      if (fetched.ok) {
        text = await fetched.text()
        JSON.parse(text)
      }
    } catch {
      text = undefined
    }
    const mapPath = text === undefined ? `maps/${path}.map` : `files/${bundlePath(mapUrl)}`
    await mkdir(dirname(join(out, mapPath)), {recursive: true})
    await writeFile(join(out, mapPath), text ?? EMPTY_MAP)
    bindings[path] = mapPath
  }
  const coverageFile = scenario ? join(out, 'coverage', `${scenario}.json`) : join(out, 'coverage.json')
  await mkdir(dirname(coverageFile), {recursive: true})
  await writeFile(coverageFile, JSON.stringify(coverage))
  await writeFile(join(out, 'maps.json'), JSON.stringify(bindings, null, 2) + '\n')
  await writeFile(join(out, 'loading.json'), JSON.stringify({schemaVersion: 1, bundles: loading}, null, 2) + '\n')
  const counts = [...seen].map((path) => loading[path]).reduce((sum, {load}) => ({...sum, [load]: (sum[load] || 0) + 1}), {})
  console.log(`${coverage.length} scripts (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ` +
    `${Object.keys(bindings).length} declared maps -> ${coverageFile}`)
}
