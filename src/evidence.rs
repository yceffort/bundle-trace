//! Portable evidence: the exact inputs of one analysis plus the results they produced.
//! Files are copied byte for byte; only filesystem bindings are rewritten.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::{Counts, Report, sha256};

pub const MANIFEST: &str = "manifest.json";
const FORMAT: &str = "coldpath-evidence";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub schema_version: u32,
    /// `full` reproduces the whole analysis; `excerpt` only the selected bundles.
    pub kind: String,
    pub analyzer: Analyzer,
    /// Analyzer options with every path relative to the evidence directory.
    pub invocation: serde_json::Value,
    pub files: Vec<FileEntry>,
    pub expected: Expected,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<Excerpt>,
}

/// What an excerpt contains, and what it cannot show.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    /// `--export-select` values and the bundles they resolved to.
    pub selectors: Vec<String>,
    pub bundles: Vec<String>,
    /// Coverage files reduced to the selected scripts.
    pub derived: Vec<Derived>,
    /// Inputs of the full analysis left out: located files by their `tree/` path,
    /// other inputs by file name.
    pub omitted: Vec<FileEntry>,
    pub full_analysis: FullAnalysis,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    pub path: String,
    pub original_sha256: String,
    pub removed_entries: usize,
}

/// Results of the full analysis, kept as context. Replaying the excerpt cannot reproduce them.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullAnalysis {
    pub reproducible: bool,
    pub bundles: usize,
    pub totals: Counts,
    pub scenario_totals: BTreeMap<String, Counts>,
    pub excluded_bundles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analyzer {
    pub version: String,
    pub commit: Option<String>,
}

impl Analyzer {
    pub fn current() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").into(),
            commit: option_env!("COLDPATH_COMMIT").map(Into::into),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub role: String,
    pub sha256: String,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub scenarios: Vec<String>,
    /// Whole-analysis results; absent from an excerpt, which verifies bundles only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totals: Option<Counts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_totals: Option<BTreeMap<String, Counts>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_bundles: Option<Vec<String>>,
    pub bundles: Vec<ExpectedBundle>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedBundle {
    pub path: String,
    pub sha256: String,
    pub source_map_sha256: Option<String>,
    /// `scenario: source/source-map` verification, in recording order.
    pub verification: Vec<String>,
    pub counts: Counts,
    /// Digest of every span boundary, source, and status; one per scenario too.
    pub spans_sha256: String,
    pub scenario_spans_sha256: BTreeMap<String, String>,
}

impl Expected {
    /// Requires a detailed report: span digests are the interval-boundary evidence.
    pub fn from_report(report: &Report) -> Result<Self> {
        ensure!(report.details, "evidence requires detailed analysis");
        let digest = |bundle: &crate::BundleRow, spans: &[crate::Span]| {
            let rows = spans
                .iter()
                .map(|s| (s.start, s.end, &bundle.sources[s.source].source, s.status))
                .collect::<Vec<_>>();
            sha256(&serde_json::to_vec(&rows).unwrap())
        };
        Ok(Self {
            scenarios: report.scenarios.clone(),
            totals: Some(report.totals.clone()),
            scenario_totals: Some(scenario_totals(report)),
            excluded_bundles: Some(report.excluded_bundles.clone()),
            bundles: report
                .bundles
                .iter()
                .map(|b| ExpectedBundle {
                    path: b.path.clone(),
                    sha256: b.sha256.clone(),
                    source_map_sha256: b.source_map_sha256.clone(),
                    verification: b
                        .verification
                        .iter()
                        .map(|v| format!("{}: {}/{}", v.scenario, v.source, v.source_map))
                        .collect(),
                    counts: b.counts.clone(),
                    spans_sha256: digest(b, &b.spans),
                    scenario_spans_sha256: b
                        .scenario_spans
                        .iter()
                        .map(|(name, spans)| (name.clone(), digest(b, spans)))
                        .collect(),
                })
                .collect(),
        })
    }

    /// The selected bundles only, without whole-analysis results.
    pub fn excerpt(report: &Report, bundles: &BTreeSet<String>) -> Result<Self> {
        let mut expected = Self::from_report(report)?;
        expected.bundles.retain(|b| bundles.contains(&b.path));
        (
            expected.totals,
            expected.scenario_totals,
            expected.excluded_bundles,
        ) = (None, None, None);
        Ok(expected)
    }

