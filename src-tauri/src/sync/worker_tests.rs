// Tests for worker.rs — moved out of the inline `mod tests` to keep the
// production file readable. Still `crate::...::worker::tests` via #[path],
// so `super::*` resolves to the parent module's items unchanged (#22).
use super::*;
use chrono::Utc;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

/// Helper: create a temp DB with full schema via migrations.
async fn test_pool() -> (DbPool, tempfile::TempDir) {
    let dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let tmp = tempfile::tempdir_in(&dir).expect("tempdir");
    let path = tmp.path().join("test.db");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("pool connect");

    sqlx::query("PRAGMA journal_mode=WAL;")
        .execute(&pool)
        .await
        .expect("WAL");
    sqlx::query("PRAGMA busy_timeout=5000;")
        .execute(&pool)
        .await
        .expect("busy_timeout");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");

    (pool, tmp)
}

/// Helper: seed a workspace with 5 columns and return the workspace ID + column ID map.
async fn seed_workspace(pool: &DbPool) -> (String, std::collections::HashMap<ColumnName, String>) {
    let ws_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) VALUES (?, 'TestWS', 'testws', '/tmp/test', ?, ?, ?)",
        )
        .bind(&ws_id)
        .bind("testowner")
        .bind("testrepo")
        .bind(&now)
        .execute(pool)
        .await
        .expect("insert workspace");

    let col_names = ["Backlog", "Doing", "Paused", "PR", "Done"];
    let mut col_ids = std::collections::HashMap::new();
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
        .expect("insert column");

        let cname = match *name {
            "Backlog" => ColumnName::Backlog,
            "Doing" => ColumnName::Doing,
            "Paused" => ColumnName::Paused,
            "PR" => ColumnName::Pr,
            "Done" => ColumnName::Done,
            _ => panic!("unknown column name"),
        };
        col_ids.insert(cname, cid);
    }

    (ws_id, col_ids)
}

/// Helper: insert a card linked to a GitHub issue.
async fn insert_card(
    pool: &DbPool,
    workspace_id: &str,
    column_id: &str,
    issue_number: i64,
    title: &str,
    remote_updated_at: &str,
) -> String {
    let card_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, github_issue_number, github_state, remote_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'github', ?, 'open', ?, ?, ?)",
        )
        .bind(&card_id)
        .bind(workspace_id)
        .bind(column_id)
        .bind(title)
        .bind(1.0)
        .bind(issue_number)
        .bind(remote_updated_at)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .expect("insert card");
    card_id
}

/// Build a GitHub-API-shaped issue JSON object, mirroring
/// `gh::client::tests::issue_json`. The worker consumes raw GitHub JSON via
/// `GitHubClient::map_issue`, so labels must be objects `{"name": ...}` and
/// `assignee` must be null or `{"login": ...}` — serializing a `RemoteIssue`
/// would emit `labels: ["..."]` (string array), which `map_issue` drops.
fn issue_json(number: u64, state: &str, labels: &[&str], updated_at: &str) -> serde_json::Value {
    let label_objs: Vec<serde_json::Value> = labels
        .iter()
        .map(|name| serde_json::json!({ "name": name }))
        .collect();
    serde_json::json!({
        "number": number,
        "title": format!("Issue #{}", number),
        "state": state,
        "updated_at": updated_at,
        "assignee": serde_json::Value::Null,
        "labels": label_objs,
        "html_url": format!(
            "https://github.com/testowner/testrepo/issues/{}",
            number
        ),
        "body": serde_json::Value::Null,
    })
}

