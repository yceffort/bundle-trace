//! Optional annotations attached after analysis: inferred source labels and bundle load causes.
//! Neither is attribution evidence; both are carried through to reports as supplied.

use std::collections::BTreeMap;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::Report;

/// A description of one report source, usually produced by `coldpath label`.
/// `name`, `kind`, `reasoning`, `evidence` and `contents` are guesses about identity; `summary` describes the code.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceLabel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    /// For a source that is a whole chunk: what it appears to contain, each with its own evidence.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contents: Vec<LabelPart>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelPart {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelGenerator {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LabelsFile {
    schema_version: u32,
    #[serde(default)]
    generator: Option<LabelGenerator>,
    sources: BTreeMap<String, SourceLabel>,
}

/// What caused the browser to request a bundle.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Load {
    /// Referenced by the initial HTML document (script tag or preload).
    Html,
    /// Not a tag, but named inside inline data of the initial HTML (for example a Next.js RSC payload).
    Inline,
    /// Requested by other scripts at runtime (dynamic import, injected tags).
    Dynamic,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Loading {
    pub load: Load,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initiator: Option<String>,
    /// Request start relative to the first request of the recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoadingFile {
    schema_version: u32,
    bundles: BTreeMap<String, Loading>,
}

/// Attach labels keyed by report source name. Evidence strings absent from available source content are dropped.
pub fn attach_labels(report: &mut Report, data: &[u8]) -> Result<()> {
    let file: LabelsFile = serde_json::from_slice(data).context("invalid --labels file")?;
    ensure!(
        file.schema_version == 1,
        "unsupported --labels schemaVersion {}",
        file.schema_version
    );
    let mut labels = file.sources;
    let mut dropped = BTreeMap::<String, usize>::new();
    for bundle in &mut report.bundles {
        for source in &mut bundle.sources {
            let Some(label) = labels.get_mut(&source.source) else {
                continue;
            };
            if let Some(content) = &source.content {
                let found = |e: &String| content.contains(e.as_str());
                let before = label.evidence.len()
                    + label
                        .contents
                        .iter()
                        .map(|p| p.evidence.len())
                        .sum::<usize>();
                label.evidence.retain(found);
                for part in &mut label.contents {
                    part.evidence.retain(found);
                }
                label.contents.retain(|part| !part.evidence.is_empty());
                let after = label.evidence.len()
                    + label
                        .contents
                        .iter()
                        .map(|p| p.evidence.len())
                        .sum::<usize>();
                *dropped.entry(source.source.clone()).or_default() += before - after;
            }
            source.label = Some(label.clone());
        }
    }
    for (source, count) in dropped.into_iter().filter(|(_, n)| *n > 0) {
        report.warnings.push(format!(
            "{source}: dropped {count} label evidence strings not found in its source content"
        ));
    }
    let mut unmatched = 0;
    for (name, label) in labels {
        match report.sources.iter_mut().find(|row| row.source == name) {
            Some(row) => row.label = Some(label),
            None => unmatched += 1,
        }
    }
    if unmatched > 0 {
        report.warnings.push(format!(
            "{unmatched} --labels entries match no report source"
        ));
    }
    report.label_generator = file.generator;
    Ok(())
}

/// Attach load causes keyed by analysis-root-relative bundle path.
pub fn attach_loading(report: &mut Report, data: &[u8]) -> Result<()> {
    let file: LoadingFile = serde_json::from_slice(data).context("invalid --loading file")?;
    ensure!(
        file.schema_version == 1,
        "unsupported --loading schemaVersion {}",
        file.schema_version
    );
    let mut bundles = file.bundles;
    for bundle in &mut report.bundles {
        bundle.loading = bundles.remove(&bundle.path);
    }
    if !bundles.is_empty() {
        report.warnings.push(format!(
            "{} --loading entries match no analyzed bundle",
            bundles.len()
        ));
    }
    Ok(())
}
