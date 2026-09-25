import {mkdir, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {enrichLocations, webpackGraph} from './graph.mjs'

// Writes the graph after the build, next to the emitted assets.
export default class ColdpathGraphPlugin {
  constructor({fileName = 'coldpath.graph.json', root} = {}) {
    this.fileName = fileName
    this.root = root
  }

  apply(compiler) {
    compiler.hooks.done.tapPromise('ColdpathGraphPlugin', async (stats) => {
      if (stats.hasErrors()) return
      const root = resolve(this.root ?? compiler.context)
      const data = stats.toJson({
        all: false, modules: true, nestedModules: true, reasons: true, children: true,
        ids: true, groupModulesByType: false, groupModulesByPath: false,
        groupModulesByAttributes: false, modulesSpace: Infinity, nestedModulesSpace: Infinity,
      })
      const graph = await enrichLocations(webpackGraph(data, root), root)
      const out = resolve(compiler.outputPath, this.fileName)
      await mkdir(dirname(out), {recursive: true})
      await writeFile(out, JSON.stringify(graph) + '\n')
    })
  }
}