// -----------------------------------------------------------------------
// Scenario 1: Remote close while Doing
// Card in "Doing" column; wiremock returns the issue closed.
// After run_cycle, card should end in "Done" column.
// -----------------------------------------------------------------------
#[tokio::test]
async fn scenario_1_remote_close_while_doing() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, col_ids) = seed_workspace(&pool).await;

    // Insert a card in Doing column, linked to issue #42
    let _card_id = insert_card(
        &pool,
        &ws_id,
        col_ids.get(&ColumnName::Doing).expect("Doing column"),
        42,
        "Doing issue",
        "2025-01-01T00:00:00Z",
    )
    .await;

    // Initialize sync_state (has last_sync → incremental fetch)
    sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
        .bind(&ws_id)
        .bind("2025-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .expect("insert sync_state");

    // Wiremock: return issue #42 closed (no kanban labels → desired_column = Done for closed)
    let server = wiremock::MockServer::start().await;
    let closed_issue = issue_json(42, "closed", &[], "2025-01-02T00:00:00Z");
    let body = serde_json::to_string(&vec![closed_issue]).expect("json");
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let gh = GitHubClient::new(server.uri(), "test-token".to_string());
    let notifier = CaptureNotifier::new();
    let rate_budget = RateBudget::new();
    let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false).await;
    assert!(result.is_ok(), "run_cycle failed: {:?}", result.err());

    // Card should now be in Done column
    let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE github_issue_number = 42",
        )
        .fetch_one(&pool)
        .await
        .expect("card exists");

    assert_eq!(
        card.column_id,
        *col_ids.get(&ColumnName::Done).expect("Done column"),
        "card should be in Done after remote close"
    );
    assert_eq!(card.github_state.as_deref(), Some("closed"));
    // §12 Row 7: MoveCard also refreshes fields — title must reflect the remote.
    assert_eq!(
        card.title, "Issue #42",
        "MoveCard should refresh the title from the remote issue"
    );
}

// -----------------------------------------------------------------------
// Fix 2 regression: an intent still in backoff (attempts>0, not yet due)
// must still suspend reconciliation. Otherwise reconcile reverts the user's
// optimistic move while the queued write waits to retry.
// -----------------------------------------------------------------------
#[tokio::test]
async fn intent_in_backoff_suspends_reconcile() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, col_ids) = seed_workspace(&pool).await;

    let backlog_id = col_ids.get(&ColumnName::Backlog).expect("Backlog column");
    let paused_id = col_ids.get(&ColumnName::Paused).expect("Paused column");
    // Card optimistically already in Paused (the user moved Backlog -> Paused).
    let card_id = insert_card(
        &pool,
        &ws_id,
        paused_id,
        77,
        "Backoff issue",
        "2025-01-01T00:00:00Z",
    )
    .await;

    // Outbox intent from=Backlog to=Paused, attempts=2, last_attempt 5s ago -> NOT due.
    let recent = (Utc::now() - chrono::Duration::seconds(5)).to_rfc3339();
    let payload = serde_json::json!({
        "from_column_name": "Backlog",
        "to_column_name": "Paused",
    })
    .to_string();
    sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?, 'set_column', ?, '2025-01-01T00:00:00Z', 2, 'boom', ?, ?)",
        )
        .bind(&card_id)
        .bind(&payload)
        .bind(&recent)
        .bind(&recent)
        .execute(&pool)
        .await
        .expect("insert outbox");

    sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
        .bind(&ws_id)
        .bind("2025-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .expect("sync_state");

    // Remote: issue #77 open, NO kanban label (desired=Backlog=from_column,
    // i.e. a comment-only bump), updated_at advanced to T2.
    let server = wiremock::MockServer::start().await;
    let issue = issue_json(77, "open", &[], "2025-01-02T00:00:00Z");
    let body = serde_json::to_string(&vec![issue]).expect("json");
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let gh = GitHubClient::new(server.uri(), "test-token".to_string());
    let notifier = CaptureNotifier::new();
    let rate_budget = RateBudget::new();
    run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false)
        .await
        .expect("run_cycle ok");

    let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .expect("card exists");

    // Reconcile must have been suspended: card stays where the user put it.
    assert_eq!(
        card.column_id, *paused_id,
        "card must stay in Paused; a backoff intent still suspends reconcile"
    );
    assert_ne!(
        card.column_id, *backlog_id,
        "card must NOT be reverted to Backlog"
    );

    // Intent is comment-only (desired==from) so it is kept, not dropped.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(
        count, 1,
        "comment-only bump must not drop the pending intent"
    );
}

