use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tauri::Manager;

pub type DbPool = sqlx::SqlitePool;

pub async fn init_db(app: &tauri::AppHandle) -> Result<DbPool, crate::error::AdeError> {
    let data_dir = app.path().app_data_dir().map_err(|e| {
        crate::error::AdeError::Io(std::io::Error::other(format!("app_data_dir: {}", e)))
    })?;

    std::fs::create_dir_all(&data_dir).map_err(crate::error::AdeError::Io)?;

    let db_path = data_dir.join("ade.sqlite");

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .connect_with(options)
        .await
        .map_err(crate::error::AdeError::Db)?;

    sqlx::query("PRAGMA journal_mode=WAL;")
        .execute(&pool)
        .await
        .map_err(crate::error::AdeError::Db)?;

    sqlx::query("PRAGMA busy_timeout=5000;")
        .execute(&pool)
        .await
        .map_err(crate::error::AdeError::Db)?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| crate::error::AdeError::Db(sqlx::Error::Migrate(Box::new(e))))?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migration_creates_all_tables() {
        use sqlx::Row;
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query("PRAGMA journal_mode=WAL;")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("PRAGMA busy_timeout=5000;")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let rows: Vec<sqlx::sqlite::SqliteRow> =
            sqlx::query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
                .fetch_all(&pool)
                .await
                .unwrap();

        let names: Vec<String> = rows.iter().map(|r| r.get::<String, _>("name")).collect();

        assert!(
            names.contains(&"workspace".to_string()),
            "missing workspace"
        );
        assert!(
            names.contains(&"board_column".to_string()),
            "missing board_column"
        );
        assert!(names.contains(&"card".to_string()), "missing card");
        assert!(names.contains(&"outbox".to_string()), "missing outbox");
        assert!(
            names.contains(&"sync_state".to_string()),
            "missing sync_state"
        );
        assert!(names.contains(&"setting".to_string()), "missing setting");
        assert!(
            names.contains(&"workspace_setting".to_string()),
            "missing workspace_setting"
        );
        assert!(names.contains(&"ui_state".to_string()), "missing ui_state");
    }
}
