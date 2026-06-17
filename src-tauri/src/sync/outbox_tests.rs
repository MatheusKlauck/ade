// Tests for outbox.rs — moved out of the inline `mod tests` to keep the
// production file readable. Still `crate::...::outbox::tests` via #[path],
// so `super::*` resolves to the parent module's items unchanged (#22).
use super::*;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

async fn test_pool() -> (DbPool, tempfile::TempDir) {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let tmp = tempfile::tempdir_in(&dir).unwrap();
    let path = tmp.path().join("test.db");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();

    sqlx::query(
        "CREATE TABLE workspace (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                root_path TEXT NOT NULL,
                github_owner TEXT,
                github_repo TEXT,
                startup_command TEXT,
                created_at TEXT NOT NULL
            );",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE card (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                column_id TEXT NOT NULL,
                title TEXT NOT NULL,
                body_preview TEXT,
                position REAL NOT NULL,
                source TEXT NOT NULL CHECK (source IN ('local','github')),
                github_issue_number INTEGER,
                github_state TEXT CHECK (github_state IN ('open','closed')),
                assignee TEXT,
                labels_json TEXT,
                remote_updated_at TEXT,
                terminal_window_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE outbox (
                card_id TEXT PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
                intent TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                base_remote_updated_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_attempt_at TEXT,
                created_at TEXT NOT NULL
            );",
    )
    .execute(&pool)
    .await
    .unwrap();

    (pool, tmp)
}

async fn seed_workspace_and_card(pool: &DbPool) -> (String, String) {
    let ws_id = uuid::Uuid::new_v4().to_string();
    let card_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES (?1, 'Dev', 'dev', '/tmp/dev', ?2)",
        )
        .bind(&ws_id)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

    sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?1, ?2, 'col1', 'Test card', 1.0, 'local', ?3, ?3)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

    (ws_id, card_id)
}

#[tokio::test]
async fn double_enqueue_keeps_one_row() {
    let (pool, _tmp) = test_pool().await;
    let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;

    let base_remote = Utc::now().to_rfc3339();

    enqueue(&pool, &card_id, "Backlog", "Doing", &base_remote)
        .await
        .unwrap();

    enqueue(&pool, &card_id, "Doing", "Paused", &base_remote)
        .await
        .unwrap();

    let rows: Vec<OutboxRow> = sqlx::query_as::<_, OutboxRow>(
            "SELECT card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at FROM outbox",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "should have exactly one row after double enqueue"
    );
    assert_eq!(rows[0].card_id, card_id);
    assert_eq!(rows[0].attempts, 0);
    // The merged intent keeps the ORIGINAL source column (the remote still
    // reflects Backlog) and only updates the destination.
    let payload: serde_json::Value = serde_json::from_str(&rows[0].payload_json).unwrap();
    assert_eq!(payload["from_column_name"], "Backlog");
    assert_eq!(payload["to_column_name"], "Paused");
}

#[tokio::test]
async fn enqueue_back_to_origin_cancels_intent() {
    let (pool, _tmp) = test_pool().await;
    let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;

    let base_remote = Utc::now().to_rfc3339();

    enqueue(&pool, &card_id, "Backlog", "Doing", &base_remote)
        .await
        .unwrap();
    enqueue(&pool, &card_id, "Doing", "Backlog", &base_remote)
        .await
        .unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "moving back to the origin cancels the intent");
}

