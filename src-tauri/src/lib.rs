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
pub mod tmux;

use chrono::Utc;
use std::collections::HashMap;
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

    // Read sync_interval_secs setting (default 30)
    let interval_secs: u64 = match sqlx::query_scalar::<_, String>(
        "SELECT value FROM setting WHERE key = 'sync_interval_secs'",
    )
    .fetch_optional(&pool)
    .await
    {
        Ok(Some(val)) => val.parse().unwrap_or(30),
        _ => 30,
    };

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
        "SELECT id, name, slug, root_path, github_owner, github_repo, startup_command, created_at FROM workspace WHERE github_owner IS NOT NULL",
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

    // Try to get GitHub token from keychain; if unavailable, workers will
    // start but skip cycles (the client needs a valid token).
    let token = match crate::ipc::github::keychain_get() {
        Ok(Some(t)) => t,
        _ => String::new(), // Empty token — workers will hit auth errors
    };

    for ws in workspaces {
        spawn_worker_for_workspace(
            ws.id.clone(),
            token.clone(),
            pool.clone(),
            app.clone(),
            workers,
        )
        .await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
                });

                spawn_sync_workers(pool, handle.clone(), &state.workers).await;

                handle.manage(state);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::workspace::workspace_create,
            ipc::workspace::workspace_list,
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
