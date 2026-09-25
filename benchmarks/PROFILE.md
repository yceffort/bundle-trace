# Why this implementation was slower

This investigation describes the original public implementation. The [subsequent MVP implementation and measurements](MVP.md) apply the source-ID, aggregation, sparse-index, hashing, and compression improvements.

Follow-up to the [tool comparison](RESULTS.md), using the same saved inputs, machine, release profile, and production commit `537b08500d0a0df2f543ebb63460da4ff441d15f`.

The largest static-analysis costs are materializing mappings and aggregating their source contributions. HTML has a different bottleneck: embedding compressed source and interval data. Rust does not eliminate allocations, string copies, tree lookups, hashing, or compression that the implementation asks it to perform.

## Measurement

`profile.py` copies the source into ignored `artifacts/profiling/source/`, adds coarse stage timers, and builds with the existing release profile. It leaves production source files and `target/release/coldpath` intact. There is no per-mapping timer. Each task has one warmup and nine measured fresh processes, randomized and serial. Filesystem caches are warm. The timer dump happens after the internal total timer; process wall time includes it.

Production and instrumented static medians were **483.18 ms and 482.90 ms**. Coverage HTML medians were **298.14 ms and 298.76 ms**. Every instrumented JSON/HTML file was byte-identical to the corresponding production output, including warmups: 20 pairs. This bounds the instrumentation's wall-time perturbation on these inputs; it is not an instruction-level CPU or allocation profile. Instrumented HTML peak RSS was approximately 5 MiB higher, so memory overhead was not zero.

Raw stage timings, counters, process timings, binary hashes, and commit are in [profile.json](results/profile.json).

## Static analysis: 103 mapped files

The input produced **1,860,534 mapping points** and **1,861,819 segments**. Selected non-overlapping stage medians:

| Work                                                                                 |      Time |
| ------------------------------------------------------------------------------------ | --------: |
| Build the mapping `BTreeMap`, including owned source paths and coordinate validation | 107.60 ms |
| Aggregate segments into per-bundle and global source totals                          | 127.13 ms |
| Convert tree entries to a vector, then construct owned segments                      |  45.12 ms |
| Decode source maps with the `sourcemap` crate                                        |  62.07 ms |
| Additional JSON parse and structural validation before decoding                      |  14.57 ms |
| SHA-256 of generated files and maps                                                  |  62.64 ms |
| Build UTF-16/UTF-8 position tables                                                   |  26.06 ms |
| Read generated files and load maps                                                   |   7.78 ms |
| Serialize and write the summary JSON                                                 |   0.65 ms |

Stage medians do not sum exactly, and this table omits other work, including cleanup, final sorting, and process startup. `attribution_total` in the raw data contains the decoding, validation, tree, and segment stages; do not add it to those sub-stages.

Tree construction plus aggregation accounts for about **49% of the process wall time**. This is a measured hot region, not a claim that string copying alone consumes that entire region. The current representation clones source paths into tree nodes, clones them into segments, and creates owned keys again for aggregation lookups even when those keys already exist. Aggregation repeatedly compares path strings in ordered maps.

The text index always constructs both directions of the UTF-16/UTF-8 lookup, although summary-only analysis does not need the reverse table. Its two vectors' summed backing capacities across the 103 files were 307,609,600 bytes, excluding the line table. This is a cumulative per-file capacity counter, **not peak RSS or total allocator traffic**. Files are processed sequentially. It supports investigating compact/sparse indexes without attributing all peak memory to them.

The extra JSON validation pass is real but only about 3% of process wall time. Removing that alone would not close the gap. Summary JSON output is under 1 ms, so the larger output file does not explain the static slowdown.

## A small controlled change

`profile-lookup.py` creates another ignored source copy and changes only two aggregation lookups: look up an existing key by reference before allocating an owned key for a new entry. It uses no stage instrumentation and keeps all analysis, validation, hashing, and output enabled.

| Static analysis variant                        | Median of nine processes |
| ---------------------------------------------- | -----------------------: |
| Production                                     |                485.29 ms |
| Avoid owned-key allocation on aggregation hits |                448.03 ms |

That is **37.26 ms, or 7.68%, less elapsed time**, with byte-identical complete JSON output in all ten pairs including warmup. It demonstrates that these particular allocations matter, while also showing that this small change is insufficient to erase the original comparison's gap. Source-map-explorer was not remeasured in this follow-up. See [raw samples](results/profile-lookup.json).

This is a diagnostic variant, not a change to production code. Output equivalence is checked on this saved build; the complete correctness suite has not been run against the variant.

## Coverage HTML: 13 recorded scripts

The instrumented process median was **298.76 ms**:

- Analysis, including detailed spans: 61.88 ms.
- HTML construction and writing: 232.86 ms.
- Within HTML construction, payload compression/Base64/embedding: **226.26 ms**.

The embedding stage processes 9,287,046 bytes of uncompressed JSON containing generated code, original content, and mapping/coverage spans. It uses gzip level 6 above the embedding threshold. The timer includes Base64 and formatting, so it does not isolate gzip alone. This stage accounts for about **76% of process wall time**. Source-map-explorer's much smaller treemap does not provide this source-and-interval inspector, so the HTML comparison includes a substantial feature difference.

## The competitor also runs Rust

The installed source-map-explorer 2.5.3 resolves `source-map` 0.7.6. Its `lib/wasm.js` loads `mappings.wasm` through `WebAssembly.instantiate`. Mozilla documents that the performance-sensitive parser was implemented in Rust and compiled to WebAssembly. The comparison is therefore not simply native Rust against a JavaScript-only source-map parser. See [Mozilla's implementation explanation](https://hacks.mozilla.org/2018/01/oxidizing-source-maps-with-rust-and-webassembly/).

## Work justified by the measurements

First, replace repeated path ownership and string-key aggregation with shared source IDs and per-source counters. Investigate avoiding full intermediate segment materialization in summary mode while preserving index-map section boundaries and duplicate-position behavior. Then measure compact text indexes and SHA-256 implementation costs. For HTML, measure compression settings/backends and payload size separately from analysis. Preserve the correctness checks when consolidating the duplicate JSON parse.

These are optimization directions, not measured speedup claims. The small lookup experiment is the only implementation change measured here; no product optimization has been published.
