import {resolve} from 'node:path'
import {importSites, sha256, sourcePath} from './graph.mjs'

// Compatible with Rollup and Vite (including the Rolldown-backed Vite build).
export default function coldpathGraph({fileName = 'coldpath.graph.json', root = process.cwd()} = {}) {
  const inputs = new Map()
  let bundler = 'rollup'
  return {
    name: 'coldpath-graph', enforce: 'pre',
    configResolved(config) { root = config.root; bundler = 'vite' },
    buildStart() { inputs.clear() },
    transform(code, id) {
      if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) return null
      try { inputs.set(id, {sites: importSites(code, id), sourceSha256: sha256(code)}) }
      catch { inputs.set(id, {sites: [], sourceSha256: sha256(code)}) }
      return null
    },
    async generateBundle(_options, bundle) {
      const ids = [...this.getModuleIds()]
      const sizes = new Map(), chunks = new Map()
      for (const output of Object.values(bundle)) if (output.type === 'chunk') {
        for (const [id, mod] of Object.entries(output.modules)) {
          sizes.set(id, (sizes.get(id) || 0) + (mod.renderedLength || 0))
          if (!chunks.has(id)) chunks.set(id, [])
          chunks.get(id).push(output.fileName)
        }
      }
      const modules = [], edges = [], warnings = []
      for (const id of ids) {
        const info = this.getModuleInfo(id)
        if (!info || info.isExternal) continue
        modules.push({id, source: sourcePath(id, resolve(root)), entry: info.isEntry, emittedBytes: sizes.get(id) || 0,
          sourceSha256: inputs.get(id)?.sourceSha256, chunks: chunks.get(id) || []})
        const known = new Map([...info.importedIds.map((to) => [to, 'static']), ...info.dynamicallyImportedIds.map((to) => [to, 'dynamic'])])
        const located = new Set()
        for (const site of inputs.get(id)?.sites || []) {
          const target = await this.resolve(site.specifier, id)
          if (!target || target.external || !known.has(target.id)) continue
          edges.push({from: id, to: target.id, ...site, locationEvidence: 'plugin-input', sourceSha256: inputs.get(id).sourceSha256})
          located.add(target.id)
        }
        for (const [to, kind] of known) {
          if (!located.has(to) && !this.getModuleInfo(to)?.isExternal) edges.push({from: id, to, kind})
        }
      }
      this.emitFile({type: 'asset', fileName, source: JSON.stringify({schemaVersion: 1, bundler, modules, edges, warnings})})
    },
  }
}
