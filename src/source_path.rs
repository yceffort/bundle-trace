//! Source identities are lexical paths: original files need not exist locally.
use std::path::{Component, Path, PathBuf};

pub(crate) struct SourcePaths<'a> {
    pub root: &'a Path,
    pub directory: &'a Path,
}

impl SourcePaths<'_> {
    pub fn resolve(&self, source: &str) -> String {
        if source == crate::attribution::UNMAPPED {
            return source.into();
        }
        let source = source.replace('\\', "/");
        if let Some((scheme, path)) = source.split_once(':')
            && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            // Preserve virtual URL namespaces, authorities, queries and parent
            // segments. Only redundant dot path components are removed.
            let end = path.find(['?', '#']).unwrap_or(path.len());
            let pathname = &path[..end];
            let start = pathname.strip_prefix("//").map_or(0, |tail| {
                tail.find('/').map_or(pathname.len(), |index| index + 2)
            });
            return format!(
                "{scheme}:{}{}{}",
                &path[..start],
                path[start..end]
                    .split('/')
                    .filter(|part| *part != ".")
                    .collect::<Vec<_>>()
                    .join("/"),
                &path[end..]
            );
        }
        let resolved = normalize(&self.directory.join(&source));
        let root = self.root.components().collect::<Vec<_>>();
        let target = resolved.components().collect::<Vec<_>>();
        let shared = root.iter().zip(&target).take_while(|(a, b)| a == b).count();
        // Different Windows volumes cannot be expressed as relative paths.
        if shared == 0 {
            return resolved.to_string_lossy().replace('\\', "/");
        }
        let mut relative = PathBuf::new();
        for _ in shared..root.len() {
            relative.push("..");
        }
        for component in &target[shared..] {
            relative.push(component.as_os_str());
        }
        if relative.as_os_str().is_empty() {
            ".".into()
        } else {
            relative.to_string_lossy().replace('\\', "/")
        }
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part),
        }
    }
    result
}
