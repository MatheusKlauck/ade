use crate::error::AdeError;
use crate::AppState;
use sqlx::Row;
use std::sync::Arc;
use tauri::State;

fn default_setting(key: &str) -> Option<String> {
    match key {
        "sync_interval_secs" => Some("30".into()),
        "auto_branch" => Some("true".into()),
        "theme" => Some("dark".into()),
        "startup_command_global" => Some("".into()),
        _ => None,
    }
}

#[tauri::command]
pub async fn setting_get(
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Option<String>, AdeError> {
    let row = sqlx::query("SELECT value FROM setting WHERE key = ?")
        .bind(&key)
        .fetch_optional(&state.db)
        .await
        .map_err(AdeError::Db)?;

    let value = row.map(|r| r.get::<String, _>("value"));
    Ok(value.or_else(|| default_setting(&key)))
}

#[tauri::command]
pub async fn setting_set(
    state: State<'_, Arc<AppState>>,
    key: String,
    value: String,
) -> Result<(), AdeError> {
    sqlx::query(
        "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(&key)
    .bind(&value)
    .execute(&state.db)
    .await
    .map_err(AdeError::Db)?;

    Ok(())
}

#[tauri::command]
pub async fn ui_state_get(
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Option<String>, AdeError> {
    let row = sqlx::query("SELECT value_json FROM ui_state WHERE key = ?")
        .bind(&key)
        .fetch_optional(&state.db)
        .await
        .map_err(AdeError::Db)?;

    Ok(row.map(|r| r.get::<String, _>("value_json")))
}

#[tauri::command]
pub async fn ui_state_set(
    state: State<'_, Arc<AppState>>,
    key: String,
    value_json: String,
) -> Result<(), AdeError> {
    sqlx::query(
        "INSERT INTO ui_state (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    )
    .bind(&key)
    .bind(&value_json)
    .execute(&state.db)
    .await
    .map_err(AdeError::Db)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn test_pool() -> (crate::db::DbPool, tempfile::TempDir) {
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
        sqlx::query("CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE ui_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);")
            .execute(&pool)
            .await
            .unwrap();
        (pool, tmp)
    }

    #[tokio::test]
    async fn setting_set_get_roundtrip() {
        let (pool, _tmp) = test_pool().await;
        sqlx::query("INSERT INTO setting (key, value) VALUES ('x', '1')")
            .execute(&pool)
            .await
            .unwrap();

        let row = sqlx::query("SELECT value FROM setting WHERE key = 'x'")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert_eq!(row.map(|r| r.get::<String, _>("value")).unwrap(), "1");
    }

    #[tokio::test]
    async fn setting_get_unknown_returns_default() {
        let v = default_setting("sync_interval_secs");
        assert_eq!(v, Some("30".into()));
        let v2 = default_setting("auto_branch");
        assert_eq!(v2, Some("true".into()));
        let v3 = default_setting("unknown_key");
        assert_eq!(v3, None);
    }

    #[tokio::test]
    async fn ui_state_set_get_roundtrip() {
        let (pool, _tmp) = test_pool().await;
        sqlx::query("INSERT INTO ui_state (key, value_json) VALUES ('x', '{\"a\":1}')")
            .execute(&pool)
            .await
            .unwrap();

        let row = sqlx::query("SELECT value_json FROM ui_state WHERE key = 'x'")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.map(|r| r.get::<String, _>("value_json")).unwrap(),
            "{\"a\":1}"
        );
    }
}
