// Recover module boundaries from map-less webpack and Turbopack chunks as synthetic source maps.
// Each module factory becomes one source; chunk wrappers stay unmapped.
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {parse} from '@babel/parser'

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

// webpack: `(self.webpackChunkX = self.webpackChunkX || []).push([[chunkIds], {id: factory} | [factory]])`
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
        modules.push({id: String(id.value), start: id.start, end: factory.end})
      }
      return {global, modules}
    }
    const modules = elements?.[1]
    if (!/^webpackChunk/.test(global ?? '') || !modules) continue
    const entries = modules.type === 'ObjectExpression'
      ? modules.properties.filter((p) => p.type === 'ObjectProperty').map((p) => [String(p.key.value ?? p.key.name), p])
      : modules.type === 'ArrayExpression' ? modules.elements.map((e, i) => e && [String(i), e]).filter(Boolean) : []
    return {global, modules: entries.map(([id, node]) => ({id, start: node.start, end: node.end}))}
  }
  return null
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
export async function inferModules({dir, out, mapsJson = [], chunks = false}) {
  if (!dir || !out) throw new Error('Usage: coldpath modules --dir DIRECTORY --out MAP_DIRECTORY [--maps-json maps.json]... [--chunks]')
  dir = resolve(dir)
  out = resolve(out)
  const mapped = new Set()
  for (const file of mapsJson) {
    for (const [bundle, map] of Object.entries(JSON.parse(await readFile(file, 'utf8')))) {
      if (JSON.parse(await readFile(resolve(dirname(file), map), 'utf8')).sources?.length) mapped.add(bundle)
    }
  }
  const bindings = {}
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
  console.log(`Recovered ${modules} modules in ${Object.keys(bindings).length - wholeChunks} chunks` +
    (chunks ? `, ${wholeChunks} whole-chunk sources` : '') + ` -> ${join(out, 'maps.json')}`)
  return bindings
}
