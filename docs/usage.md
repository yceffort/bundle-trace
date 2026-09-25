# Usage guide

Run `coldpath --help` for the complete CLI. All paths in the examples are relative to your current working directory.

## Files, globs, and output

```sh
coldpath dist/app.js --treemap artifacts/size.html
coldpath 'dist/**/*.js' --json artifacts/size.json --tsv artifacts/size.tsv
coldpath dist/app.js /path/to/custom.map --treemap artifacts/size.html
coldpath --dir dist --treemap artifacts/all.html
coldpath --dir dist 'dist/assets/*.js' --coverage chrome.json --url-prefix https://example.com/ --json artifacts/coverage.json
```

Use file/glob inputs to select bundles, or `--dir` alone to scan a directory recursively. Combine them to select bundles under a fixed analysis root. File/glob inputs remain relative to the current working directory, not to `--dir`. Quote globs to expand them consistently inside the CLI. Repeated files are deduplicated; unmatched patterns and unsupported file types fail. `.js`, `.mjs`, and `.cjs` are supported. A single JavaScript file can be followed by one explicit map; multiple adjacent `file.js.map` inputs pair with their JavaScript files. For other multi-file map bindings, use repeated `--map`.

`--dir` sets the analysis root, and selected JavaScript files must stay inside it (including after resolving symlinks). Without `--dir`, the common parent directory of the selected JavaScript files becomes the root. Report bundle paths, CLI/config include/exclude patterns, `--map` bundle keys, and coverage paths/URL suffixes are relative to that root. Pin the root with `--dir` to keep URL mappings and filter paths stable when changing the selection; budgets apply only to selected bundles that pass the filters. Automatically discovered maps must remain inside the root; explicitly supplied maps can be outside it.

With file/glob inputs, coverage for unselected files that exist inside the analysis root is skipped with a warning. Coverage paths missing from the root still fail, so a wrong URL prefix is not silently ignored. Selected files retain source/hash, map, and range verification; files absent from the recording remain unmeasured. To analyze only `dist/assets/app.js` from a recording containing `https://example.com/assets/*.js`, use `--dir dist dist/assets/app.js --url-prefix https://example.com/` with the coverage/output options.

File/glob input with no output option writes a compact `coldpath.html` to the current directory, replacing any existing file. After a successful default write, the CLI prints `Wrote coldpath.html`. No browser launches automatically. Use `-` as the output path for stdout, for example `--json -` or `--tsv -`; diagnostics then go to stderr. At most one output can target stdout. File outputs can be combined.

TSV aggregates contributions by original source across selected bundles. Columns are `Source`, `Bytes`, `Observed`, `Unobserved`, and `Unmeasured`. In source names, backslashes, tabs, CR, and LF are escaped as `\\`, `\t`, `\r`, and `\n` so each source occupies one row.

## Source maps

`--dir` without file/glob inputs recursively scans `.js`, `.mjs`, and `.cjs` files. The analyzer reads a final standalone `//# sourceMappingURL=...`, `//@ sourceMappingURL=...`, or `/*# sourceMappingURL=... */` comment, falling back to an adjacent `filename.js.map` when there is no reference. The map's filename does not need to match the JavaScript filename.

Supported map inputs include ordinary v3 maps, indexed maps with embedded sections, and base64 or percent-encoded `data:application/json` maps. `sourcesContent` is optional. Explicit overrides take precedence over comments:

```sh
coldpath --dir dist \
  --map chunks/app.js=/path/to/private/app.map \
  --html artifacts/report.html
```

Repeat `--map` as needed. Automatically discovered local maps must stay inside `--dir`; explicit bindings may refer outside it. The analyzer never fetches HTTP maps or external-URL indexed sections.