    /// Human-readable differences; empty when the replay reproduced every recorded
    /// result. Results absent from `self` are not compared.
    pub fn differences(&self, actual: &Self) -> Vec<String> {
        let mut out = Vec::new();
        let mut check = |what: &str, expected: String, actual: String| {
            if expected != actual {
                out.push(format!("{what}: expected {expected}, got {actual}"));
            }
        };
        check(
            "scenarios",
            format!("{:?}", self.scenarios),
            format!("{:?}", actual.scenarios),
        );
        if let Some(totals) = &self.totals {
            check(
                "totals",
                format!("{totals:?}"),
                format!("{:?}", actual.totals.as_ref().unwrap()),
            );
        }
        if let Some(totals) = &self.scenario_totals {
            check(
                "scenario totals",
                format!("{totals:?}"),
                format!("{:?}", actual.scenario_totals.as_ref().unwrap()),
            );
        }
        if let Some(excluded) = &self.excluded_bundles {
            check(
                "excluded bundles",
                format!("{excluded:?}"),
                format!("{:?}", actual.excluded_bundles.as_ref().unwrap()),
            );
        }
        let actual_bundles = actual
            .bundles
            .iter()
            .map(|b| (&b.path, b))
            .collect::<BTreeMap<_, _>>();
        for bundle in &self.bundles {
            match actual_bundles.get(&bundle.path) {
                None => out.push(format!("{}: bundle missing from replay", bundle.path)),
                Some(actual) if *actual != bundle => out.push(format!(
                    "{}: results differ (counts {:?} -> {:?}; spans {}; verification {:?} -> {:?})",
                    bundle.path,
                    bundle.counts,
                    actual.counts,
                    if bundle.spans_sha256 == actual.spans_sha256
                        && bundle.scenario_spans_sha256 == actual.scenario_spans_sha256
                    {
                        "unchanged"
                    } else {
                        "changed"
                    },
                    bundle.verification,
                    actual.verification
                )),
                Some(_) => {}
            }
        }
        for path in actual_bundles.keys() {
            if !self.bundles.iter().any(|b| &&b.path == path) {
                out.push(format!("{path}: bundle only in replay"));
            }
        }
        out
    }
}

fn scenario_totals(report: &Report) -> BTreeMap<String, Counts> {
    report
        .scenario_reports
        .iter()
        .map(|s| (s.scenario.clone(), s.totals.clone()))
        .collect()
}

/// Copies inputs into a new evidence directory. Files whose location matters to
/// analysis (bundles, maps, roots) keep their layout below a common ancestor.
pub struct Writer {
    out: PathBuf,
    ancestor: PathBuf,
    files: BTreeMap<String, FileEntry>,
    inputs: usize,
    derived: Vec<Derived>,
    omitted: BTreeMap<String, FileEntry>,
}

impl Writer {
    pub fn new(out: &Path, located: &[PathBuf]) -> Result<Self> {
        ensure!(
            !out.exists() || fs::read_dir(out)?.next().is_none(),
            "evidence directory must be new or empty: {}",
            out.display()
        );
        let mut ancestor = located
            .first()
            .context("evidence needs an analysis root")?
            .clone();
        for path in located {
            while !path.starts_with(&ancestor) {
                ensure!(ancestor.pop(), "inputs do not share a filesystem root");
            }
        }
        fs::create_dir_all(out)?;
        Ok(Self {
            out: out.into(),
            ancestor,
            files: BTreeMap::new(),
            inputs: 0,
            derived: Vec::new(),
            omitted: BTreeMap::new(),
        })
    }

    fn tree_path(&self, path: &Path) -> Result<String> {
        let relative = path
            .strip_prefix(&self.ancestor)
            .with_context(|| format!("{} is outside the evidence tree", path.display()))?;
        let mut out = String::from("tree");
        for part in relative.components() {
            out.push('/');
            out.push_str(&part.as_os_str().to_string_lossy());
        }
        Ok(out)
    }

    /// A located directory (analysis or build root); recreated even when empty.
    pub fn tree_dir(&mut self, path: &Path) -> Result<String> {
        let relative = self.tree_path(path)?;
        fs::create_dir_all(self.out.join(&relative))?;
        Ok(relative)
    }

    /// A located file, copied to the same position relative to the other located paths.
    pub fn tree_file(&mut self, path: &Path, role: &str) -> Result<String> {
        let relative = self.tree_path(path)?;
        self.copy(path, relative, role)
    }

    /// A file whose location does not matter; its file name is kept (coverage
    /// scenario names come from it).
    pub fn input(&mut self, path: &Path, role: &str) -> Result<String> {
        let relative = self.input_path(path)?;
        self.copy(path, relative, role)
    }

