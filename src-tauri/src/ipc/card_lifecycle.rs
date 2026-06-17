// Terminal/git side effects of moving a card, extracted from `card_move` so
// the IPC handler keeps only the position math + outbox enqueue. Both fns
// preserve the original behavior exactly: a failed tmux step emits its notify
// and returns Ok(()) so `card_move` still returns the moved card.

use crate::board_pos::{append_position, insert_between, needs_rebalance, rebalance};
use crate::db::DbPool;
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::ColumnName;
use crate::models::Card;
use crate::notify::emit_notify;
use crate::pty::PtyRegistry;
use crate::sync::outbox;
use crate::{gitlocal, tmux};
use chrono::Utc;
use sqlx::Row;
use tauri::{Emitter, Manager};

use super::board::emit_board;

/// Move to Done: close the card's terminal. Mirrors the move-to-Doing launch
/// below — the backend owns the terminal lifecycle, so this fires for every
/// move path (drag or programmatic), not just the optimistic UI close in
/// Board.tsx. We kill the tmux window (so the agent process actually stops,
/// not just the viewer), drop any open PTY panes, clear the link, and tell
/// the frontend to remove the pane.
pub async fn on_moved_to_done(
    db: &DbPool,
    app: &tauri::AppHandle,
    pty: &PtyRegistry,
    card: &mut Card,
) -> Result<(), AdeError> {
    // Gestor card: the dispatch path (B) stores the worker window on the
    // agent_task, not card.terminal_window_id. Abort the task — that tears down
    // its worktree+window via cleanup — then re-pin the card to Done so the
    // human's drag wins over the aborted→Paused projection (D13).
    if let Some(t) = crate::repo::agent_tasks_for_workspace(db, &card.workspace_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|t| {
            t.card_id == card.id
                && !crate::gestor::fsm::TaskState::parse(&t.state)
                    .map(|s| s.is_terminal())
                    .unwrap_or(false)
        })
    {
        let _ = crate::gestor::fsm::transition(
            db,
            &t.id,
            crate::gestor::fsm::TaskState::Aborted,
            Some("moved to Done by user"),
        )
        .await;
        if let Ok(ws) = crate::repo::workspace_by_id(db, &card.workspace_id).await {
            let repo_path = gitlocal::find_repo_path(&ws.root_path).unwrap_or(ws.root_path);
            crate::gestor::dispatch::cleanup(db, &repo_path, &t.id).await;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let _ =
            crate::repo::move_card_to_column(db, &card.id, &card.workspace_id, "Done", &now).await;
        emit_board(app, &card.workspace_id, db).await?;
        return Ok(());
    }

    let Some(window_id) = card.terminal_window_id.clone() else {
        return Ok(());
    };

    // Run the default preset's close commands into the still-live tmux
    // window before we tear it down. Best-effort: any failure (no default
    // preset, malformed JSON, tmux gone) just skips to the kill below.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PresetClose {
        id: String,
        #[serde(default)]
        close_commands: Vec<String>,
    }
    let default_id =
        crate::ipc::settings::workspace_setting_value(db, &card.workspace_id, "default_preset_id")
            .await
            .unwrap_or_default();
    if !default_id.is_empty() {
        let raw = crate::ipc::settings::workspace_setting_value(
            db,
            &card.workspace_id,
            "terminal_presets",
        )
        .await
        .unwrap_or_default();
        if let Ok(list) = serde_json::from_str::<Vec<PresetClose>>(&raw) {
            if let Some(p) = list.into_iter().find(|p| p.id == default_id) {
                let cmds: Vec<String> = p
                    .close_commands
                    .into_iter()
                    .map(|c| c.trim().to_string())
                    .filter(|c| !c.is_empty())
                    .collect();
                if !cmds.is_empty() {
                    // One tmux spawn for all commands, off the async
                    // runtime so it can't stall other IPC handlers.
                    let wid = window_id.clone();
                    let joined = cmds.join("; ");
                    let _ =
                        tokio::task::spawn_blocking(move || tmux::send_keys(&wid, &joined)).await;
                    // Give the commands a moment to start before the kill.
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            }
        }
    }

    // Drop PTY panes for this window first (kills each viewer process).
    // Scope the lock so it's released before the awaits below.
    {
        if let Ok(mut reg) = pty.lock() {
            let keys: Vec<String> = reg
                .iter()
                .filter(|(_, p)| p.window_id == window_id && p.workspace_id == card.workspace_id)
                .map(|(k, _)| k.clone())
                .collect();
            for k in keys {
                if let Some(pane) = reg.remove(&k) {
                    let _ = pane.close();
                }
            }
        }
    }
    // Kill the tmux window itself. Best-effort: it may already be gone.
    {
        let wid = window_id.clone();
        let _ = tokio::task::spawn_blocking(move || tmux::kill_window(&wid)).await;
    }

    // Clear the link so a later move back to Doing spawns a fresh window.
    sqlx::query("UPDATE card SET terminal_window_id = NULL WHERE id = ?")
        .bind(&card.id)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;
    card.terminal_window_id = None;

    // Tell the frontend to drop the pane from its UI.
    let _ = app.emit(
        "evt:terminal_close",
        serde_json::json!({
            "workspace_id": card.workspace_id,
            "window_id": window_id,
        }),
    );

    // Board changed (terminal_window_id cleared).
    emit_board(app, &card.workspace_id, db).await?;
    Ok(())
}

/// Move to Doing: the single dispatch surface (B/D11). The human dragging a card
/// to Doing runs the SAME enqueue+worker-launch the autonomous loop uses — the
/// gestor owns the card's FSM either way. The worker runs in an isolated worktree
/// with the protocol prompt injected by the backend; we focus its pane WITHOUT a
/// `card_id` so the frontend does not re-inject. Re-dragging an in-flight card
/// just re-focuses its window.
pub async fn on_moved_to_doing(
    db: &DbPool,
    app: &tauri::AppHandle,
    card: &Card,
) -> Result<(), AdeError> {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        emit_notify(
            app,
            "warn",
            "DISPATCH_FAILED",
            "could not resolve app data dir for dispatch",
        );
        return Ok(());
    };

    match crate::gestor::dispatch::enqueue_and_dispatch(
        db,
        &app_data_dir,
        &card.workspace_id,
        &card.id,
    )
    .await
    {
        Ok(Some(window_id)) => {
            let _ = app.emit(
                "evt:terminal_focus",
                serde_json::json!({
                    "workspace_id": card.workspace_id,
                    "window_id": window_id,
                }),
            );
        }
        Ok(None) => {}
        Err(e) => emit_notify(
            app,
            "warn",
            "DISPATCH_FAILED",
            &format!("failed to dispatch worker: {e}"),
        ),
    }

    // Board changed (card projected to Doing, terminal opened).
    emit_board(app, &card.workspace_id, db).await?;
    Ok(())
}

