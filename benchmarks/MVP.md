# Explorer MVP and optimized measurements

The explorer now supports JavaScript files/globs, an explicit map for a single file, hierarchical bundle/folder/file treemaps, package grouping, search, sorting, coverage colors, mapped-only view filtering, and HTML/JSON/TSV output. `--treemap` writes a compact offline explorer; `--html` retains the full source/interval inspector. File/glob input without an output option writes `coldpath.html`.

This covers the central size-exploration workflow described in [source-map-explorer's documentation](https://github.com/danvk/source-map-explorer). It is not a drop-in CLI/schema replacement. CSS/Sass/LESS, regex path replacement, source-level gzip attribution, and automatic browser opening are not included. The CLI still verifies capture evidence, preserves unmeasured bytes, and supports CI budgets.

## What changed in analysis

- Resolve source paths once per map and use numeric source IDs in mapping points and segments.
- Collect points in a vector; retain stable last-mapping-wins semantics and explicit index-section boundaries. Sort only when the collected positions are out of order.
- Aggregate into per-source arrays, then update global source totals once per source/bundle instead of once per segment.
- Store UTF-8/UTF-16 corrections only around non-ASCII characters instead of allocating two full character-index tables.
- Enable SHA-256's runtime-detected AArch64 acceleration through sha2's `asm` feature on that target. Keep software fallback and the same digest/evidence checks.
- Use flate2's zlib-rs backend for gzip, keeping level 6. The full inspector remains complete; the compact treemap needs only source totals.

Structural map validation and capture hashing remain enabled. Analysis still uses one thread. The new gzip backend can produce different compressed sizes at the same level; reports name the backend and the usage guide calls out the impact on gzip budgets.

## Method

Same saved input datasets as [the original comparison](RESULTS.md): 103 mapped files, 7,125,745 generated UTF-8 bytes for static analysis; 13 recorded scripts, 672,025 bytes for coverage. Apple M5, macOS 27, Node.js 24.20.0, Rust 1.95.0 release profile with thin LTO. Original executable: public commit `537b08500d0a0df2f543ebb63460da4ff441d15f`. Optimized executable: working-tree implementation, with exact binary SHA-256 recorded in the results.

One warmup and nine measured fresh processes per task, randomized serial order with seed 20260923. Wall time includes startup and report writes; builds, installation, recording, and dataset preparation are excluded. Filesystem caches are warm on a shared machine. All 120 processes exited successfully. Per-child peak RSS comes from `wait4`. These measurements describe this build and machine; they do not establish a general ranking or browser loading speed.

source-map-explorer 2.5.3 uses source-map 0.7.6 and the same documented relaxed-boundary fallback as before. Both analyzers receive the same saved JS/maps. Both coverage adapters receive the same recording, prepared outside the timer. Summary schemas and attribution boundary policies still differ. No Monocart rerun was needed to measure this optimization; its original compatibility findings remain in the earlier report.

## Results

Nine-run medians:

| Input / output                       | Original coldpath | Optimized coldpath |            source-map-explorer |
| ------------------------------------ | --------------------: | ---------------------: | -----------------------------: |
| 103 files, static JSON               |             473.39 ms |          **136.44 ms** |                      230.16 ms |
| 103 files, static treemap HTML       |                     — |          **135.65 ms** |                      257.75 ms |
| 13 scripts, coverage JSON            |              58.46 ms |           **20.84 ms** |                       64.47 ms |
| 13 scripts, coverage treemap HTML    |                     — |           **20.57 ms** |                       73.35 ms |
| 13 scripts, full code-inspector HTML |             294.46 ms |          **116.05 ms** | Not offered by this comparator |

Static JSON takes **71.2% less time than the original implementation**, and **40.7% less than source-map-explorer** on this run (runtime ratios of approximately 3.47× and 1.69× respectively). The coverage treemap takes 72.0% less elapsed time than the comparator's treemap. Both treemaps support hierarchical size exploration and coverage coloring, but their UI/output features are not identical. The full inspector is a separate workload and is still slower to generate than either compact treemap.

| Input / output   | Original peak RSS | Optimized peak RSS | source-map-explorer peak RSS |
| ---------------- | ----------------: | -----------------: | ---------------------------: |
| Static JSON      |        407.97 MiB |     **109.23 MiB** |                   368.22 MiB |
| Static treemap   |                 — |     **109.36 MiB** |                   366.77 MiB |
| Coverage JSON    |         76.19 MiB |      **26.91 MiB** |                   112.19 MiB |
| Coverage treemap |                 — |      **26.91 MiB** |                   120.72 MiB |
| Full inspector   |         85.09 MiB |      **46.11 MiB** |                            — |

Optimized/comparator treemap sizes: 461/494 KiB for static input and 132/185 KiB for coverage input. The full inspector grew from 2,729 to 2,769 KiB with the new gzip backend while generating faster. Summary JSON is byte-identical before and after; static JSON remains 757 KiB, versus the comparator's different 325 KiB schema.

## Correctness and UI checks

- All 37 Rust tests pass on stable and Rust 1.88, including exhaustive UTF-8/UTF-16 boundary comparisons, duplicate mapping positions, nested index sections, stale capture rejection, CLI globs/maps/stdout, and HTML escaping. Stable clippy passes with warnings denied.
- Ten complete summary/detailed JSON reports across eight saved datasets are byte-identical to the original executable, including source rows, hashes, warnings, and detailed spans. See [equivalence evidence](results/mvp-equivalence.json).
- Every static/coverage JSON pair in the timing run is also byte-identical before/after: 20 pairs including warmups.
- Existing browser checks exercise actual Chromium coverage against an independent per-code-unit oracle, native input adapters, code navigation, compression decoding, and the collector.
- New Chromium checks cover hierarchy, breadcrumbs, keyboard activation, exact area totals, all 15 small entries in a folder, search, package grouping, mapped-only filtering without changing totals, mobile layout, no network requests, and hostile source paths.

Raw timings, ranges, RSS, report sizes, and binary hashes: [mvp-measurements.json](results/mvp-measurements.json). Reproduction commands are in [README.md](README.md#measure-the-optimized-explorer). Local full HTML reports and screenshots are under ignored `artifacts/mvp/` and `artifacts/treemap/`.