#[tokio::test]
async fn backoff_schedule_respected() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, card_id) = seed_workspace_and_card(&pool).await;
    let now = Utc::now();

    // Row with attempts=1, last_attempt_at=30 seconds ago -> due (30s >= 5s)
    let past_30s = (now - chrono::Duration::seconds(30)).to_rfc3339();
    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 1, NULL, ?3, ?4)",
        )
        .bind(&card_id)
        .bind(&past_30s)
        .bind(&past_30s)
        .bind(&past_30s)
        .execute(&pool)
        .await
        .unwrap();

    let now_str = now.to_rfc3339();
    let due_rows = due(&pool, &now_str, &ws_id).await.unwrap();
    assert_eq!(due_rows.len(), 1, "attempts=1 with 30s elapsed is due");

    // Row with attempts=2, last_attempt_at=20 seconds ago -> NOT due (20s < 30s)
    let (pool2, _tmp2) = test_pool().await;
    let (ws2, card_id2) = seed_workspace_and_card(&pool2).await;
    let past_20s = (now - chrono::Duration::seconds(20)).to_rfc3339();
    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 2, NULL, ?3, ?4)",
        )
        .bind(&card_id2)
        .bind(&past_20s)
        .bind(&past_20s)
        .bind(&past_20s)
        .execute(&pool2)
        .await
        .unwrap();

    let due_rows2 = due(&pool2, &now_str, &ws2).await.unwrap();
    assert!(
        due_rows2.is_empty(),
        "attempts=2 with 20s elapsed is NOT due (needs 30s)"
    );

    // Row with attempts=0 -> due immediately
    let (pool3, _tmp3) = test_pool().await;
    let (ws3, card_id3) = seed_workspace_and_card(&pool3).await;
    let past_60s = (now - chrono::Duration::seconds(60)).to_rfc3339();
    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 0, NULL, NULL, ?3)",
        )
        .bind(&card_id3)
        .bind(&past_60s)
        .bind(&past_60s)
        .execute(&pool3)
        .await
        .unwrap();

    let due_rows3 = due(&pool3, &now_str, &ws3).await.unwrap();
    assert_eq!(due_rows3.len(), 1, "attempts=0 is always due");
}

#[tokio::test]
async fn record_failure_increments() {
    let (pool, _tmp) = test_pool().await;
    let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;
    let now = Utc::now().to_rfc3339();

    // Insert an outbox row with attempts=0
    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 0, NULL, NULL, ?2)",
        )
        .bind(&card_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

    let fail_time = Utc::now().to_rfc3339();
    record_failure(&pool, &card_id, "network error", &fail_time)
        .await
        .unwrap();

    let row: OutboxRow = sqlx::query_as::<_, OutboxRow>(
            "SELECT card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at FROM outbox WHERE card_id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(row.attempts, 1);
    assert_eq!(row.last_error.as_deref(), Some("network error"));
    assert_eq!(row.last_attempt_at.as_deref(), Some(fail_time.as_str()));
}

#[tokio::test]
async fn resolve_removes_row() {
    let (pool, _tmp) = test_pool().await;
    let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;
    let now = Utc::now().to_rfc3339();

    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 0, NULL, NULL, ?2)",
        )
        .bind(&card_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

    resolve(&pool, &card_id).await.unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(count, 0);
}

#[tokio::test]
async fn fourth_failure_flag() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, card_id) = seed_workspace_and_card(&pool).await;
    let now = Utc::now();
    // attempts=3, last_attempt_at=11 minutes ago -> still due (10m delay elapsed)
    let past_11m = (now - chrono::Duration::seconds(660)).to_rfc3339();
    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 3, NULL, ?3, ?4)",
        )
        .bind(&card_id)
        .bind(&past_11m)
        .bind(&past_11m)
        .bind(&past_11m)
        .execute(&pool)
        .await
        .unwrap();

    let now_str = now.to_rfc3339();
    let due_rows = due(&pool, &now_str, &ws_id).await.unwrap();
    assert_eq!(
        due_rows.len(),
        1,
        "attempts=3 with 11m elapsed is due (10m delay)"
    );
}

// ── M5-T4: send_outbox integration tests ──────────────────────────

/// Helper: create a test pool with board_column table for send_outbox tests.
async fn test_pool_with_columns() -> (DbPool, tempfile::TempDir) {
    let (pool, tmp) = test_pool().await;

    sqlx::query(
        "CREATE TABLE board_column (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                position INTEGER NOT NULL
            );",
    )
    .execute(&pool)
    .await
    .unwrap();

    (pool, tmp)
}

