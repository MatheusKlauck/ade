// M3-T1: workspace_create + remote parsing (§7, §9.1, §9.2, §3).

use crate::error::AdeError;
use crate::gitlocal::{parse_github_remote, slugify};
use crate::models::Workspace;
use crate::notify::emit_notify;
use chrono::Utc;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

const COLUMN_NAMES: [&str; 5] = ["Backlog", "Doing", "Paused", "PR", "Done"];

/// Detect a git repo strictly inside `path` and, if its `origin` remote points at
/// GitHub, return `(owner, repo)`. Returns:
///   - `Ok(Some((owner, repo)))` — GitHub origin found.
///   - `Ok(None)` — no repo, no origin remote, or origin is not GitHub.
///
/// When an `origin` remote exists but is not a GitHub URL, `*remote_not_github` is
/// set to `true` so the caller can emit `REMOTE_NOT_GITHUB`.
fn detect_github(path: &Path, remote_not_github: &mut bool) -> Option<(String, String)> {
    // discover() walks up parent directories; constrain it to `path` by checking the
    // discovered repo's working directory is within (or equal to) `path`.
    let repo = git2::Repository::discover(path).ok()?;
    let workdir = repo.workdir()?;
    let canon_workdir = workdir.canonicalize().ok()?;
    let canon_path = path.canonicalize().ok()?;
    if !canon_workdir.starts_with(&canon_path) {
        // Repo found, but it lives in a parent directory — not "strictly inside path".
        return None;
    }

    let remote = repo.find_remote("origin").ok()?;
    let url = remote.url().ok()?;
    match parse_github_remote(url) {
        Some(pair) => Some(pair),
        None => {
            *remote_not_github = true;
            None
        }
    }
}

#[tauri::command]
pub async fn workspace_create(
    path: String,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<Workspace, AdeError> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(AdeError::Other(format!(
            "directory does not exist: {}",
            path
        )));
    }

    let dirname = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();

    let ws_id = uuid::Uuid::new_v4().to_string();
    let uuid8: String = ws_id.chars().take(8).collect();
    let fallback = format!("ws-{}", uuid8);
    let name = if dirname.is_empty() {
        fallback.clone()
    } else {
        dirname.to_string()
    };
    let base_slug = slugify(dirname, &fallback);

    let mut remote_not_github = false;
    let github = detect_github(dir, &mut remote_not_github);
    let (github_owner, github_repo) = match github {
        Some((o, r)) => (Some(o), Some(r)),
        None => (None, None),
    };

    let now = Utc::now().to_rfc3339();

    // Resolve slug, retrying with `-2`, `-3`, … on UNIQUE collision.
    let mut suffix: u32 = 1;
    let inserted_slug = loop {
        let candidate = if suffix == 1 {
            base_slug.clone()
        } else {
            format!("{}-{}", base_slug, suffix)
        };

        let result = sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&ws_id)
        .bind(&name)
        .bind(&candidate)
        .bind(&path)
        .bind(&github_owner)
        .bind(&github_repo)
        .bind(&now)
        .execute(&state.db)
        .await;

        match result {
            Ok(_) => break candidate,
            Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
                suffix += 1;
                if suffix > 1000 {
                    return Err(AdeError::Other(
                        "could not allocate unique workspace slug".to_string(),
                    ));
                }
                continue;
            }
            Err(e) => return Err(AdeError::Db(e)),
        }
    };
    let _ = inserted_slug;

    // Seed the 5 fixed columns (§3).
    for (i, col_name) in COLUMN_NAMES.iter().enumerate() {
        let cid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO board_column (id, workspace_id, name, position) VALUES (?, ?, ?, ?)",
        )
        .bind(&cid)
        .bind(&ws_id)
        .bind(col_name)
        .bind(i as i64)
        .execute(&state.db)
        .await
        .map_err(AdeError::Db)?;
    }

    if remote_not_github {
        emit_notify(
            &app,
            "warn",
            "REMOTE_NOT_GITHUB",
            "origin remote is not a GitHub URL; workspace created as local-only",
        );
    }

    // If this workspace is GitHub-linked, spawn a sync worker for it.
    if github_owner.is_some() {
        let token = crate::ipc::github::keychain_get()
            .ok()
            .flatten()
            .unwrap_or_default();
        crate::spawn_worker_for_workspace(
            ws_id.clone(),
            token,
            state.db.clone(),
            app.clone(),
            &state.workers,
        )
        .await;
    }

    let ws: Workspace = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, slug, root_path, github_owner, github_repo, startup_command, created_at FROM workspace WHERE id = ?",
    )
    .bind(&ws_id)
    .fetch_one(&state.db)
    .await
    .map_err(AdeError::Db)?;

    Ok(ws)
}

