// M3-T1: slug + remote parsing (§9.1, §9.2). M4-T1 adds branch logic.

use crate::error::AdeError;
use git2::{BranchType, Status, StatusOptions};
use std::path::{Path, PathBuf};

/// §9.1 — Lowercase ASCII; every run of chars outside `[a-z0-9]` becomes a single
/// `-`; trim leading/trailing `-`; truncate to 40 chars (then trim `-` again); if
/// empty → `fallback`.
pub fn slugify(input: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in input.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    // Trim leading/trailing dashes.
    let trimmed = out.trim_matches('-');
    // Truncate to 40 chars, then trim dashes again.
    let truncated: String = trimmed.chars().take(40).collect();
    let result = truncated.trim_matches('-').to_string();
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

/// §9.2 — Parse a git remote URL into `(owner, repo)` if it points at github.com,
/// else `None`.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();

    // Forms:
    //   git@github.com:o/r.git           (scp-like)
    //   https://github.com/o/r.git
    //   https://github.com/o/r
    //   ssh://git@github.com/o/r.git
    let rest = [
        "git@github.com:",
        "https://github.com/",
        "ssh://git@github.com/",
        "ssh://github.com/",
        "http://github.com/",
    ]
    .iter()
    .find_map(|prefix| url.strip_prefix(prefix))?;

    // Strip a trailing ".git" suffix if present.
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let rest = rest.trim_end_matches('/');

    let (owner, repo) = rest.split_once('/')?;

    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }

    Some((owner.to_string(), repo.to_string()))
}

/// The git repository working directory at or strictly inside `path`. Returns
/// `None` when no repo is found, or when the discovered repo lives in a *parent*
/// directory (the workspace folder must contain its own repo).
fn repo_workdir_within(path: &Path) -> Option<PathBuf> {
    // discover() walks up parent directories; constrain it by checking the
    // discovered repo's working directory is within (or equal to) `path`.
    let repo = git2::Repository::discover(path).ok()?;
    let workdir = repo.workdir()?;
    let canon_workdir = workdir.canonicalize().ok()?;
    let canon_path = path.canonicalize().ok()?;
    if !canon_workdir.starts_with(&canon_path) {
        return None;
    }
    Some(canon_workdir)
}

/// Map a workspace folder to the git repository it owns and return that repo's
/// working-directory path. Resolution order:
///   1. `root` itself is a git repo (or contains one at its top level).
///   2. `root` is just a container — scan its immediate subdirectories and pick
///      the first (alphabetically) that is a git repo, e.g. `test/` → `test/zkDash`.
///
/// Returns `None` if no repo is found at or one level below `root`. Hidden
/// directories (dot-prefixed) are skipped.
pub fn find_repo_path(root: &str) -> Option<String> {
    let root_path = Path::new(root);

    if let Some(wd) = repo_workdir_within(root_path) {
        return Some(wd.to_string_lossy().into_owned());
    }

    // Container folder: look one level down. Sort for a deterministic pick when
    // several subdirectories are repos.
    let mut subdirs: Vec<PathBuf> = std::fs::read_dir(root_path)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !n.starts_with('.'))
                    .unwrap_or(false)
        })
        .collect();
    subdirs.sort();

    subdirs
        .iter()
        .find_map(|sub| repo_workdir_within(sub).map(|wd| wd.to_string_lossy().into_owned()))
}

/// Outcome of `prepare_branch`: whether a new branch was created, an existing
/// one was reused, or the operation was skipped because the working tree is dirty.
#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum BranchOutcome {
    Created,
    ReusedExisting,
    SkippedDirty,
}

