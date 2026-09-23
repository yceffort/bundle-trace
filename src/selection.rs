//! CLI file/glob selection. Paths stay relative to an explicit or inferred root.
use anyhow::{Context, Result, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct Selection {
    pub root: PathBuf,
    pub files: Vec<PathBuf>,
    pub maps: BTreeMap<String, PathBuf>,
}

/// Inputs are relative to the working directory, even when a root is supplied.
pub fn resolve(patterns: &[String], root: Option<&Path>) -> Result<Selection> {
    let mut paths = BTreeSet::new();
    for pattern in patterns {
        // Prefer a literal path: square brackets in actual filenames are valid.
        if Path::new(pattern).is_file() {
            paths.insert(fs::canonicalize(pattern)?);
            continue;
        }
        let mut matched = false;
        for path in glob::glob(pattern).with_context(|| format!("invalid file glob: {pattern}"))? {
            let path = path?;
            ensure!(path.is_file(), "input is not a file: {}", path.display());
            paths.insert(fs::canonicalize(path)?);
            matched = true;
        }
        ensure!(matched, "input matched no files: {pattern}");
    }
    let mut scripts = Vec::new();
    let mut map_files = Vec::new();
    for path in paths {
        match path.extension().and_then(|s| s.to_str()) {
            Some("js" | "mjs" | "cjs") => scripts.push(path),
            Some("map") => map_files.push(path),
            _ => anyhow::bail!(
                "unsupported input {}; expected JavaScript or .map",
                path.display()
            ),
        }
    }
    ensure!(!scripts.is_empty(), "no JavaScript input files");
    let root = if let Some(root) = root {
        let root = fs::canonicalize(root)
            .with_context(|| format!("resolve analysis root {}", root.display()))?;
        ensure!(
            root.is_dir(),
            "analysis root is not a directory: {}",
            root.display()
        );
        for script in &scripts {
            ensure!(
                script.starts_with(&root),
                "input file {} is outside analysis root {}",
                script.display(),
                root.display()
            );
        }
        root
    } else {
        let mut root = scripts[0].parent().unwrap().to_path_buf();
        for script in &scripts[1..] {
            while !script.starts_with(&root) {
                ensure!(root.pop(), "inputs do not share a filesystem root");
            }
        }
        root
    };
    let relative = |path: &Path| -> Result<String> {
        Ok(path
            .strip_prefix(&root)?
            .to_string_lossy()
            .replace('\\', "/"))
    };
    let mut maps = BTreeMap::new();
    for map in &map_files {
        let script = scripts
            .iter()
            .find(|script| map.as_os_str() == format!("{}.map", script.display()).as_str())
            .or_else(|| (scripts.len() == 1 && map_files.len() == 1).then_some(&scripts[0]))
            .with_context(|| {
                format!(
                    "cannot pair {}; use --dir and --map bundle=map",
                    map.display()
                )
            })?;
        ensure!(
            maps.insert(relative(script)?, map.clone()).is_none(),
            "multiple maps for {}",
            script.display()
        );
    }
    let files = scripts
        .iter()
        .map(|p| p.strip_prefix(&root).map(Path::to_path_buf))
        .collect::<std::result::Result<_, _>>()?;
    Ok(Selection { root, files, maps })
}
