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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&handle).await.expect("db init failed");
                handle.manage(Arc::new(AppState { db: pool }));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
