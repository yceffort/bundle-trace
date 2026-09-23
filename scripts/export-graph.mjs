import {readFile, writeFile, mkdir, stat} from 'node:fs/promises'
import {resolve, dirname, join} from 'node:path'
import {parseArgs} from 'node:util'
import {esbuildGraph, webpackGraph, turbopackGraph, enrichLocations} from './graph-utils.mjs'

const {values} = parseArgs({options: {
  input: {type: 'string'}, format: {type: 'string'}, root: {type: 'string', default: '.'},
  out: {type: 'string'}, environment: {type: 'string', default: 'client'},
}})
if (!values.input || !values.out || !['esbuild', 'webpack', 'turbopack'].includes(values.format)) {
  throw new Error('Usage: node scripts/export-graph.mjs --format esbuild|webpack|turbopack --input FILE_OR_ANALYZE_DIRECTORY --root BUILD_ROOT --out graph.json [--environment client|server|all]')
}
if (!['client', 'server', 'all'].includes(values.environment)) throw new Error('Invalid --environment')
let input = resolve(values.input)
if ((await stat(input)).isDirectory()) input = join(input, 'data/modules.data')
const bytes = await readFile(input), root = resolve(values.root)
const graph = values.format === 'turbopack' ? turbopackGraph(bytes, root, values.environment) :
  values.format === 'webpack' ? webpackGraph(JSON.parse(bytes), root) : esbuildGraph(JSON.parse(bytes), root)
await enrichLocations(graph, root)
await mkdir(dirname(resolve(values.out)), {recursive: true})
await writeFile(values.out, JSON.stringify(graph) + '\n')
console.log(`Exported ${graph.bundler}: ${graph.modules.length} modules, ${graph.edges.length} edges, ${graph.edges.filter((e) => e.location).length} import locations`)
