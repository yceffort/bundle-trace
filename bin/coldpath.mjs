#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {runAnalyzer} from '../lib/analyzer.mjs'
import {collect} from '../lib/collect.mjs'
import {exportGraph} from '../lib/export-graph.mjs'
import {loadScenarios} from '../lib/scenarios.mjs'

const usage = `Usage:
  coldpath collect --scenarios coldpath.scenarios.json
  coldpath collect --url URL --dir DIRECTORY --out FILE [--prefix PATH] [--scenario NAME] [--actions FILE] [--wait-ms N]
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
    }})
    if (values.scenarios) {
      const {scenarios} = await loadScenarios(values.scenarios)
      for (const scenario of scenarios) await collect(scenario)
      return 0
    }
    await collect({...values, waitMs: values['wait-ms'] === undefined ? undefined : Number(values['wait-ms'])})
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