// -----------------------------------------------------------------------
// Scenario 2: Echo suppression
// Card in "Doing" column with remote_updated_at = T1.
// Wiremock returns issue with kanban:doing label and updated_at = T2 (newer).
// After run_cycle: card stays in Doing, remote_updated_at bumped to T2.
// -----------------------------------------------------------------------
#[tokio::test]
async fn scenario_2_echo_suppression() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, col_ids) = seed_workspace(&pool).await;

    let doing_id = col_ids.get(&ColumnName::Doing).expect("Doing column");

    // Card in Doing, remote_updated_at = T1
    let card_id = insert_card(
        &pool,
        &ws_id,
        doing_id,
        10,
        "Echo issue",
        "2025-01-01T00:00:00Z", // T1
    )
    .await;

    sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
        .bind(&ws_id)
        .bind("2025-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .expect("sync_state");

    // Wiremock: issue #10 open with kanban:doing label, updated_at = T2
    let server = wiremock::MockServer::start().await;
    let echo_issue = issue_json(10, "open", &["kanban:doing"], "2025-01-02T00:00:00Z");
    let body = serde_json::to_string(&vec![echo_issue]).expect("json");
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let gh = GitHubClient::new(server.uri(), "test-token".to_string());
    let notifier = CaptureNotifier::new();
    let rate_budget = RateBudget::new();
    let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false).await;
    assert!(result.is_ok(), "run_cycle failed: {:?}", result.err());
    // Card should still be in Doing
    let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .expect("card exists");

    assert_eq!(
        card.column_id, *doing_id,
        "card should stay in Doing (echo suppressed)"
    );
    // remote_updated_at should be bumped to T2
    assert_eq!(
        card.remote_updated_at.as_deref(),
        Some("2025-01-02T00:00:00Z"),
        "remote_updated_at should be bumped to T2"
    );
}

// -----------------------------------------------------------------------
// Scenario 3: Remote column change beats queued move
// Card in Backlog, outbox has intent from=Backlog to=Paused.
// Wiremock returns issue with kanban:doing label (remote moved to Doing ≠ from_column).
// After run_cycle: intent dropped, card reconciled to Doing, INTENT_DROPPED emitted.
//
// Second assertion: an intent whose issue only gained a comment
// (same desired_column as from_column) is NOT dropped.
// -----------------------------------------------------------------------
#[tokio::test]
async fn scenario_3_remote_change_beats_queued_move() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, col_ids) = seed_workspace(&pool).await;

    let backlog_id = col_ids.get(&ColumnName::Backlog).expect("Backlog column");
    let doing_id = col_ids.get(&ColumnName::Doing).expect("Doing column");

    // Card A in Backlog, linked to issue #55 — will be moved remotely to Doing
    let card_a_id = insert_card(
        &pool,
        &ws_id,
        backlog_id,
        55,
        "Intent-drop issue",
        "2025-01-01T00:00:00Z",
    )
    .await;

    // Card B in Backlog, linked to issue #56 — will get a comment only (stays Backlog)
    let card_b_id = insert_card(
        &pool,
        &ws_id,
        backlog_id,
        56,
        "Comment-only issue",
        "2025-01-01T00:00:00Z",
    )
    .await;

    // Outbox intent for card A: from=Backlog, to=Paused
    outbox::enqueue(
        &pool,
        &card_a_id,
        "Backlog",
        "Paused",
        "2025-01-01T00:00:00Z",
    )
    .await
    .expect("enqueue A");

    // Outbox intent for card B: from=Backlog, to=Paused (same from_column)
    outbox::enqueue(
        &pool,
        &card_b_id,
        "Backlog",
        "Paused",
        "2025-01-01T00:00:00Z",
    )
    .await
    .expect("enqueue B");

    sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
        .bind(&ws_id)
        .bind("2025-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .expect("sync_state");

    // Wiremock:
    //   issue #55 has kanban:doing (remote moved to Doing ≠ Backlog=from_column)
    //   issue #56 has no kanban labels (desired=Backlog = from_column)
    let server = wiremock::MockServer::start().await;
    let issue_55 = issue_json(55, "open", &["kanban:doing"], "2025-01-02T00:00:00Z");
    let issue_56 = issue_json(56, "open", &[], "2025-01-02T00:00:00Z");
    let body = serde_json::to_string(&vec![issue_55, issue_56]).expect("json");
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let gh = GitHubClient::new(server.uri(), "test-token".to_string());
    let notifier = CaptureNotifier::new();
    let rate_budget = RateBudget::new();
    let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false).await;
    assert!(result.is_ok(), "run_cycle failed: {:?}", result.err());

    // Card A should be reconciled to Doing (intent dropped)
    let card_a: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_a_id)
        .fetch_one(&pool)
        .await
        .expect("card A exists");

    assert_eq!(
        card_a.column_id, *doing_id,
        "card A should be moved to Doing (intent dropped, reconciled)"
    );

    // Outbox row for card A should be resolved (deleted)
    let count_a: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
        .bind(&card_a_id)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(
        count_a, 0,
        "outbox row for card A should be resolved (deleted)"
    );

    // INTENT_DROPPED notification should have been emitted
    let events = notifier.take();
    let intent_dropped = events.iter().any(|(level, code, msg)| {
        level == "warn" && code == "INTENT_DROPPED" && msg.contains("55")
    });
    assert!(
        intent_dropped,
        "INTENT_DROPPED should be emitted for card A"
    );

    // Card B should stay in Backlog (its intent is NOT dropped because desired=Backlog=from)
    // The intent remains in the outbox
    let card_b: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_b_id)
        .fetch_one(&pool)
        .await
        .expect("card B exists");

    assert_eq!(
        card_b.column_id, *backlog_id,
        "card B should stay in Backlog (intent not dropped)"
    );

    // Outbox row for card B should still exist
    let count_b: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
        .bind(&card_b_id)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(
        count_b, 1,
        "outbox row for card B should still exist (intent not dropped)"
    );
}

