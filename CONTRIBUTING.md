# Contributing

Issues and pull requests are welcome. For incorrect byte counts, include a small generated JavaScript file, its source map, the coverage input, your command, and the expected result. Synthetic reproductions are fine; source maps and reports can contain your application's source code.

## Setup and checks

Rust 1.88+ builds the analyzer with no JavaScript toolchain:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Keep `Cargo.lock` committed and preserve the minimum Rust version. CI checks stable Rust on Linux/macOS and Rust 1.88 on Linux.

For changes to input adapters, report HTML, or the collector, also run:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:browser
```

Use Node.js 24+ and the pnpm version in `package.json`. JavaScript dependencies are development-only. Generated verification files belong in the ignored `artifacts/` directory.

## Test boundaries

- `tests/analysis.rs`: nested V8 ranges, Unicode offsets, source maps, verification evidence, filters, compression, reports, and budget exits.
- `scripts/verify.mjs`: captures actual Chromium coverage and compares every interval with an independent per-code-unit reference implementation.
- `scripts/verify-formats.mjs`: imports real Playwright and Node coverage, validates Chrome-shaped input, and exercises the offline HTML UI and embedded-data escaping.
- `scripts/verify-collector.mjs`: runs the collector as a separate process against a local fixture, including a custom interaction and stale-source rejection.

Do not format or regenerate `examples/recorded/entry.js` or its map as a cosmetic edit. Their exact bytes are part of the recorded coverage's SHA-256 evidence. Source fixtures for new captures live in `fixtures/`.

Preserve the distinction between unobserved and unmeasured code, source verification and map verification, UTF-16 offsets and UTF-8 bytes. A source-map anchor cannot prove that an original source line was fully executed.

## Scope

The project analyzes generated JavaScript bytes. It does not currently produce Istanbul/LCOV test reports, measure CPU cost, analyze CSS, diff builds, or automatically remove code. Import-path explanations require an esbuild metafile; source maps alone do not provide an import graph. There is no comparative performance benchmark or supported prebuilt-binary release process yet.

Changes to the CLI or JSON schema should update the usage guide. Contributions are distributed under the project's MIT license.
