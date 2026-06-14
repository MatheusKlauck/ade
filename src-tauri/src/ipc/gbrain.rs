//! IPC commands for the StatusBar "brain pill": status snapshot + search.
//! Both read from the app-owned `gbrain serve --http` (see [`crate::gbrain`]).

use crate::error::AdeError;
use crate::gbrain::{GbrainHit, GbrainStatus};
use crate::AppState;
use std::sync::Arc;
use tauri::State;

/// Clone the live endpoint + token out of `AppState`. The lock is released
/// before any await (the guard never crosses an async boundary).
fn endpoint(state: &AppState) -> Result<(String, String), AdeError> {
    let guard = state
        .gbrain
        .lock()
        .map_err(|_| AdeError::Other("gbrain runtime lock poisoned".into()))?;
    match guard.as_ref() {
        Some(rt) => Ok((rt.base_url.clone(), rt.token.clone())),
        None => Err(AdeError::Other("gbrain serve not ready yet".into())),
    }
}

/// Brain health for the pill. Returns `healthy: false` (not an error) when the
/// serve is still coming up, so the UI renders "offline" rather than a toast.
#[tauri::command]
pub async fn gbrain_status(state: State<'_, Arc<AppState>>) -> Result<GbrainStatus, AdeError> {
    match endpoint(&state) {
        Ok((base, token)) => Ok(crate::gbrain::status(&base, &token).await),
        Err(_) => Ok(GbrainStatus::default()),
    }
}

/// Semantic/hybrid search over the brain (+ indexed code) for the popover.
#[tauri::command]
pub async fn gbrain_query(
    state: State<'_, Arc<AppState>>,
    q: String,
    limit: Option<u32>,
) -> Result<Vec<GbrainHit>, AdeError> {
    let (base, token) = endpoint(&state)?;
    crate::gbrain::query(&base, &token, &q, limit.unwrap_or(8)).await
}
