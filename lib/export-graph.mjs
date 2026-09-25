import {readFile, writeFile, mkdir, stat} from 'node:fs/promises'
import {resolve, dirname, join} from 'node:path'
import {esbuildGraph, webpackGraph, turbopackGraph, enrichLocations} from './graph.mjs'

export async function exportGraph({format, input, root = '.', out, environment = 'client'}) {
  if (!input || !out || !['esbuild', 'webpack', 'turbopack'].includes(format)) {
    throw new Error('Usage: coldpath graph --format esbuild|webpack|turbopack --input FILE_OR_ANALYZE_DIRECTORY --root BUILD_ROOT --out graph.json [--environment client|server|all]')
  }
  if (!['client', 'server', 'all'].includes(environment)) throw new Error('Invalid --environment')
  input = resolve(input)
  if ((await stat(input)).isDirectory()) input = join(input, 'data/modules.data')
  const bytes = await readFile(input)
  root = resolve(root)
  const graph = format === 'turbopack' ? turbopackGraph(bytes, root, environment) :
    format === 'webpack' ? webpackGraph(JSON.parse(bytes), root) : esbuildGraph(JSON.parse(bytes), root)
  await enrichLocations(graph, root)
  await mkdir(dirname(resolve(out)), {recursive: true})
  await writeFile(out, JSON.stringify(graph) + '\n')
  console.log(`Exported ${graph.bundler}: ${graph.modules.length} modules, ${graph.edges.length} edges, ${graph.edges.filter((e) => e.location).length} import locations`)
  return graph
}