/// §16 step 2, §3, §9.1 — Ensure a branch named `issue-{issue_number}` exists and
/// is checked out. Returns `SkippedDirty` if the working tree has modified/staged
/// files (untracked files are clean). Returns `ReusedExisting` if the branch already
/// exists. Returns `Created` if a new branch was created from HEAD.
#[allow(dead_code)]
pub fn prepare_branch(repo_path: &str, issue_number: u64) -> Result<BranchOutcome, AdeError> {
    let repo = git2::Repository::open(repo_path)?;

    // Check if the working tree is dirty.
    // Per spec: untracked = clean; modified/staged/typechange = dirty.
    let mut status_opts = StatusOptions::new();
    status_opts.include_untracked(false);
    let statuses = repo.statuses(Some(&mut status_opts))?;
    let dirty = statuses.iter().any(|entry| {
        let s = entry.status();
        s != Status::CURRENT && s != Status::IGNORED
    });
    if dirty {
        return Ok(BranchOutcome::SkippedDirty);
    }

    let branch_name = format!("issue-{issue_number}");

    // Check if branch already exists.
    if repo.find_branch(&branch_name, BranchType::Local).is_ok() {
        // Branch exists — checkout it.
        let refname = format!("refs/heads/{branch_name}");
        repo.set_head(&refname)?;
        repo.checkout_head(None)?;
        return Ok(BranchOutcome::ReusedExisting);
    }

    // Create a new branch from HEAD and checkout.
    let head = repo.head()?;
    let target = head.target().ok_or_else(|| {
        AdeError::Other("HEAD has no direct target (symbolic or unborn branch)".into())
    })?;
    let commit = repo.find_commit(target)?;
    repo.branch(&branch_name, &commit, false)?;
    let refname = format!("refs/heads/{branch_name}");
    repo.set_head(&refname)?;
    repo.checkout_head(None)?;

    Ok(BranchOutcome::Created)
}

