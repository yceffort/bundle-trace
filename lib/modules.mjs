// Recover module boundaries from map-less webpack and Turbopack chunks as synthetic source maps.
// Each module factory body becomes one source; chunk wrappers and factory headers (`id:(e,t,n)=>`) stay unmapped,
// because V8 counts a header as observed when its chunk runs even if the factory is never called.
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {parse} from '@babel/parser'
import {sha256} from './graph.mjs'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const vlq = (value) => {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1, out = ''
  do {
    let digit = rest & 31
    rest >>>= 5
    if (rest) digit |= 32
    out += B64[digit]
  } while (rest)
  return out
}

async function scripts(dir) {
  const files = []
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await scripts(path))
    else if (/\.(m|c)?js$/.test(entry.name)) files.push(path)
  }
  return files
}

// webpack: `(self.webpackChunkX = self.webpackChunkX || []).push([[chunkIds], {id: factory} | [factory]])`; webpack 4 uses `this.webpackJsonp`
// Turbopack: `(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([currentScript, id, factory, id, factory, ...])`
export function chunkModules(code) {
  let ast
  try {
    ast = parse(code, {sourceType: 'script', errorRecovery: true})
  } catch {
    return null
  }
  for (const statement of ast.program.body) {
    const call = statement.expression
    if (call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.property.name !== 'push') continue
    let target = call.callee.object
    if (target.type === 'LogicalExpression') target = target.left
    if (target.type === 'AssignmentExpression') target = target.left
    const global = target.type === 'MemberExpression' ? target.property.name : target.name
    const elements = call.arguments[0]?.elements
    if (global === 'TURBOPACK' && elements) {
      const modules = []
      for (let i = 1; i + 1 < elements.length; i += 2) {
        const [id, factory] = [elements[i], elements[i + 1]]
        if (!['NumericLiteral', 'StringLiteral'].includes(id?.type) || !/Function/.test(factory?.type)) return null
        modules.push({id: String(id.value), start: factory.body.start, end: factory.end, factory})
      }
      return {global, modules}
    }
    const modules = elements?.[1]
    if (!/^webpack(Chunk|Jsonp)/.test(global ?? '') || !modules) continue
    const entries = modules.type === 'ObjectExpression'
      ? modules.properties.filter((p) => p.type === 'ObjectProperty').map((p) => [String(p.key.value ?? p.key.name), p])
      : modules.type === 'ArrayExpression' ? modules.elements.map((e, i) => e && [String(i), e]).filter(Boolean) : []
    return {global, modules: entries.map(([id, node]) => {
      const factory = node.type === 'ObjectProperty' ? node.value : node
      return /Function/.test(factory.type)
        ? {id, start: factory.body.start, end: factory.end, factory}
        : {id, start: node.start, end: node.end}
    })}
  }
  return null
}

const isFunction = (node) => /Function|Method/.test(node.type) && node.params
const literalId = (node) => ['NumericLiteral', 'StringLiteral'].includes(node?.type) ? String(node.value) : null
const children = (node) => Object.entries(node).filter(([key]) => !['loc', 'start', 'end', 'extra', 'comments'].includes(key))
  .flatMap(([, value]) => Array.isArray(value) ? value : [value]).filter((value) => value && typeof value.type === 'string')

function bindingNames(pattern, names) {
  if (!pattern) return names
  if (pattern.type === 'Identifier') names.add(pattern.name)
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((p) => bindingNames(p.type === 'RestElement' ? p.argument : p.value, names))
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e) => bindingNames(e, names))
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, names)
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, names)
  return names
}

// Every name a function binds anywhere inside it. Over-approximating only drops edges, never invents them.
function declaresName(fn, name) {
  const names = new Set()
  const visit = (node) => {
    if (isFunction(node)) node.params.forEach((p) => bindingNames(p, names))
    if (node.type === 'VariableDeclarator') bindingNames(node.id, names)
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) names.add(node.id.name)
    if (node.type === 'CatchClause') bindingNames(node.param, names)
    children(node).forEach(visit)
  }
  visit(fn)
  return names.has(name)
}

