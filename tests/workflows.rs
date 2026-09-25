use coldpath::{AnalyzeOptions, Status, analyze_with_options, ci, graph, sha256};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "coldpath-workflows-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, path: &str, text: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::write(&path, text).unwrap();
        path
    }
    fn map(&self, sources: &[&str]) {
        self.write("app.js.map", &json!({"version":3,"sources":sources,"names":[],"mappings":sources.iter().enumerate().map(|(i,_)| if i==0 {"AAAA"} else {"ICAA"}).collect::<Vec<_>>().join(",")}).to_string());
    }
    fn coverage(&self, name: &str, source: &str, ranges: Value) -> PathBuf {
        self.write(name, &json!({"schemaVersion":1,"scenario":name,"scripts":[{"path":"app.js","sha256":sha256(source.as_bytes()),"sourceMapSha256":fs::read(self.0.join("app.js.map")).ok().map(|m|sha256(&m)),"functions":if ranges.as_array().unwrap().is_empty() { json!([]) } else {json!([{"isBlockCoverage":true,"ranges":ranges}])}}]}).to_string())
    }
    fn empty(&self, name: &str) -> PathBuf {
        self.write(
            name,
            &json!({"schemaVersion":1,"scenario":name,"scripts":[]}).to_string(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn ordered_observation_and_scenario_spans_preserve_unicode_and_overlap() {
    let f = Fixture::new();
    let source = "한🔥xyz";
    f.write("app.js", source);
    f.map(&["src/app.ts"]);
    let initial = f.coverage(
        "initial",
        source,
        json!([{"startOffset":0,"endOffset":3,"count":1}]),
    );
    let open = f.coverage(
        "open",
        source,
        json!([{"startOffset":1,"endOffset":4,"count":1}]),
    );
    let search = f.coverage(
        "search",
        source,
        json!([{"startOffset":3,"endOffset":6,"count":1}]),
    );
    let files = [search, initial, open];
    let mut options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        scenario_order: vec!["initial".into(), "open".into(), "search".into()],
        source_compression: true,
        ..Default::default()
    };
    let mut report = analyze_with_options(&f.0, &files, &options).unwrap();
    let b = &report.bundles[0];
    let s = &b.sources[0];
    assert_eq!(
        s.first_observed
            .iter()
            .map(|p| (&*p.scenario, p.bytes, p.earlier_unmeasured))
            .collect::<Vec<_>>(),
        [
            ("initial", 7, false),
            ("open", 1, false),
            ("search", 2, false)
        ]
    );
    assert_eq!(s.counts.observed_bytes, 10);
    for (scenario, observed) in [("initial", 7), ("open", 5), ("search", 3)] {
        let spans = &b.scenario_spans[scenario];
        assert_eq!(
            spans.iter().map(|s| s.end - s.start).sum::<usize>(),
            source.len()
        );
        assert_eq!(
            spans
                .iter()
                .filter(|s| s.status == Status::Observed)
                .map(|s| s.end - s.start)
                .sum::<usize>(),
            observed
        );
        for span in spans {
            assert_eq!(
                source[..span.start].encode_utf16().count(),
                span.start_utf16
            );
            assert_eq!(source[..span.end].encode_utf16().count(), span.end_utf16);
        }
    }
    assert_eq!(
        s.estimated_compression.as_ref().unwrap().gzip_bytes,
        ci::compress(source.as_bytes()).unwrap().gzip_bytes
    );
    let candidate = &report.scenario_reports[2].interaction_candidates[0];
    assert_eq!(candidate.interaction_only_bytes, 3); // Difference from initial, not preceding interaction.
    assert_eq!(
        candidate
            .estimated_deferrable_compression
            .as_ref()
            .unwrap()
            .gzip_bytes,
        ci::compress(b"xyz").unwrap().gzip_bytes
    );
    let serialized = serde_json::to_value(&report).unwrap();
    assert!(serialized["packages"][0]["estimatedCompression"]["gzipBytes"].is_number());
    report.strip_details();
    assert!(report.bundles[0].scenario_spans.is_empty());
    options.scenario_order.clear();
    let implicit = analyze_with_options(&f.0, &files, &options).unwrap();
    assert_eq!(implicit.scenarios, ["initial", "search", "open"]);
    assert_eq!(implicit.bundles[0].sources[0].first_observed.len(), 2);
    let comparison =
        coldpath::baseline::compare(&implicit, &serde_json::to_vec(&report).unwrap()).unwrap();
    assert!(
        !comparison
            .warnings
            .iter()
            .any(|w| w.contains("Scenario sets differ"))
    );
    for bad in [
        vec!["initial", "open"],
        vec!["initial", "open", "open"],
        vec!["open", "initial", "search"],
    ] {
        options.scenario_order = bad.into_iter().map(String::from).collect();
        assert!(analyze_with_options(&f.0, &files, &options).is_err());
    }
}

#[test]
fn missing_earlier_measurements_never_become_deferral_or_removal_evidence() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.map(&["src/lazy.js"]);
    let options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        source_compression: true,
        ..Default::default()
    };
    let report = analyze_with_options(
        &f.0,
        &[
            f.empty("initial"),
            f.coverage(
                "later",
                "abcd",
                json!([{"startOffset":0,"endOffset":2,"count":1}]),
            ),
        ],
        &options,
    )
    .unwrap();
    assert!(report.bundles[0].sources[0].first_observed[0].earlier_unmeasured);
    assert!(
        report.bundles[0].scenario_spans["initial"]
            .iter()
            .all(|s| s.status == Status::Unmeasured)
    );
    let candidate = &report.scenario_reports[1].interaction_candidates[0];
    assert_eq!(candidate.interaction_only_bytes, 0);
    assert_eq!(candidate.initial_unmeasured_observed_bytes, 2);
    assert!(candidate.estimated_deferrable_compression.is_none());
    assert_eq!(report.recommendations[0].kind, "measure-initial");
    assert!(report.recommendations[0].estimated_compression.is_none());
    let report = analyze_with_options(
        &f.0,
        &[f.empty("initial"), f.coverage("later", "abcd", json!([]))],
        &options,
    )
    .unwrap();
    assert!(report.recommendations.is_empty());
}