Source identities use the **analysis root**, not CWD. Relative `sources` (including `sourceRoot`) resolve against the actual map file's directory; inline data maps use the JavaScript file's directory. Paths are normalized lexically without reading original files. Thus `dist/a.js.map` → `../src/x.js` and `dist/sub/b.js.map` → `../../src/x.js` aggregate as one source: `src/x.js` with the project as root, or `../src/x.js` with `--dir dist`. Leading `..` remains for sources outside the root; the treemap groups these under “Outside analysis root”. URL namespaces such as `webpack://app/./src/x.js` retain their scheme and authority and remove only redundant `.` path components. Pin the same `--dir` convention for comparisons. Standalone attribution APIs without a map location retain the map's source names.

Files without maps remain `[unmapped]`. Explicitly missing maps, malformed maps, overlapping/out-of-order indexed sections, and unrecoverable ranges cause failure. Invalid individual mapping points (outside their generated line or inside a surrogate pair) are skipped with warnings. Empty sections and unmapped prefixes remain unmapped. When mappings share a generated coordinate, the last mapping wins. Conflicting `sourcesContent` for one source name causes an error when source details are requested.

## Coverage inputs

The format is detected automatically:

| Input                                           | JavaScript verification                                      | Map verification at capture time     |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| `schemaVersion: 1` envelope                     | Recorded SHA-256                                             | Recorded SHA-256 or explicit absence |
| Chrome export / Puppeteer `{url,text,ranges}[]` | Exact `text` comparison                                      | Unverified                           |
| Playwright `{url,source,functions}[]`           | Exact `source` comparison when provided                      | Unverified                           |
| CDP / `NODE_V8_COVERAGE` `{result:[...]}`       | Requires `--allow-unverified` when source evidence is absent | Unverified                           |

`--allow-unverified` permits missing evidence; it never overrides a provided source/hash mismatch. Attaching a current map to an older standard export does not establish which map existed during capture. Reports preserve the two verification states separately.

### URL mapping

```sh
coldpath --dir dist \
  --coverage playwright.json \
  --url-prefix https://example.com/assets/ \
  --html artifacts/report.html
```

Prefixes must end with `/`; the longest matching prefix wins. Query strings and fragments are removed and the path is percent-decoded. A `file://` URL referring to a file inside `--dir` is mapped automatically.

Use `--script-map paths.json` to map exact URLs, including queries:

```json
{
  "https://cdn.example.com/app?id=1": "chunks/app.js"
}
```

Explicit mappings take precedence over prefixes. Relative bundle paths cannot contain `..`, absolute paths, or backslashes. Unsupported URLs and CSS entries are skipped with warnings. Nonempty coverage with no mapped JavaScript fails.

### Node.js

```sh
NODE_V8_COVERAGE=artifacts/node-coverage node dist/server.js

# Replace the filename with the one Node generated.
coldpath --dir dist \
  --coverage artifacts/node-coverage/coverage-123.json \
  --allow-unverified --html artifacts/node.html
```

Raw V8 offsets alone cannot establish that the recording matches the local build. Keep build artifacts and recordings together. Pass multiple files using repeated `--coverage`, not a shell-expanded list after one flag.

### Hash-bound envelope

The optional collector emits this format:

```json
{
  "schemaVersion": 1,
  "scenario": "home",
  "scripts": [
    {
      "path": "chunks/app.js",
      "sha256": "SHA-256 of exact generated UTF-8 bytes",
      "sourceMapSha256": "SHA-256 of exact map bytes, or null if absent",
      "functions": [
        {
          "functionName": "",
          "isBlockCoverage": true,
          "ranges": [{"startOffset": 0, "endOffset": 100, "count": 1}]
        }
      ]
    }
  ]
}
```

`path` is relative to `--dir`; `sourceMapSha256` is JSON `null` when no map exists. A map that exists during analysis must have a matching recorded hash. Extra capture metadata is allowed.

Each recording resolves nested ranges before observations are unioned. Child ranges override their parents, including an executed child inside an unexecuted parent. Execution counts are not added together. Separate envelopes can contain repeated executions or `takePreciseCoverage` deltas; scripts absent from all recordings are unmeasured.

