# Analyzing a site you do not build

When you cannot build a site yourself, you usually have no source maps, no bundler graph, and no local copy of its scripts. Three commands fill part of that gap. Each one records its own kind of evidence, and the report keeps those kinds separate.

| Command | Produces | Kind of evidence |
| --- | --- | --- |
| `coldpath snapshot` | served scripts, their V8 coverage, and what caused each script to load | measured in Chromium |
| `coldpath modules` | one synthetic source per webpack module factory | recovered from the bundle's own structure |
| `coldpath label` | a summary of each source and, for recovered modules, a guessed identity | a language model's inference |

```sh
npm install --save-dev playwright @anthropic-ai/sdk
npx playwright install chromium

coldpath snapshot --url https://example.com/ --out artifacts/site
coldpath modules --dir artifacts/site/files --out artifacts/site/modules --maps-json artifacts/site/maps.json --chunks
coldpath analyze --dir artifacts/site/files --coverage artifacts/site/coverage.json --url-prefix https:// \
  --maps-json artifacts/site/maps.json --maps-json artifacts/site/modules/maps.json \
  --loading artifacts/site/loading.json --details --json artifacts/site/report.json
coldpath label --report artifacts/site/report.json --out artifacts/site/labels.json
coldpath analyze --dir artifacts/site/files --coverage artifacts/site/coverage.json --url-prefix https:// \
  --maps-json artifacts/site/maps.json --maps-json artifacts/site/modules/maps.json \
  --loading artifacts/site/loading.json --labels artifacts/site/labels.json --details --treemap artifacts/site/report.html
```

Use `--url-prefix http://` for plain HTTP sites. Both prefixes may be passed.

## snapshot