// Literal module ids a factory loads through its own require binding. Nested functions that rebind that name,
// such as a browserify bundle inside a module, are skipped. Offsets are UTF-16 offsets into the chunk.
// webpack: `n(id)` (a static import or a require, indistinguishable after compilation), `n.bind(n, id)` and `n.t.bind(n, id, mode)`
// after `n.e(chunk)` (dynamic). Turbopack: `e.i(id)` (ESM import), `e.r(id)` (require), `e.A(id)` and the loader's
// `e.v(t => ...t(id))` (dynamic).
export function factoryEdges(factory, bundler) {
  const turbopack = bundler === 'turbopack'
  const param = factory.params[turbopack ? 0 : 2]
  if (param?.type !== 'Identifier') return []
  const name = param.name
  const edges = []
  const isName = (node) => node?.type === 'Identifier' && node.name === name
  const visit = (node, loaders) => {
    if (node !== factory && isFunction(node) && declaresName(node, name)) return
    if (node.type === 'CallExpression') {
      const {callee, arguments: args} = node
      let id = null, kind
      if (!turbopack && isName(callee)) [id, kind] = [literalId(args[0]), 'unknown']
      else if (!turbopack && callee.type === 'MemberExpression' && callee.property.name === 'bind' && isName(args[0]) &&
        (isName(callee.object) || (callee.object.type === 'MemberExpression' && isName(callee.object.object) && callee.object.property.name === 't'))) {
        [id, kind] = [literalId(args[1]), 'dynamic']
      } else if (turbopack && callee.type === 'MemberExpression' && isName(callee.object)) {
        kind = {i: 'static', r: 'require', A: 'dynamic'}[callee.property.name]
        if (kind) id = literalId(args[0])
        if (callee.property.name === 'v' && isFunction(args[0] ?? {}) && args[0].params[0]?.type === 'Identifier') {
          loaders = new Set([...loaders, args[0].params[0].name])
        }
      } else if (callee.type === 'Identifier' && loaders.has(callee.name)) [id, kind] = [literalId(args[0]), 'dynamic']
      if (id !== null) edges.push({id, kind, offset: node.start})
    }
    children(node).forEach((child) => visit(child, loaders))
  }
  visit(factory, new Set())
  return edges
}

// `ranges`: [{source, start, end}] in UTF-16 offsets; each range becomes one source.
export function moduleMap(code, ranges) {
  const lineStarts = [0]
  for (const match of code.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length)
  const position = (offset) => {
    const line = lineStarts.findLastIndex((start) => start <= offset)
    return [line, offset - lineStarts[line]]
  }
  const sources = [], sourcesContent = [], points = []
  for (const {source, start, end} of ranges) {
    const index = sources.push(source) - 1
    sourcesContent.push(code.slice(start, end))
    const [first] = position(start)
    points.push([start, index, 0])
    for (let line = first + 1; line < lineStarts.length && lineStarts[line] < end; line++) points.push([lineStarts[line], index, line - first])
    points.push([end, null])
  }
  let line = 0, column = 0, source = 0, originalLine = 0, mappings = '', first = true
  for (const [offset, index, original] of points) {
    const [l, c] = position(offset)
    for (; line < l; line++, column = 0, first = true) mappings += ';'
    mappings += (first ? '' : ',') + vlq(c - column)
    first = false
    column = c
    if (index === null) continue
    mappings += vlq(index - source) + vlq(original - originalLine) + 'A'
    source = index
    originalLine = original
  }
  return {version: 3, sources, sourcesContent, names: [], mappings}
}