fn evidence_graph() -> Value {
    json!({"schemaVersion":1,"bundler":"webpack","modules":[
        {"id":"entry","source":"src/main.js","entry":true},{"id":"middle","source":"src/middle.js"},
        {"id":"a","source":"src/a.js"},{"id":"b","source":"src/b.js"}],"edges":[
        {"from":"entry","to":"a","kind":"dynamic","location":{"line":1,"column":1}},
        {"from":"entry","to":"middle","kind":"static","location":{"line":2,"column":1}},
        {"from":"middle","to":"a","kind":"static","location":{"line":12,"column":3},"locationEvidence":"webpack-stats"},
        {"from":"middle","to":"b","kind":"static","location":{"line":13,"column":1}},
        {"from":"a","to":"middle","kind":"static"}]})
}

#[test]
fn graph_recommendations_prefer_static_evidence_and_distinguish_partial_initial_use() {
    let f = Fixture::new();
    let source = "abcdefghijkl";
    f.write("app.js", source);
    f.map(&[
        "webpack://app/./src/a.js",
        "turbopack:///[project]/src/b.js",
        "src/never.js",
    ]);
    let options = AnalyzeOptions {
        initial_scenario: Some("initial".into()),
        source_compression: true,
        ..Default::default()
    };
    let files = [
        f.coverage(
            "initial",
            source,
            json!([{"startOffset":0,"endOffset":2,"count":1}]),
        ),
        f.coverage(
            "open",
            source,
            json!([{"startOffset":0,"endOffset":8,"count":1}]),
        ),
    ];
    let mut report = analyze_with_options(&f.0, &files, &options).unwrap();
    let data = evidence_graph();
    graph::attach(&mut report, &serde_json::to_vec(&data).unwrap(), &f.0, &f.0).unwrap();
    let path = report
        .import_paths
        .as_ref()
        .unwrap()
        .iter()
        .find(|p| p.source == "src/a.js")
        .unwrap();
    assert_eq!(
        path.path.as_ref().unwrap(),
        &["src/main.js", "src/middle.js", "src/a.js"]
    );
    assert_eq!(path.edges[1].location.as_ref().unwrap().line, 12);
    assert_eq!(
        path.resolved_source.as_deref(),
        Some("webpack://app/src/a.js")
    );
    let recommendations = &report.recommendations;
    assert!(
        recommendations
            .iter()
            .any(|r| r.kind == "split-review" && r.bytes == 2 && r.source.ends_with("/a.js"))
    );
    assert!(
        recommendations
            .iter()
            .any(|r| r.kind == "defer-review" && r.bytes == 4 && r.source.ends_with("/b.js"))
    );
    assert!(
        recommendations
            .iter()
            .any(|r| r.kind == "removal-review" && r.source == "src/never.js")
    );
    let md = ci::markdown(&report);
    assert!(md.contains("src/middle.js:12:3"));
    assert!(md.contains("not additive transfer savings"));
    let mut dynamic = data.clone();
    dynamic["edges"][1]["kind"] = json!("dynamic");
    graph::attach(
        &mut report,
        &serde_json::to_vec(&dynamic).unwrap(),
        &f.0,
        &f.0,
    )
    .unwrap();
    assert!(
        report
            .recommendations
            .iter()
            .any(|r| r.kind == "dynamic-boundary-review")
    );
    let mut bad = data.clone();
    bad["edges"][0]["to"] = json!("missing");
    assert!(graph::attach(&mut report, &serde_json::to_vec(&bad).unwrap(), &f.0, &f.0).is_err());
    let mut bad = data.clone();
    bad["edges"][0]["location"]["column"] = json!(0);
    assert!(graph::attach(&mut report, &serde_json::to_vec(&bad).unwrap(), &f.0, &f.0).is_err());
    let mut bad = data;
    bad["schemaVersion"] = json!(99);
    assert!(graph::attach(&mut report, &serde_json::to_vec(&bad).unwrap(), &f.0, &f.0).is_err());
}

