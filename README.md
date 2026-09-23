# bundle-trace

[![CI](https://github.com/yceffort/bundle-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/yceffort/bundle-trace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Trace JavaScript bundle bytes back to original files and packages, then overlay V8 coverage to see what ran during your scenarios.

`bundle-trace` is a Rust CLI. Analysis, compression, and report generation run offline, without Node.js or a browser. Bring an existing Chrome, Playwright, Puppeteer, or Node coverage recording, or use the optional Chromium collector.

- Attribute generated JavaScript to original sources using source maps.
- Keep **observed**, **unobserved**, and **unmeasured** bytes separate.
- Explore bundles, packages, original sources, and generated code in a single offline HTML report.
- Merge scenarios from the same build and reject mismatched source evidence.
- Export JSON and Markdown; enforce byte budgets in CI.
- Calculate whole-bundle gzip/Brotli sizes and inspect import paths from esbuild metafiles.

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

The project is not published to crates.io or npm. Node.js is only needed for the optional collector and browser integration tests.

## Try the recorded example

From a checkout, run this without installing Node.js or Chromium:

```sh
cargo run --locked --release -- \
  --dir examples/recorded \
  --coverage examples/recorded/initial.coverage.json \
  --coverage examples/recorded/interaction.coverage.json \
  --json artifacts/report.json \
  --html artifacts/report.html
```

Expected totals: **293 bytes**, **208 observed**, **85 unobserved**, **0 unmeasured**. Open `artifacts/report.html` directly in your browser. Its data, scripts, and styles are embedded; no report server or network requests are needed.

The example contains real V8 coverage, source maps, and multibyte characters. Do not reformat `examples/recorded`: the recordings verify the exact JavaScript and map hashes.

## Analyze your build

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

`--url-prefix` maps the URL suffix to a file under `--dir` and must end in `/`. Use repeated `--coverage` arguments to union scenarios from the **same build**. For exact URL mappings, source-map overrides, Playwright inputs, and Node coverage, see the [usage guide](docs/usage.md).

## Understand the numbers

| Field             | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `bytes`           | Generated, uncompressed UTF-8 bytes                         |
| `observedBytes`   | Bytes in ranges executed in at least one supplied recording |
| `unobservedBytes` | Bytes not executed in a script that has a recording         |
| `unmeasuredBytes` | Bytes in a script with no supplied recording                |

The three states sum to `bytes`. V8 offsets use UTF-16 code units; the analyzer converts them to UTF-8 byte boundaries. These numbers are neither original TypeScript file sizes nor compressed transfer sizes.

Source-map attribution is an estimate: a mapping owns bytes up to the next mapping on the same line or the line's end. Unmapped prefixes, line breaks, and segments without a source remain `[unmapped]`. Original source highlights identify mapping anchors, not exact source-level statement or branch coverage.

HTML reports and `--details` JSON include generated code and any original source embedded in your maps. Summary JSON omits that code. Large HTML payloads require a browser with `DecompressionStream` support.

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

## Development

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked

# Optional integration checks with real Chromium and Node coverage:
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:browser
```

CI runs Rust tests on Linux and macOS, checks the minimum Rust version on Linux, and exercises the HTML report, input adapters, and collector in Chromium. See [CONTRIBUTING.md](CONTRIBUTING.md) for test boundaries and fixtures.

## Origin and license

Extracted from the [`bundle-trace` experiment in yceffort/blog](https://github.com/yceffort/blog/tree/7f33d3bccd6ebc71d7c26c07a2527ced07846c3b/experiments/bundle-trace). The original repository keeps the blog-specific performance studies and measurement data; this repository maintains the reusable analyzer and collector.

[MIT](LICENSE) © 2026 yceffort.
