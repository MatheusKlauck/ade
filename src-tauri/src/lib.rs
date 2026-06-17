pub mod board_pos;
pub mod db;
pub mod error;
pub mod gbrain;
pub mod gestor;
pub mod notify;

mod gh;
mod gitlocal;
mod ipc;
mod models;
mod pty;
mod repo;
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
    /// Running gestor loops, keyed by workspace id, so changing `autonomy_level`
    /// in the UI starts/stops the loop live — no app restart (see `setting_set`).
    pub gestor: tokio::sync::Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    /// Window ids with a live completion monitor (see `term_monitor`).
    pub monitors: term_monitor::Monitors,
    /// The app-owned `gbrain serve --http` connection, populated asynchronously
    /// by `gbrain::init_background` shortly after startup (None until ready). A
    /// std Mutex so the sync exit handler can take it to kill the serve.
    pub gbrain: std::sync::Mutex<Option<gbrain::GbrainRuntime>>,
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

    let _ws: crate::models::Workspace = repo::workspace_by_id(pool, &ws_id).await?;

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
        crate::gh::client::GITHUB_API_BASE.to_string(),
        token,
    ));
    let notify = Arc::new(tokio::sync::Notify::new());

    let rate_budget = Arc::new(sync::rate::RateBudget::new());

    // Read this workspace's sync_interval_secs setting (default 30)
    let interval_secs: u64 =
        crate::ipc::settings::workspace_setting_value(&pool, &workspace_id, "sync_interval_secs")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(crate::ipc::settings::DEFAULT_SYNC_INTERVAL_SECS);

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
    let workspaces: Vec<crate::models::Workspace> =
        match sqlx::query_as::<_, crate::models::Workspace>(concat!(
            "SELECT ",
            crate::repo::workspace_cols!(),
            " FROM workspace WHERE github_owner IS NOT NULL AND closed_at IS NULL"
        ))
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
        spawn_worker_for_workspace(ws.id.clone(), token, pool.clone(), app.clone(), workers).await;
    }
}

/// Spawn the Gestor runtime loop at boot for every open workspace at autonomy
/// L2+ (D11: the dial is the only control; L2 is the first level that dispatches).
/// Each loop probes `claude` and, if present, drives that workspace's tasks; a
/// missing provider disables only that loop. Handles are registered in
/// `AppState.gestor` so `setting_set` can start/stop a loop live when
/// `autonomy_level` changes (no restart).
async fn spawn_gestor_runtimes(pool: db::DbPool, app: tauri::AppHandle, handles: &GestorHandles) {
    let workspaces: Vec<crate::models::Workspace> =
        match sqlx::query_as::<_, crate::models::Workspace>(concat!(
            "SELECT ",
            crate::repo::workspace_cols!(),
            " FROM workspace WHERE closed_at IS NULL"
        ))
        .fetch_all(&pool)
        .await
        {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("failed to query workspaces for gestor: {}", e);
                return;
            }
        };

    for ws in workspaces {
        // D11: the autonomy dial is the only control. The autonomous loop runs
        // at L2+ (can_dispatch); L0/L1 need no loop (L0 is manual, L1's jobs are
        // on-demand via IPC). No `gestor_enabled` toggle.
        if crate::gestor::autonomy::load(&pool, &ws.id)
            .await
            .can_dispatch()
        {
            spawn_gestor_for_workspace(ws.id, pool.clone(), app.clone(), handles).await;
        }
    }
}

type GestorHandles = tokio::sync::Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>;

/// Start one workspace's gestor loop and register its handle so a toggle-off can
/// stop it. Replaces (aborts) any existing handle for the workspace, so calling
/// it on an already-running loop is a clean restart — `start_runtime` reconciles
/// orphaned worker tasks on entry. The loop self-disables if `claude` is absent.
pub(crate) async fn spawn_gestor_for_workspace(
    workspace_id: String,
    pool: db::DbPool,
    app: tauri::AppHandle,
    handles: &GestorHandles,
) {
    let provider = Arc::new(crate::gestor::provider::ClaudeCli::new());
    let notify = Arc::new(tokio::sync::Notify::new());
    let (db2, app2, ws_id) = (pool, app, workspace_id.clone());
    let handle = tauri::async_runtime::spawn(async move {
        crate::gestor::runtime::start_runtime(db2, provider, ws_id, app2, notify, 3).await;
    });
    if let Some(old) = handles.lock().await.insert(workspace_id, handle) {
        old.abort();
    }
}

