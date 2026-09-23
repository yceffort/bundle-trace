# Usage guide

Run `bundle-trace --help` for the complete CLI. All paths in the examples are relative to your current working directory.

## Source maps

`--dir` recursively scans `.js`, `.mjs`, and `.cjs` files. The analyzer reads a final standalone `//# sourceMappingURL=...`, `//@ sourceMappingURL=...`, or `/*# sourceMappingURL=... */` comment, falling back to an adjacent `filename.js.map` when there is no reference. The map's filename does not need to match the JavaScript filename.

Supported map inputs include ordinary v3 maps, indexed maps with embedded sections, and base64 or percent-encoded `data:application/json` maps. `sourcesContent` is optional. Explicit overrides take precedence over comments:

```sh
bundle-trace --dir dist \
  --map chunks/app.js=/path/to/private/app.map \
  --html artifacts/report.html
```

Repeat `--map` as needed. Automatically discovered local maps must stay inside `--dir`; explicit bindings may refer outside it. The analyzer never fetches HTTP maps or external-URL indexed sections.

Files without maps remain `[unmapped]`. Explicitly missing maps, malformed maps, overlapping/out-of-order indexed sections, and unrecoverable ranges cause failure. Invalid individual mapping points (outside their generated line or inside a surrogate pair) are skipped with warnings. Empty sections and unmapped prefixes remain unmapped. Conflicting `sourcesContent` for one source name causes an error when source details are requested.

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
bundle-trace --dir dist \
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
bundle-trace --dir dist \
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
          "ranges": [{ "startOffset": 0, "endOffset": 100, "count": 1 }]
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
bundle-trace --dir dist \
  --coverage initial.json --coverage interaction.json \
  --html artifacts/report.html \
  --json artifacts/summary.json \
  --markdown artifacts/summary.md
```

HTML provides bundle/package search, source drilldown, code-range navigation, an optional size distribution, app-code and coverage-state filters, and system/light/dark themes. UI filters do not change the overall totals. Original-source highlights identify mapping anchors; generated-code colors represent observed, unobserved, and unmeasured byte ranges.

JSON uses `schemaVersion: 2`. Summary output includes totals, bundles, source/package attribution, `bundles[].sources`, warnings, and verification evidence. Add `--details` for `bundles[].spans`, `generatedSource`, and embedded original code. Requesting HTML does not automatically make JSON detailed.

In detailed output, `spans[].source` indexes that bundle's `sources` array. `start/end` are half-open UTF-8 byte offsets; `startUtf16/endUtf16` are JavaScript string offsets. `original` identifies a zero-based source-map line/column anchor, not an original execution range. Sources without `sourcesContent` show positions only.

HTML stores details by chunk and decodes them on demand. Blocks larger than 16 KiB use gzip/base64 and require `DecompressionStream`. Code views render a window around the selected range; data remains complete even when the visible generated snippet is truncated. The report makes no external network requests.

## Filters, compression, and budgets

```sh
bundle-trace --dir dist \
  --include '**/*.js' --exclude 'vendor/**' \
  --compression --max-bytes 1000000 \
  --json artifacts/report.json --markdown artifacts/summary.md
```

CLI globs apply to generated bundle paths relative to `--dir`. `*` does not cross `/`; `**` does. Exclusion wins over inclusion. Filters change totals and the budget denominator; excluded paths are recorded in `excludedBundles`. An empty selection fails.

`--compression` compresses each complete bundle with gzip level 6 and Brotli quality 5, lgwin 22. The report sums file sizes. These are neither per-source savings estimates nor a guarantee of your server's encoding size; even the same compression level can differ between implementations.

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

Success exits `0`; input or analysis failure exits `1`; budget failure exits `2` after reports are written. Malformed CLI arguments also exit `2` through clap. Combine `maxUnobservedBytes` with `maxUnmeasuredBytes` when measurement coverage matters: recording less code must not appear to improve unused-byte results. Markdown output is a local file and does not post comments to any service.

## Import paths

Pass an esbuild metafile from the same build:

```sh
bundle-trace --dir dist --metafile meta.json --why src/feature.ts
```

`--why` uses the exact esbuild input key. The analyzer reports one shortest path through the input graph and records paths in JSON's `importPaths`. Metafile `bytesInOutput` and source-map attributed bytes have different definitions. Metafiles are not hash-verified; retain the correct one with the build.

Source maps do not reveal an import graph. webpack and Turbopack graph adapters, runtime call graphs, build comparisons, and per-scenario contribution reports are not implemented.