## Reports

```sh
coldpath --dir dist \
  --coverage initial.json --coverage interaction.json \
  --html artifacts/report.html \
  --json artifacts/summary.json \
  --markdown artifacts/summary.md
```

`--treemap file.html` provides a compact size/coverage explorer: bundle → folder → file navigation, breadcrumbs, package grouping, search, sorting, and a mapped-only view filter. Tile area uses generated bytes; colors show the three coverage states. Small files are still available in the table. It embeds only summary data, requires no decompression API, and follows the system color theme.

`--html file.html` provides the full code inspector: bundle/package search, source drilldown, code-range navigation, an optional size distribution, app-code and coverage-state filters, and system/light/dark themes. UI filters in either report do not change overall totals or budgets. Original-source highlights identify mapping anchors; generated-code colors represent observed, unobserved, and unmeasured byte ranges.

JSON uses `schemaVersion: 3`, reflecting normalized source identities. Regenerate older baselines; their raw source strings cannot reliably be compared with normalized identities. Summary output includes totals, bundles, source/package attribution, `bundles[].sources`, `scenarioReports`, the `sourcePaths` convention, warnings, and verification evidence. Add `--details` for `bundles[].spans`, `bundles[].scenarioSpans`, `generatedSource`, and embedded original code. Requesting HTML does not automatically make JSON detailed.

In detailed output, `spans[].source` indexes that bundle's `sources` array. `start/end` are half-open UTF-8 byte offsets; `startUtf16/endUtf16` are JavaScript string offsets. `original` identifies a zero-based source-map line/column anchor, not an original execution range. Sources without `sourcesContent` show positions only.

Inspector HTML stores details by chunk and decodes them on demand. Blocks larger than 16 KiB use gzip/base64 and require `DecompressionStream`. Code views render a window around the selected range; data remains complete even when the visible generated snippet is truncated. Both HTML reports work through `file://` and make no external network requests.

### Labels and load causes

A source mapped into more than one bundle has `sources[].duplicates`: `bundles` (how many bundles contain it) and `extraBytes` (the bytes of every copy except the largest). Copies can be minified differently, so their sizes may differ. Duplication is reported separately from coverage, since a copy can be both needed and executed, and it never changes totals or budgets. The treemap lists the largest duplicates under "Shipped in more than one file". `[unmapped]` is never a duplicate.

`--labels labels.json` attaches descriptions produced by `coldpath label` to `sources[].label` and `bundles[].sources[].label`, and records `labelGenerator`. `--loading loading.json` attaches `bundles[].loading` from `coldpath snapshot`. Labels are a language model's summaries and guesses, never attribution evidence; neither option changes counts or budgets. See [analyzing a site you do not build](third-party.md) for both file formats.

### Scenarios and execution phases

```sh
coldpath --dir dist \
  --coverage initial.json --coverage open-report.json \
  --initial-scenario initial \
  --treemap artifacts/scenarios.html --details \
  --json artifacts/scenarios.json --markdown artifacts/scenarios.md
```

Envelope recordings use their `scenario` field; standard exports use the input filename (for example `--initial-scenario initial.json`). Repeated recordings with the same name are unioned. Each `scenarioReports` entry contains separate totals, bundles (including their source counts), sources, and packages. Global totals continue to use the union across all recordings, without double counting. A script missing from a scenario is unmeasured in that scenario even when another scenario recorded it.

`--initial-scenario` computes each later scenario's `interactionCandidates`: `interactionOnlyBytes` is the byte-range difference between later execution and initial execution, restricted to scripts measured during initial. `initialUnmeasuredObservedBytes` separately records later execution where initial evidence is absent. Candidate ranges can overlap between later scenarios; do not sum them to obtain the union. A candidate can be part of a source that also executes during initial.