// -----------------------------------------------------------------------
// M5-T3: seed then incremental — verify incremental fetch uses `since`
// -----------------------------------------------------------------------
#[tokio::test]
async fn seed_then_incremental() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, _col_ids) = seed_workspace(&pool).await;

    // Wiremock for seed: return 3 open issues
    let server = wiremock::MockServer::start().await;

    let issue1 = issue_json(101, "open", &[], "2025-06-01T00:00:00Z");
    let issue2 = issue_json(102, "open", &[], "2025-06-01T00:00:00Z");
    let issue3 = issue_json(103, "open", &[], "2025-06-01T00:00:00Z");
    let seed_body = serde_json::to_string(&vec![issue1, issue2, issue3]).expect("json");

    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::query_param("state", "open"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&seed_body))
        .mount(&server)
        .await;

    let gh = GitHubClient::new(server.uri(), "test-token".to_string());
    let notifier = CaptureNotifier::new();
    let rate_budget = RateBudget::new();

    // Seed cycle — no last_sync
    let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false)
        .await
        .expect("seed cycle");
    assert!(result.was_seed, "first cycle should be a seed");
    assert_eq!(result.issue_count, 3);

    // Verify last_sync is set
    let last_sync: String =
        sqlx::query_scalar::<_, String>("SELECT last_sync FROM sync_state WHERE workspace_id = ?")
            .bind(&ws_id)
            .fetch_one(&pool)
            .await
            .expect("last_sync");
    assert!(!last_sync.is_empty(), "last_sync should be set after seed");

    // Verify 3 cards were created
    let card_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM card WHERE workspace_id = ?")
        .bind(&ws_id)
        .fetch_one(&pool)
        .await
        .expect("card count");
    assert_eq!(card_count, 3, "should have 3 cards after seed");

    // Now set up wiremock for incremental fetch — return 1 new issue (#104)
    // and the existing issue #102 with updated labels
    // We need to reset the server mock
    let server2 = wiremock::MockServer::start().await;
    let issue4 = issue_json(104, "open", &[], "2025-06-02T00:00:00Z");
    let incremental_body = serde_json::to_string(&vec![issue4]).expect("json");

    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::query_param("state", "all"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&incremental_body))
        .mount(&server2)
        .await;

    let gh2 = GitHubClient::new(server2.uri(), "test-token".to_string());

    // Incremental cycle — has last_sync
    let result2 = run_cycle(&pool, &gh2, &ws_id, &notifier, &rate_budget, false)
        .await
        .expect("incremental cycle");
    assert!(!result2.was_seed, "second cycle should be incremental");

    // Verify the new card appears
    let card_count2: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM card WHERE workspace_id = ?")
        .bind(&ws_id)
        .fetch_one(&pool)
        .await
        .expect("card count");
    assert_eq!(card_count2, 4, "should have 4 cards after incremental");

    // Verify the since parameter was sent
    // We check the wiremock request log
    let requests = server2.received_requests().await.expect("requests");
    assert!(!requests.is_empty(), "should have received requests");
    let request_url = &requests[0].url;
    assert!(
        request_url.query().unwrap_or("").contains("since="),
        "incremental fetch should include since parameter, got: {:?}",
        request_url.query()
    );
}

