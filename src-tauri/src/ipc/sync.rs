use crate::error::AdeError;
use crate::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn sync_now(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
) -> Result<(), AdeError> {
    let workers = state.workers.lock().await;
    if let Some(handle) = workers.get(&workspace_id) {
        handle.notify.notify_one();
        Ok(())
    } else {
        Err(AdeError::Other(format!(
            "no worker found for workspace {}",
            workspace_id
        )))
    }
}
