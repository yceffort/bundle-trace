import {parse} from '@babel/parser'
import {createHash} from 'node:crypto'
import {readFile, realpath} from 'node:fs/promises'
import {isAbsolute, resolve, dirname, relative} from 'node:path'

export const sha256 = (source) => createHash('sha256').update(source).digest('hex')
export const slash = (path) => path.replaceAll('\\', '/')
export const sourcePath = (path, root) => path.startsWith('[project]/') ? path.slice(10) :
  isAbsolute(path) ? slash(relative(root, path)) : path.replace(/^\.\//, '')

// Parse syntax, never execute a module. Dynamic expressions stay unresolved.
export function importSites(code, filename) {
  const ast = parse(code, {sourceType: 'unambiguous', sourceFilename: filename,
    createImportExpressions: true, plugins: ['jsx', 'typescript', 'decorators-legacy', 'importAttributes']})
  const sites = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    let value, kind
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      if (node.importKind === 'type' || node.exportKind === 'type') return
      if (node.specifiers?.length && node.specifiers.every((s) => s.importKind === 'type' || s.exportKind === 'type')) return
      value = node.source?.value; kind = 'static'
    } else if (node.type === 'ImportExpression') { value = node.source?.value; kind = 'dynamic' }
    else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      value = node.arguments[0]?.value; kind = 'require'
    }
    if (typeof value === 'string') sites.push({specifier: value, kind,
      location: {line: node.loc.start.line, column: node.loc.start.column + 1}, locationEvidence: 'parsed-source'})
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast.program)
  return sites
}

