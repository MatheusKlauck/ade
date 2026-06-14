//! One-time wiring so the app and Claude Code share one `gbrain serve --http`:
//! mint/cache a bearer token, and repoint Claude Code's gbrain MCP entry from a
//! lock-stealing stdio serve to the shared HTTP endpoint.

use crate::error::AdeError;
use keyring_core::{Entry, Error as KeyringError};
use serde_json::{json, Value};
use std::process::Command;

fn map_keyring(e: KeyringError) -> AdeError {
    AdeError::Keychain(e.to_string())
}

/// Keychain slot for the long-lived serve bearer token (plaintext; the brain
/// only stores its hash, so we must keep our own copy to reuse).
fn token_entry() -> Result<Entry, AdeError> {
    Entry::new("ade", "gbrain_serve_token").map_err(map_keyring)
}

fn cached_token() -> Result<Option<String>, AdeError> {
    match token_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(map_keyring(e)),
    }
}

/// Extract a `gbrain_<hex>` token from `gbrain auth create` output.
fn parse_minted_token(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .find(|tok| tok.starts_with("gbrain_") && tok.len() > 16)
        .map(str::to_string)
}

/// Mint a fresh bearer via `gbrain auth create`. The token name is reused, so a
/// pre-existing one is revoked first (its plaintext is unrecoverable — we only
/// reach here when our keychain copy is missing). Requires the PGLite lock to be
/// free, so call this AFTER reaping the stdio serve and BEFORE starting ours.
fn mint_token(bin: &str) -> Result<String, AdeError> {
    const NAME: &str = "ade-app";
    let run = |args: &[&str]| Command::new(bin).args(args).output();

    let out = run(&["auth", "create", NAME])
        .map_err(|e| AdeError::Other(format!("gbrain auth create failed to launch: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);

    if let Some(tok) = parse_minted_token(&stdout) {
        return Ok(tok);
    }

    // Likely "already exists" — revoke and recreate to obtain a fresh plaintext.
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("already exists") || stdout.contains("already exists") {
        let _ = run(&["auth", "revoke", NAME]);
        let retry = run(&["auth", "create", NAME])
            .map_err(|e| AdeError::Other(format!("gbrain auth create (retry) failed: {e}")))?;
        if let Some(tok) = parse_minted_token(&String::from_utf8_lossy(&retry.stdout)) {
            return Ok(tok);
        }
    }
    Err(AdeError::Other(format!(
        "could not mint gbrain bearer token (stdout: {}, stderr: {})",
        stdout.trim(),
        stderr.trim()
    )))
}

/// Return a usable bearer token, minting + caching one on first run.
pub fn ensure_token(bin: &str) -> Result<String, AdeError> {
    if let Some(t) = cached_token()? {
        return Ok(t);
    }
    let token = mint_token(bin)?;
    token_entry()?.set_password(&token).map_err(map_keyring)?;
    Ok(token)
}

/// Path to Claude Code's config (`~/.claude.json`).
fn claude_config_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".claude.json"))
}

/// Repoint Claude Code's `gbrain` MCP server to the shared HTTP serve. Idempotent
/// (no-op when already pointing at `url`) and conservative: only rewrites a
/// `stdio` entry, and backs up the file to `~/.claude.json.bak` before writing.
/// Returns true when the config was changed.
pub fn rewire_claude_code(port: u16, token: &str) -> Result<bool, AdeError> {
    let Some(path) = claude_config_path() else {
        return Ok(false);
    };
    rewire_at(&path, port, token)
}

/// Path-injectable core of [`rewire_claude_code`] (keeps tests off the real
/// `~/.claude.json` and off global `HOME` mutation).
fn rewire_at(path: &std::path::Path, port: u16, token: &str) -> Result<bool, AdeError> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)?;
    let mut cfg: Value = serde_json::from_str(&raw)
        .map_err(|e| AdeError::Other(format!("~/.claude.json is not valid JSON: {e}")))?;

    let url = format!("{}/mcp", super::serve::base_url(port));
    let desired = json!({
        "type": "http",
        "url": url,
        "headers": { "Authorization": format!("Bearer {token}") }
    });

    let entry = cfg.pointer("/mcpServers/gbrain");
    match entry {
        // Already HTTP at the right URL AND bearer → nothing to do. Comparing the
        // header too means a rotated token still gets written through.
        Some(e) if e == &desired => Ok(false),
        // Present (stdio or stale http) → rewrite. Absent → leave alone; the app
        // only adopts an existing gbrain wiring, it doesn't invent one.
        Some(_) => {
            std::fs::write(path.with_extension("json.bak"), &raw)?;
            cfg["mcpServers"]["gbrain"] = desired;
            let pretty = serde_json::to_string_pretty(&cfg)
                .map_err(|e| AdeError::Other(e.to_string()))?;
            std::fs::write(path, pretty)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minted_token_finds_gbrain_token() {
        let out = "Token created for \"ade-app\" (takes_holders=[\"world\"]):\n\n  gbrain_0123456789abcdef0123456789abcdef\n\nSave this token";
        assert_eq!(
            parse_minted_token(out).as_deref(),
            Some("gbrain_0123456789abcdef0123456789abcdef")
        );
    }

    #[test]
    fn parse_minted_token_none_when_absent() {
        assert_eq!(parse_minted_token("no token here"), None);
    }

    #[test]
    fn rewire_rewrites_stdio_entry_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join(".claude.json");
        std::fs::write(
            &cfg,
            r#"{"mcpServers":{"gbrain":{"type":"stdio","command":"gbrain","args":["serve"]}}}"#,
        )
        .unwrap();

        let changed = rewire_at(&cfg, 7777, "tok").unwrap();
        assert!(changed);

        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(after["mcpServers"]["gbrain"]["type"], "http");
        assert_eq!(
            after["mcpServers"]["gbrain"]["url"],
            "http://127.0.0.1:7777/mcp"
        );
        assert_eq!(
            after["mcpServers"]["gbrain"]["headers"]["Authorization"],
            "Bearer tok"
        );
        // Backup exists and preserves the original stdio entry.
        let bak = std::fs::read_to_string(dir.path().join(".claude.json.bak")).unwrap();
        assert!(bak.contains("\"stdio\""));
    }

    #[test]
    fn rewire_is_idempotent_when_already_http() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join(".claude.json");
        std::fs::write(
            &cfg,
            r#"{"mcpServers":{"gbrain":{"type":"http","url":"http://127.0.0.1:7777/mcp","headers":{"Authorization":"Bearer tok"}}}}"#,
        )
        .unwrap();
        assert!(!rewire_at(&cfg, 7777, "tok").unwrap());
    }

    #[test]
    fn rewire_skips_when_no_gbrain_entry() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join(".claude.json");
        std::fs::write(&cfg, r#"{"mcpServers":{"other":{"type":"stdio"}}}"#).unwrap();
        assert!(!rewire_at(&cfg, 7777, "tok").unwrap());
    }
}