    /// An input written as `data` instead of its original bytes, recorded with the
    /// original's hash.
    pub fn derived(
        &mut self,
        path: &Path,
        data: &[u8],
        role: &str,
        removed_entries: usize,
    ) -> Result<String> {
        let relative = self.input_path(path)?;
        let original = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        self.derived.push(Derived {
            path: relative.clone(),
            original_sha256: sha256(&original),
            removed_entries,
        });
        self.store(&relative, data, role)?;
        Ok(relative)
    }

    /// Records an input the excerpt leaves out. Files copied anyway are not listed.
    pub fn omit(&mut self, path: &Path, role: &str) -> Result<()> {
        let relative = match self.tree_path(path) {
            Ok(relative) => relative,
            Err(_) => path
                .file_name()
                .with_context(|| format!("{} has no file name", path.display()))?
                .to_string_lossy()
                .into_owned(),
        };
        let data = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        self.omitted.entry(relative.clone()).or_insert(FileEntry {
            path: relative,
            role: role.into(),
            sha256: sha256(&data),
        });
        Ok(())
    }

    fn input_path(&mut self, path: &Path) -> Result<String> {
        let name = path
            .file_name()
            .with_context(|| format!("{} has no file name", path.display()))?
            .to_string_lossy();
        let relative = format!("inputs/{}/{name}", self.inputs);
        self.inputs += 1;
        Ok(relative)
    }

    fn copy(&mut self, path: &Path, relative: String, role: &str) -> Result<String> {
        if !self.files.contains_key(&relative) {
            let data = fs::read(path).with_context(|| format!("read {}", path.display()))?;
            self.store(&relative, &data, role)?;
        }
        Ok(relative)
    }

    fn store(&mut self, relative: &str, data: &[u8], role: &str) -> Result<()> {
        let target = self.out.join(relative);
        fs::create_dir_all(target.parent().unwrap())?;
        fs::write(&target, data)?;
        self.files.insert(
            relative.into(),
            FileEntry {
                path: relative.into(),
                role: role.into(),
                sha256: sha256(data),
            },
        );
        Ok(())
    }

    /// `selected` makes an excerpt: `(selectors, bundles)` from `--export-select`.
    pub fn finish(
        self,
        invocation: serde_json::Value,
        report: &Report,
        selected: Option<(Vec<String>, BTreeSet<String>)>,
    ) -> Result<()> {
        let (kind, expected, excerpt) = match selected {
            None => ("full", Expected::from_report(report)?, None),
            Some((selectors, bundles)) => (
                "excerpt",
                Expected::excerpt(report, &bundles)?,
                Some(Excerpt {
                    selectors,
                    bundles: bundles.into_iter().collect(),
                    derived: self.derived,
                    omitted: self
                        .omitted
                        .into_values()
                        .filter(|f| !self.files.contains_key(&f.path))
                        .collect(),
                    full_analysis: FullAnalysis {
                        reproducible: false,
                        bundles: report.bundles.len(),
                        totals: report.totals.clone(),
                        scenario_totals: scenario_totals(report),
                        excluded_bundles: report.excluded_bundles.clone(),
                    },
                }),
            ),
        };
        let manifest = Manifest {
            format: FORMAT.into(),
            schema_version: 1,
            kind: kind.into(),
            analyzer: Analyzer::current(),
            invocation,
            files: self.files.into_values().collect(),
            expected,
            excerpt,
        };
        fs::write(
            self.out.join(MANIFEST),
            serde_json::to_string_pretty(&manifest)? + "\n",
        )?;
        Ok(())
    }
}

/// Reads a manifest and rejects any listed file that is missing or changed.
pub fn open(dir: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(
        &fs::read(dir.join(MANIFEST))
            .with_context(|| format!("read {}", dir.join(MANIFEST).display()))?,
    )
    .context("invalid evidence manifest")?;
    ensure!(
        manifest.format == FORMAT && manifest.schema_version == 1,
        "unsupported evidence format {} v{}",
        manifest.format,
        manifest.schema_version
    );
    match (manifest.kind.as_str(), &manifest.excerpt) {
        ("full", None) | ("excerpt", Some(_)) => {}
        (kind, _) => bail!("evidence kind {kind:?} cannot be replayed"),
    }
    for file in &manifest.files {
        ensure!(
            Path::new(&file.path)
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
            "unsafe evidence path {}",
            file.path
        );
        let data = fs::read(dir.join(&file.path))
            .with_context(|| format!("evidence file missing: {}", file.path))?;
        ensure!(
            sha256(&data) == file.sha256,
            "evidence file changed: {} no longer matches its manifest SHA-256",
            file.path
        );
    }
    Ok(manifest)
}
