// Evidence manifests record the analyzer commit; `-dirty` marks uncommitted changes.
use std::process::Command;

fn git(args: &[&str]) -> Option<std::process::Output> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
}

fn main() {
    println!("cargo:rerun-if-env-changed=COLDPATH_COMMIT");
    // Missing paths would force a rerun on every build.
    for path in [
        ".git/HEAD",
        ".git/index",
        ".git/refs",
        ".git/packed-refs",
        "src",
    ] {
        if std::path::Path::new(path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    if std::env::var_os("COLDPATH_COMMIT").is_some() {
        return;
    }
    let Some(head) = git(&["rev-parse", "HEAD"]) else {
        return;
    };
    let mut commit = String::from_utf8_lossy(&head.stdout).trim().to_owned();
    if git(&["status", "--porcelain", "--untracked-files=no"]).is_none_or(|o| !o.stdout.is_empty())
    {
        commit.push_str("-dirty");
    }
    println!("cargo:rustc-env=COLDPATH_COMMIT={commit}");
}
