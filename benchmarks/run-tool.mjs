// One process per measurement. Dataset adaptation is outside the timed runs.
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'

const [tool, dataset, outputArg, mode = 'json', policy = 'default'] = process.argv.slice(2)
const diagnostics = process.env.COMPARISON_DIAGNOSTICS === '1'
const input = resolve(dataset),
  output = resolve(outputArg)
await mkdir(output, {recursive: true})
const manifest = JSON.parse(await readFile(join(input, 'manifest.json'), 'utf8'))
if (tool === 'sme') {
  const {explore} = await import('source-map-explorer')
  const options = {
    noRoot: true,
    noBorderChecks: policy === 'relaxed',
    ...(!mode.startsWith('static') ? {coverage: join(input, 'chrome.json')} : {}),
    output: {
      format: mode.endsWith('html') ? 'html' : 'json',
      filename: join(output, mode.endsWith('html') ? 'index.html' : 'report.json'),
    },
  }
  let result
  try {
    result = await explore(
      manifest.bundles.map((row) => ({
        code: join(input, 'files', row.path),
        ...(row.mapPath ? {map: join(input, 'files', row.mapPath)} : {}),
      })),
      options,
    )
  } catch (error) {
    result = error
    process.exitCode = 1
  }
  const errors = (result.errors ?? []).map(({bundleName, code, message, isWarning}) => ({
    bundleName,
    code,
    message,
    isWarning: !!isWarning,
  }))
  const bundles = result.bundles ?? []
  if (errors.some((error) => !error.isWarning) || bundles.length !== manifest.bundles.length)
    process.exitCode = 1
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        tool,
        mode,
        policy,
        bundles: bundles.length,
        expectedBundles: manifest.bundles.length,
        errors,
        rows: diagnostics
          ? bundles.map((b) => ({
              ...b,
              bundleName: b.bundleName.replace(join(input, 'files') + '/', ''),
            }))
          : undefined,
        exception: result instanceof Error ? result.message : undefined,
      },
      null,
      2,
    ),
  )
} else if (tool === 'monocart') {
  const {CoverageReport} = await import('monocart-coverage-reports')
  const entries = JSON.parse(await readFile(join(input, 'playwright.json'), 'utf8'))
  if (policy !== 'generated')
    for (const entry of entries) {
      const path = new URL(entry.url).pathname.slice(1)
      const row = manifest.bundles.find((row) => row.path === path)
      if (row.mapPath)
        entry.sourceMap = JSON.parse(await readFile(join(input, 'files', row.mapPath), 'utf8'))
    }
  const report = new CoverageReport({
    name: 'bundle-trace comparison',
    outputDir: output,
    cleanCache: true,
    // Debug retains the exact generated text and exposes generated-file rows.
    logging: policy === 'generated' || policy === 'debug-map' ? 'debug' : 'error',
    sourceMapResolver: async () => undefined,
    reports: mode.endsWith('html') ? ['v8'] : ['v8-json'],
    inline: true,
  })
  await report.add(entries)
  const result = await report.generate()
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        tool,
        mode,
        policy,
        summary: result.summary,
        fileCount: result.files.length,
        files: diagnostics
          ? result.files.map(({sourcePath, debug, summary, data, source}) => ({
              sourcePath,
              debug: !!debug,
              summary,
              sourceLength: source.length,
              utf8Bytes: Buffer.byteLength(source),
              ranges: data.bytes,
            }))
          : undefined,
      },
      null,
      2,
    ),
  )
} else throw new Error('Unknown tool: ' + tool)