#[tauri::command]
pub async fn workspace_list(
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Vec<Workspace>, AdeError> {
    let workspaces: Vec<Workspace> = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, slug, root_path, github_owner, github_repo, startup_command, created_at FROM workspace ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await
    .map_err(AdeError::Db)?;

    Ok(workspaces)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitlocal::{parse_github_remote, slugify};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;

    async fn test_pool() -> (crate::db::DbPool, tempfile::TempDir) {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let tmp = tempfile::tempdir_in(&dir).unwrap();
        let path = tmp.path().join("test.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE workspace (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                root_path TEXT NOT NULL,
                github_owner TEXT,
                github_repo TEXT,
                startup_command TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE board_column (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                position INTEGER NOT NULL
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        (pool, tmp)
    }

    /// Insert a workspace the way `workspace_create` does (without the Tauri command
    /// machinery), exercising slug-collision resolution + column seeding. Returns the
    /// slug that was actually inserted.
    async fn insert_workspace(
        pool: &crate::db::DbPool,
        path: &Path,
        github: Option<(String, String)>,
    ) -> String {
        let dirname = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let ws_id = uuid::Uuid::new_v4().to_string();
        let uuid8: String = ws_id.chars().take(8).collect();
        let fallback = format!("ws-{}", uuid8);
        let name = if dirname.is_empty() {
            fallback.clone()
        } else {
            dirname.to_string()
        };
        let base_slug = slugify(dirname, &fallback);
        let now = Utc::now().to_rfc3339();
        let (owner, repo) = match github {
            Some((o, r)) => (Some(o), Some(r)),
            None => (None, None),
        };

        let mut suffix: u32 = 1;
        let inserted = loop {
            let candidate = if suffix == 1 {
                base_slug.clone()
            } else {
                format!("{}-{}", base_slug, suffix)
            };
            let result = sqlx::query(
                "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&ws_id)
            .bind(&name)
            .bind(&candidate)
            .bind(path.to_str().unwrap())
            .bind(&owner)
            .bind(&repo)
            .bind(&now)
            .execute(pool)
            .await;
            match result {
                Ok(_) => break candidate,
                Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
                    suffix += 1;
                    continue;
                }
                Err(e) => panic!("insert failed: {}", e),
            }
        };

        for (i, col_name) in COLUMN_NAMES.iter().enumerate() {
            let cid = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO board_column (id, workspace_id, name, position) VALUES (?, ?, ?, ?)",
            )
            .bind(&cid)
            .bind(&ws_id)
            .bind(col_name)
            .bind(i as i64)
            .execute(pool)
            .await
            .unwrap();
        }
        inserted
    }

    #[tokio::test]
    async fn non_git_folder_is_local_workspace() {
        let (pool, _tmp) = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();

        // detect_github on a plain (non-git) folder → None, no notification flagged.
        let mut remote_not_github = false;
        let github = detect_github(&path, &mut remote_not_github);
        assert!(github.is_none());
        assert!(!remote_not_github);

        let slug = insert_workspace(&pool, &path, github).await;
        assert!(!slug.is_empty());

        let row = sqlx::query("SELECT github_owner, github_repo FROM workspace WHERE slug = ?")
            .bind(&slug)
            .fetch_one(&pool)
            .await
            .unwrap();
        let owner: Option<String> = row.get("github_owner");
        let repo: Option<String> = row.get("github_repo");
        assert!(owner.is_none());
        assert!(repo.is_none());
    }

    #[tokio::test]
    async fn slug_collision_gets_suffix_2() {
        let (pool, _tmp) = test_pool().await;

        // Two distinct folders with the same dirname → same base slug.
        let parent_a = tempfile::tempdir().unwrap();
        let parent_b = tempfile::tempdir().unwrap();
        let dir_a = parent_a.path().join("myproj");
        let dir_b = parent_b.path().join("myproj");
        std::fs::create_dir(&dir_a).unwrap();
        std::fs::create_dir(&dir_b).unwrap();

        let slug_a = insert_workspace(&pool, &dir_a, None).await;
        let slug_b = insert_workspace(&pool, &dir_b, None).await;

        assert_eq!(slug_a, "myproj");
        assert_eq!(slug_b, "myproj-2");
    }

    #[tokio::test]
    async fn seeds_five_columns() {
        let (pool, _tmp) = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let _slug = insert_workspace(&pool, dir.path(), None).await;

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM board_column")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 5);
    }

    // §9.2 vector tests live in gitlocal.rs; mirror the GitHub-vs-local split here so a
    // non-GitHub remote produces no owner/repo (the workspace stays local).
    #[test]
    fn remote_vector_github_https() {
        assert_eq!(
            parse_github_remote("https://github.com/o/r.git"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn remote_vector_non_github_stays_local() {
        assert!(parse_github_remote("https://gitlab.com/o/r.git").is_none());
    }
}