#[test]
fn unobserved_budget_fails_without_selected_measurements_but_accepts_measured_zero_use() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.write("other.js", "unused");
    f.empty("empty.json");
    f.write(
        "other.json",
        &json!([{"url":"other.js","text":"unused","ranges":[]}]).to_string(),
    );
    f.coverage("measured.json", "abcd", json!([]));
    let run = |coverage: Option<&str>, budget: &str| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_coldpath"));
        cmd.current_dir(&f.0)
            .args(["app.js", "--max-unobserved-bytes", budget, "--json", "-"]);
        if let Some(path) = coverage {
            cmd.args(["--coverage", path]);
        }
        cmd.output().unwrap()
    };
    for coverage in [None, Some("empty.json"), Some("other.json")] {
        let output = run(coverage, "100");
        assert_eq!(
            output.status.code(),
            Some(2),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            report["budgetFailures"][0]
                .as_str()
                .unwrap()
                .contains("without measured coverage")
        );
    }
    assert!(run(Some("measured.json"), "4").status.success());
    assert_eq!(run(Some("measured.json"), "0").status.code(), Some(2));
}

#[test]
fn graph_source_hashes_reject_stale_locations_and_keep_compact_exports_compact() {
    let f = Fixture::new();
    f.write("app.js", "abcd");
    f.write("app.js.map", &json!({"version":3,"sources":["src/a.js"],"sourcesContent":["ORIGINAL_SNAPSHOT"],"names":[],"mappings":"AAAA"}).to_string());
    let data = json!({"schemaVersion":1,"bundler":"rollup","modules":[
        {"id":"a","source":"src/a.js","entry":true,"sourceSha256":sha256(b"ORIGINAL_SNAPSHOT")},
        {"id":"b","source":"src/b.js"}],"edges":[
        {"from":"a","to":"b","kind":"static","location":{"line":1,"column":1},"locationEvidence":"plugin-input"}]});
    f.write("graph.json", &data.to_string());
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_coldpath"))
            .current_dir(&f.0)
            .args([
                "--dir",
                ".",
                "--graph",
                "graph.json",
                "--graph-root",
                ".",
                "--json",
                "-",
                "--treemap",
                "compact.html",
                "--why",
                "src/a.js",
            ])
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["details"], false);
    assert!(report["bundles"][0]["generatedSource"].is_null());
    assert!(report["bundles"][0]["scenarioSpans"].is_null());
    assert!(
        report["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("1 matched sourcesContent"))
    );
    assert!(
        !fs::read_to_string(f.0.join("compact.html"))
            .unwrap()
            .contains("ORIGINAL_SNAPSHOT")
    );
    let mut stale = data.clone();
    stale["modules"][0]["sourceSha256"] = json!(sha256(b"OLD_SOURCE"));
    f.write("graph.json", &stale.to_string());
    let output = run();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("graph source snapshot differs"));
    // Babel-style loaders replace sourcesContent; the file on disk still matches the graph.
    fs::create_dir_all(f.0.join("src")).unwrap();
    let on_disk = f.write("src/a.js", "OLD_SOURCE");
    let output = run();
    fs::remove_file(on_disk).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report["warnings"].as_array().unwrap().iter().any(|w| {
        let w = w.as_str().unwrap();
        w.contains("0 matched sourcesContent") && w.contains("1 matched only the file on disk")
    }));
    let mut report = coldpath::analyze(&f.0, &[]).unwrap();
    let mut no_entry = data.clone();
    no_entry["modules"][0]["entry"] = json!(false);
    assert!(
        graph::attach(
            &mut report,
            &serde_json::to_vec(&no_entry).unwrap(),
            &f.0,
            &f.0
        )
        .is_err()
    );
    let mut duplicate = data;
    duplicate["modules"][1]["id"] = json!("a");
    assert!(
        graph::attach(
            &mut report,
            &serde_json::to_vec(&duplicate).unwrap(),
            &f.0,
            &f.0
        )
        .is_err()
    );
}