// `mapsJson`: existing bindings (such as snapshot's maps.json); scripts bound to a map with sources are left alone.
// `chunks`: a script without recognizable modules becomes one whole-chunk source instead of staying unmapped.
// `graph`: also write a dependency graph (docs/graphs.md format) whose edges are the factories' literal require calls.
export async function inferModules({dir, out, mapsJson = [], chunks = false, graph}) {
  if (!dir || !out) throw new Error('Usage: coldpath modules --dir DIRECTORY --out MAP_DIRECTORY [--maps-json maps.json]... [--chunks] [--graph FILE]')
  dir = resolve(dir)
  out = resolve(out)
  const mapped = new Set()
  for (const file of mapsJson) {
    for (const [bundle, map] of Object.entries(JSON.parse(await readFile(file, 'utf8')))) {
      if (JSON.parse(await readFile(resolve(dirname(file), map), 'utf8')).sources?.length) mapped.add(bundle)
    }
  }
  const bindings = {}
  const factories = new Map()
  let modules = 0, wholeChunks = 0
  for (const file of await scripts(dir)) {
    const path = relative(dir, file).split(sep).join('/')
    if (mapped.has(path)) continue
    const code = await readFile(file, 'utf8')
    const found = chunkModules(code)
    let ranges
    if (found?.modules.length) {
      ranges = found.modules.map(({id, start, end}) => ({source: `webpack://inferred/${found.global}/${id}.js`, start, end}))
      modules += ranges.length
      const bundler = found.global === 'TURBOPACK' ? 'turbopack' : 'webpack'
      for (const {id, start, end, factory} of found.modules) {
        const key = `${found.global}/${id}`
        if (!factories.has(key)) factories.set(key, {global: found.global, copies: []})
        factories.get(key).copies.push({content: code.slice(start, end),
          edges: factory ? factoryEdges(factory, bundler).map((edge) => ({...edge, offset: edge.offset - start})) : []})
      }
    } else if (chunks && code) {
      ranges = [{source: `webpack://inferred/chunk/${path}`, start: 0, end: code.length}]
      wholeChunks++
    } else continue
    const mapFile = join(out, path + '.map')
    await mkdir(dirname(mapFile), {recursive: true})
    await writeFile(mapFile, JSON.stringify(moduleMap(code, ranges)))
    bindings[path] = relative(out, mapFile).split(sep).join('/')
  }
  await writeFile(join(out, 'maps.json'), JSON.stringify(bindings, null, 2) + '\n')
  if (graph) await writeFile(resolve(graph), JSON.stringify(recoveredGraph(factories), null, 2) + '\n')
  console.log(`Recovered ${modules} modules in ${Object.keys(bindings).length - wholeChunks} chunks` +
    (chunks ? `, ${wholeChunks} whole-chunk sources` : '') + ` -> ${join(out, 'maps.json')}` + (graph ? `, ${resolve(graph)}` : ''))
  return bindings
}

const location = (text, offset) => {
  const before = text.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/)
  return {line: before.length, column: before.at(-1).length + 1}
}

// Module ids resolve only within one chunk global. A module shipped in several chunks becomes one graph module;
// its locations and hash are kept only when every copy has the same text.
function recoveredGraph(factories) {
  const modules = [], edges = [], incoming = new Set()
  let self = 0, unresolved = 0
  for (const [key, {global, copies}] of factories) {
    const same = copies.every((copy) => copy.content === copies[0].content)
    modules.push({id: key, source: `${key}.js`, ...(same && {sourceSha256: sha256(copies[0].content)})})
    const seen = new Set()
    for (const copy of same ? copies.slice(0, 1) : copies) {
      for (const {id, kind, offset} of copy.edges) {
        const to = `${global}/${id}`
        if (to === key) { self++; continue }
        if (!factories.has(to)) { unresolved++; continue }
        if (seen.has(to + kind)) continue
        seen.add(to + kind)
        incoming.add(to)
        edges.push({from: key, to, kind, ...(same && {location: location(copy.content, offset), locationEvidence: 'recovered-factory'})})
      }
    }
  }
  for (const module of modules) if (!incoming.has(module.id)) module.entry = true
  return {schemaVersion: 1, bundler: 'recovered', modules, edges, warnings: [
    'Graph recovered from minified module factories, not exported by a bundler: edges are literal module ids passed to each factory\'s require binding, ' +
    'and entries are modules that no recovered factory loads.',
    unresolved && `${unresolved} require calls named ids without a recovered factory (runtime modules, chunks not captured, or nested bundles) and were left out.`,
    self && `${self} self references were left out.`,
  ].filter(Boolean)}
}
