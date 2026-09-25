#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {runAnalyzer} from '../lib/analyzer.mjs'
import {collect} from '../lib/collect.mjs'
import {exportGraph} from '../lib/export-graph.mjs'
import {loadScenarios} from '../lib/scenarios.mjs'

const usage = `Usage:
  coldpath collect --scenarios coldpath.scenarios.json
  coldpath collect --url URL --dir DIRECTORY --out FILE [--prefix PATH] [--scenario NAME] [--actions FILE] [--wait-ms N]
                   [--cdn-prefix URL]... [--device NAME] [--viewport WxH] [--user-agent UA] [--device-scale-factor N] [--mobile] [--touch]
                   [--latency-ms N --download-kbps N --upload-kbps N] [--cpu-slowdown N] [--storage-state FILE]
  coldpath graph --format esbuild|webpack|turbopack --input FILE --root BUILD_ROOT --out graph.json [--environment client|server|all]
  coldpath analyze [--scenarios coldpath.scenarios.json] [ANALYZER OPTIONS...]
  coldpath [ANALYZER OPTIONS...]

Run \`coldpath analyze --help\` for analyzer options. See docs/collecting.md and docs/graphs.md.`

const [command, ...rest] = process.argv.slice(2)

async function main() {
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(usage)
    return 0
  }
  if (command === 'collect') {
    const {values} = parseArgs({args: rest, options: {
      scenarios: {type: 'string'}, url: {type: 'string'}, dir: {type: 'string'}, out: {type: 'string'},
      prefix: {type: 'string'}, scenario: {type: 'string'}, actions: {type: 'string'}, 'wait-ms': {type: 'string'},
      'cdn-prefix': {type: 'string', multiple: true}, device: {type: 'string'}, viewport: {type: 'string'}, 'user-agent': {type: 'string'},
      'device-scale-factor': {type: 'string'}, mobile: {type: 'boolean'}, touch: {type: 'boolean'},
      'latency-ms': {type: 'string'}, 'download-kbps': {type: 'string'}, 'upload-kbps': {type: 'string'},
      'cpu-slowdown': {type: 'string'}, 'storage-state': {type: 'string'},
    }})
    if (values.scenarios) {
      const {scenarios} = await loadScenarios(values.scenarios)
      for (const scenario of scenarios) await collect(scenario)
      return 0
    }
    const number = (key) => values[key] === undefined ? undefined : Number(values[key])
    let viewport
    if (values.viewport) {
      const match = /^(\d+)x(\d+)$/.exec(values.viewport)
      if (!match) throw new Error('--viewport must be WIDTHxHEIGHT')
      viewport = {width: Number(match[1]), height: Number(match[2])}
    }
    const throttled = ['latency-ms', 'download-kbps', 'upload-kbps'].some((key) => values[key] !== undefined)
    await collect({
      url: values.url, dir: values.dir, out: values.out, prefix: values.prefix, scenario: values.scenario,
      actions: values.actions, waitMs: number('wait-ms'), cdnPrefixes: values['cdn-prefix'], device: values.device, viewport,
      userAgent: values['user-agent'], deviceScaleFactor: number('device-scale-factor'),
      isMobile: values.mobile, hasTouch: values.touch, cpuSlowdown: number('cpu-slowdown'),
      network: throttled ? {latencyMs: number('latency-ms'), downloadKbps: number('download-kbps'), uploadKbps: number('upload-kbps')} : undefined,
      storageState: values['storage-state'],
    })
    return 0
  }
  if (command === 'graph') {
    const {values} = parseArgs({args: rest, options: {
      format: {type: 'string'}, input: {type: 'string'}, root: {type: 'string'},
      out: {type: 'string'}, environment: {type: 'string'},
    }})
    await exportGraph(values)
    return 0
  }
  const args = command === 'analyze' ? rest : [command, ...rest]
  const at = args.indexOf('--scenarios')
  if (at < 0) return runAnalyzer(args)
  const [, file] = args.splice(at, 2)
  const {dir, scenarios} = await loadScenarios(file)
  const names = scenarios.map((s) => s.scenario)
  return runAnalyzer([
    ...(args.includes('--dir') ? [] : ['--dir', dir]),
    ...scenarios.flatMap((s) => ['--coverage', s.out]),
    '--scenario-order', names.join(','),
    ...(args.includes('--initial-scenario') ? [] : ['--initial-scenario', names[0]]),
    ...args,
  ])
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`coldpath: ${error.message}`)
  process.exitCode = 1
}