The treemap’s **First observed scenario** view gives each scenario a color, alongside never observed and unmeasured bytes. `bundles[].sources[].firstObserved` partitions observed bytes by the first recording in the declared order that executed each range. By default, order follows the first appearance of each name in the coverage inputs, with `--initial-scenario` moved first. Use `--scenario-order initial,open-report,search` to declare every scenario exactly once; initial must be first. This is an ordering of recordings, not inferred wall-clock execution time.

When an earlier scenario lacks a bundle recording, later observations have `earlierUnmeasured: true` and appear yellow: their earliest execution is unknown. The **Initial vs interactions** view and initial selector provide the simpler two-phase comparison. Coverage selection shows one scenario. These colors do not prove when scripts were downloaded or that a whole source can be deferred.

Click a source to see import chains, available line/column evidence, isolated compression estimates, and review actions. Add `--details --treemap` to open the code inspector inline. Its **Scenario** selector switches generated range colors and original mapping anchors between the union and each recording; treemap scenario selection carries into the inspector. `scenarioSpans` uses the same source indices and UTF-8/UTF-16 offsets as union spans. Missing recordings render unmeasured. Without `--details`, the compact treemap contains no code or interval payloads.

`recommendations` in JSON and Markdown distinguishes `defer-review` (known static chain, no initial execution), `split-review` (some initial execution), `dynamic-boundary-review`, `inspect-imports`, and `measure-initial`. `removal-review` requires no observed bytes and full measurement of that source in **every** supplied scenario. These are review suggestions, not automatic refactorings. Graph paths describe dependency edges, not runtime download causality. See [graph adapters](graphs.md).

### Compare a PR with a baseline

```sh
# Generate main.json on the base build using the same root and selection rules.
coldpath --dir dist --json artifacts/main.json

# Run on the PR build.
coldpath --dir dist --baseline artifacts/main.json \
  --max-added-bytes 10000 \
  --json artifacts/pr.json --markdown artifacts/pr.md --treemap artifacts/pr.html
```

`baseline` contains `totals`, `sources`, `packages`, `bundles`, and matching named `scenarios`. Each change has `name`, `change` (`added`, `removed`, `changed`, or `unchanged`), `before`, `after`, and signed `delta` counts. Removed sources have zero current counts and negative deltas. Sources aggregate across chunks, so changing a chunk hash or moving a source between chunks does not make it a new source. Bundle comparisons use exact bundle paths. JSON keeps every row; CLI and Markdown show leading changes. TSV continues to contain current source totals.

**Change from baseline** colors growth/reduction, outlines new sources, and lists removed sources below the table. Source deltas always describe that source across all selected bundles, even when a tile shows one bundle's contribution; folder colors indicate contained changes. Selecting a scenario shows its baseline comparison and unobserved-byte delta. Missing baseline scenarios are shown as unavailable, not zero. Different filters, scenario sets, or measurement coverage produce comparison warnings. Keep selection, capture procedures, scenario names, and root conventions consistent between builds.

`--max-added-bytes` limits net generated-byte growth. To budget initial unobserved-byte growth, pass `--baseline main.json --initial-scenario initial --max-added-unobserved-bytes 10000` together with the current coverage inputs. The same initial scenario must exist in the baseline. This budget fails if either initial scenario has unmeasured bytes; select the intended initial bundles consistently if later-loaded bundles lack initial measurements. A budget failure still writes all requested reports and exits `2`. Older schemas or incompatible byte/path metrics fail as input errors.

## Explorer MVP scope

The explorer supports JavaScript files/globs, hierarchical treemaps, source/package search, coverage coloring, JSON/TSV export, and offline HTML sharing. It does not implement source-map-explorer's CLI or JSON schema verbatim. CSS/Sass/LESS analysis, regex source-path replacement, exact additive per-source gzip attribution, and automatic browser opening are outside this MVP. Mapped-only is a view filter; source-map comments and other unmapped regions remain in totals. Existing capture verification, unmeasured states, and CI budgets remain available.

## Filters, compression, and budgets

