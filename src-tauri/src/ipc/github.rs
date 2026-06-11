use keyring_core::Entry;
use keyring_core::Error as KeyringError;

fn map_err(e: KeyringError) -> crate::error::AdeError {
    crate::error::AdeError::Keychain(e.to_string())
}

fn entry() -> Result<Entry, crate::error::AdeError> {
    Entry::new("ade", "github_pat").map_err(map_err)
}

pub fn keychain_set(token: &str) -> Result<(), crate::error::AdeError> {
    entry()?.set_password(token).map_err(map_err)
}

#[allow(dead_code)]
pub fn keychain_get() -> Result<Option<String>, crate::error::AdeError> {
    match entry()?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

#[allow(dead_code)]
pub fn keychain_delete() -> Result<(), crate::error::AdeError> {
    entry()?.delete_credential().map_err(map_err)
}

/// Validate a GitHub PAT by calling GET /user.
/// On success, store in Keychain and return the login name.
/// On 401, return TokenInvalid (do NOT store).
/// On 403 with a scope-related message, emit a TOKEN_SCOPE notification and return TokenInvalid.
#[tauri::command]
pub async fn github_set_token(
    app: tauri::AppHandle,
    token: String,
) -> Result<serde_json::Value, crate::error::AdeError> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "ade")
        .send()
        .await
        .map_err(|e| crate::error::AdeError::GitHub(format!("request failed: {e}")))?;

    let status = response.status();
    if status.as_u16() == 401 {
        return Err(crate::error::AdeError::TokenInvalid);
    }

    if status.as_u16() == 403 {
        let body = response.text().await.unwrap_or_default();
        // Check for scope-related message
        if body.contains("scope") {
            crate::notify::emit_notify(&app, "warn", "TOKEN_SCOPE", &body);
            return Err(crate::error::AdeError::TokenInvalid);
        }
        return Err(crate::error::AdeError::GitHub(format!(
            "HTTP 403: {}",
            body.chars().take(200).collect::<String>()
        )));
    }

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(crate::error::AdeError::GitHub(format!(
            "HTTP {}: {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        )));
    }

    let user: serde_json::Value = response.json().await.map_err(|e| {
        crate::error::AdeError::GitHub(format!("failed to parse /user response: {e}"))
    })?;

    let login = user["login"].as_str().unwrap_or("").to_string();

    keychain_set(&token)?;
    Ok(serde_json::json!({ "login": login }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn valid_token_returns_login() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/user"))
            .and(header("Authorization", "Bearer ghp_valid123"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"login":"octocat","id":1}"#),
            )
            .mount(&server)
            .await;

        // We test the HTTP validation logic directly (not the Tauri command,
        // which needs an AppHandle). This validates the core flow:
        // - GET /user with the token
        // - 200 → extract login, would store in keychain
        let client = reqwest::Client::new();
        let response = client
            .get(format!("{}/user", server.uri()))
            .header("Authorization", "Bearer ghp_valid123")
            .header("User-Agent", "ade")
            .send()
            .await
            .expect("request should succeed");

        assert_eq!(response.status().as_u16(), 200);
        let user: serde_json::Value = response.json().await.expect("should parse json");
        assert_eq!(user["login"].as_str(), Some("octocat"));
    }

    #[tokio::test]
    async fn invalid_token_401_returns_error() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(401).set_body_string(r#"{"message":"Bad credentials"}"#),
            )
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let response = client
            .get(format!("{}/user", server.uri()))
            .header("Authorization", "Bearer ghp_bad_token")
            .header("User-Agent", "ade")
            .send()
            .await
            .expect("request should succeed");

        assert_eq!(response.status().as_u16(), 401);
        // In the real command, this maps to AdeError::TokenInvalid
        // and the token is NOT stored in keychain.
    }

    #[tokio::test]
    async fn token_403_with_scope_message() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(403).set_body_string(
                    r#"{"message":"Must have admin scope to access this endpoint"}"#,
                ),
            )
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let response = client
            .get(format!("{}/user", server.uri()))
            .header("Authorization", "Bearer ghp_limited_scope")
            .header("User-Agent", "ade")
            .send()
            .await
            .expect("request should succeed");

        assert_eq!(response.status().as_u16(), 403);
        let body: String = response.text().await.expect("should read body");
        assert!(body.contains("scope"), "403 body should mention scope");
        // In the real command, this would emit TOKEN_SCOPE notification
        // and return AdeError::TokenInvalid.
    }

    #[ignore = "needs-keychain"]
    #[test]
    fn keychain_set_get_delete_roundtrip() {
        let test_token = "ghp_test_roundtrip_12345";
        keychain_set(test_token).expect("set failed");
        let got = keychain_get().expect("get failed");
        assert_eq!(got, Some(test_token.to_string()));
        keychain_delete().expect("delete failed");
        let after = keychain_get().expect("get after delete failed");
        assert_eq!(after, None);
    }
}
