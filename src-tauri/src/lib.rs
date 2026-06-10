pub mod db;
pub mod error;
pub mod notify;

mod gh;
mod gitlocal;
mod ipc;
mod models;
mod pty;
mod sync;
mod tmux;

use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub db: db::DbPool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&handle).await.expect("db init failed");
                handle.manage(Arc::new(AppState { db: pool }));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::github::github_set_token,
            ipc::settings::setting_get,
            ipc::settings::setting_set,
            ipc::settings::ui_state_get,
            ipc::settings::ui_state_set,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("tauri application error: {}", e);
        std::process::exit(1);
    }
}