/// Stop a workspace's gestor loop (toggle-off). In-flight tmux workers keep
/// running; their tasks are reconciled if the loop is started again later.
pub(crate) async fn stop_gestor_for_workspace(workspace_id: &str, handles: &GestorHandles) {
    if let Some(h) = handles.lock().await.remove(workspace_id) {
        h.abort();
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
            // Reap viewer sessions stranded by a previous hard exit (crash,
            // SIGKILL, `tauri dev` HMR restart) — those bypass the clean-exit
            // handler in `run()` and would otherwise pile up in the tmux server
            // indefinitely. Only detached viewers are killed, so a second live
            // instance's sessions (and all base sessions) are left untouched.
            let reaped = tmux::kill_detached_viewers();
            if reaped > 0 {
                eprintln!("reaped {reaped} stranded tmux viewer session(s)");
            }
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
                    gestor: tokio::sync::Mutex::new(HashMap::new()),
                    monitors: Arc::new(std::sync::Mutex::new(HashSet::new())),
                    gbrain: std::sync::Mutex::new(None),
                });

                spawn_sync_workers(pool, handle.clone(), &state.workers).await;

                // Gestor: spawn the autonomous loop for workspaces dialed to L2+
                // (D11). L0/L1 run no loop; the rest of the app is untouched when
                // the gestor is manual or `claude` is absent.
                spawn_gestor_runtimes(state.db.clone(), handle.clone(), &state.gestor).await;

                // Bring up the shared gbrain serve off the startup path so it
                // doesn't delay first paint; it publishes into state.gbrain once
                // the HTTP serve is reachable.
                let gbrain_state = state.clone();
                tauri::async_runtime::spawn(async move {
                    gbrain::init_background(gbrain_state).await;
                });

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
            ipc::board::card_update_github,
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
            ipc::skills::skills_list,
            ipc::claude_sessions::claude_sessions,
            ipc::gbrain::gbrain_status,
            ipc::gbrain::gbrain_query,
            ipc::gbrain::gbrain_identity,
            ipc::gbrain::gbrain_sources,
            ipc::gbrain::gbrain_recent_pages,
            ipc::gbrain::gbrain_health,
            ipc::gbrain::gbrain_liveness,
            ipc::gbrain::gbrain_sync,
            ipc::gbrain::gbrain_restart,
            ipc::gestor::gestor_plan,
            ipc::gestor::proposal_approve,
            ipc::gestor::gestor_build_feature,
            ipc::gestor::gestor_enqueue_card,
            ipc::gestor::gestor_tasks_list,
            ipc::gestor::gestor_feed_list,
            ipc::gestor::gestor_release_notes,
            ipc::gestor::pr_merge,
        ])
        .build(tauri::generate_context!());

    let app = match result {
        Ok(app) => app,
        Err(e) => {
            eprintln!("tauri application error: {}", e);
            std::process::exit(1);
        }
    };

    app.run(|app_handle, event| {
        // On a clean quit, kill every open pane's viewer session so it doesn't
        // leak into the tmux server. `pane.close()` kills only the ephemeral
        // viewer (and its PTY child) — base sessions are deliberately left
        // alive so a workspace's windows survive an app restart (reattach).
        // Hard exits (crash, SIGKILL, HMR) skip this; the startup sweep in
        // `setup()` reaps whatever they strand.
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                let panes: Vec<crate::pty::PtyPane> = match state.pty.lock() {
                    Ok(mut reg) => reg.drain().map(|(_, pane)| pane).collect(),
                    Err(_) => Vec::new(),
                };
                for pane in panes {
                    let _ = pane.close();
                }
                // Stop the app-owned gbrain serve so it doesn't outlive the app
                // (and keep holding the PGLite lock).
                if let Ok(mut g) = state.gbrain.lock() {
                    if let Some(rt) = g.take() {
                        rt.handle.kill();
                    }
                }
            }
        }
    });
}
