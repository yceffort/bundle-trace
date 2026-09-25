"""Instrument an ignored source copy; preserve the production binary and sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
from baseline import checkout, build, COMMIT
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / 'artifacts/profiling'
COPY = BASE / 'source'


def replace(path, before, after):
    text = path.read_text()
    assert text.count(before) == 1, (path, before, text.count(before))
    path.write_text(text.replace(before, after))


def prepare():
    COPY.mkdir(parents=True, exist_ok=True)
    checkout(COPY)
    (COPY / 'src/profile.rs').write_text('''
use std::{collections::BTreeMap, sync::Mutex, time::Instant};
static TIMES: Mutex<BTreeMap<&'static str, u128>> = Mutex::new(BTreeMap::new());
static COUNTS: Mutex<BTreeMap<&'static str, usize>> = Mutex::new(BTreeMap::new());
pub struct Stage(&'static str, Instant);
impl Stage { pub fn new(name: &'static str) -> Self { Self(name, Instant::now()) } }
impl Drop for Stage { fn drop(&mut self) { elapsed(self.0, self.1); } }
pub fn elapsed(name: &'static str, start: Instant) {
    let ns = start.elapsed().as_nanos();
    *TIMES.lock().unwrap().entry(name).or_default() += ns;
}
pub fn count(name: &'static str, value: usize) {
    *COUNTS.lock().unwrap().entry(name).or_default() += value;
}
pub fn dump() {
    let value = serde_json::json!({"nanoseconds": *TIMES.lock().unwrap(), "counts": *COUNTS.lock().unwrap()});
    std::fs::write(std::env::var("COLDPATH_PROFILE").unwrap(), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}
''')
    lib = COPY / 'src/lib.rs'
    replace(lib, 'pub mod attribution;', 'pub mod profile;\npub mod attribution;')
    replace(lib, '        let content =\n', '        let stage = crate::profile::Stage::new("read_js");\n        let content =\n')
    replace(lib, '        let text = TextIndex::new(&content);', '        drop(stage);\n        let stage = crate::profile::Stage::new("text_index");\n        let text = TextIndex::new(&content);\n        drop(stage);')
    replace(lib, '        let hash = sha256(content.as_bytes());', '        let stage = crate::profile::Stage::new("hash_js");\n        let hash = sha256(content.as_bytes());\n        drop(stage);\n        let stage = crate::profile::Stage::new("load_map");')
    replace(lib, '        let (segments, map_hash, mut contents) =', '        drop(stage);\n        let (segments, map_hash, mut contents) =')
    replace(lib, '            let attribution::Attribution {', '            let stage = crate::profile::Stage::new("attribution_total");\n            let attribution::Attribution {')
    replace(lib, '            if invalid_points > 0 {', '            drop(stage);\n            if invalid_points > 0 {')
    replace(lib, '            (segments, Some(sha256(&data)), contents)', '            let stage = crate::profile::Stage::new("hash_map");\n            let hash = sha256(&data);\n            drop(stage);\n            (segments, Some(hash), contents)')
    replace(lib, '        let observations = coverage.remove(&path);', '        let stage = crate::profile::Stage::new("coverage_normalization");\n        let observations = coverage.remove(&path);')
    replace(lib, '        let mut counts = Counts::default();', '        drop(stage);\n        let stage = crate::profile::Stage::new("aggregation_and_spans");\n        let mut counts = Counts::default();')
    replace(lib, '        report.totals.add(&counts);', '        drop(stage);\n        report.totals.add(&counts);')
    attr = COPY / 'src/attribution.rs'
    replace(attr, '    validate_map(&serde_json::from_slice(data)?)?;', '    let stage = crate::profile::Stage::new("map_json_validation");\n    validate_map(&serde_json::from_slice(data)?)?;\n    drop(stage);')
    replace(attr, '    let map = sourcemap::decode_slice(data)?;', '    let stage = crate::profile::Stage::new("sourcemap_decode");\n    let map = sourcemap::decode_slice(data)?;\n    drop(stage);')
    replace(attr, '    decoder.collect(&map, (0, 0), None)?;', '    let stage = crate::profile::Stage::new("mapping_tree");\n    decoder.collect(&map, (0, 0), None)?;\n    drop(stage);\n    crate::profile::count("mapping_points", decoder.points.len());\n    let stage = crate::profile::Stage::new("points_conversion");')
    replace(attr, '    let mut result = Vec::new();', '    drop(stage);\n    let stage = crate::profile::Stage::new("segments_build");\n    let mut result = Vec::new();')
    replace(attr, '    Ok(Attribution {', '    drop(stage);\n    crate::profile::count("segments", result.len());\n    Ok(Attribution {')
    text_index = COPY / 'src/text.rs'
    replace(text_index, '        let byte_boundaries = boundaries', '        let byte_boundaries: Vec<(usize, usize)> = boundaries')
    replace(text_index, '        Self {', '        crate::profile::count("text_index_allocated_bytes_sum", boundaries.capacity() * std::mem::size_of::<Option<usize>>() + byte_boundaries.capacity() * std::mem::size_of::<(usize, usize)>());\n        Self {')
    report = COPY / 'src/report.rs'
    replace(report, 'fn embedded_data(id: &str, json: String) -> Result<String> {', 'fn embedded_data(id: &str, json: String) -> Result<String> {\n    let _stage = crate::profile::Stage::new("html_embed_compression_base64");\n    crate::profile::count("html_uncompressed_json_bytes", json.len());')
    main = COPY / 'src/main.rs'
    replace(main, 'fn main() -> Result<()> {', 'fn main() -> Result<()> {\n    let profile_main = std::time::Instant::now();')
    replace(main, '    let mut report = coldpath::analyze_with_options(&args.dir, &args.coverage, &options)?;', '    let stage = coldpath::profile::Stage::new("analyze_total");\n    let mut report = coldpath::analyze_with_options(&args.dir, &args.coverage, &options)?;\n    drop(stage);')
    replace(main, '    if let Some(path) = args.html {', '    if let Some(path) = args.html {\n        let _stage = coldpath::profile::Stage::new("html_total_and_write");')
    replace(main, '    if let Some(path) = args.json {', '    if let Some(path) = args.json {\n        let _stage = coldpath::profile::Stage::new("json_total_and_write");')
    replace(main, '\n    Ok(())\n}\n\nfn write_report', '\n    coldpath::profile::elapsed("main_total", profile_main);\n    coldpath::profile::dump();\n    Ok(())\n}\n\nfn write_report')


def measure(rounds, production):
    instrumented = BASE / 'target/release/coldpath'
    rows = []
    rng = random.Random(20260923)
    for index in range(-1, rounds):
        jobs = [(variant, mode) for variant in ['production', 'instrumented'] for mode in ['static', 'html']]
        rng.shuffle(jobs)
        for variant, mode in jobs:
            output = BASE / f'{index}-{variant}-{mode}'
            output.mkdir(parents=True, exist_ok=True)
            dataset = ROOT / 'artifacts/comparison/inputs' / ('blog-mapped' if mode == 'static' else 'blog-measured')
            cmd = [str(instrumented if variant == 'instrumented' else production), '--dir', str(dataset / 'files')]
            if mode == 'html':
                cmd += ['--coverage', str(dataset / 'playwright.json'), '--url-prefix', 'https://comparison.invalid/', '--html', str(output / 'index.html')]
            else:
                cmd += ['--json', str(output / 'report.json')]
            with (output / 'process.log').open('wb') as log:
                start = time.perf_counter_ns()
                proc = subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                        env={**os.environ, 'COLDPATH_PROFILE': str(output / 'profile.json')})
                _, status, usage = os.wait4(proc.pid, 0)
                elapsed = (time.perf_counter_ns() - start) / 1e6
                proc.returncode = os.waitstatus_to_exitcode(status)
            assert proc.returncode == 0, output / 'process.log'
            row = dict(round=index, variant=variant, mode=mode, wallMs=elapsed, peakRssBytes=usage.ru_maxrss if os.uname().sysname == 'Darwin' else usage.ru_maxrss * 1024)
            if variant == 'instrumented':
                row.update(json.loads((output / 'profile.json').read_text()))
            rows.append(row)
            print(f'{index} {variant} {mode}: {elapsed:.2f} ms', flush=True)
        for mode, filename in [('static', 'report.json'), ('html', 'index.html')]:
            assert (BASE / f'{index}-production-{mode}' / filename).read_bytes() == (BASE / f'{index}-instrumented-{mode}' / filename).read_bytes(), ('instrumented output differs', index, mode)
    summary = []
    for variant in ['production', 'instrumented']:
        for mode in ['static', 'html']:
            selected = [r for r in rows if r['round'] >= 0 and r['variant'] == variant and r['mode'] == mode]
            value = dict(variant=variant, mode=mode, medianWallMs=statistics.median(r['wallMs'] for r in selected), medianPeakRssBytes=statistics.median(r['peakRssBytes'] for r in selected))
            if variant == 'instrumented':
                value['medianStageMs'] = {k: statistics.median(r['nanoseconds'][k] / 1e6 for r in selected) for k in selected[0]['nanoseconds']}
                value['counts'] = selected[0]['counts']
            summary.append(value)
    result = dict(method='Isolated instrumented source copy, release profile unchanged; one warmup and randomized serial fresh processes. Stage timers are nested; stage medians do not sum exactly. Production runs bound instrumentation overhead. RSS is per child, not cumulative.', commit=COMMIT, binarySha256={name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in [('production', production), ('instrumented', instrumented)]}, outputsByteIdentical=True, summary=summary, samples=rows)
    (ROOT / 'benchmarks/results/profile.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rounds', type=int, default=9)
    args = parser.parse_args()
    production = build()
    prepare()
    subprocess.run(['cargo', 'build', '--release', '--locked', '--manifest-path', str(COPY / 'Cargo.toml'), '--target-dir', str(BASE / 'target')], cwd=ROOT, check=True)
    measure(args.rounds, production)
