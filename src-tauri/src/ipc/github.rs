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

#[tauri::command]
pub async fn github_set_token(token: String) -> Result<serde_json::Value, crate::error::AdeError> {
    keychain_set(&token)?;
    Ok(serde_json::json!({ "login": "" }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