/// Helper: seed a workspace with 5 board columns and return (ws_id, col_id_map).
async fn seed_workspace_with_columns(
    pool: &DbPool,
) -> (String, std::collections::HashMap<ColumnName, String>) {
    let ws_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) VALUES (?1, 'Dev', 'dev', '/tmp/dev', 'owner', 'repo', ?2)",
        )
        .bind(&ws_id)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

    let columns = [
        ("Backlog", 0i64),
        ("Doing", 1),
        ("Paused", 2),
        ("PR", 3),
        ("Done", 4),
    ];

    let mut col_id_by_name = std::collections::HashMap::new();
    for (name, pos) in &columns {
        let col_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO board_column (id, workspace_id, name, position) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&col_id)
        .bind(&ws_id)
        .bind(*name)
        .bind(*pos)
        .execute(pool)
        .await
        .unwrap();

        let cname = match *name {
            "Backlog" => ColumnName::Backlog,
            "Doing" => ColumnName::Doing,
            "Paused" => ColumnName::Paused,
            "PR" => ColumnName::Pr,
            "Done" => ColumnName::Done,
            _ => unreachable!(),
        };
        col_id_by_name.insert(cname, col_id);
    }

    (ws_id, col_id_by_name)
}

/// Spike 4: Move Doing→Done issues close call + label removal.
/// Card in Doing column with github_issue_number=42, source=github,
/// labels_json='["kanban:doing"]', github_state='open'.
/// Enqueue outbox intent: from=Doing, to=Done.
/// Wiremock: mock set_issue_state("closed") → 200, remove_label("kanban:doing") → 204.
/// Assert: outbox row deleted, card moved to Done column, card's github_state = "closed".
#[tokio::test]
async fn send_outbox_doing_to_done() {
    use crate::sync::notifier::CaptureNotifier;
    use wiremock::matchers::{body_json, method as match_method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let (pool, _tmp) = test_pool_with_columns().await;
    let (ws_id, col_ids) = seed_workspace_with_columns(&pool).await;

    let card_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let done_col_id = col_ids.get(&ColumnName::Done).unwrap().clone();

    // Card in Doing column, optimistically moved to Done by the UI.
    // DB: column_id = Done (optimistic), but labels_json still has "kanban:doing",
    // github_state = "open" — the labels haven't been pushed to GitHub yet.
    // Actually, for the conflict check, the card's labels_json and github_state
    // represent the *remote* cached state. When we enqueue Doing→Done, the
    // from_column=Doing matches the cached state (labels_json has kanban:doing,
    // github_state=open => desired_column=Doing). So the conflict check passes.
    // The optimistic move puts the card's column_id at Done in the UI.
    // But for the outbox sender, we re-check from_column against cached labels/state.
    sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, github_issue_number, github_state, labels_json, remote_updated_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'Test card', 1.0, 'github', 42, 'open', '[\"kanban:doing\"]', ?4, ?4, ?4)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&done_col_id) // optimistically moved to Done in UI
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

    // Enqueue outbox intent: from=Doing, to=Done
    let base_remote = now.clone();
    enqueue(&pool, &card_id, "Doing", "Done", &base_remote)
        .await
        .unwrap();

    let server = MockServer::start().await;

    // Mock: remove_label("kanban:doing") for issue 42 → 204
    Mock::given(match_method("DELETE"))
        .and(path("/repos/owner/repo/issues/42/labels/kanban:doing"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    // Mock: remove_label("kanban:paused") for issue 42 → 404 (not present, OK)
    Mock::given(match_method("DELETE"))
        .and(path("/repos/owner/repo/issues/42/labels/kanban:paused"))
        .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
        .mount(&server)
        .await;

    // Mock: remove_label("kanban:pr") for issue 42 → 404 (not present, OK)
    Mock::given(match_method("DELETE"))
        .and(path("/repos/owner/repo/issues/42/labels/kanban:pr"))
        .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
        .mount(&server)
        .await;

    // Mock: set_issue_state("closed") → 200
    Mock::given(match_method("PATCH"))
        .and(path("/repos/owner/repo/issues/42"))
        .and(body_json(serde_json::json!({ "state": "closed" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "number": 42,
            "title": "Test issue",
            "state": "closed",
            "updated_at": "2025-01-03T00:00:00Z",
            "assignee": null,
            "labels": [],
            "html_url": "https://github.com/owner/repo/issues/42",
            "body": null,
        })))
        .mount(&server)
        .await;

    // Mock: get_issue for re-fetch → 200
    Mock::given(match_method("GET"))
        .and(path("/repos/owner/repo/issues/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "number": 42,
            "title": "Test issue",
            "state": "closed",
            "updated_at": "2025-01-03T00:00:00Z",
            "assignee": null,
            "labels": [],
            "html_url": "https://github.com/owner/repo/issues/42",
            "body": null,
        })))
        .mount(&server)
        .await;

    let gh = crate::gh::client::GitHubClient::new(server.uri(), "test-token".to_string());
    let rate_budget = crate::sync::rate::RateBudget::new();
    let notifier = CaptureNotifier::new();

    send_outbox(&pool, &gh, "owner", "repo", &ws_id, &notifier, &rate_budget)
        .await
        .expect("send_outbox should succeed");

    // Assert: outbox row deleted
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "outbox row should be deleted after success");

    // Assert: card is in Done column
    let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(card.column_id, done_col_id, "card should be in Done column");
    assert_eq!(
        card.github_state.as_deref(),
        Some("closed"),
        "card github_state should be closed"
    );
}

