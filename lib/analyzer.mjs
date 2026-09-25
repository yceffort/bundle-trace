import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'

const executable = process.platform === 'win32' ? 'bundle-trace.exe' : 'bundle-trace'

// COLDPATH_ANALYZER, then the platform package, then bundle-trace on PATH.
export function analyzerPath() {
  if (process.env.COLDPATH_ANALYZER) return process.env.COLDPATH_ANALYZER
  try {
    const manifest = createRequire(import.meta.url).resolve(`coldpath-${process.platform}-${process.arch}/package.json`)
    const candidate = join(dirname(manifest), 'bin', executable)
    if (existsSync(candidate)) return candidate
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  return executable
}

export function runAnalyzer(args) {
  const binary = analyzerPath()
  const result = spawnSync(binary, args, {stdio: 'inherit'})
  if (result.error?.code === 'ENOENT') {
    throw new Error(`Rust analyzer not found (${binary}). Install coldpath-${process.platform}-${process.arch}, set COLDPATH_ANALYZER, or put bundle-trace on PATH.`)
  }
  if (result.error) throw result.error
  return result.status ?? 1
}