#[test]
fn labels_and_loading_attach_without_changing_counts_and_drop_absent_evidence() {
    let f = Fixture::new();
    let source = "var a=1;var b=2;";
    f.write("app.js", source);
    f.write("app.js.map", &json!({"version":3,"sources":["m/1.js","m/2.js"],"sourcesContent":["var a=1;","var b=2;"],"names":[],"mappings":"AAAA,QCAA"}).to_string());
    let mut report = analyze_with_options(&f.0, &[], &AnalyzeOptions::default()).unwrap();
    let before = serde_json::to_value(&report.totals).unwrap();
    let labels = json!({"schemaVersion":1,"generator":{"provider":"test","model":"m","mode":"identify"},"sources":{
        "m/1.js":{"name":"first","shortName":"first","kind":"app","summary":"s","reasoning":"r","evidence":["var a=1","not in source"]},
        "m/2.js":{"summary":"only a summary","contents":[{"name":"p","kind":"package","evidence":["var b=2"]},{"name":"q","evidence":["missing"]}]},
        "m/missing.js":{"summary":"x"}}});
    coldpath::annotations::attach_labels(&mut report, labels.to_string().as_bytes()).unwrap();
    let loading = json!({"schemaVersion":1,"bundles":{"app.js":{"load":"html","initiator":"parser","startMs":5},"gone.js":{"load":"dynamic"}}});
    coldpath::annotations::attach_loading(&mut report, loading.to_string().as_bytes()).unwrap();
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["totals"], before);
    let first = value["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["source"] == "m/1.js")
        .unwrap();
    assert_eq!(first["label"]["evidence"], json!(["var a=1"]));
    assert_eq!(value["bundles"][0]["sources"][0]["label"]["name"], "first");
    assert_eq!(
        value["bundles"][0]["sources"][1]["label"],
        json!({"summary":"only a summary","contents":[{"name":"p","kind":"package","evidence":["var b=2"]}]})
    );
    assert_eq!(
        value["bundles"][0]["loading"],
        json!({"load":"html","initiator":"parser","startMs":5})
    );
    assert_eq!(value["labelGenerator"]["model"], "m");
    let warnings = value["warnings"].to_string();
    assert!(warnings.contains("m/1.js: dropped 1 label evidence"));
    assert!(warnings.contains("m/2.js: dropped 1 label evidence"));
    assert!(warnings.contains("1 --labels entries match no report source"));
    assert!(warnings.contains("1 --loading entries match no analyzed bundle"));
    let bad = json!({"schemaVersion":1,"bundles":{"app.js":{"load":"prefetch"}}});
    assert!(
        coldpath::annotations::attach_loading(&mut report, bad.to_string().as_bytes()).is_err()
    );
    let future = json!({"schemaVersion":2,"sources":{}});
    assert!(
        coldpath::annotations::attach_labels(&mut report, future.to_string().as_bytes()).is_err()
    );
    let extra = json!({"schemaVersion":1,"sources":{"m/1.js":{"confidence":"high"}}});
    assert!(
        coldpath::annotations::attach_labels(&mut report, extra.to_string().as_bytes()).is_err()
    );
}
