// snapshot -> modules -> label -> analyze against a local site whose chunk has no reachable map.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {mkdir, readFile, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {chromium} from 'playwright'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const out = join(root, 'artifacts', 'inferred')
await rm(out, {recursive: true, force: true})
await mkdir(out, {recursive: true})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const env = {...process.env, COLDPATH_ANALYZER: join(root, 'target', 'debug', 'coldpath')}
const cli = (...args) => run(process.execPath, [join(root, 'bin', 'coldpath.mjs'), ...args], {env})

const modules = {
  10: '(e)=>{e.exports="coldpath-sentinel 한🔥"}',
  11: 'function(e){\n  e.exports=function never(){return "shared-common-text only-in-eleven"}\n}',
  12: '(e)=>{e.exports="shared-common-text"}',
  13: '(e)=>{e.exports="shared-common-text"}',
  14: '(e)=>{e.exports="shared-common-text"}',
}
const chunk = `(self.webpackChunk_test=self.webpackChunk_test||[]).push([[1],{${Object.entries(modules).map(([id, code]) => `${id}:${code}`).join(',')}}]);
(function(){var m=self.webpackChunk_test[0][1],x={};m[10](x);var s=document.createElement("script");s.src="/a/"+"dy"+"n.js";document.head.append(s)})()
//# sourceMappingURL=chunk.js.map`
const turbo = '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,20,e=>{e.x="turbo-sentinel"},"21",function(e){\n  e.y=1\n}]);'
const pages = {
  '/': ['text/html', '<!doctype html><meta charset="utf-8"><script src="/a/chunk.js"></script><script src="/a/turbo.js"></script><script>var s=document.createElement("script");s.src="/a/late.js";document.head.append(s)</script>'],
  '/a/chunk.js': ['text/javascript', chunk],
  '/a/turbo.js': ['text/javascript', turbo],
  '/a/dyn.js': ['text/javascript', 'window.dyn=1'],
  '/a/late.js': ['text/javascript', 'window.late=1'],
}
const site = createServer((request, response) => {
  const page = pages[request.url]
  if (!page) return response.writeHead(404).end()
  response.setHeader('content-type', page[0] + '; charset=utf-8')
  response.end(page[1])
})
// Answers from source text: module 10 gets real evidence, 11 only a common string, the rest an absent one.
const answer = (text) => {
  const source = JSON.parse(text).source
  const evidence = source.endsWith('/10.js') ? ['coldpath-sentinel', 'absent from the module'] :
    source.endsWith('/11.js') ? ['shared-common-text'] : ['absent from the module']
  return {summary: 'summary of ' + source, name: 'guess-' + source.split('/').pop(), shortName: 'guess', kind: 'app', reasoning: 'because', evidence}
}
const requests = []
const model = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const json = JSON.parse(body)
    requests.push({url: request.url, json})
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/chat/completions') {
      assert.equal(json.response_format.json_schema.strict, true)
      response.end(JSON.stringify({choices: [{message: {content: JSON.stringify(answer(json.messages[1].content))}}], usage: {prompt_tokens: 3, completion_tokens: 2}}))
    } else {
      assert.equal(json.output_config.format.type, 'json_schema')
      const value = answer(json.messages[0].content)
      response.end(JSON.stringify({id: 'msg_test', type: 'message', role: 'assistant', model: json.model, stop_reason: 'end_turn',
        content: [{type: 'text', text: JSON.stringify({summary: value.summary})}], usage: {input_tokens: 3, output_tokens: 2}}))
    }
  })
})
await Promise.all([site, model].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))))
const origin = `http://127.0.0.1:${site.address().port}`
const modelUrl = `http://127.0.0.1:${model.address().port}`
try {
  await cli('snapshot', '--url', origin + '/', '--out', out, '--wait-ms', '500')
  const host = new URL(origin).host
  const loading = JSON.parse(await readFile(join(out, 'loading.json'), 'utf8')).bundles
  assert.equal(loading[`${host}/a/chunk.js`].load, 'html')
  assert.equal(loading[`${host}/a/late.js`].load, 'inline')
  assert.equal(loading[`${host}/a/dyn.js`].load, 'dynamic')
  assert.equal(loading[`${host}/a/chunk.js`].initiator, 'parser')
  // The declared map is a 404: snapshot binds an empty map so analysis does not fail.
  assert.deepEqual(JSON.parse(await readFile(join(out, 'maps.json'), 'utf8')), {[`${host}/a/chunk.js`]: `maps/${host}/a/chunk.js.map`})
  assert.equal(await readFile(join(out, 'files', host, 'a', 'chunk.js'), 'utf8'), chunk)

  await cli('modules', '--dir', join(out, 'files'), '--out', join(out, 'modules'))
  const analyze = (...extra) => cli('analyze', '--dir', join(out, 'files'), '--coverage', join(out, 'coverage.json'), '--url-prefix', 'http://',
    '--maps-json', join(out, 'maps.json'), '--maps-json', join(out, 'modules', 'maps.json'), '--loading', join(out, 'loading.json'), '--details', ...extra)
  await analyze('--json', join(out, 'report.json'))
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
  const bundle = report.bundles.find((row) => row.path === `${host}/a/chunk.js`)
  assert.equal(bundle.loading.load, 'html')
  for (const [id, code] of Object.entries(modules)) {
    const row = bundle.sources.find((source) => source.source === `webpack://inferred/webpackChunk_test/${id}.js`)
    // Line terminators stay unmapped, as with any source map.
    assert.equal(row.bytes, Buffer.byteLength(`${id}:${code}`.replaceAll('\n', '')), `module ${id} bytes`)
    assert.equal(row.content, `${id}:${code}`)
  }
  const byId = (id) => bundle.sources.find((source) => source.source.endsWith(`/${id}.js`))
  assert.equal(byId(10).unobservedBytes, 0, 'module 10 ran completely')
  assert(byId(11).unobservedBytes > byId(11).observedBytes, 'module 11 factory never ran')
  assert.equal(bundle.sources.reduce((sum, row) => sum + row.bytes, 0), bundle.bytes)
  const turbopack = report.bundles.find((row) => row.path === `${host}/a/turbo.js`)
  for (const [id, text] of [['20', '20,e=>{e.x="turbo-sentinel"}'], ['21', '"21",function(e){\n  e.y=1\n}']]) {
    const row = turbopack.sources.find((source) => source.source === `webpack://inferred/TURBOPACK/${id}.js`)
    assert.equal(row.content, text)
    assert.equal(row.bytes, Buffer.byteLength(text.replaceAll('\n', '')), `Turbopack module ${id} bytes`)
  }

  await run(process.execPath, [join(root, 'bin', 'coldpath.mjs'), 'label', '--report', join(out, 'report.json'), '--out', join(out, 'labels.json'),
    '--provider', 'openai', '--model', 'test-model', '--base-url', modelUrl + '/v1'], {env})
  const labels = JSON.parse(await readFile(join(out, 'labels.json'), 'utf8'))
  assert.deepEqual(labels.generator, {provider: 'openai', model: 'test-model', mode: 'identify'})
  const label = (id) => labels.sources[`webpack://inferred/webpackChunk_test/${id}.js`]
  assert.deepEqual(label(10).evidence, ['coldpath-sentinel'], 'absent evidence is dropped')
  assert.deepEqual(label(11), {summary: 'summary of webpack://inferred/webpackChunk_test/11.js'}, 'common evidence rejects the guess')
  assert.deepEqual(Object.keys(label(12)), ['summary'], 'absent-only evidence rejects the guess')
  assert(!Object.keys(labels.sources).some((source) => !source.startsWith('webpack://inferred/')), 'identify mode only guesses recovered modules')

  await run(process.execPath, [join(root, 'bin', 'coldpath.mjs'), 'label', '--report', join(out, 'report.json'), '--out', join(out, 'described.json'),
    '--mode', 'describe'], {env: {...env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: modelUrl}})
  const described = JSON.parse(await readFile(join(out, 'described.json'), 'utf8'))
  assert.equal(described.generator.provider, 'anthropic')
  // Describe covers every source with content; here only recovered modules have content.
  assert.equal(Object.keys(described.sources).length, Object.keys(modules).length + 2)
  assert(Object.values(described.sources).every((row) => Object.keys(row).join() === 'summary'))
  assert(requests.some((row) => row.url === '/v1/messages'))

  await analyze('--labels', join(out, 'labels.json'), '--json', join(out, 'labeled.json'), '--treemap', join(out, 'labeled.html'))
  const labeled = JSON.parse(await readFile(join(out, 'labeled.json'), 'utf8'))
  assert.equal(labeled.totals.bytes, report.totals.bytes)
  assert.equal(labeled.sources.find((row) => row.source.endsWith('/10.js')).label.name, 'guess-10.js')

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error))
    await page.goto('file://' + join(out, 'labeled.html'))
    const rows = await page.locator('#rows button').allTextContents()
    assert.deepEqual(rows.sort(), ['Initial HTML tags', 'Loaded by scripts', 'Named in initial HTML data'])
    await page.fill('#search', 'guess-10')
    for (let i = 0; i < 6 && await page.locator('#file').isHidden(); i++) await page.locator('#rows button').first().click()
    assert.match(await page.locator('#scope').textContent(), /^≈ guess \(10\.js\)$/)
    assert.match(await page.locator('#file').textContent(), /Inferred identity: guess-10\.js \(app\).*coldpath-sentinel.*not source-map evidence/s)
    assert.match(await page.locator('#file').textContent(), /Bundle loaded.*Initial HTML tags \(initiator: parser\)/s)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
  console.log('verified snapshot, module recovery, labeling and annotated reports')
} finally {
  site.close()
  model.close()
}
