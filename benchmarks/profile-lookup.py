"""One isolated counterfactual: avoid allocating owned keys on aggregation hits."""
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import time
from baseline import checkout, build, COMMIT

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / 'artifacts/profiling'
COPY = BASE / 'lookup-source'
COPY.mkdir(parents=True, exist_ok=True)
production = build()
checkout(COPY)
lib = COPY / 'src/lib.rs'
code = lib.read_text()
before = '''            let source_index = *source_indices
                .entry(segment.source.clone())
                .or_insert_with(|| {'''
after = '''            let source_index = if let Some(&index) = source_indices.get(&segment.source) {
                index
            } else {'''
assert code.count(before) == 1
code = code.replace(before, after)
before = '''                    index
                });'''
after = '''                    source_indices.insert(segment.source.clone(), index);
                    index
                };'''
assert code.count(before) == 1
code = code.replace(before, after)
before = '''            source_counts
                .entry(segment.source.clone())
                .or_default()
                .add(&row);'''
after = '''            if let Some(counts) = source_counts.get_mut(&segment.source) {
                counts.add(&row);
            } else {
                source_counts.insert(segment.source.clone(), row.clone());
            }'''
assert code.count(before) == 1
lib.write_text(code.replace(before, after))
subprocess.run(['cargo', 'build', '--release', '--locked', '--manifest-path', str(COPY / 'Cargo.toml'), '--target-dir', str(BASE / 'target')], cwd=ROOT, check=True)
experiment = BASE / 'lookup-bundle-trace'
shutil.copyfile(BASE / 'target/release/bundle-trace', experiment)
experiment.chmod(0o755)
samples = []
rng = random.Random(20260923)
for index in range(-1, 9):
    variants = ['production', 'borrowed_lookup']
    rng.shuffle(variants)
    for variant in variants:
        output = BASE / f'lookup-{index}-{variant}'
        output.mkdir(parents=True, exist_ok=True)
        cmd = [str(production if variant == 'production' else experiment), '--dir', str(ROOT / 'artifacts/comparison/inputs/blog-mapped/files'), '--json', str(output / 'report.json')]
        with (output / 'process.log').open('wb') as log:
            start = time.perf_counter_ns()
            proc = subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            _, status, usage = os.wait4(proc.pid, 0)
            elapsed = (time.perf_counter_ns() - start) / 1e6
            proc.returncode = os.waitstatus_to_exitcode(status)
        assert proc.returncode == 0, output / 'process.log'
        samples.append(dict(round=index, variant=variant, wallMs=elapsed, peakRssBytes=usage.ru_maxrss if os.uname().sysname == 'Darwin' else usage.ru_maxrss * 1024))
        print(f'{index} {variant}: {elapsed:.2f} ms', flush=True)
    assert (BASE / f'lookup-{index}-production/report.json').read_bytes() == (BASE / f'lookup-{index}-borrowed_lookup/report.json').read_bytes()
summary = [{ 'variant': variant, 'medianWallMs': statistics.median(r['wallMs'] for r in samples if r['round'] >= 0 and r['variant'] == variant), 'medianPeakRssBytes': statistics.median(r['peakRssBytes'] for r in samples if r['round'] >= 0 and r['variant'] == variant)} for variant in ['production', 'borrowed_lookup']]
result = dict(method='One warmup + nine randomized serial process pairs. Same release profile and full output. Only source_indices/source_counts key lookup changed; no instrumentation. Entire static JSON output compared byte for byte after every pair. This input-specific check does not replace the full correctness suite.', commit=COMMIT, binarySha256={name:hashlib.sha256(path.read_bytes()).hexdigest() for name,path in [('production', production), ('borrowed_lookup', experiment)]}, outputsByteIdentical=True, summary=summary, samples=samples)
(ROOT / 'benchmarks/results/profile-lookup.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(summary, indent=2))
