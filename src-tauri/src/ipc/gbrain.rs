//! IPC commands for the StatusBar "brain pill" and its per-state expansion
//! panel: status snapshot, search, per-source sync state, browse, health
//! diagnostics, and the two safe actions (sync now, restart serve). All reads
//! go through the app-owned `gbrain serve --http` (see [`crate::gbrain`]).

use crate::error::AdeError;
use crate::gbrain::{
    GbrainHealth, GbrainHit, GbrainIdentity, GbrainLiveness, GbrainPage, GbrainSource, GbrainStatus,
};
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

/// Just the serve origin, without the bearer — for the unauthenticated liveness
/// probe, which works even before the token/admin path is usable.
fn base(state: &AppState) -> Result<String, AdeError> {
    let guard = state
        .gbrain
        .lock()
        .map_err(|_| AdeError::Other("gbrain runtime lock poisoned".into()))?;
    match guard.as_ref() {
        Some(rt) => Ok(rt.base_url.clone()),
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

/// Version + engine + update availability, for the panel header.
#[tauri::command]
pub async fn gbrain_identity(state: State<'_, Arc<AppState>>) -> Result<GbrainIdentity, AdeError> {
    let (base, token) = endpoint(&state)?;
    crate::gbrain::identity(&base, &token).await
}

/// Per-source sync state, for the "stale" panel's source list.
#[tauri::command]
pub async fn gbrain_sources(state: State<'_, Arc<AppState>>) -> Result<Vec<GbrainSource>, AdeError> {
    let (base, token) = endpoint(&state)?;
    crate::gbrain::sources(&base, &token).await
}

/// Recently-updated pages, for the explore/browse list.
#[tauri::command]
pub async fn gbrain_recent_pages(
    state: State<'_, Arc<AppState>>,
    limit: Option<u32>,
) -> Result<Vec<GbrainPage>, AdeError> {
    let (base, token) = endpoint(&state)?;
    crate::gbrain::recent_pages(&base, &token, limit.unwrap_or(20)).await
}

/// Brain quality metrics (orphans, missing embeddings, score) for diagnostics.
#[tauri::command]
pub async fn gbrain_health(state: State<'_, Arc<AppState>>) -> Result<GbrainHealth, AdeError> {
    let (base, token) = endpoint(&state)?;
    crate::gbrain::health(&base, &token).await
}

/// Unauthenticated liveness probe (`GET /health`) for the offline panel — tells
/// "process up but not ready" apart from "nothing listening".
#[tauri::command]
pub async fn gbrain_liveness(state: State<'_, Arc<AppState>>) -> Result<GbrainLiveness, AdeError> {
    match base(&state) {
        Ok(base) => Ok(crate::gbrain::liveness(&base).await),
        Err(_) => Ok(GbrainLiveness::default()),
    }
}

/// Trigger a brain sync (enqueues a `sync` job on the serve). Safe action from
/// the "stale" panel; returns the job id when the server reports one.
#[tauri::command]
pub async fn gbrain_sync(
    state: State<'_, Arc<AppState>>,
    full: Option<bool>,
) -> Result<String, AdeError> {
    let (base, token) = endpoint(&state)?;
    crate::gbrain::trigger_sync(&base, &token, full.unwrap_or(false)).await
}

/// Restart the app-owned serve in place (kill child → respawn, supervision
/// stays up). Recovery action from the "offline" panel.
#[tauri::command]
pub async fn gbrain_restart(state: State<'_, Arc<AppState>>) -> Result<(), AdeError> {
    let guard = state
        .gbrain
        .lock()
        .map_err(|_| AdeError::Other("gbrain runtime lock poisoned".into()))?;
    match guard.as_ref() {
        Some(rt) => rt
            .handle
            .restart()
            .map_err(|e| AdeError::Other(format!("could not restart gbrain serve: {e}"))),
        None => Err(AdeError::Other("gbrain serve not ready yet".into())),
    }
}