/// Move a card to a column at the drop target, persisting the position math in a
/// transaction, then run the cross-cutting effects (outbox enqueue for linked
/// cards, Doing/Done lifecycle). The IPC command `card_move` is a thin shell over
/// this so the rule is testable without Tauri `State`.
pub(crate) async fn move_card(
    db: &DbPool,
    app: &tauri::AppHandle,
    pty: &PtyRegistry,
    card_id: String,
    to_column_id: String,
    before_card_id: Option<String>,
    after_card_id: Option<String>,
) -> Result<Card, AdeError> {
    let mut tx = db.begin().await.map_err(AdeError::Db)?;

    let card_row = sqlx::query("SELECT workspace_id, column_id, position FROM card WHERE id = ?")
        .bind(&card_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(AdeError::Db)?;

    let (workspace_id, from_column_id, _old_position) = match card_row {
        Some(r) => (
            r.get::<String, _>("workspace_id"),
            r.get::<String, _>("column_id"),
            r.get::<f64, _>("position"),
        ),
        None => {
            emit_notify(
                app,
                "warn",
                "INTERNAL",
                &format!("card_move: card {} not found", card_id),
            );
            return Err(AdeError::Other(format!("card {} not found", card_id)));
        }
    };

    let new_position = if before_card_id.is_none() && after_card_id.is_none() {
        let max_pos: Option<f64> = sqlx::query_scalar(
            "SELECT MAX(position) FROM card WHERE workspace_id = ? AND column_id = ?",
        )
        .bind(&workspace_id)
        .bind(&to_column_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(AdeError::Db)?;
        append_position(max_pos)
    } else {
        let before_pos = match before_card_id {
            Some(ref id) => {
                let row = sqlx::query("SELECT position FROM card WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(AdeError::Db)?;
                row.map(|r| r.get::<f64, _>("position"))
            }
            None => None,
        };
        let after_pos = match after_card_id {
            Some(ref id) => {
                let row = sqlx::query("SELECT position FROM card WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(AdeError::Db)?;
                row.map(|r| r.get::<f64, _>("position"))
            }
            None => None,
        };

        // Semantics: `before` is the card immediately BELOW the drop target (upper bound),
        // `after` is the card immediately ABOVE (lower bound). Positions are ascending top→bottom,
        // so after_pos < before_pos when both are present.
        match (before_pos, after_pos) {
            // Drop between two cards: midpoint.
            (Some(before), Some(after)) => insert_between(after, before),
            // Drop before the FIRST card (nothing below it): place above it, i.e. between 0 and it.
            (Some(before), None) => insert_between(0.0, before),
            // Column drop / append after the LAST card (nothing above it): place after it.
            (None, Some(after)) => append_position(Some(after)),
            // Empty column or completely unanchored: append after current max.
            (None, None) => {
                let max_pos: Option<f64> = sqlx::query_scalar(
                    "SELECT MAX(position) FROM card WHERE workspace_id = ? AND column_id = ?",
                )
                .bind(&workspace_id)
                .bind(&to_column_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
                append_position(max_pos)
            }
        }
    };

    sqlx::query("UPDATE card SET column_id = ?, position = ?, updated_at = ? WHERE id = ?")
        .bind(&to_column_id)
        .bind(new_position)
        .bind(Utc::now().to_rfc3339())
        .bind(&card_id)
        .execute(&mut *tx)
        .await
        .map_err(AdeError::Db)?;

    let positions_in_column: Vec<(String, f64)> = sqlx::query(
        "SELECT id, position FROM card WHERE workspace_id = ? AND column_id = ? ORDER BY position",
    )
    .bind(&workspace_id)
    .bind(&to_column_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(AdeError::Db)?
    .into_iter()
    .map(|r: sqlx::sqlite::SqliteRow| {
        let id: String = r.get("id");
        let pos: f64 = r.get("position");
        (id, pos)
    })
    .collect();

    let pos_values: Vec<f64> = positions_in_column.iter().map(|(_, p)| *p).collect();
    if needs_rebalance(&pos_values) {
        let rebalanced = rebalance(&positions_in_column);
        for (id, pos) in rebalanced {
            sqlx::query("UPDATE card SET position = ? WHERE id = ?")
                .bind(pos)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
        }
    }

    tx.commit().await.map_err(AdeError::Db)?;

    let mut card: Card = crate::repo::card_by_id_required(db, &card_id).await?;

    emit_board(app, &workspace_id, db).await?;

    // M5-T4: §13.1 — enqueue outbox intent for linked cards on user drag
    if card.source == "github" && card.github_issue_number.is_some() {
        if let Some(ref remote_updated_at) = card.remote_updated_at {
            // Resolve column names from IDs
            let from_col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
                .bind(&from_column_id)
                .fetch_optional(db)
                .await
                .map_err(AdeError::Db)?;
            let to_col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
                .bind(&to_column_id)
                .fetch_optional(db)
                .await
                .map_err(AdeError::Db)?;

            if let (Some(from_r), Some(to_r)) = (from_col_row, to_col_row) {
                let from_name: String = from_r.get::<String, _>("name");
                let to_name: String = to_r.get::<String, _>("name");
                // Only enqueue if the move is a real column change (not same column reorder)
                if from_name != to_name {
                    if let Err(e) =
                        outbox::enqueue(db, &card_id, &from_name, &to_name, remote_updated_at).await
                    {
                        emit_notify(
                            app,
                            "error",
                            "DB_ERROR",
                            &format!("failed to enqueue outbox intent: {}", e),
                        );
                    }
                }
            }
        }
    }

    // M4-T2: §16 trigger — auto-launch terminal on move to Doing (user drag only)
    let _ = from_column_id;

    // 1. Check if target column is "Doing"
    let col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
        .bind(&to_column_id)
        .fetch_optional(db)
        .await
        .map_err(AdeError::Db)?;

    let col_name: String = match col_row {
        Some(r) => r.get::<String, _>("name"),
        None => return Ok(card),
    };
    let target_column = ColumnName::try_from_str(&col_name);

    if target_column == Some(ColumnName::Done) {
        on_moved_to_done(db, app, pty, &mut card).await?;
        return Ok(card);
    }

    if target_column != Some(ColumnName::Doing) {
        return Ok(card);
    }

    on_moved_to_doing(db, app, &card).await?;

    Ok(card)
}

/// Promote a local card to a real GitHub issue: create the issue, apply the
/// column's kanban label (or close it for Done), and refresh the local row. The
/// IPC command `card_promote` is a thin shell over this.
pub(crate) async fn promote_card(
    db: &DbPool,
    app: &tauri::AppHandle,
    card_id: String,
) -> Result<Card, AdeError> {
    // 1. Load card
    let card: Card = crate::repo::card_by_id(db, &card_id)
        .await?
        .ok_or_else(|| AdeError::Other("card not found".to_string()))?;

    // 2. Only local cards can be promoted
    if card.source != "local" {
        return Err(AdeError::Other("card already linked".to_string()));
    }

    // 3. Look up workspace for GitHub owner/repo
    let ws_row = sqlx::query("SELECT github_owner, github_repo FROM workspace WHERE id = ?")
        .bind(&card.workspace_id)
        .fetch_optional(db)
        .await
        .map_err(AdeError::Db)?
        .ok_or_else(|| AdeError::Other("workspace not found".to_string()))?;

    let owner: String = ws_row
        .get::<Option<String>, _>("github_owner")
        .ok_or_else(|| AdeError::Other("workspace has no GitHub owner".to_string()))?;
    let repo: String = ws_row
        .get::<Option<String>, _>("github_repo")
        .ok_or_else(|| AdeError::Other("workspace has no GitHub repo".to_string()))?;

    // 4. Get GitHub token from keychain (per-workspace, with legacy global fallback)
    let token = crate::ipc::github::keychain_get_for_workspace(&card.workspace_id)?
        .ok_or_else(|| AdeError::Other("GitHub token not found in keychain".to_string()))?;

    // 5. Create GitHubClient
    let gh = GitHubClient::new(crate::gh::client::GITHUB_API_BASE.to_string(), token);

    // 6. Create the GitHub issue
    let issue = gh
        .create_issue(&owner, &repo, &card.title, card.body_preview.as_deref())
        .await
        .map_err(|e| AdeError::Other(format!("failed to create GitHub issue: {e}")))?;

    // 7. Update card in DB: source, issue number, state, remote_updated_at, labels_json
    let labels_initial = "[]";
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE card SET source = 'github', github_issue_number = ?, github_state = 'open', remote_updated_at = ?, labels_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(issue.number as i64)
    .bind(&issue.updated_at)
    .bind(labels_initial)
    .bind(&now)
    .bind(&card_id)
    .execute(db)
    .await
    .map_err(AdeError::Db)?;

    // 8. If column is not Backlog, add kanban label
    let col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
        .bind(&card.column_id)
        .fetch_optional(db)
        .await
        .map_err(AdeError::Db)?;

    let col_name_str: Option<String> = col_row.map(|r| r.get::<String, _>("name"));

    let column_name = col_name_str
        .as_deref()
        .and_then(ColumnName::try_from_str)
        .unwrap_or(ColumnName::Backlog);

    let mut labels_vec: Vec<String> = Vec::new();

    match column_name {
        ColumnName::Backlog => {
            // No label needed
        }
        ColumnName::Doing | ColumnName::Paused | ColumnName::Pr => {
            // Non-Backlog open columns always carry a kanban label.
            let label = column_name
                .kanban_label()
                .expect("open non-Backlog columns have a kanban label")
                .to_string();
            gh.add_label(&owner, &repo, issue.number, &label)
                .await
                .map_err(|e| {
                    AdeError::Other(format!("failed to add label to GitHub issue: {e}"))
                })?;
            labels_vec.push(label);

            // Re-fetch the issue to get the updated timestamp after label add
            let updated_issue = gh
                .get_issue(&owner, &repo, issue.number)
                .await
                .map_err(|e| AdeError::Other(format!("failed to re-fetch GitHub issue: {e}")))?;
            let labels_json =
                serde_json::to_string(&labels_vec).unwrap_or_else(|_| "[]".to_string());
            sqlx::query("UPDATE card SET labels_json = ?, remote_updated_at = ? WHERE id = ?")
                .bind(&labels_json)
                .bind(&updated_issue.updated_at)
                .bind(&card_id)
                .execute(db)
                .await
                .map_err(AdeError::Db)?;
        }
        ColumnName::Done => {
            // Close the issue
            gh.set_issue_state(&owner, &repo, issue.number, "closed")
                .await
                .map_err(|e| AdeError::Other(format!("failed to close GitHub issue: {e}")))?;
        }
    }

    // 9. Emit board event
    emit_board(app, &card.workspace_id, db).await?;

    // 10. Return the updated card
    let updated_card = crate::repo::card_by_id_required(db, &card_id).await?;

    Ok(updated_card)
}
