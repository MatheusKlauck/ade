pub mod board_pos;
pub mod db;
pub mod error;
pub mod notify;

mod gh;
mod gitlocal;
mod ipc;
mod models;
mod pty;
mod sync;
mod term_monitor;
pub mod tmux;

use chrono::Utc;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::Manager;

/// A handle to a running sync worker, allowing both immediate kick
/// (via `notify`) and clean shutdown (by aborting `join`).
pub struct WorkerHandle {
    pub notify: Arc<tokio::sync::Notify>,
    pub join: tokio::task::JoinHandle<()>,
}

pub struct AppState {
    pub pty: crate::pty::PtyRegistry,
    pub db: db::DbPool,
    pub workers: tokio::sync::Mutex<HashMap<String, WorkerHandle>>,
    /// Window ids with a live completion monitor (see `term_monitor`).
    pub monitors: term_monitor::Monitors,
}

async fn seed_dev_workspace(pool: &db::DbPool) -> Result<(), crate::error::AdeError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace")
        .fetch_one(pool)
        .await
        .map_err(crate::error::AdeError::Db)?;
    if count > 0 {
        return Ok(());
    }

    let (slug, root_path) = tmux::dev_workspace()?;
    let ws_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES (?, 'Dev', ?, ?, ?)",
    )
    .bind(&ws_id)
    .bind(&slug)
    .bind(&root_path)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(crate::error::AdeError::Db)?;

    let _ws: crate::models::Workspace = sqlx::query_as::<_, crate::models::Workspace>(
        "SELECT id, name, slug, root_path, github_owner, github_repo, startup_command, created_at FROM workspace WHERE id = ?",
    )
    .bind(&ws_id)
    .fetch_one(pool)
    .await
    .map_err(crate::error::AdeError::Db)?;

    let col_names = ["Backlog", "Doing", "Paused", "PR", "Done"];
    for (i, name) in col_names.iter().enumerate() {
        let cid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO board_column (id, workspace_id, name, position) VALUES (?, ?, ?, ?)",
        )
        .bind(&cid)
        .bind(&ws_id)
        .bind(name)
        .bind(i as i64)
        .execute(pool)
        .await
        .map_err(crate::error::AdeError::Db)?;
    }

    Ok(())
}

/// Spawn a sync worker for a single workspace.
///
/// If a worker already exists for `workspace_id` it is replaced: the old
/// task is aborted and a new one is started with the given `token`.
pub async fn spawn_worker_for_workspace(
    workspace_id: String,
    token: String,
    pool: db::DbPool,
    app: tauri::AppHandle,
    workers: &tokio::sync::Mutex<HashMap<String, WorkerHandle>>,
) {
    // Abort existing worker for this workspace, if any.
    let mut map = workers.lock().await;
    if let Some(old) = map.remove(&workspace_id) {
        old.join.abort();
    }
    // Release the lock before spawning — the worker doesn't need the map.
    drop(map);

    let gh = Arc::new(crate::gh::client::GitHubClient::new(
        "https://api.github.com".to_string(),
        token,
    ));
    let notify = Arc::new(tokio::sync::Notify::new());

    let rate_budget = Arc::new(sync::worker::RateBudget::new());

    // Read this workspace's sync_interval_secs setting (default 30)
    let interval_secs: u64 =
        crate::ipc::settings::workspace_setting_value(&pool, &workspace_id, "sync_interval_secs")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);

    let db = pool.clone();
    let app_clone = app.clone();
    let rb = rate_budget.clone();
    let notify_clone = notify.clone();
    let ws_id = workspace_id.clone();

    let join = tokio::spawn(async move {
        sync::worker::start_worker(db, gh, ws_id, rb, app_clone, notify_clone, interval_secs).await;
    });

    workers
        .lock()
        .await
        .insert(workspace_id, WorkerHandle { notify, join });
}