// -----------------------------------------------------------------------
// issue #10: a manual "Sync" (force_full) does an authoritative full fetch
// (state=all, no `since`) and recovers an issue stranded behind the watermark.
// An incremental cycle with the same watermark would never see it because the
// issue's updated_at is older than last_sync.
// -----------------------------------------------------------------------
#[tokio::test]
async fn manual_sync_full_recovers_stranded_issue() {
    let (pool, _tmp) = test_pool().await;
    let (ws_id, _col_ids) = seed_workspace(&pool).await;

    // Watermark is AHEAD of the stranded issue's updated_at.
    sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
        .bind(&ws_id)
        .bind("2025-06-10T00:00:00Z")
        .execute(&pool)
        .await
        .expect("insert sync_state");

    // Stranded open issue: updated_at (2025-06-01) is BEFORE the watermark, so a
    // real incremental `since=2025-06-10` fetch would never return it.
    let stranded = issue_json(200, "open", &[], "2025-06-01T00:00:00Z");
    let body = serde_json::to_string(&vec![stranded]).expect("json");

    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::query_param("state", "all"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let gh = GitHubClient::new(server.uri(), "test-token".to_string());
    let notifier = CaptureNotifier::new();
    let rate_budget = RateBudget::new();

    // Manual sync: force_full = true.
    let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, true)
        .await
        .expect("full cycle");
    assert!(
        !result.was_seed,
        "a workspace with last_sync is not a seed even on a full sync"
    );

    // The stranded issue was recovered as a card.
    let card_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM card WHERE workspace_id = ? AND github_issue_number = 200",
    )
    .bind(&ws_id)
    .fetch_one(&pool)
    .await
    .expect("card count");
    assert_eq!(card_count, 1, "full sync should recover the stranded issue");

    // The full fetch must NOT carry a `since` watermark.
    let requests = server.received_requests().await.expect("requests");
    assert!(!requests.is_empty(), "should have received a request");
    let query = requests[0].url.query().unwrap_or("");
    assert!(
        query.contains("state=all"),
        "full fetch should request state=all, got: {query}"
    );
    assert!(
        !query.contains("since="),
        "full fetch must NOT include a since watermark, got: {query}"
    );
}

// -----------------------------------------------------------------------
// M5-T3: rate budget pause test
// -----------------------------------------------------------------------
#[tokio::test]
async fn rate_budget_pause() {
    let budget = RateBudget::new();

    // Initially not paused
    assert!(
        budget.check().await.is_ok(),
        "should not be paused initially"
    );

    // Set pause to future
    budget
        .pause_until(Instant::now() + Duration::from_secs(300))
        .await;

    // Check should return RateLimited
    let result = budget.check().await;
    assert!(
        matches!(result, Err(AdeError::RateLimited(_))),
        "should be rate limited when paused"
    );

    // Clear the pause
    budget.clear().await;

    // Check should return Ok now
    assert!(
        budget.check().await.is_ok(),
        "should not be paused after clear"
    );

    // Set a past instant — should be expired, check returns Ok
    budget
        .pause_until(Instant::now() - Duration::from_secs(1))
        .await;
    assert!(
        budget.check().await.is_ok(),
        "expired pause should return Ok"
    );
}
