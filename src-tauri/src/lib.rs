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
use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub pty: crate::pty::PtyRegistry,
    pub db: db::DbPool,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&handle).await.expect("db init failed");
                if let Err(e) = seed_dev_workspace(&pool).await {
                    eprintln!("seed dev workspace failed: {}", e);
                }
                handle.manage(Arc::new(AppState {
                    db: pool,
                    pty: std::sync::Arc::new(std::sync::Mutex::new(
                        std::collections::HashMap::new(),
                    )),
                }));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::board::board_get,
            ipc::board::card_create,
            ipc::board::card_update,
            ipc::board::card_delete,
            ipc::board::card_move,
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
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("tauri application error: {}", e);
        std::process::exit(1);
    }
}
