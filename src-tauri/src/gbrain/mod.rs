//! Integration with a local, app-supervised `gbrain serve --http`.
//!
//! Topology: the app owns one shared `gbrain serve --http` (the single PGLite
//! lock holder) and talks to it — alongside Claude Code — as an MCP-over-HTTP
//! client. This module is the client surface: typed `status`/`query` reads for
//! the StatusBar "brain pill". Process supervision lives in [`serve`], one-time
//! bearer/CC wiring in [`wiring`], and the raw transport in [`mcp`].

pub mod mcp;
pub mod serve;
pub mod wiring;

use crate::error::AdeError;
use mcp::McpClient;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Live connection info for the app-owned serve, stored in `AppState` once the
/// background init settles. Holds the supervisor handle (killed on app exit) and
/// the endpoint + bearer the IPC reads use.
pub struct GbrainRuntime {
    pub handle: serve::ServeHandle,
    pub base_url: String,
    pub token: String,
}

/// Bring up the shared serve in the background so window paint isn't blocked:
/// reap any lock-holding stdio serve, mint/reuse a bearer, start + await the
/// HTTP serve, repoint Claude Code, then publish the runtime into `AppState`.
/// Best-effort throughout — failures log and leave the pill showing "offline".
pub async fn init_background(state: Arc<crate::AppState>) {
    let prep = tokio::task::spawn_blocking(|| {
        let bin = serve::gbrain_bin();
        let reaped = serve::reap_orphan_stdio_serve();
        if reaped > 0 {
            eprintln!("reaped {reaped} stray stdio gbrain serve process(es)");
        }
        wiring::ensure_token(&bin)
    })
    .await;

    let token = match prep {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            eprintln!("gbrain: could not obtain bearer token: {e}");
            return;
        }
        Err(e) => {
            eprintln!("gbrain: token task failed: {e}");
            return;
        }
    };

    let port = serve::DEFAULT_PORT;
    let handle = serve::spawn_supervised(port);
    if !serve::wait_until_ready(port, &token, 30).await {
        eprintln!("gbrain serve --http did not become ready on :{port} (continuing; will retry via supervisor)");
    }

    let tok = token.clone();
    let _ = tokio::task::spawn_blocking(move || match wiring::rewire_claude_code(port, &tok) {
        Ok(true) => eprintln!("gbrain: repointed Claude Code MCP to http://127.0.0.1:{port}/mcp"),
        Ok(false) => {}
        Err(e) => eprintln!("gbrain: could not rewire Claude Code config: {e}"),
    })
    .await;

    let rt = GbrainRuntime {
        handle,
        base_url: serve::base_url(port),
        token,
    };
    if let Ok(mut g) = state.gbrain.lock() {
        *g = Some(rt);
    }
}

/// Compact brain health for the status pill. Fields are optional because the
/// snapshot shape varies by gbrain version; absent fields simply don't render.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct GbrainStatus {
    /// Reachable + answering. False is set by the caller when the serve is down.
    pub healthy: bool,
    /// Total pages in the brain, when the snapshot reports it.
    pub pages: Option<u64>,
    /// Whether the brain is freshly synced with its repo(s).
    pub sync_fresh: Option<bool>,
    /// Last synced commit / timestamp label, when present.
    pub last_commit: Option<String>,
}

/// One search hit for the brain-search popover.
#[derive(Debug, Serialize, PartialEq)]
pub struct GbrainHit {
    pub slug: String,
    pub title: String,
    pub snippet: String,
    pub source: Option<String>,
    pub score: Option<f64>,
}

/// Fetch a status snapshot from the serve. A transport failure (serve down)
/// is mapped to `healthy: false` rather than an error, so the pill can render
/// "offline" instead of surfacing a toast.
pub async fn status(base_url: &str, token: &str) -> GbrainStatus {
    let client = McpClient::new(base_url, token);
    // `get_brain_identity` is read-scope (page/chunk counts + version), so it
    // works with any bearer — unlike `get_stats`/`get_status_snapshot`, which
    // are admin-scope. A successful call also proves the serve is reachable.
    match client.call_tool_json("get_brain_identity", json!({})).await {
        Ok(v) => map_status(&v),
        Err(_) => GbrainStatus::default(), // healthy = false
    }
}

