use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use base64::Engine;

fn annotation(content: &str) -> Option<&str> {
    let content = content.trim_end();
    if let Some(comment) = content.strip_suffix("*/")
        && let Some((_, tail)) = comment
            .rsplit_once("/*#")
            .or_else(|| comment.rsplit_once("/*@"))
        && let Some(reference) = tail.trim().strip_prefix("sourceMappingURL=")
    {
        return Some(reference.trim());
    }
    content
        .lines()
        .next_back()
        .unwrap_or("")
        .trim()
        .strip_prefix("//#")
        .or_else(|| {
            content
                .lines()
                .next_back()
                .unwrap_or("")
                .trim()
                .strip_prefix("//@")
        })
        .and_then(|comment| comment.trim().strip_prefix("sourceMappingURL="))
        .map(str::trim)
}

/// Explicit paths can live outside --dir; discovered references stay inside it.
pub fn load(
    file: &Path,
    content: &str,
    root: &Path,
    explicit: Option<&PathBuf>,
) -> Result<Option<Vec<u8>>> {
    Ok(load_with_location(file, content, root, explicit)?.map(|map| map.data))
}

pub(crate) struct LoadedMap {
    pub data: Vec<u8>,
    /// Directory for resolving sources, including for inline maps.
    pub directory: PathBuf,
    /// The map file read, if the map is not inline.
    pub path: Option<PathBuf>,
}

pub(crate) fn load_with_location(
    file: &Path,
    content: &str,
    root: &Path,
    explicit: Option<&PathBuf>,
) -> Result<Option<LoadedMap>> {
    if let Some(path) = explicit {
        return Ok(Some(LoadedMap {
            data: fs::read(path)
                .with_context(|| format!("read explicit map {}", path.display()))?,
            directory: fs::canonicalize(path)?.parent().unwrap().to_path_buf(),
            path: Some(fs::canonicalize(path)?),
        }));
    }
    if let Some(reference) = annotation(content).and_then(|s| s.strip_prefix("data:")) {
        let (metadata, payload) = reference
            .split_once(',')
            .context("invalid source-map data URL")?;
        ensure!(
            matches!(
                metadata.split(';').next(),
                Some("application/json" | "application/octet-stream" | "")
            ),
            "unsupported source-map data URL media type"
        );
        let payload = percent_encoding::percent_decode_str(payload).collect::<Vec<_>>();
        return Ok(Some(LoadedMap {
            data: if metadata
                .split(';')
                .any(|part| part.eq_ignore_ascii_case("base64"))
            {
                base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .context("invalid base64 source map")?
            } else {
                payload
            },
            directory: fs::canonicalize(file)?.parent().unwrap().to_path_buf(),
            path: None,
        }));
    }
    locate(file, content, root)?
        .map(|path| -> std::io::Result<LoadedMap> {
            Ok(LoadedMap {
                data: fs::read(&path)?,
                directory: path.parent().unwrap().to_path_buf(),
                path: Some(path),
            })
        })
        .transpose()
        .context("read source map")
}

/// Follow a final standalone sourceMappingURL line (including Turbopack's hashed
/// map names), otherwise try the conventional adjacent .map. Never fetch URLs.
pub fn locate(file: &Path, content: &str, root: &Path) -> Result<Option<PathBuf>> {
    let annotation = annotation(content);
    let path = if let Some(reference) = annotation {
        let reference = reference.trim();
        ensure!(
            !reference.contains(':') && !reference.starts_with('/') && !reference.contains('\\'),
            "only relative local sourceMappingURL is supported: {reference}"
        );
        let reference = reference.split(['?', '#']).next().unwrap();
        let decoded = percent_encoding::percent_decode_str(reference).decode_utf8()?;
        ensure!(!decoded.is_empty(), "empty sourceMappingURL");
        file.parent().unwrap().join(decoded.as_ref())
    } else {
        file.with_file_name(format!(
            "{}.map",
            file.file_name().unwrap().to_string_lossy()
        ))
    };
    if !path.try_exists()? {
        ensure!(
            annotation.is_none(),
            "declared source map does not exist: {}",
            path.display()
        );
        return Ok(None);
    }
    let canonical =
        fs::canonicalize(&path).with_context(|| format!("resolve {}", path.display()))?;
    ensure!(
        canonical.starts_with(fs::canonicalize(root)?),
        "source map escapes --dir: {}",
        path.display()
    );
    Ok(Some(canonical))
}
