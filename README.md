# bundle-trace

[![CI](https://github.com/yceffort/bundle-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/yceffort/bundle-trace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

See which JavaScript runs initially, which runs only during interactions, and what changed in a pull request—backed by source maps and V8 coverage.

`bundle-trace` is a Rust CLI. Analysis, compression, and report generation run offline, without Node.js or a browser. Bring an existing Chrome, Playwright, Puppeteer, or Node coverage recording, or use the optional Chromium collector.

- Attribute generated JavaScript to original sources using source maps.
- Keep **observed**, **unobserved**, and **unmeasured** bytes separate.
- Explore bundle/folder/package treemaps, with an optional source-code inspector.
- Color bytes by their first observed scenario; inspect code separately for each recording.
- Compare a baseline by source, package, and scenario; highlight growth and new modules.
- Union recordings from the same build and reject mismatched source evidence.
- Accept files/globs and export HTML, JSON, TSV, and Markdown; enforce byte budgets in CI.
- Trace import chains and available locations from esbuild, webpack, Rollup/Vite, and Next.js Turbopack graphs.
- Review suggested loading boundaries with explicitly estimated source gzip/Brotli sizes.

Early-stage software: the CLI and JSON schema may change. Unobserved bytes are code that did not run during the supplied scenarios; they are not automatically safe to delete.

## Install

Requires Rust 1.88 or newer. Install from GitHub:

```sh
cargo install --git https://github.com/yceffort/bundle-trace --locked
```

Or build locally:

```sh
git clone https://github.com/yceffort/bundle-trace.git
cd bundle-trace
cargo build --locked --release
./target/release/bundle-trace --help
```

The project is not published to crates.io or npm. Node.js is only needed for optional collection, graph export, and integration tests.

## Try the recorded example

From a checkout, run this without installing Node.js or Chromium:

```sh
cargo run --locked --release -- \
  --dir examples/recorded \
  --coverage examples/recorded/initial.coverage.json \
  --coverage examples/recorded/interaction.coverage.json \
  --initial-scenario initial \
  --json artifacts/report.json \
  --treemap artifacts/report.html --details
```

Expected totals: **293 bytes**, **208 observed**, **85 unobserved**, **0 unmeasured**. Open `artifacts/report.html` directly in your browser. Colors separate initial and later execution; click a source and select a scenario to inspect its code ranges. Its data, scripts, and styles are embedded; no report server or network requests are needed.

The example contains real V8 coverage, source maps, and multibyte characters. Do not reformat `examples/recorded`: the recordings verify the exact JavaScript and map hashes.

## Analyze your build

For a compact size explorer, pass files or a quoted glob:

```sh
bundle-trace 'dist/**/*.js' --treemap artifacts/size.html
bundle-trace dist/app.js dist/app.js.map --json artifacts/size.json
bundle-trace 'dist/**/*.js' --tsv -
```

Open the HTML directly in your browser. Click bundles and folders to zoom, navigate back with breadcrumbs, search sources, or group by package. Tile area represents bytes; coverage colors distinguish observed, unobserved, and unmeasured code. Every file is available in the table, including small tiles. With file/glob inputs and no output option, the CLI writes `bundle-trace.html` in the current directory, replacing any existing file, and prints `Wrote bundle-trace.html` after saving it.

Build your application with source maps and point the CLI at its JavaScript output:

```sh
bundle-trace --dir dist --compression --html artifacts/bundle.html
```

Without a recording, all bytes are unmeasured. Missing source maps are allowed and remain `[unmapped]`; explicitly referenced missing or invalid maps cause an error.

To add a Chrome Coverage export:

```sh
bundle-trace --dir dist \
  --coverage chrome-coverage.json \
  --url-prefix https://example.com/assets/ \
  --json artifacts/coverage.json \
  --html artifacts/coverage.html
```

`--url-prefix` maps the URL suffix to a file under the analysis root and must end in `/`. Combine `--dir` with file/glob inputs to keep this root fixed when selecting only part of a build, for example `--dir dist 'dist/assets/*.js'`. Without `--dir`, the common parent of the selected JavaScript files becomes the root. Use repeated `--coverage` arguments to union scenarios from the **same build**. For coverage of unselected files, exact URL mappings, source-map overrides, Playwright inputs, and Node coverage, see the [usage guide](docs/usage.md).

## Understand the numbers

| Field             | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `bytes`           | Generated, uncompressed UTF-8 bytes                         |
| `observedBytes`   | Bytes in ranges executed in at least one supplied recording |
| `unobservedBytes` | Bytes not executed in a script that has a recording         |
| `unmeasuredBytes` | Bytes in a script with no supplied recording                |

The three states sum to `bytes`. V8 offsets use UTF-16 code units; the analyzer converts them to UTF-8 byte boundaries. These numbers are neither original TypeScript file sizes nor compressed transfer sizes.

Source-map attribution is an estimate: a mapping owns bytes up to the next mapping on the same line or the line's end. Unmapped prefixes, line breaks, and segments without a source remain `[unmapped]`. Original source highlights identify mapping anchors, not exact source-level statement or branch coverage.

`--treemap` exports a compact size/coverage explorer; add `--details` to include its inline code inspector. `--html` exports the full generated/original code inspector. Detailed outputs include source code; summary JSON and default treemaps omit it. Large inspector payloads require a browser with `DecompressionStream` support.

## Find loading boundaries

```sh
bundle-trace --dir dist \
  --coverage initial.json --coverage open-report.json --coverage search.json \
  --initial-scenario initial --scenario-order initial,open-report,search \
  --graph artifacts/graph.json --graph-root . --source-compression \
  --treemap artifacts/actions.html --details --markdown artifacts/actions.md
```

[Export a graph from your bundler](docs/graphs.md) first. The report distinguishes static-import deferral candidates, sources that need to be split because part executes initially, existing dynamic boundaries, and missing initial measurements. Click a colored tile for import locations, estimates, and scenario-specific code highlights. Estimates compress source fragments in isolation; they are **not guaranteed transfer savings**.

Scenario order is explicit, not inferred from timestamps. Standard coverage exports use filenames as scenario names; hash-bound envelopes use their `scenario` field.

## Collect a browser scenario

The optional collector requires Node.js 24+, pnpm 12.1.0, and Chromium:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium

# Serve the same build locally in another terminal.
node scripts/collect.mjs \
  --url http://127.0.0.1:3000/ \
  --dir path/to/dist/assets \
  --prefix /assets/ \
  --out artifacts/initial.coverage.json
```

For Next.js, use the build's static output directory with `--prefix /_next/static/`. The collector accepts a local action module for clicks, searches, and other interactions. See [collecting coverage](docs/collecting.md) for the action API, capture scope, and source-map limitations.

## Use in CI

```sh
bundle-trace --dir dist \
  --exclude 'vendor/**' \
  --compression --max-bytes 1000000 \
  --json artifacts/report.json \
  --markdown artifacts/summary.md
```

Exit codes: `0` success, `1` input/analysis error, `2` budget exceeded. Argument syntax errors also use `2` (clap). Reports are written before budget failure. [Configuration](docs/usage.md#filters-compression-and-budgets) also supports observed-scenario coverage budgets and gzip/Brotli budgets.

Compare a PR build against a saved report from main:

```sh
bundle-trace --dir dist --baseline artifacts/main.json \
  --max-added-bytes 10000 --treemap artifacts/pr.html \
  --json artifacts/pr.json --markdown artifacts/pr.md
```

Use the same analysis-root convention and bundle selection for both builds. Reports use schema version 3 with normalized source paths; regenerate older baselines. Add matching coverage scenarios to compare execution changes, and `--initial-scenario initial --max-added-unobserved-bytes 10000` to budget initial unobserved growth. See [scenario and PR comparisons](docs/usage.md#scenarios-and-execution-phases) for measurement requirements and visual controls.

## Development

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked

# Optional integration checks with real Chromium and Node coverage:
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:corpus
```

CI runs Rust tests on Linux and macOS, checks the minimum Rust version on Linux, and exercises the HTML report, input adapters, collector, and five real bundler builds in Chromium on both platforms. See [CONTRIBUTING.md](CONTRIBUTING.md) for test boundaries and fixtures.

A [reproducible comparison](benchmarks/RESULTS.md) and [explorer measurements](benchmarks/MVP.md) record performance and compatibility on one saved build. These are development measurements, not a general performance ranking or proof of attribution accuracy across bundlers.

## Measured attribution accuracy

The [real-build corpus](docs/accuracy-corpus.md) publishes reference-map agreement, known-origin probe errors, and per-scenario V8 range checks for esbuild, Rollup, Vite, webpack, and Next.js/Turbopack. It includes a negative control that changes source ownership while retaining every byte count.

The current Next.js fixture exposes **22 incorrectly attributed probe bytes out of 67**, caused by source-map anchors inside inlined literals. Agreement with a source map does not prove semantic attribution is correct. These small fixtures do not establish an error rate for arbitrary applications.

## Origin and license

Extracted from the [`bundle-trace` experiment in yceffort/blog](https://github.com/yceffort/blog/tree/7f33d3bccd6ebc71d7c26c07a2527ced07846c3b/experiments/bundle-trace). The original repository keeps the blog-specific performance studies and measurement data; this repository maintains the reusable analyzer and collector.

[MIT](LICENSE) © 2026 yceffort.