/// Semantic/hybrid search over the brain (+ indexed code). Errors propagate so
/// the popover can show why a query failed.
pub async fn query(base_url: &str, token: &str, q: &str, limit: u32) -> Result<Vec<GbrainHit>, AdeError> {
    let client = McpClient::new(base_url, token);
    let v = client
        .call_tool_json("query", json!({ "query": q, "limit": limit }))
        .await?;
    Ok(map_hits(&v))
}

// --- defensive shape mapping -------------------------------------------------
// The exact JSON of `get_status_snapshot` / `query` is gbrain-version-specific
// and confirmed against the live serve during verification. These mappers read
// several plausible key spellings and degrade gracefully on anything missing.

fn first_u64(v: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_u64))
}
fn first_bool(v: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_bool))
}
fn first_str(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .map(String::from)
}

fn map_status(v: &Value) -> GbrainStatus {
    GbrainStatus {
        healthy: true, // a successful call means the serve answered
        pages: first_u64(v, &["page_count", "pages", "pageCount", "total_pages"]),
        sync_fresh: first_bool(v, &["sync_fresh", "syncFresh", "fresh", "up_to_date"]),
        last_commit: first_str(
            v,
            &["last_sync_iso", "last_commit", "lastCommit", "last_commit_at", "synced_at"],
        ),
    }
}

/// Find the array of hits regardless of whether the tool returns a bare array or
/// wraps it under a `results`/`hits`/`matches` key.
fn hits_array(v: &Value) -> Vec<Value> {
    if let Some(arr) = v.as_array() {
        return arr.clone();
    }
    for key in ["results", "hits", "matches", "pages", "items"] {
        if let Some(arr) = v.get(key).and_then(Value::as_array) {
            return arr.clone();
        }
    }
    Vec::new()
}

fn map_hits(v: &Value) -> Vec<GbrainHit> {
    hits_array(v)
        .iter()
        .map(|h| GbrainHit {
            slug: first_str(h, &["slug", "id", "page_slug"]).unwrap_or_default(),
            title: first_str(h, &["title", "name", "heading"]).unwrap_or_default(),
            // gbrain's SearchResult carries the matched text in `chunk_text`;
            // the others are tolerated for other tools / versions.
            snippet: first_str(h, &["chunk_text", "snippet", "excerpt", "preview", "text", "content"])
                .unwrap_or_default(),
            source: first_str(h, &["source", "source_id", "corpus"]),
            score: ["score", "similarity", "rank"]
                .iter()
                .find_map(|k| h.get(*k).and_then(Value::as_f64)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_status_reads_brain_identity_shape() {
        // Real `get_brain_identity` payload: version + engine + counts.
        let v = json!({
            "version": "0.42.42.0",
            "engine": "pglite",
            "page_count": 102,
            "chunk_count": 265,
            "last_sync_iso": "2026-06-13T00:00:00Z"
        });
        let s = map_status(&v);
        assert_eq!(s.healthy, true);
        assert_eq!(s.pages, Some(102));
        assert_eq!(s.last_commit.as_deref(), Some("2026-06-13T00:00:00Z"));
    }

    #[test]
    fn map_status_tolerates_missing_fields() {
        let s = map_status(&json!({}));
        assert!(s.healthy);
        assert_eq!(s.pages, None);
    }

    #[test]
    fn map_hits_reads_search_result_shape() {
        // Real gbrain `query` returns a bare array of SearchResult rows.
        let v = json!([
            { "slug": "foo", "title": "Foo", "chunk_text": "about foo", "score": 0.9, "source_id": "gstack-code" },
            { "id": "bar", "name": "Bar", "snippet": "about bar" }
        ]);
        let hits = map_hits(&v);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].slug, "foo");
        assert_eq!(hits[0].snippet, "about foo"); // chunk_text → snippet
        assert_eq!(hits[0].score, Some(0.9));
        assert_eq!(hits[0].source.as_deref(), Some("gstack-code"));
        assert_eq!(hits[1].slug, "bar"); // id → slug fallback
        assert_eq!(hits[1].title, "Bar"); // name → title fallback
    }

    #[test]
    fn map_hits_handles_bare_array() {
        let v = json!([{ "slug": "x", "title": "X", "text": "hi" }]);
        let hits = map_hits(&v);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "hi");
    }
}
