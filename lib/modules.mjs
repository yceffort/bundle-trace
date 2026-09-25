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

export function moduleMap(code, {global, modules}) {
  const lineStarts = [0]
  for (const match of code.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length)
  const position = (offset) => {
    const line = lineStarts.findLastIndex((start) => start <= offset)
    return [line, offset - lineStarts[line]]
  }
  const sources = [], sourcesContent = [], points = []
  for (const {id, start, end} of modules) {
    const index = sources.push(`webpack://inferred/${global}/${id}.js`) - 1
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

export async function inferModules({dir, out}) {
  if (!dir || !out) throw new Error('Usage: coldpath modules --dir DIRECTORY --out MAP_DIRECTORY')
  dir = resolve(dir)
  out = resolve(out)
  const bindings = {}
  let modules = 0
  for (const file of await scripts(dir)) {
    const code = await readFile(file, 'utf8')
    const found = chunkModules(code)
    if (!found?.modules.length) continue
    const path = relative(dir, file).split(sep).join('/')
    const mapFile = join(out, path + '.map')
    await mkdir(dirname(mapFile), {recursive: true})
    await writeFile(mapFile, JSON.stringify(moduleMap(code, found)))
    bindings[path] = relative(out, mapFile).split(sep).join('/')
    modules += found.modules.length
  }
  await writeFile(join(out, 'maps.json'), JSON.stringify(bindings, null, 2) + '\n')
  console.log(`Recovered ${modules} modules in ${Object.keys(bindings).length} chunks -> ${join(out, 'maps.json')}`)
  return bindings
}