export async function enrichLocations(graph, root) {
  const modules = new Map(graph.modules.map((m) => [m.id, m]))
  const byFrom = new Map()
  for (const edge of graph.edges) {
    if (!byFrom.has(edge.from)) byFrom.set(edge.from, [])
    byFrom.get(edge.from).push(edge)
  }
  const cache = new Map()
  const result = []
  for (const [from, edges] of byFrom) {
    const mod = modules.get(from)
    let sites = []
    if (mod && !mod.source.startsWith('[') && !mod.source.includes('\0')) {
      const filename = resolve(root, mod.source)
      try {
        let parsed = cache.get(filename)
        if (!parsed) {
          const code = await readFile(filename, 'utf8')
          parsed = {sites: importSites(code, filename), hash: sha256(code)}
          cache.set(filename, parsed)
        }
        sites = parsed.sites
        mod.sourceSha256 = parsed.hash
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EISDIR') graph.warnings.push(`No parsed import locations for ${mod.source}: ${error.message}`)
      }
    }
    for (const edge of edges) {
      const target = modules.get(edge.to)
      const matches = []
      for (const site of sites) {
        if (edge.specifier && site.specifier === edge.specifier) { matches.push(site); continue }
        if (!site.specifier.startsWith('.') || !target) continue
        // Resolve only to a target already established by the bundler graph.
        const stem = resolve(root, dirname(mod.source), site.specifier)
        const expected = resolve(root, target.source)
        const candidates = [stem, ...['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].map((ext) => stem + ext),
          ...['.js', '.jsx', '.ts', '.tsx'].map((ext) => resolve(stem, 'index' + ext))]
        if (candidates.includes(expected)) matches.push(site)
        else if (await realpath(stem).catch(() => null) === expected) matches.push(site)
      }
      const compatible = matches.filter((site) => edge.kind === 'unknown' || site.kind === edge.kind)
      if (compatible.length) for (const site of compatible) result.push({...edge, ...site})
      else result.push(edge)
    }
  }
  graph.edges = result
  return graph
}

export function esbuildGraph(meta, root) {
  const sizes = new Map(), entries = new Set()
  const dynamicallyImported = new Set(Object.values(meta.inputs).flatMap((input) =>
    (input.imports || []).filter((i) => !i.external && i.kind === 'dynamic-import').map((i) => i.path)))
  for (const [filename, output] of Object.entries(meta.outputs)) {
    if (!/\.[cm]?js$/.test(filename)) continue
    if (output.entryPoint && !dynamicallyImported.has(output.entryPoint)) entries.add(output.entryPoint)
    for (const [id, input] of Object.entries(output.inputs || {})) sizes.set(id, (sizes.get(id) || 0) + input.bytesInOutput)
  }
  return {schemaVersion: 1, bundler: 'esbuild', warnings: [],
    modules: Object.keys(meta.inputs).map((id) => ({id, source: sourcePath(id, root), entry: entries.has(id), emittedBytes: sizes.get(id) || 0})),
    edges: Object.entries(meta.inputs).flatMap(([from, input]) => (input.imports || []).filter((i) => !i.external).map((i) => ({
      from, to: i.path, specifier: i.original, kind: i.kind === 'dynamic-import' ? 'dynamic' : i.kind?.startsWith('require') ? 'require' : 'static',
    }))) }
}

export function webpackGraph(stats, root) {
  const graph = {schemaVersion: 1, bundler: 'webpack', modules: [], edges: [], warnings: []}
  let compilationIndex = 0
  const compilation = (stats) => {
    const prefix = `${compilationIndex++}:`
    const all = []
    const entries = new Set()
    const flatten = (modules, parent) => { for (const mod of modules || []) {
      if (mod.identifier) {
        all.push(mod)
        if ((mod.reasons || []).some((r) => r.type === 'entry') ||
          (parent && mod.nameForCondition && entries.has(parent.identifier) && mod.nameForCondition === parent.nameForCondition)) entries.add(mod.identifier)
      }
      flatten(mod.modules, mod)
    } }
    flatten(stats.modules)
    const known = new Set(all.map((m) => m.identifier))
    for (const mod of all) {
      const source = mod.nameForCondition || mod.name || mod.identifier
      graph.modules.push({id: prefix + mod.identifier, source: sourcePath(source, root),
        entry: entries.has(mod.identifier), emittedBytes: null})
      for (const reason of mod.reasons || []) {
        if (reason.active === false || !known.has(reason.moduleIdentifier)) continue
        const kind = /import\(\)/.test(reason.type) ? 'dynamic' : /harmony/.test(reason.type) ? 'static' : /cjs|require/.test(reason.type) ? 'require' : 'unknown'
        // An import-specifier reason points to a USE, not the declaration.
        // Recover the declaration from syntax instead of presenting that use as an import.
        const loc = /harmony import specifier/.test(reason.type) ? null : /^(\d+):(\d+)(?:-|$)/.exec(reason.loc || '')
        graph.edges.push({from: prefix + reason.moduleIdentifier, to: prefix + mod.identifier, kind, specifier: reason.userRequest,
          ...(loc ? {location: {line: Number(loc[1]), column: Number(loc[2]) + 1}, locationEvidence: 'webpack-stats'} : {})})
      }
      // Concatenated inner modules have no reasons. Stats still records their
      // first issuer; syntax enrichment can prove its import kind and position.
      if (known.has(mod.issuer) && !(mod.reasons || []).some((r) => r.moduleIdentifier === mod.issuer && r.active !== false)) {
        graph.edges.push({from: prefix + mod.issuer, to: prefix + mod.identifier, kind: 'unknown'})
      }
    }
    for (const child of stats.children || []) compilation(child)
  }
  compilation(stats)
  if (!graph.modules.length) throw new Error('webpack stats needs modules, nestedModules and reasons (without grouped modules)')
  return graph
}

// Next 16.3 analyzer: big-endian JSON header followed by offset-table adjacency lists.
export function turbopackGraph(bytes, root, environment = 'client') {
  const get = (offset, data = bytes) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > data.length) throw new Error('Invalid Turbopack edge offset')
    return data.readUInt32BE(offset)
  }
  const length = get(0)
  if (length > bytes.length - 4) throw new Error('Truncated Turbopack module header')
  const header = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'))
  const binary = bytes.subarray(4 + length)
  if (!Array.isArray(header.modules) || !header.module_dependencies || !header.async_module_dependencies) throw new Error('Unsupported Turbopack modules.data schema')
  const keep = (mod) => environment === 'all' || (environment === 'client' ? /\[(?:app-)?client\]/.test(mod.ident) : !/\[(?:app-)?client\]/.test(mod.ident))
  const modules = header.modules.flatMap((mod, i) => keep(mod) ? [{id: String(i), source: sourcePath(mod.path, root), entry: mod.path.startsWith('[next]/entry/'), emittedBytes: null}] : [])
  const ids = new Set(modules.map((m) => m.id)), edges = []
  for (const [field, kind] of [['module_dependencies', 'static'], ['async_module_dependencies', 'dynamic'], ['traced_module_dependencies', 'unknown']]) {
    const ref = header[field]
    if (!ref?.length) continue
    if (ref.offset < 0 || ref.offset + ref.length > binary.length) throw new Error('Invalid Turbopack adjacency bounds')
    const block = binary.subarray(ref.offset, ref.offset + ref.length)
    const count = get(0, block)
    if (count > header.modules.length || 4 + count * 4 > block.length) throw new Error('Invalid Turbopack adjacency count')
    let previous = 0
    for (let from = 0; from < count; from++) {
      const end = get(4 + from * 4, block)
      if (end < previous || 4 + count * 4 + end * 4 > block.length) throw new Error('Invalid Turbopack adjacency range')
      for (let j = previous; j < end; j++) {
        const to = get(4 + count * 4 + j * 4, block)
        if (to >= header.modules.length) throw new Error('Invalid Turbopack dependency index')
        if (ids.has(String(from)) && ids.has(String(to))) edges.push({from: String(from), to: String(to), kind})
      }
      previous = end
    }
  }
  if (!modules.some((m) => m.entry)) {
    const targets = new Set(edges.map((e) => e.to))
    for (const mod of modules) mod.entry = !targets.has(mod.id)
  }
  return {schemaVersion: 1, bundler: 'turbopack', modules, edges, warnings: ['Turbopack analyzer graphs are experimental and produced separately from the application build. Keep both from the same source revision.']}
}