```sh
coldpath --dir dist \
  --include '**/*.js' --exclude 'vendor/**' \
  --compression --max-bytes 1000000 \
  --json artifacts/report.json --markdown artifacts/summary.md
```

CLI/config include/exclude globs apply to generated bundle paths relative to the analysis root (`--dir` when supplied). `*` does not cross `/`; `**` does. Exclusion wins over inclusion. Filters change totals and the budget denominator; excluded paths are recorded in `excludedBundles`. An empty selection fails.

`--compression` compresses each complete bundle with gzip level 6 (flate2's zlib-rs backend) and Brotli quality 5, lgwin 22. The report sums file sizes. These are neither per-source savings estimates nor a guarantee of your server's encoding size; even the same compression level can differ between implementations. The backend changed from the original release's miniz_oxide, so gzip byte counts and near-threshold gzip budgets can change even when input files are unchanged.

`--source-compression` separately estimates source sizes: concatenate each source’s attributed generated fragments in order within each bundle, then compress with the same gzip/Brotli settings. `estimatedCompression` on bundle sources, sources, and packages sums these independently compressed contributions. `sourceCompressionMethod` records the method. Package estimates are sums of isolated source estimates, not compression of the entire package.

With an initial scenario, `interactionCandidates[].estimatedDeferrableCompression` compresses only the measured later-minus-initial fragments. It is omitted/null when no such measured fragments exist. These fragments need not form valid standalone JavaScript. Dictionaries, wrappers, shared code, bundler optimization, and request overhead change after refactoring; estimates are non-additive and can exceed whole-bundle compression. Rebuild to measure actual savings. Source estimates are not used for whole-bundle compression budgets.

Store reusable settings with `--config ci.json`:

```json
{
  "include": ["**/*.js"],
  "exclude": ["vendor/**"],
  "compression": true,
  "budgets": {
    "maxBytes": 1000000,
    "maxUnobservedBytes": 300000,
    "maxUnmeasuredBytes": 0,
    "maxGzipBytes": 300000,
    "maxBrotliBytes": 250000
  }
}
```

CLI include/exclude lists are appended; CLI byte budgets override matching config values. gzip/Brotli budgets are configured in JSON and automatically enable compression. Unknown keys fail. Input/output paths and URL mappings are CLI options.

Success exits `0`; input or analysis failure exits `1`; budget failure exits `2` after reports are written. Malformed CLI arguments also exit `2` through clap. `maxUnobservedBytes` fails with exit `2` if no selected bytes have coverage, including absent, empty, or entirely unselected recordings. A measured recording with zero execution is valid and all of its bytes are unobserved. For partially measured builds, combine `maxUnobservedBytes` with `maxUnmeasuredBytes`: recording less code must not appear to improve unused-byte results. Markdown output is a local file and does not post comments to any service.

## Import paths

Pass an esbuild metafile from the same build:

```sh
coldpath --dir dist --metafile meta.json --why src/feature.ts
```

`--why` uses the exact esbuild input key. The analyzer reports one shortest path through the input graph and records paths in JSON's `importPaths`. Metafile `bytesInOutput` and source-map attributed bytes have different definitions. Metafiles are not hash-verified; retain the correct one with the build.

For treemap source matching, `--metafile-root` specifies the working directory used by the build; it defaults to CWD. This binds esbuild input keys to the same normalized source identities. `--why` still accepts the exact esbuild key. The current graph records one shortest path, not import line/column locations or proof that a particular static import caused initial loading.

For static/dynamic edges and one-based import locations, use `--graph graph.json --graph-root BUILD_ROOT` with the [bundler graph adapters](graphs.md). This supports esbuild, webpack, Rollup/Vite and Next.js Turbopack. `--why` then accepts a graph source or normalized report source and prints edge kinds and available locations. `--graph` and legacy `--metafile` are mutually exclusive. Runtime call graphs and exact compressed savings are not inferred from source maps.