/// Spike 5: 4 consecutive failures → row dropped, card reverted, notification captured.
/// Card in Paused column (optimistically moved from Backlog), github_issue_number=99,
/// labels_json='[]', github_state='open', remote_updated_at set.
/// Outbox intent: from=Backlog, to=Paused, attempts=3.
/// Wiremock: all calls return 500.
/// Assert: outbox row deleted, card reverted to Backlog, notification SYNC_WRITE_FAILED captured.
#[tokio::test]
async fn send_outbox_fourth_failure_reverts() {
    use crate::sync::notifier::CaptureNotifier;
    use wiremock::matchers::{method as match_method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let (pool, _tmp) = test_pool_with_columns().await;
    let (ws_id, col_ids) = seed_workspace_with_columns(&pool).await;

    let card_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let past_11m = (now - chrono::Duration::seconds(660)).to_rfc3339();
    let backlog_col_id = col_ids.get(&ColumnName::Backlog).unwrap().clone();
    let paused_col_id = col_ids.get(&ColumnName::Paused).unwrap().clone();

    // Card optimistically in Paused column, but labels_json='[]' and github_state='open'
    // => desired_column = Backlog. from_column=Backlog matches.
    sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, github_issue_number, github_state, labels_json, remote_updated_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'Test card', 1.0, 'github', 99, 'open', '[]', ?4, ?4, ?4)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&paused_col_id) // optimistically in Paused
        .bind(&past_11m)
        .execute(&pool)
        .await
        .unwrap();

    // Outbox intent: from=Backlog, to=Paused, attempts=3
    // Using direct insert so we can set attempts=3
    let payload = serde_json::json!({
        "from_column_name": "Backlog",
        "to_column_name": "Paused",
    })
    .to_string();
    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', ?2, ?3, 3, NULL, ?4, ?4)",
        )
        .bind(&card_id)
        .bind(&payload)
        .bind(&past_11m)
        .bind(&past_11m)
        .execute(&pool)
        .await
        .unwrap();

    // Wiremock: all calls return 500
    let server = MockServer::start().await;

    // Mock: add_label for "kanban:paused" → 500
    Mock::given(match_method("POST"))
        .and(path("/repos/owner/repo/issues/99/labels"))
        .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
        .mount(&server)
        .await;

    let gh = crate::gh::client::GitHubClient::new(server.uri(), "test-token".to_string());
    let rate_budget = crate::sync::rate::RateBudget::new();
    let notifier = CaptureNotifier::new();

    // send_outbox should not error (it handles failures internally)
    send_outbox(&pool, &gh, "owner", "repo", &ws_id, &notifier, &rate_budget)
        .await
        .expect("send_outbox should not return error on API failure");

    // Assert: outbox row deleted (dropped after 4th failure)
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "outbox row should be deleted after 4th failure");

    // Assert: card reverted to Backlog (desired_column of issue with no labels = Backlog)
    let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        card.column_id, backlog_col_id,
        "card should be reverted to Backlog column"
    );

    // Assert: SYNC_WRITE_FAILED notification captured
    let events = notifier.take();
    let sync_write_failed = events
        .iter()
        .any(|(level, code, _)| level == "error" && code == "SYNC_WRITE_FAILED");
    assert!(
        sync_write_failed,
        "should have SYNC_WRITE_FAILED notification, got: {:?}",
        events
    );
}
