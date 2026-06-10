use crate::db::DbPool;
use crate::error::AdeError;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
#[allow(dead_code)]
pub struct OutboxRow {
    pub card_id: String,
    pub intent: String,
    pub payload_json: String,
    pub base_remote_updated_at: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub last_attempt_at: Option<String>,
    pub created_at: String,
}

#[allow(dead_code)]
pub async fn enqueue(
    db: &DbPool,
    card_id: &str,
    from_column: &str,
    to_column: &str,
    base_remote_updated_at: &str,
) -> Result<(), AdeError> {
    let payload_json = serde_json::json!({
        "from_column_name": from_column,
        "to_column_name": to_column,
    })
    .to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT OR REPLACE INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
         VALUES (?, 'set_column', ?, ?, 0, NULL, NULL, ?)",
    )
    .bind(card_id)
    .bind(&payload_json)
    .bind(base_remote_updated_at)
    .bind(&now)
    .execute(db)
    .await
    .map_err(AdeError::Db)?;

    Ok(())
}

/// Load every pending intent for a workspace, regardless of backoff/due state.
/// Reconcile suspension (§12 Row 4) and conflict-drop (§13 step 1) must consider
/// ALL pending rows — `due()` only governs when the network sender retries.
#[allow(dead_code)]
pub async fn all_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<OutboxRow>, AdeError> {
    let rows: Vec<OutboxRow> = sqlx::query_as::<_, OutboxRow>(
        "SELECT o.card_id, o.intent, o.payload_json, o.base_remote_updated_at, o.attempts, o.last_error, o.last_attempt_at, o.created_at
         FROM outbox o JOIN card c ON c.id = o.card_id
         WHERE c.workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)?;

    Ok(rows)
}

#[allow(dead_code)]
pub async fn due(db: &DbPool, now: &str) -> Result<Vec<OutboxRow>, AdeError> {
    let now_dt: DateTime<Utc> = now
        .parse()
        .map_err(|e| AdeError::Other(format!("invalid now timestamp: {}", e)))?;

    let rows: Vec<OutboxRow> = sqlx::query_as::<_, OutboxRow>(
        "SELECT card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at FROM outbox",
    )
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)?;

    let mut due_rows = Vec::new();

    for row in rows {
        let is_due = if row.attempts == 0 {
            let created: DateTime<Utc> = row
                .created_at
                .parse()
                .map_err(|e| AdeError::Other(format!("invalid created_at: {}", e)))?;
            now_dt >= created
        } else {
            let delay_secs = match row.attempts {
                1 => 5,
                2 => 30,
                3 => 120,
                _ => 600,
            };

            let ref_str = row.last_attempt_at.as_deref().unwrap_or(&row.created_at);
            let ref_time: DateTime<Utc> = ref_str
                .parse()
                .map_err(|e| AdeError::Other(format!("invalid timestamp: {}", e)))?;

            let elapsed = now_dt.signed_duration_since(ref_time).num_seconds();
            elapsed >= delay_secs
        };

        if is_due {
            due_rows.push(row);
        }
    }

    Ok(due_rows)
}

#[allow(dead_code)]
pub async fn record_failure(
    db: &DbPool,
    card_id: &str,
    error: &str,
    now: &str,
) -> Result<(), AdeError> {
    sqlx::query(
        "UPDATE outbox SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE card_id = ?",
    )
    .bind(error)
    .bind(now)
    .bind(card_id)
    .execute(db)
    .await
    .map_err(AdeError::Db)?;

    Ok(())
}

#[allow(dead_code)]
pub async fn resolve(db: &DbPool, card_id: &str) -> Result<(), AdeError> {
    sqlx::query("DELETE FROM outbox WHERE card_id = ?")
        .bind(card_id)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;

    Ok(())
}

#[cfg(test)]
mod tests {
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
        let payload: serde_json::Value = serde_json::from_str(&rows[0].payload_json).unwrap();
        assert_eq!(payload["from_column_name"], "Doing");
        assert_eq!(payload["to_column_name"], "Paused");
    }

    #[tokio::test]
    async fn backoff_schedule_respected() {
        let (pool, _tmp) = test_pool().await;
        let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;
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
        let due_rows = due(&pool, &now_str).await.unwrap();
        assert_eq!(due_rows.len(), 1, "attempts=1 with 30s elapsed is due");

        // Row with attempts=2, last_attempt_at=20 seconds ago -> NOT due (20s < 30s)
        let (pool2, _tmp2) = test_pool().await;
        let (_ws2, card_id2) = seed_workspace_and_card(&pool2).await;
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

        let due_rows2 = due(&pool2, &now_str).await.unwrap();
        assert!(
            due_rows2.is_empty(),
            "attempts=2 with 20s elapsed is NOT due (needs 30s)"
        );

        // Row with attempts=0 -> due immediately
        let (pool3, _tmp3) = test_pool().await;
        let (_ws3, card_id3) = seed_workspace_and_card(&pool3).await;
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

        let due_rows3 = due(&pool3, &now_str).await.unwrap();
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
        let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;
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
        let due_rows = due(&pool, &now_str).await.unwrap();
        assert_eq!(
            due_rows.len(),
            1,
            "attempts=3 with 11m elapsed is due (10m delay)"
        );
    }
}