/// Add a git worktree at `worktree_path` on a fresh branch `branch` cut from
/// `base` (PLANO §3 dispatch). Shells out to `git worktree add` — argv only, no
/// shell string. Used by the gestor to give each task an isolated checkout.
#[allow(dead_code)]
pub fn worktree_add(
    repo_path: &str,
    worktree_path: &str,
    branch: &str,
    base: &str,
) -> Result<(), AdeError> {
    if let Some(parent) = Path::new(worktree_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("worktree")
        .arg("add")
        .arg("-b")
        .arg(branch)
        .arg(worktree_path)
        .arg(base)
        .output()
        .map_err(|e| AdeError::Other(format!("git worktree add: {e}")))?;
    if !out.status.success() {
        return Err(AdeError::Other(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Remove a git worktree (PLANO §3 cleanup). `--force` so a dirty/abandoned
/// worktree still gets cleaned. Best-effort prune of the now-stale admin entry.
#[allow(dead_code)]
pub fn worktree_remove(repo_path: &str, worktree_path: &str) -> Result<(), AdeError> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("worktree")
        .arg("remove")
        .arg("--force")
        .arg(worktree_path)
        .output()
        .map_err(|e| AdeError::Other(format!("git worktree remove: {e}")))?;
    if !out.status.success() {
        return Err(AdeError::Other(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_fix_login_broken() {
        assert_eq!(slugify("Fix: login broken!!", "fb"), "fix-login-broken");
    }

    #[test]
    fn slugify_injection_chars() {
        // `$(rm -rf ~)` + backtick id backtick
        assert_eq!(slugify("$(rm -rf ~)`id`", "fb"), "rm-rf-id");
    }

    #[test]
    fn slugify_unicode() {
        assert_eq!(slugify("ÁÉÍ déjà vu 🚀", "fb"), "d-j-vu");
    }

    #[test]
    fn slugify_empty_uses_fallback() {
        assert_eq!(slugify("", "card-ab12"), "card-ab12");
    }

    #[test]
    fn slugify_all_symbols_uses_fallback() {
        assert_eq!(slugify("!!!", "fb"), "fb");
    }

    #[test]
    fn slugify_truncates_to_40() {
        let input = "a".repeat(60);
        assert_eq!(slugify(&input, "fb"), "a".repeat(40));
    }

    #[test]
    fn parse_scp_with_git_suffix() {
        assert_eq!(
            parse_github_remote("git@github.com:o/r.git"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_https_with_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/o/r.git"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_https_without_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/o/r"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_ssh_scheme_with_git_suffix() {
        assert_eq!(
            parse_github_remote("ssh://git@github.com/o/r.git"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_non_github_returns_none() {
        assert_eq!(parse_github_remote("https://gitlab.com/o/r.git"), None);
    }

    // ---- prepare_branch tests ----

    /// Helper: creates a temp repo with one initial commit (file "hello.txt" with
    /// content "hello"). Returns (Repository, TempDir).
    fn init_test_repo() -> (git2::Repository, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = git2::Repository::init(dir.path()).expect("git init");

        // Create an initial commit so HEAD is not unborn.
        let sig = git2::Signature::now("test", "test@test.com").expect("sig");
        let filepath = dir.path().join("hello.txt");
        std::fs::write(&filepath, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index
            .add_path(std::path::Path::new("hello.txt"))
            .expect("add path");
        index.write().expect("index write");

        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("find tree");
            repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
                .expect("commit");
        }

        (repo, dir)
    }

    #[test]
    fn worktree_add_and_remove_roundtrip() {
        let (repo, dir) = init_test_repo();
        let repo_path = repo.path().parent().unwrap().to_str().unwrap();
        let wt = dir.path().join("wt-task1");
        let wt_str = wt.to_str().unwrap();

        worktree_add(repo_path, wt_str, "gestor/task1", "HEAD").expect("worktree add");
        assert!(wt.join("hello.txt").exists(), "worktree has the checkout");

        worktree_remove(repo_path, wt_str).expect("worktree remove");
        assert!(!wt.exists(), "worktree dir removed");
    }

    #[test]
    fn branch_clean_creates() {
        let (repo, _dir) = init_test_repo();
        let path = repo.path().parent().unwrap().to_str().unwrap();

        let outcome = prepare_branch(path, 42).expect("prepare_branch");
        assert_eq!(outcome, BranchOutcome::Created);

        // Verify the branch exists and is checked out.
        let repo2 = git2::Repository::open(path).expect("reopen");
        let head = repo2.head().expect("head");
        assert_eq!(head.shorthand().unwrap(), "issue-42");
    }

    #[test]
    fn branch_reuse_existing() {
        let (repo, _dir) = init_test_repo();
        let path = repo.path().parent().unwrap().to_str().unwrap();

        // Create the branch the first time.
        let outcome1 = prepare_branch(path, 7).expect("prepare_branch 1");
        assert_eq!(outcome1, BranchOutcome::Created);

        // Call again — should reuse.
        let outcome2 = prepare_branch(path, 7).expect("prepare_branch 2");
        assert_eq!(outcome2, BranchOutcome::ReusedExisting);
    }

    #[test]
    fn branch_dirty_skips() {
        let (repo, dir) = init_test_repo();
        let path = repo.path().parent().unwrap().to_str().unwrap();

        // Modify a tracked file (don't stage it).
        let filepath = dir.path().join("hello.txt");
        std::fs::write(&filepath, "modified").expect("write modified");

        let outcome = prepare_branch(path, 99).expect("prepare_branch");
        assert_eq!(outcome, BranchOutcome::SkippedDirty);

        // Verify the branch was NOT created.
        let repo2 = git2::Repository::open(path).expect("reopen");
        assert!(
            repo2
                .find_branch("issue-99", git2::BranchType::Local)
                .is_err(),
            "branch should not exist when working tree is dirty"
        );
    }

    // ---- find_repo_path tests ----

    fn canon(p: &Path) -> String {
        p.canonicalize().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn find_repo_path_at_root() {
        let (repo, dir) = init_test_repo();
        let _ = repo;
        let found = find_repo_path(dir.path().to_str().unwrap()).expect("repo at root");
        assert_eq!(found, canon(dir.path()));
    }

    #[test]
    fn find_repo_path_in_subdir() {
        // Container folder with no repo, but a repo one level down (e.g. zkDash).
        let container = tempfile::tempdir().expect("container");
        let sub = container.path().join("zkDash");
        std::fs::create_dir(&sub).expect("mkdir sub");
        git2::Repository::init(&sub).expect("git init sub");

        let found = find_repo_path(container.path().to_str().unwrap()).expect("repo in subdir");
        assert_eq!(found, canon(&sub));
    }

    #[test]
    fn find_repo_path_none_when_no_repo() {
        let empty = tempfile::tempdir().expect("empty");
        std::fs::create_dir(empty.path().join("plain")).expect("mkdir plain");
        assert_eq!(find_repo_path(empty.path().to_str().unwrap()), None);
    }
}