/// Spawn sync workers for all workspaces that have github_owner set.
async fn spawn_sync_workers(
    pool: db::DbPool,
    app: tauri::AppHandle,
    workers: &tokio::sync::Mutex<HashMap<String, WorkerHandle>>,
) {
    let workspaces: Vec<crate::models::Workspace> = match sqlx::query_as::<_, crate::models::Workspace>(
        "SELECT id, name, slug, root_path, github_owner, github_repo, startup_command, created_at FROM workspace WHERE github_owner IS NOT NULL AND closed_at IS NULL",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("failed to query workspaces for sync: {}", e);
            return;
        }
    };

    for ws in workspaces {
        // Each workspace uses its own token (falling back to the legacy global
        // entry). If unavailable, the worker starts but skips cycles until a
        // valid token is set.
        let token = match crate::ipc::github::keychain_get_for_workspace(&ws.id) {
            Ok(Some(t)) => t,
            _ => String::new(),
        };
        spawn_worker_for_workspace(
            ws.id.clone(),
            token,
            pool.clone(),
            app.clone(),
            workers,
        )
        .await;
    }
}

/// Ensure common tool locations are on `PATH`.
///
/// macOS GUI launches (Finder, IDE-started `tauri dev`, and the release `.app`
/// bundle) inherit a minimal `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` — that
/// excludes Homebrew (`/opt/homebrew/bin`) and `/usr/local/bin`. Without them
/// `tmux` can't be found and every session/window spawn fails with ENOENT
/// ("No such file or directory"). Append the usual locations (idempotently) so
/// the app — and the shells it starts — can find their tools. Called once at
/// setup, before anything shells out.
fn ensure_path_env() {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
    let mut changed = false;
    for extra in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
        let p = std::path::PathBuf::from(extra);
        if p.is_dir() && !dirs.iter().any(|d| d == &p) {
            dirs.push(p);
            changed = true;
        }
    }
    if changed {
        if let Ok(joined) = std::env::join_paths(&dirs) {
            std::env::set_var("PATH", joined);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // GUI launches inherit a minimal PATH (no Homebrew/local bin), which
            // makes every tmux spawn fail with ENOENT. Fix it before anything,
            // including the sync workers below, shells out.
            ensure_path_env();
            // Register the OS-native credential store (macOS Keychain / Windows
            // Credential Manager / Linux Secret Service) as keyring-core's
            // default. keyring-core's Entry::new() has NO store until one is set
            // here — without it every GitHub token set/get fails, so tokens are
            // never persisted and sync workers never get a credential.
            if let Err(e) = keyring::use_native_store(true) {
                eprintln!("failed to initialize OS keychain store: {e}");
            }
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&handle).await.expect("db init failed");
                if let Err(e) = seed_dev_workspace(&pool).await {
                    eprintln!("seed dev workspace failed: {}", e);
                }

                let state = Arc::new(AppState {
                    db: pool.clone(),
                    pty: std::sync::Arc::new(std::sync::Mutex::new(
                        std::collections::HashMap::new(),
                    )),
                    workers: tokio::sync::Mutex::new(HashMap::new()),
                    monitors: Arc::new(std::sync::Mutex::new(HashSet::new())),
                });

                spawn_sync_workers(pool, handle.clone(), &state.workers).await;

                handle.manage(state);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::workspace::workspace_create,
            ipc::workspace::workspace_list,
            ipc::workspace::workspace_close,
            ipc::board::board_get,
            ipc::board::card_create,
            ipc::board::card_update,
            ipc::board::card_delete,
            ipc::board::card_move,
            ipc::board::card_promote,
            ipc::card::card_detail,
            ipc::github::github_set_token,
            ipc::settings::setting_get,
            ipc::settings::setting_set,
            ipc::settings::ui_state_get,
            ipc::settings::ui_state_set,
            ipc::terminal::terminal_open,
            ipc::terminal::terminal_write,
            ipc::terminal::terminal_resize,
            ipc::terminal::terminal_close,
            ipc::terminal::terminal_kill_window,
            ipc::sync::sync_now,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("tauri application error: {}", e);
        std::process::exit(1);
    }
}
