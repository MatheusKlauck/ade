//! Per-pane Repo view (git diffs) and Worktree isolation.
//!
//! ponytail: shells out to the `git` binary instead of git2. The diff text and
//! worktree lifecycle map 1:1 to git CLI subcommands, so this is a few lines vs
//! a lot of libgit2 plumbing. Ceiling: requires `git` on PATH (a given in a dev
//! tool). Upgrade path: port to the already-vendored git2 crate if we ever ship
//! to an environment without the git binary.

use crate::error::AdeError;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use tauri::State;

/// Run `git -C <cwd> <args>` and return stdout, erroring on non-zero exit.
fn git(cwd: &str, args: &[&str]) -> Result<String, AdeError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| AdeError::Other(format!("git: {e}")))?;
    if !out.status.success() {
        return Err(AdeError::Other(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The repo root a pane operates in: the worktree path when isolated, else the
/// workspace's git working directory.
async fn repo_root(
    workspace_id: &str,
    worktree: Option<String>,
    state: &Arc<crate::AppState>,
) -> Result<String, AdeError> {
    if let Some(p) = worktree {
        return Ok(p);
    }
    let ws = crate::repo::workspace_by_id(&state.db, workspace_id).await?;
    Ok(crate::gitlocal::find_repo_path(&ws.root_path).unwrap_or(ws.root_path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// "M" modified, "A" added, "D" deleted, "?" untracked.
    pub status: String,
}

/// Collapse a porcelain XY status code into the single letter the UI shows.
fn status_from_xy(xy: &str) -> &'static str {
    if xy == "??" {
        "?"
    } else if xy.contains('D') {
        "D"
    } else if xy.contains('A') {
        "A"
    } else {
        "M"
    }
}

#[tauri::command]
pub async fn repo_changes(
    workspace_id: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Vec<ChangedFile>, AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    let out = tokio::task::spawn_blocking(move || {
        // -z: NUL-separated, paths verbatim and unquoted — names with spaces or
        // unicode survive (plain --porcelain octal-escapes and quotes them).
        git(&base, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))??;

    let mut files = Vec::new();
    let mut fields = out.split('\0');
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let xy = &entry[..2];
        let path = entry[3..].to_string();
        // A rename/copy emits the source path as a trailing field; consume it so
        // it isn't parsed as a bogus entry. The XY field holds the destination.
        if xy.starts_with('R') || xy.starts_with('C') {
            fields.next();
        }
        files.push(ChangedFile {
            path,
            status: status_from_xy(xy).to_string(),
        });
    }
    Ok(files)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    /// File contents at HEAD ("" for an untracked/new file).
    pub original: String,
    /// Current working-tree contents ("" for a deleted file).
    pub modified: String,
}

#[tauri::command]
pub async fn repo_file_versions(
    workspace_id: String,
    path: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<FileVersions, AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    let versions = tokio::task::spawn_blocking(move || {
        // HEAD blob; absent for untracked files, so swallow the error → "".
        let original = Command::new("git")
            .arg("-C")
            .arg(&base)
            .args(["show", &format!("HEAD:{path}")])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        // Working-tree file; absent for a deletion → "".
        let modified = std::fs::read_to_string(Path::new(&base).join(&path)).unwrap_or_default();
        FileVersions { original, modified }
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))?;
    Ok(versions)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    /// The main repo root, so the frontend can `cd` the shell back on toggle-off.
    pub root: String,
}

#[tauri::command]
pub async fn worktree_add(
    workspace_id: String,
    pane_id: String,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<WorktreeInfo, AdeError> {
    let root = repo_root(&workspace_id, None, &state).await?;
    let short: String = pane_id.chars().filter(|c| c.is_alphanumeric()).take(8).collect();
    let branch = format!("ade-wt/{short}");

    let root_path = Path::new(&root);
    let parent = root_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| root_path.to_path_buf());
    let reponame = root_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    // Sibling dir so the worktree never shows up as untracked inside the repo.
    let wt_path = parent.join(".ade-worktrees").join(format!("{reponame}-{short}"));
    let wt_str = wt_path.to_string_lossy().into_owned();

    let root2 = root.clone();
    let branch2 = branch.clone();
    let wt2 = wt_str.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AdeError> {
        if let Some(p) = Path::new(&wt2).parent() {
            std::fs::create_dir_all(p).ok();
        }
        // New worktree on a fresh branch off HEAD. If the branch already exists
        // (re-toggle), attach the worktree to it instead of failing.
        let mk = Command::new("git")
            .arg("-C")
            .arg(&root2)
            .args(["worktree", "add", "-b", &branch2, &wt2])
            .output()
            .map_err(|e| AdeError::Other(format!("git: {e}")))?;
        if mk.status.success() {
            return Ok(());
        }
        let retry = Command::new("git")
            .arg("-C")
            .arg(&root2)
            .args(["worktree", "add", &wt2, &branch2])
            .output()
            .map_err(|e| AdeError::Other(format!("git: {e}")))?;
        if !retry.status.success() {
            return Err(AdeError::Other(
                String::from_utf8_lossy(&retry.stderr).trim().to_string(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))??;

    Ok(WorktreeInfo { path: wt_str, branch, root })
}

#[tauri::command]
pub async fn worktree_remove(
    workspace_id: String,
    path: String,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let root = repo_root(&workspace_id, None, &state).await?;
    tokio::task::spawn_blocking(move || -> Result<(), AdeError> {
        // Throwaway branch the worktree sits on, captured before removal so it
        // can be cleaned up after (else ade-wt/* branches pile up over toggles).
        let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string());
        // No --force: git refuses to remove a worktree with uncommitted changes,
        // which is the safe default — toggling off must never silently drop work.
        let out = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["worktree", "remove", &path])
            .output()
            .map_err(|e| AdeError::Other(format!("git: {e}")))?;
        if !out.status.success() {
            return Err(AdeError::Other(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        // Drop our throwaway branch. Safe -d: if it carries unmerged commits git
        // refuses and we leave it (no data loss); only ade-wt/* are ever touched.
        if let Some(b) = branch {
            if b.starts_with("ade-wt/") {
                let _ = git(&root, &["branch", "-d", &b]);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))??;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    /// Last commit time on the branch, unix seconds (0 if unparseable).
    pub updated: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: String,
    pub branches: Vec<BranchInfo>,
}

#[tauri::command]
pub async fn git_branches(
    workspace_id: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<GitBranches, AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    tokio::task::spawn_blocking(move || -> Result<GitBranches, AdeError> {
        let current = git(&base, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        // tab-separated "name\tunix", most-recently-committed first.
        let raw = git(
            &base,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)%09%(committerdate:unix)",
                "refs/heads",
            ],
        )?;
        let branches = raw
            .lines()
            .filter_map(|line| {
                let (name, ts) = line.split_once('\t')?;
                if name.is_empty() {
                    return None;
                }
                Some(BranchInfo {
                    name: name.trim().to_string(),
                    updated: ts.trim().parse().unwrap_or(0),
                })
            })
            .collect();
        Ok(GitBranches { current, branches })
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn git_create_branch(
    workspace_id: String,
    name: String,
    from: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    // Create the new branch off `from` and switch to it.
    tokio::task::spawn_blocking(move || git(&base, &["switch", "-c", &name, &from]).map(|_| ()))
        .await
        .map_err(|e| AdeError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn git_delete_branch(
    workspace_id: String,
    name: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    // -d is the safe delete: git refuses to drop an unmerged branch, so we never
    // silently lose commits. The error surfaces to the user to force with intent.
    tokio::task::spawn_blocking(move || git(&base, &["branch", "-d", &name]).map(|_| ()))
        .await
        .map_err(|e| AdeError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn git_checkout(
    workspace_id: String,
    branch: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    tokio::task::spawn_blocking(move || git(&base, &["switch", &branch]).map(|_| ()))
        .await
        .map_err(|e| AdeError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn git_commit(
    workspace_id: String,
    message: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    tokio::task::spawn_blocking(move || -> Result<(), AdeError> {
        git(&base, &["add", "-A"])?;
        git(&base, &["commit", "-m", &message])?;
        Ok(())
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn git_stash(
    workspace_id: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let base = repo_root(&workspace_id, worktree, &state).await?;
    // -u stashes untracked files too. With nothing to stash git exits 0 with a
    // "No local changes to save" note, so this is a no-op, not an error.
    tokio::task::spawn_blocking(move || git(&base, &["stash", "push", "-u"]).map(|_| ()))
        .await
        .map_err(|e| AdeError::Other(e.to_string()))?
}

/// Absolute path of `path` inside the pane's repo (or its worktree).
async fn abs_in_repo(
    workspace_id: &str,
    path: &str,
    worktree: Option<String>,
    state: &Arc<crate::AppState>,
) -> Result<String, AdeError> {
    let base = repo_root(workspace_id, worktree, state).await?;
    Ok(Path::new(&base).join(path).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn repo_abs_path(
    workspace_id: String,
    path: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<String, AdeError> {
    abs_in_repo(&workspace_id, &path, worktree, &state).await
}

// ponytail: macOS only (`open` / `code`). Linux (`xdg-open`) and Windows
// (`explorer` / `start`) are a switch on cfg!(target_os) when we ship there.

#[tauri::command]
pub async fn open_in_finder(
    workspace_id: String,
    path: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let abs = abs_in_repo(&workspace_id, &path, worktree, &state).await?;
    tokio::task::spawn_blocking(move || -> Result<(), AdeError> {
        let out = Command::new("open")
            .arg(&abs)
            .output()
            .map_err(|e| AdeError::Other(format!("open: {e}")))?;
        if !out.status.success() {
            return Err(AdeError::Other(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))??;
    Ok(())
}

#[tauri::command]
pub async fn open_in_vscode(
    workspace_id: String,
    path: String,
    worktree: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let abs = abs_in_repo(&workspace_id, &path, worktree, &state).await?;
    tokio::task::spawn_blocking(move || -> Result<(), AdeError> {
        // Prefer the `code` CLI; if it's not installed, open via the app bundle.
        if let Ok(o) = Command::new("code").arg(&abs).output() {
            if o.status.success() {
                return Ok(());
            }
        }
        let out = Command::new("open")
            .args(["-a", "Visual Studio Code"])
            .arg(&abs)
            .output()
            .map_err(|e| AdeError::Other(format!("open: {e}")))?;
        if !out.status.success() {
            return Err(AdeError::Other(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| AdeError::Other(e.to_string()))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::status_from_xy;

    #[test]
    fn maps_porcelain_xy_codes() {
        assert_eq!(status_from_xy("??"), "?"); // untracked
        assert_eq!(status_from_xy(" M"), "M"); // modified, unstaged
        assert_eq!(status_from_xy("M "), "M"); // modified, staged
        assert_eq!(status_from_xy("A "), "A"); // added
        assert_eq!(status_from_xy(" D"), "D"); // deleted
        assert_eq!(status_from_xy("MM"), "M"); // staged + unstaged edits
        assert_eq!(status_from_xy("AD"), "D"); // added then deleted → deletion wins
    }
}
