// M2-T8: Minimal run_cycle for spike tests; M5-T3 expands into full worker loop.

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::{ColumnName, RemoteIssue, SyncAction};
use crate::models::Card;
use crate::sync::engine::{desired_column, reconcile, CardSnapshot, PendingIntent};
use crate::sync::outbox;
use chrono::Utc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::sync::notifier::{AppNotifier, Notifier};
use crate::sync::rate::RateBudget;
#[cfg(test)]
use crate::sync::notifier::CaptureNotifier;

// ── CycleResult ─────────────────────────────────────────────────────

/// What `run_cycle` returns so the caller can decide what to do next
/// (e.g., ensure labels, emit ISSUE_LIST_LARGE).
pub struct CycleResult {
    pub was_seed: bool,
    pub issue_count: usize,
    #[allow(dead_code)]
    pub cycle_start: String,
}

// ── run_cycle ────────────────────────────────────────────────────────

/// Run one sync cycle for a workspace.
/// 1. Look up workspace github_owner/github_repo and sync_state.last_sync
/// 2. Incremental fetch (or seed if no last_sync)
/// 3. Reconcile each issue via engine::reconcile()
/// 4. Apply actions in one DB transaction
/// 5. Run outbox sender pass (check each due intent against remote state)
/// 6. Update sync_state
pub async fn run_cycle(
    db: &DbPool,
    gh: &GitHubClient,
    workspace_id: &str,
    notifier: &dyn Notifier,
    rate_budget: &RateBudget,
    force_full: bool,
) -> Result<CycleResult, AdeError> {
    // Check rate budget before making any HTTP requests.
    rate_budget.check().await?;

    // 1. Look up workspace
    let ws: crate::models::Workspace = crate::repo::workspace_by_id(db, workspace_id).await?;

    let owner = ws
        .github_owner
        .ok_or_else(|| AdeError::Other("workspace has no github_owner".into()))?;
    let repo = ws
        .github_repo
        .ok_or_else(|| AdeError::Other("workspace has no github_repo".into()))?;

    // 2. Check sync_state for last_sync
    let last_sync: Option<String> = crate::sync::queries::read_last_sync(db, workspace_id).await?;

    let was_seed = last_sync.is_none();

    // 3. Fetch remote issues.
    // §11: the next `last_sync` watermark is captured BEFORE the request starts,
    // so issues touched during the round-trip aren't skipped next cycle.
    //
    // A user-initiated "Sync" (`force_full`) does an authoritative full fetch
    // (state=all, no `since`) so it reconciles against the repo's entire issue list
    // and recovers any issue that fell behind the incremental watermark. The
    // background interval stays incremental (`since=last_sync`) for efficiency.
    let cycle_start = Utc::now().to_rfc3339();
    let remote_issues: Vec<RemoteIssue> = match (&last_sync, force_full) {
        (_, true) => gh.list_issues_full(&owner, &repo).await?,
        (Some(since), false) => gh.list_issues_since(&owner, &repo, since).await?,
        (None, false) => gh.list_issues_seed(&owner, &repo).await?,
    };

    let issue_count = remote_issues.len();

    // 4. Build a map of local cards by github_issue_number for reconciliation
    let local_cards: Vec<Card> = crate::repo::cards_for_workspace(db, workspace_id).await?;

    let mut local_by_number: std::collections::HashMap<i64, Card> =
        std::collections::HashMap::new();
    for card in &local_cards {
        if let Some(num) = card.github_issue_number {
            local_by_number.insert(num, card.clone());
        }
    }

    // 5. Load pending outbox intents.
    // §12 Row 4 / §13 step 1: ALL pending intents suspend reconciliation and are
    // checked for conflict, not only the ones whose backoff is due (`due()` only
    // gates the network retry, which lands in M5).
    let pending_rows = outbox::all_for_workspace(db, workspace_id).await?;
    let mut pending_by_card_id: std::collections::HashMap<String, outbox::OutboxRow> =
        std::collections::HashMap::new();
    for row in &pending_rows {
        pending_by_card_id.insert(row.card_id.clone(), row.clone());
    }

    // Build column name lookup: column_id -> ColumnName
    let columns: Vec<crate::models::BoardColumn> =
        crate::repo::columns_for_workspace(db, workspace_id).await?;

    let mut col_name_by_id: std::collections::HashMap<String, ColumnName> =
        std::collections::HashMap::new();
    let mut col_id_by_name: std::collections::HashMap<ColumnName, String> =
        std::collections::HashMap::new();
    for col in &columns {
        let Some(cname) = ColumnName::try_from_str(&col.name) else {
            continue;
        };
        col_name_by_id.insert(col.id.clone(), cname);
        col_id_by_name.insert(cname, col.id.clone());
    }

    // 6. Reconcile and apply actions — §14: all mutations land in one transaction.
    let now = Utc::now().to_rfc3339();
    let mut tx = db.begin().await.map_err(AdeError::Db)?;
    // Notifications are deferred until the transaction commits, so a rollback never
    // tells the user a move was dropped that wasn't actually persisted.
    let mut dropped_intents: Vec<u64> = Vec::new();

    for remote in &remote_issues {
        let number = remote.number as i64;
        let local_card = local_by_number.get(&number);

        // Build CardSnapshot if local card exists
        let snapshot = local_card.and_then(|card| {
            col_name_by_id
                .get(&card.column_id)
                .map(|&col_name| CardSnapshot {
                    card_id: card.id.clone(),
                    column: col_name,
                    remote_updated_at: card.remote_updated_at.clone(),
                })
        });

        let card_id_opt = local_card.map(|c| c.id.clone());

        // §13 step 1 — drop-before-reconcile: if a queued intent exists and the
        // remote has moved the card to a *different* column than `from_column_name`,
        // that's a genuine column conflict. Drop the intent (in-tx) and remove it
        // from the in-memory pending map BEFORE reconciling, so the card is
        // reconciled to the remote state in the SAME cycle (§12 Row 7 produces
        // MoveCard once `pending` is None). A metadata-only bump
        // (`desired == from_column`) keeps the intent and Row 4 still Ignores.
        if let Some(card_id) = &card_id_opt {
            // Read the source column out of the pending row (if any), then release
            // the immutable borrow before we may mutate the map below.
            let from_col_name = match pending_by_card_id.get(card_id) {
                Some(outbox_row) => Some(parse_column_name(&outbox_row.payload_json)?),
                None => None,
            };

            if let Some(from_col_name) = from_col_name {
                let desired_now = desired_column(remote);
                if desired_now != from_col_name {
                    // Genuine column conflict: drop intent, queue INTENT_DROPPED.
                    sqlx::query("DELETE FROM outbox WHERE card_id = ?")
                        .bind(card_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(AdeError::Db)?;
                    pending_by_card_id.remove(card_id);
                    dropped_intents.push(remote.number);
                }
                // If desired_now == from_col_name, the remote change was metadata-only
                // (e.g., a comment). The intent is still valid; leave it for M5 sender.
            }
        }

        // Build PendingIntent from any intent that survived the conflict check.
        let pending = card_id_opt
            .as_ref()
            .and_then(|cid| pending_by_card_id.get(cid))
            .and_then(|row| {
                let payload: serde_json::Value = serde_json::from_str(&row.payload_json).ok()?;
                let to_col_str = payload.get("to_column_name")?.as_str()?;
                let to_col = ColumnName::try_from_str(to_col_str)?;
                Some(PendingIntent {
                    base_remote_updated_at: Some(row.base_remote_updated_at.clone()),
                    to: to_col,
                })
            });

        let action = reconcile(remote, snapshot.as_ref(), pending.as_ref());

        match action {
            SyncAction::CreateCard { issue, column } => {
                let col_id = col_id_by_name
                    .get(&column)
                    .ok_or_else(|| AdeError::Other(format!("column not found: {:?}", column)))?;
                let card_id = uuid::Uuid::new_v4().to_string();
                let labels_json = serde_json::to_string(&issue.labels)
                    .map_err(|e| AdeError::Other(format!("labels json: {}", e)))?;
                sqlx::query(
                    "INSERT INTO card (id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&card_id)
                .bind(workspace_id)
                .bind(col_id)
                .bind(&issue.title)
                .bind(&issue.body_preview)
                .bind(0.0)
                .bind(issue.number as i64)
                .bind(&issue.state)
                .bind(&issue.assignee)
                .bind(&labels_json)
                .bind(&issue.updated_at)
                .bind(&now)
                .bind(&now)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
            }
            SyncAction::MoveCard { card_id, to } => {
                let col_id = col_id_by_name
                    .get(&to)
                    .ok_or_else(|| AdeError::Other(format!("column not found: {:?}", to)))?;
                // §12 Row 7: MoveCard also refreshes fields — a remote move can carry
                // a title/labels/assignee change in the same payload.
                let labels_json = serde_json::to_string(&remote.labels)
                    .map_err(|e| AdeError::Other(format!("labels json: {}", e)))?;
                sqlx::query(
                    "UPDATE card SET column_id = ?, title = ?, github_state = ?, assignee = ?, labels_json = ?, remote_updated_at = ?, updated_at = ? WHERE id = ?",
                )
                .bind(col_id)
                .bind(&remote.title)
                .bind(&remote.state)
                .bind(&remote.assignee)
                .bind(&labels_json)
                .bind(&remote.updated_at)
                .bind(&now)
                .bind(&card_id)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
            }
            SyncAction::RefreshCardFields { card_id } => {
                let labels_json = serde_json::to_string(&remote.labels)
                    .map_err(|e| AdeError::Other(format!("labels json: {}", e)))?;
                sqlx::query(
                    "UPDATE card SET title = ?, github_state = ?, assignee = ?, labels_json = ?, remote_updated_at = ?, updated_at = ? WHERE id = ?",
                )
                .bind(&remote.title)
                .bind(&remote.state)
                .bind(&remote.assignee)
                .bind(&labels_json)
                .bind(&remote.updated_at)
                .bind(&now)
                .bind(&card_id)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
            }
            SyncAction::TouchRemoteUpdatedAt { card_id } => {
                sqlx::query("UPDATE card SET remote_updated_at = ?, updated_at = ? WHERE id = ?")
                    .bind(&remote.updated_at)
                    .bind(&now)
                    .bind(&card_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(AdeError::Db)?;
            }
            SyncAction::Ignore => {}
        }
    }

    // 8. Update sync_state — §11: watermark captured before the fetch (cycle_start).
    if last_sync.is_some() {
        sqlx::query("UPDATE sync_state SET last_sync = ? WHERE workspace_id = ?")
            .bind(&cycle_start)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(AdeError::Db)?;
    } else {
        sqlx::query("INSERT OR REPLACE INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
            .bind(workspace_id)
            .bind(&cycle_start)
            .execute(&mut *tx)
            .await
            .map_err(AdeError::Db)?;
    }

    tx.commit().await.map_err(AdeError::Db)?;

    // Emit deferred notifications only after the transaction has committed.
    for number in dropped_intents {
        notifier.notify(
            "warn",
            "INTENT_DROPPED",
            &format!(
                "issue #{} was moved on GitHub; your move was discarded",
                number
            ),
        );
    }

    Ok(CycleResult {
        was_seed,
        issue_count,
        cycle_start,
    })
}

/// Parse the `from_column_name` field of an outbox payload into a `ColumnName`.
/// §13: the conflict check compares this source column against
/// `desired_column(remote_now)`.
fn parse_column_name(payload_json: &str) -> Result<ColumnName, AdeError> {
    let payload: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|e| AdeError::Other(format!("outbox payload json: {}", e)))?;
    let from_col_str = payload
        .get("from_column_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AdeError::Other("outbox payload missing from_column_name".into()))?;
    ColumnName::try_from_str(from_col_str)
        .ok_or_else(|| AdeError::Other(format!("unknown column name: {}", from_col_str)))
}

// ── start_worker ─────────────────────────────────────────────────────

/// Spawn a per-workspace sync worker that loops on an interval.
/// Each cycle: sleep → check rate_budget → run_cycle → post-cycle hooks.
/// A `Notify` allows `sync_now` to kick an immediate cycle.
pub async fn start_worker(
    db: DbPool,
    gh: Arc<GitHubClient>,
    workspace_id: String,
    rate_budget: Arc<RateBudget>,
    app: tauri::AppHandle,
    notify: Arc<tokio::sync::Notify>,
    interval_secs: u64,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
    // The first tick completes immediately; skip it so we respect the interval.
    interval.tick().await;

    loop {
        // A user-initiated "Sync" arrives via `notify` and triggers a full reconcile;
        // the periodic `interval` tick stays incremental.
        let force_full = tokio::select! {
            _ = interval.tick() => false,
            _ = notify.notified() => true,
        };

        // No token yet: skip quietly instead of burning a 401 + SYNC_ERROR
        // toast every cycle. The worker is respawned when a token is saved.
        if !gh.has_token() {
            continue;
        }

        // Check rate budget — if paused, skip this cycle.
        if let Err(AdeError::RateLimited(_)) = rate_budget.check().await {
            let _ = app.emit(
                "evt:sync",
                serde_json::json!({
                    "workspace_id": &workspace_id,
                    "status": "error",
                    "last_sync": serde_json::Value::Null,
                }),
            );
            continue;
        }

        // Emit syncing status
        let _ = app.emit(
            "evt:sync",
            serde_json::json!({
                "workspace_id": &workspace_id,
                "status": "syncing",
                "last_sync": serde_json::Value::Null,
            }),
        );

        let notifier = AppNotifier(app.clone());
        match run_cycle(&db, &gh, &workspace_id, &notifier, &rate_budget, force_full).await {
            Ok(result) => {
                // If seed and issue count > 500, emit ISSUE_LIST_LARGE
                if result.was_seed && result.issue_count > 500 {
                    crate::notify::emit_notify(
                        &app,
                        "warn",
                        "ISSUE_LIST_LARGE",
                        &format!(
                            "workspace {} has {} issues; initial sync may take a while",
                            workspace_id, result.issue_count
                        ),
                    );
                }

                // Look up owner/repo once for the post-cycle hooks. A lookup
                // failure skips the hooks but must NOT skip the trailing
                // "idle" emit, or the UI stays stuck on "syncing".
                let ws: Option<crate::models::Workspace> =
                    crate::repo::workspace_by_id(&db, &workspace_id).await.ok();
                let owner_repo = ws
                    .as_ref()
                    .and_then(|ws| Some((ws.github_owner.as_ref()?, ws.github_repo.as_ref()?)));

                // If seed, ensure labels once
                if result.was_seed {
                    if let Some((owner, repo)) = owner_repo {
                        if let Ok(()) = gh.ensure_labels(owner, repo).await {
                            let _ = sqlx::query(
                                "UPDATE sync_state SET labels_ensured = 1 WHERE workspace_id = ?",
                            )
                            .bind(&workspace_id)
                            .execute(&db)
                            .await;
                        }
                    }
                }

                // M5-T4: Send outbox intents (§13.1 sender pass)
                if let Some((owner, repo)) = owner_repo {
                    if let Err(e) = outbox::send_outbox(
                        &db,
                        &gh,
                        owner,
                        repo,
                        &workspace_id,
                        &notifier,
                        &rate_budget,
                    )
                    .await
                    {
                        if let AdeError::RateLimited(ref hint) = e {
                            rate_budget
                                .pause_until(Instant::now() + rate_limit_pause(hint))
                                .await;
                            crate::notify::emit_notify(
                                &app,
                                "warn",
                                "RATE_LIMITED",
                                "GitHub rate limit hit during outbox send; pausing sync",
                            );
                        } else {
                            crate::notify::emit_notify(
                                &app,
                                "error",
                                "OUTBOX_SEND_ERROR",
                                &format!("outbox send failed: {}", e),
                            );
                        }
                    }
                }

                // Reconcile wrote cards straight to the DB; push the refreshed
                // board so the UI reflects pulled issues without a workspace switch.
                let _ = crate::ipc::board::emit_board(&app, &workspace_id, &db).await;

                // Get current last_sync for the event
                let last_sync: Option<String> =
                    crate::sync::queries::read_last_sync(&db, &workspace_id)
                        .await
                        .ok()
                        .flatten();

                let _ = app.emit(
                    "evt:sync",
                    serde_json::json!({
                        "workspace_id": workspace_id,
                        "status": "idle",
                        "last_sync": last_sync,
                    }),
                );
            }
            Err(AdeError::RateLimited(ref hint)) => {
                // Pause until the reset hinted by the rate-limit headers
                // (x-ratelimit-reset epoch or retry-after delta), with a 60s
                // fallback when the hint isn't parseable.
                rate_budget
                    .pause_until(Instant::now() + rate_limit_pause(hint))
                    .await;
                crate::notify::emit_notify(
                    &app,
                    "warn",
                    "RATE_LIMITED",
                    "GitHub rate limit hit; pausing sync",
                );
                // Keep showing the last successful sync time in the UI.
                let last_sync: Option<String> =
                    crate::sync::queries::read_last_sync(&db, &workspace_id)
                        .await
                        .ok()
                        .flatten();
                let _ = app.emit(
                    "evt:sync",
                    serde_json::json!({
                        "workspace_id": workspace_id,
                        "status": "error",
                        "last_sync": last_sync,
                    }),
                );
            }
            Err(e) => {
                crate::notify::emit_notify(&app, "error", "SYNC_ERROR", &e.to_string());
                let last_sync: Option<String> =
                    crate::sync::queries::read_last_sync(&db, &workspace_id)
                        .await
                        .ok()
                        .flatten();
                let _ = app.emit(
                    "evt:sync",
                    serde_json::json!({
                        "workspace_id": workspace_id,
                        "status": "error",
                        "last_sync": last_sync,
                    }),
                );
            }
        }
    }
}

/// Translate the hint carried by `AdeError::RateLimited` into a pause duration.
/// The hint is either `x-ratelimit-reset` (unix epoch seconds) or `retry-after`
/// (delta seconds). Unparseable hints fall back to 60s; pauses cap at 1h.
fn rate_limit_pause(hint: &str) -> Duration {
    const FALLBACK_SECS: u64 = 60;
    const MAX_SECS: u64 = 3600;
    let secs = match hint.trim().parse::<i64>() {
        // Values this large are an epoch timestamp, not a delta.
        Ok(v) if v > 1_000_000_000 => (v - Utc::now().timestamp()).max(1) as u64,
        Ok(v) if v > 0 => v as u64,
        _ => FALLBACK_SECS,
    };
    Duration::from_secs(secs.min(MAX_SECS))
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
