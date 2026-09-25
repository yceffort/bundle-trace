// Ask a language model what report sources are. Identity guesses are inferred, never attribution evidence:
// every evidence string must occur in the source and be rare across all sources, or the guess is dropped.
import {readFile, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const KINDS = ['package', 'app', 'polyfill', 'data', 'unknown']

const describeSchema = (lang) => ({
  type: 'object',
  properties: {summary: {type: 'string', description: `${lang}, 1-2 sentences: what this code does or contains, stated from the code itself`}},
  required: ['summary'],
  additionalProperties: false,
})

const identifySchema = (lang) => ({
  type: 'object',
  properties: {
    summary: describeSchema(lang).properties.summary,
    name: {type: 'string', description: 'npm package with entry point if known (e.g. react-dom/client), or a one-line description of app code'},
    shortName: {type: 'string', description: 'kebab-case label of at most 3 words, e.g. react-dom-client, market-calendar'},
    kind: {type: 'string', enum: KINDS},
    reasoning: {type: 'string', description: `${lang}, 1-2 sentences: why these clues point to this name`},
    evidence: {type: 'array', items: {type: 'string'}, description: 'exact substrings copied from the module input that support the guess'},
  },
  required: ['summary', 'name', 'shortName', 'kind', 'reasoning', 'evidence'],
  additionalProperties: false,
})

// A whole chunk usually bundles several things, so it gets a list of parts instead of one name.
const chunkSchema = (lang) => ({
  type: 'object',
  properties: {
    summary: describeSchema(lang).properties.summary,
    shortName: {type: 'string', description: 'kebab-case label of at most 3 words for the chunk as a whole, e.g. vendor-charts'},
    reasoning: identifySchema(lang).properties.reasoning,
    contents: {type: 'array', description: 'packages or app features the chunk appears to contain, largest first', items: {
      type: 'object',
      properties: {
        name: identifySchema(lang).properties.name,
        kind: {type: 'string', enum: KINDS},
        evidence: identifySchema(lang).properties.evidence,
      },
      required: ['name', 'kind', 'evidence'],
      additionalProperties: false,
    }},
  },
  required: ['summary', 'shortName', 'reasoning', 'contents'],
  additionalProperties: false,
})

const SYSTEM = {
  identify: `You identify modules in a minified production JavaScript bundle that has no source maps.
Given a digest of one module, say what it most likely is: a specific npm package (and entry point if you can tell), app code (describe its feature in a few words), a polyfill, or a data table.
Within a package family, name the specific package or entry point (react vs react-dom vs react-dom/client vs scheduler) using APIs or messages only that entry point contains.
Copy evidence strings exactly from the input. They are checked mechanically: strings absent from the module, or common across many modules (like "use strict"), are discarded, and a guess with no distinctive evidence is rejected.
Say "unknown" rather than guessing a package name you cannot support.`,
  chunk: `You identify what one whole chunk of a minified production JavaScript bundle contains. The bundler merged its modules into one scope, so there are no module boundaries.
From a digest of the chunk, list the npm packages (with entry points if you can tell), app features, polyfills, or data tables it appears to contain, largest first, each with its own evidence.
Copy evidence strings exactly from the input. They are checked mechanically: strings absent from the chunk, or common across many sources (like "use strict"), are discarded, and a part with no distinctive evidence is dropped.
Leave out anything you cannot support rather than guessing.`,
  describe: `You summarize one module of a JavaScript bundle from a digest of its strings, property keys and first characters. Describe what the code does or contains; do not guess its package name.`,
}

function valid(value, rule) {
  if (rule.type === 'object') {
    return typeof value === 'object' && value !== null && rule.required.every((key) => valid(value[key], rule.properties[key]))
  }
  if (rule.type === 'array') return Array.isArray(value) && value.every((item) => valid(item, rule.items))
  return typeof value === 'string' && (!rule.enum || rule.enum.includes(value))
}

// Limits grow with size (80 strings and 60 keys up to 40 KB, at most 400 and 300); samples spread over the whole text.
function digest(code) {
  const scale = Math.min(5, Math.max(1, code.length / 40000))
  const spread = (items, limit) => {
    const unique = [...new Set(items)]
    return unique.length <= limit ? unique : Array.from({length: limit}, (_, i) => unique[Math.floor((i * unique.length) / limit)])
  }
  return {
    head: code.slice(0, 600),
    strings: spread([...code.matchAll(/(["'`])((?:(?!\1)[^\\\n]){4,80})\1/g)].map((m) => m[2]).filter((s) => /[A-Za-z]{3}/.test(s)), Math.round(80 * scale)),
    keys: spread([...code.matchAll(/[{,]([A-Za-z_$][\w$]{3,40}):/g)].map((m) => m[1]), Math.round(60 * scale)),
  }
}

async function anthropicClient() {
  for (const base of [import.meta.url, pathToFileURL(resolve('package.json')).href]) {
    try {
      const sdk = await import(pathToFileURL(createRequire(base).resolve('@anthropic-ai/sdk')).href)
      const Anthropic = sdk.default?.default ?? sdk.default
      return new Anthropic()
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error('--provider anthropic requires the Anthropic SDK: npm install --save-dev @anthropic-ai/sdk')
}

export async function label({report, out, top = 50, mode = 'identify', provider = 'anthropic', model, baseUrl, lang = 'English', concurrency = 5}) {
  if (!report || !out || !['identify', 'describe'].includes(mode) || !['anthropic', 'openai'].includes(provider)) {
    throw new Error('Usage: coldpath label --report report.json --out labels.json [--mode identify|describe] [--provider anthropic|openai] [--model NAME] [--base-url URL] [--top N] [--lang LANGUAGE]')
  }
  model ??= provider === 'anthropic' ? 'claude-haiku-4-5' : undefined
  if (!model) throw new Error('--provider openai requires --model')
  const data = JSON.parse(await readFile(report, 'utf8'))
  const contents = new Map()
  for (const bundle of data.bundles) for (const source of bundle.sources) if (source.content) contents.set(source.source, source.content)
  if (!contents.size) throw new Error('the report has no source content: generate it with --details')
  const all = [...contents.values()]
  const maxDocFreq = Math.max(3, Math.ceil(all.length * 0.005))
  const docFreq = (text) => all.reduce((count, code) => count + code.includes(text), 0)
  // Identity is only guessed for modules recovered by `coldpath modules`; describe works on any source.
  const targets = data.sources
    .filter((row) => contents.has(row.source) && (mode === 'describe' || row.source.startsWith('webpack://inferred/')))
    .sort((a, b) => b.unobservedBytes - a.unobservedBytes || b.bytes - a.bytes)
    .slice(0, Number(top))

  const schemas = {identify: identifySchema(lang), chunk: chunkSchema(lang), describe: describeSchema(lang)}
  const usage = {input: 0, output: 0}
  const client = provider === 'anthropic' ? await anthropicClient() : null
  async function ask(content, task) {
    const schema = schemas[task]
    let text
    if (client) {
      const response = await client.messages.create({
        model, max_tokens: task === 'chunk' ? 2048 : 1024, system: SYSTEM[task], messages: [{role: 'user', content}],
        output_config: {format: {type: 'json_schema', schema}},
      })
      usage.input += response.usage.input_tokens
      usage.output += response.usage.output_tokens
      text = response.content.find((block) => block.type === 'text')?.text
    } else {
      const key = process.env.COLDPATH_LABEL_API_KEY ?? process.env.OPENAI_API_KEY
      const response = await fetch(`${baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...(key && {authorization: `Bearer ${key}`})},
        body: JSON.stringify({model, messages: [{role: 'system', content: SYSTEM[task]}, {role: 'user', content}],
          response_format: {type: 'json_schema', json_schema: {name: 'label', strict: true, schema}}}),
      })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      const json = await response.json()
      usage.input += json.usage?.prompt_tokens ?? 0
      usage.output += json.usage?.completion_tokens ?? 0
      text = json.choices?.[0]?.message?.content
    }
    try {
      const value = JSON.parse(text)
      return valid(value, schema) ? value : null
    } catch {
      return null
    }
  }

  const sources = {}
  let rejected = 0, failed = 0
  const queue = [...targets]
  await Promise.all(Array.from({length: concurrency}, async () => {
    for (let row; (row = queue.shift());) {
      const code = contents.get(row.source)
      const task = mode === 'describe' ? 'describe' : row.source.startsWith('webpack://inferred/chunk/') ? 'chunk' : 'identify'
      const answer = await ask(JSON.stringify({source: row.source, bytes: row.bytes, ...digest(code)}), task)
      if (!answer) {
        failed++
        console.error(`${row.source}: no valid answer`)
        continue
      }
      if (mode === 'describe') {
        sources[row.source] = {summary: answer.summary}
        continue
      }
      const distinctive = (list) => list.filter((text) => text.length >= 6 && code.includes(text) && docFreq(text) <= maxDocFreq)
      if (task === 'chunk') {
        const contents = answer.contents.filter((part) => part.kind !== 'unknown')
          .map((part) => ({...part, evidence: distinctive(part.evidence)})).filter((part) => part.evidence.length)
        if (!contents.length) {
          rejected++
          sources[row.source] = {summary: answer.summary}
          console.error(`${row.source}: rejected all ${answer.contents.length} guessed parts (no distinctive evidence)`)
          continue
        }
        sources[row.source] = {shortName: answer.shortName, summary: answer.summary, reasoning: answer.reasoning, contents}
        continue
      }
      const evidence = distinctive(answer.evidence)
      if (!evidence.length || answer.kind === 'unknown') {
        rejected++
        sources[row.source] = {summary: answer.summary}
        console.error(`${row.source}: rejected guess ${JSON.stringify(answer.name)} (no distinctive evidence)`)
        continue
      }
      sources[row.source] = {name: answer.name, shortName: answer.shortName, kind: answer.kind, summary: answer.summary, reasoning: answer.reasoning, evidence}
    }
  }))
  await writeFile(out, JSON.stringify({schemaVersion: 1, generator: {provider, model, mode}, sources}, null, 2) + '\n')
  console.log(`Labeled ${Object.keys(sources).length}/${targets.length} sources (${rejected} identity guesses rejected, ${failed} failed); ` +
    `tokens in ${usage.input}, out ${usage.output} -> ${out}`)
}