`coldpath snapshot --url URL --out DIRECTORY [--wait-ms N] [--actions FILE]` loads the page once in Chromium with precise V8 coverage, waits for `load` plus `--wait-ms` (default 5,000), runs an optional action module (the same `{page, context}` interface as [`collect`](collecting.md#custom-interactions)), and writes:

- `files/<host>/<path>`: the exact text of every external `.js`, `.mjs`, and `.cjs` script. Coverage is Playwright-format with source text, so the analyzer compares each file with what was recorded.
- `coverage.json`: the recording. Inline scripts are left out.
- `maps.json`: explicit map bindings for scripts that declare a `sourceMappingURL`. A map the snapshot could fetch is saved at its own URL path under `files/`, so relative source paths inside it resolve as they would on the site. A declared map that could not be fetched is bound to an empty map under `maps/`, so the analyzer treats the script as unmapped instead of failing. The analyzer itself never fetches.
- `loading.json`: why each script loaded (see below).

Unlike `collect`, `snapshot` does not block cross-origin requests and has no local build to check against: the saved text is the only evidence of what ran. Keep the snapshot directory together; a later visit may serve different files.

### Load causes

| `load` | Meaning |
| --- | --- |
| `html` | The initial HTML document references the URL in a `<script src>` or `<link href>` tag. |
| `inline` | No tag references it, but its file name appears elsewhere in the initial HTML, for example in a Next.js RSC payload or an inline loader snippet. This is a text match. |
| `dynamic` | Neither: other scripts requested it at runtime (dynamic `import()`, injected tags). |

Each entry also records the Chrome DevTools Protocol `initiator` type and `startMs`, the request start relative to the first request of the visit. A load cause says what requested a script, not whether it was needed for the first render.

## modules

`coldpath modules --dir DIRECTORY --out MAP_DIRECTORY` parses every script with `@babel/parser` and looks for chunk registrations with one function per module:

- webpack: `(self.webpackChunk<name> = ...).push([[chunk ids], {id: factory}])`, including the array form `[factory, ...]`.
- Turbopack: `(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([currentScript, id, factory, id, factory, ...])`. Checked against the Next.js version pinned in the accuracy corpus; other Turbopack versions may use another layout.

For each chunk it writes a source map in which every module, from its id to the end of its factory, becomes the source `webpack://inferred/<chunk global>/<module id>.js` with that text as `sourcesContent`.

With `--chunks`, a script without recognizable modules (for example Rollup or Vite output) becomes a single source, `webpack://inferred/chunk/<bundle path>`, holding the whole file. That gives `label` something to read; it recovers no boundaries.

`--maps-json` takes existing bindings such as the snapshot's `maps.json`. Scripts bound to a map that has sources are skipped, so a real map is never replaced by a recovered one. Scripts bound to an empty map are treated as unmapped. Chunk wrappers stay unmapped. `maps.json` lists the bindings; pass it after the snapshot's `maps.json` so recovered maps override the empty ones (later `--maps-json` files win).

Limitations:

- Only webpack and Turbopack chunk registrations are recognized. Rollup, Vite, and esbuild hoist modules into one scope per chunk, so their output keeps no module boundaries to recover; `--chunks` can only treat such a chunk as a whole.
- A factory is the smallest unit. Module concatenation (webpack) and scope hoisting merge many original modules into one factory, and those cannot be separated.
- As with any source map, line terminators and the text between factories are unmapped.
- Coverage counts the factory's `id:(e,t,n)=>` header as observed when its chunk ran, even if the factory itself was never called. A factory whose observed bytes equal that header never executed.
- Module ids name modules only within one webpack runtime. Sources are grouped by chunk global so that two runtimes on the same page do not collide.

## label

`coldpath label --report report.json --out labels.json` reads a report generated with `--details` and asks a language model about the sources with the most unobserved bytes (`--top`, default 50). The model sees a digest of each source: its first 600 characters plus string literals and property keys sampled evenly across the whole text. The limits are 80 strings and 60 keys up to 40,000 characters and grow with size to at most 400 and 300, so a large chunk is still only sampled. **This sends code to the model provider.** Do not use it on code you may not share.

- `--mode identify` (default) handles only recovered `webpack://inferred/` sources. For a module it asks for a `summary` of what the code does, plus a guessed `name`, `shortName`, `kind` (`package`, `app`, `polyfill`, `data`, or `unknown`), `reasoning`, and `evidence`. For a whole chunk (`webpack://inferred/chunk/`) it asks for a `summary`, `shortName`, `reasoning`, and `contents`: a list of parts, each with its own `name`, `kind`, and `evidence`.
- `--mode describe` handles every source with content and asks only for a `summary`. Use it on your own source-mapped builds. Scripts without source content (unmapped, or with maps that lack `sourcesContent`) cannot be described.
- `--lang` sets the language of summaries and reasoning (default English).

Identity guesses are checked mechanically. An evidence string is kept only if it has at least 6 characters, occurs in the source, and occurs in no more than `max(3, 0.5%)` of all sources in the report, which rejects boilerplate such as `"use strict"`. A guess with no remaining evidence, or with kind `unknown`, is discarded and only its summary is kept. For a chunk, each part is checked on its own: parts without evidence are dropped, and if none remain only the summary is kept. The analyzer checks evidence again against the source content when it attaches labels. None of this makes a guess correct: several strings can be distinctive and still point to the wrong package, and the model's summaries are not verified.

Providers:

| `--provider` | Endpoint | Credentials |
| --- | --- | --- |
| `anthropic` (default, model `claude-haiku-4-5`) | Anthropic Messages API with a JSON schema output format | the Anthropic SDK's usual sources, for example `ANTHROPIC_API_KEY`; requires `@anthropic-ai/sdk` |
| `openai` | any OpenAI-compatible `POST {--base-url}/chat/completions` with a strict JSON schema `response_format` (OpenAI by default; also local servers such as Ollama or LM Studio) | `COLDPATH_LABEL_API_KEY` or `OPENAI_API_KEY` as a bearer token, if set |

`--model` is required for `openai`. Servers that do not honor strict JSON schemas may return answers that fail validation; those sources are reported and skipped. The command prints token usage.

## Report fields

`--labels FILE` attaches `label` (including `contents` for whole chunks) to `sources[]` and `bundles[].sources[]` and records `labelGenerator` (`provider`, `model`, `mode`). `--loading FILE` attaches `loading` (`load`, `initiator`, `startMs`) to `bundles[]`. Neither changes any byte count, budget, or recommendation. Entries that match nothing produce warnings; unknown fields and unknown `load` values are errors.

```json
{"schemaVersion": 1, "generator": {"provider": "anthropic", "model": "claude-haiku-4-5", "mode": "identify"},
 "sources": {"webpack://inferred/webpackChunk_N_E/94337.js": {"name": "asn1.js", "shortName": "asn1-js", "kind": "package",
   "summary": "...", "reasoning": "...", "evidence": ["DecoderBuffer overrun"]}}}
```

```json
{"schemaVersion": 1, "bundles": {"cdn.example.com/app/main.js": {"load": "html", "initiator": "parser", "startMs": 83}}}
```

The treemap groups bundles by load cause when `--loading` is given, shows labeled sources as `≈ shortName (file)`, includes label names, part names, and summaries in search, and shows the summary, guessed identity or chunk contents, reasoning, and evidence on a source's page, marked as a model's guess.
