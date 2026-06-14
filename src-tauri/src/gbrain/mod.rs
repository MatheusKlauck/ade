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
    /// Total pages across all sources, when reported.
    pub pages: Option<u64>,
    /// Total chunks across all sources, when reported.
    pub chunks: Option<u64>,
    /// Worst staleness class across sources (`fresh` < `aging` < `stale`), which
    /// drives the pill colour. `None` when no source reports one.
    pub staleness: Option<String>,
    /// Most recent successful sync timestamp across sources (ISO 8601).
    pub last_sync_at: Option<String>,
    /// Lowest embedding coverage across sources (%), highlighting the laggard.
    pub embedding_coverage_pct: Option<u64>,
    /// Sync failures the brain hasn't acknowledged yet (>0 → needs attention).
    pub unacknowledged_failures: Option<u64>,
    /// How many sources the brain federates.
    pub source_count: Option<u64>,
}

/// Brain identity: version + engine + update availability. Read-scope, so it
/// works with any bearer; used for the panel header.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct GbrainIdentity {
    pub version: Option<String>,
    pub engine: Option<String>,
    pub pages: Option<u64>,
    pub chunks: Option<u64>,
    pub update_available: Option<bool>,
    pub latest_version: Option<String>,
}

/// One federated source's sync state, for the "stale" panel's per-source list.
#[derive(Debug, Serialize, PartialEq)]
pub struct GbrainSource {
    pub id: String,
    pub sync_enabled: Option<bool>,
    pub staleness: Option<String>,
    pub staleness_hours: Option<f64>,
    pub last_sync_at: Option<String>,
    pub last_commit: Option<String>,
    pub pages: Option<u64>,
    pub chunks: Option<u64>,
    pub embedding_coverage_pct: Option<u64>,
}

/// One page row for the "explore" browse list (no text query).
#[derive(Debug, Serialize, PartialEq)]
pub struct GbrainPage {
    pub slug: String,
    pub title: String,
    pub kind: Option<String>,
    pub updated_at: Option<String>,
}

/// Brain quality metrics from `get_health`, for the offline/diagnostic panel.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct GbrainHealth {
    pub brain_score: Option<u64>,
    pub page_count: Option<u64>,
    pub embed_coverage: Option<u64>,
    pub stale_pages: Option<u64>,
    pub orphan_pages: Option<u64>,
    pub missing_embeddings: Option<u64>,
    pub dead_links: Option<u64>,
}

/// Liveness from the serve's unauthenticated `GET /health`. Reachable even when
/// MCP calls would fail (e.g. mid-startup), so the offline panel can tell
/// "process is up but not ready" from "nothing listening".
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct GbrainLiveness {
    pub reachable: bool,
    pub status: Option<String>,
    pub version: Option<String>,
    pub engine: Option<String>,
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
///
/// Prefers `get_status_snapshot` (admin-scope) for real per-source sync
/// freshness; falls back to read-scope `get_brain_identity` when the bearer
/// lacks admin (older topology), which still yields counts + reachability.
pub async fn status(base_url: &str, token: &str) -> GbrainStatus {
    let client = McpClient::new(base_url, token);
    if let Ok(v) = client.call_tool_json("get_status_snapshot", json!({})).await {
        return map_status_from_snapshot(&v);
    }
    match client.call_tool_json("get_brain_identity", json!({})).await {
        Ok(v) => map_status_from_identity(&v),
        Err(_) => GbrainStatus::default(), // healthy = false
    }
}

/// Brain identity (version, engine, update availability) for the panel header.
pub async fn identity(base_url: &str, token: &str) -> Result<GbrainIdentity, AdeError> {
    let client = McpClient::new(base_url, token);
    let v = client.call_tool_json("get_brain_identity", json!({})).await?;
    Ok(map_identity(&v))
}

/// Per-source sync state, from `get_status_snapshot`'s `sync.sources[]`.
pub async fn sources(base_url: &str, token: &str) -> Result<Vec<GbrainSource>, AdeError> {
    let client = McpClient::new(base_url, token);
    let v = client.call_tool_json("get_status_snapshot", json!({})).await?;
    Ok(snapshot_sources(&v).iter().map(map_source).collect())
}

/// Recently-updated pages for the explore/browse list (no text query).
pub async fn recent_pages(base_url: &str, token: &str, limit: u32) -> Result<Vec<GbrainPage>, AdeError> {
    let client = McpClient::new(base_url, token);
    let v = client
        .call_tool_json("list_pages", json!({ "limit": limit, "sort": "updated_desc" }))
        .await?;
    Ok(hits_array(&v).iter().map(map_page).collect())
}

/// Brain quality metrics from `get_health` (admin-scope) for diagnostics.
pub async fn health(base_url: &str, token: &str) -> Result<GbrainHealth, AdeError> {
    let client = McpClient::new(base_url, token);
    let v = client.call_tool_json("get_health", json!({})).await?;
    Ok(map_health(&v))
}

/// Unauthenticated liveness probe (`GET /health`). Never errors — a failure is
/// reported as `reachable: false` so the offline panel can render it.
pub async fn liveness(base_url: &str) -> GbrainLiveness {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return GbrainLiveness::default(),
    };
    match http.get(&url).send().await {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(v) => GbrainLiveness {
                reachable: true,
                status: first_str(&v, &["status"]),
                version: first_str(&v, &["version"]),
                engine: first_str(&v, &["engine"]),
            },
            // Answered but not JSON — still reachable.
            Err(_) => GbrainLiveness { reachable: true, ..Default::default() },
        },
        Err(_) => GbrainLiveness::default(),
    }
}

/// Trigger a brain sync. `sync_brain` is CLI-only (not exposed over HTTP MCP),
/// so we enqueue a `sync` job via `submit_job` (admin-scope) instead — the same
/// path the serve's own cycle uses. Returns a human-readable job id when the
/// server reports one.
pub async fn trigger_sync(base_url: &str, token: &str, full: bool) -> Result<String, AdeError> {
    let client = McpClient::new(base_url, token);
    let v = client
        .call_tool_json("submit_job", json!({ "name": "sync", "data": { "full": full } }))
        .await?;
    Ok(first_str(&v, &["job_id", "id", "jobId"]).unwrap_or_else(|| "queued".to_string()))
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

fn first_f64(v: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_f64))
}

/// Rank a staleness class so we can pick the worst across sources. Unknown
/// classes sort highest (treated as "needs a look").
fn staleness_rank(class: &str) -> u8 {
    match class {
        "fresh" => 0,
        "aging" => 1,
        "stale" => 2,
        _ => 3,
    }
}

/// The `sync.sources[]` array out of a `get_status_snapshot` payload.
fn snapshot_sources(v: &Value) -> Vec<Value> {
    v.get("sync")
        .and_then(|s| s.get("sources"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn map_source(s: &Value) -> GbrainSource {
    GbrainSource {
        id: first_str(s, &["id", "source_id", "name"]).unwrap_or_default(),
        sync_enabled: first_bool(s, &["sync_enabled"]),
        staleness: first_str(s, &["staleness_class", "staleness"]),
        staleness_hours: first_f64(s, &["staleness_hours"]),
        last_sync_at: first_str(s, &["last_sync_at", "last_sync_iso", "synced_at"]),
        last_commit: first_str(s, &["last_commit"]),
        pages: first_u64(s, &["pages", "page_count"]),
        chunks: first_u64(s, &["chunks_total", "chunks", "chunk_count"]),
        embedding_coverage_pct: first_u64(s, &["embedding_coverage_pct", "embed_coverage"]),
    }
}

/// Roll up the per-source snapshot into the compact pill status: sum counts,
/// keep the worst staleness, the most recent sync, and the lowest coverage.
fn map_status_from_snapshot(v: &Value) -> GbrainStatus {
    let sources: Vec<GbrainSource> = snapshot_sources(v).iter().map(map_source).collect();
    let sum = |f: fn(&GbrainSource) -> Option<u64>| {
        let vals: Vec<u64> = sources.iter().filter_map(f).collect();
        if vals.is_empty() { None } else { Some(vals.iter().sum()) }
    };
    let staleness = sources
        .iter()
        .filter_map(|s| s.staleness.clone())
        .max_by_key(|c| staleness_rank(c));
    let last_sync_at = sources.iter().filter_map(|s| s.last_sync_at.clone()).max();
    let embedding_coverage_pct = sources.iter().filter_map(|s| s.embedding_coverage_pct).min();
    GbrainStatus {
        healthy: true,
        pages: sum(|s| s.pages),
        chunks: sum(|s| s.chunks),
        staleness,
        last_sync_at,
        embedding_coverage_pct,
        unacknowledged_failures: v
            .get("sync")
            .and_then(|s| first_u64(s, &["unacknowledged_failures"]))
            .or_else(|| first_u64(v, &["unacknowledged_failures"])),
        source_count: Some(sources.len() as u64),
    }
}

/// Fallback for a non-admin bearer: read-scope `get_brain_identity` gives counts
/// and reachability but no per-source freshness, so staleness stays `None`.
fn map_status_from_identity(v: &Value) -> GbrainStatus {
    GbrainStatus {
        healthy: true,
        pages: first_u64(v, &["page_count", "pages", "pageCount", "total_pages"]),
        chunks: first_u64(v, &["chunk_count", "chunks", "chunkCount"]),
        ..Default::default()
    }
}

fn map_identity(v: &Value) -> GbrainIdentity {
    GbrainIdentity {
        version: first_str(v, &["version"]),
        engine: first_str(v, &["engine"]),
        pages: first_u64(v, &["page_count", "pages"]),
        chunks: first_u64(v, &["chunk_count", "chunks"]),
        update_available: first_bool(v, &["update_available", "updateAvailable"]),
        latest_version: first_str(v, &["latest_version", "latestVersion"]),
    }
}

fn map_page(p: &Value) -> GbrainPage {
    GbrainPage {
        slug: first_str(p, &["slug", "id"]).unwrap_or_default(),
        title: first_str(p, &["title", "name"]).unwrap_or_default(),
        kind: first_str(p, &["type", "kind"]),
        updated_at: first_str(p, &["updated_at", "updatedAt", "modified_at"]),
    }
}

fn map_health(v: &Value) -> GbrainHealth {
    GbrainHealth {
        brain_score: first_u64(v, &["brain_score"]),
        page_count: first_u64(v, &["page_count"]),
        embed_coverage: first_u64(v, &["embed_coverage", "embedding_coverage"]),
        stale_pages: first_u64(v, &["stale_pages"]),
        orphan_pages: first_u64(v, &["orphan_pages", "orphans"]),
        missing_embeddings: first_u64(v, &["missing_embeddings"]),
        dead_links: first_u64(v, &["dead_links"]),
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
    fn map_status_from_snapshot_rolls_up_sources() {
        // Real `get_status_snapshot` shape: sync.sources[] + counts per source.
        let v = json!({
            "sync": {
                "unacknowledged_failures": 1,
                "sources": [
                    {
                        "id": "default", "staleness_class": "fresh",
                        "last_sync_at": "2026-06-13T10:00:00Z",
                        "pages": 9, "chunks_total": 20, "embedding_coverage_pct": 80
                    },
                    {
                        "id": "artifacts", "staleness_class": "stale",
                        "last_sync_at": "2026-06-13T23:00:00Z",
                        "pages": 1, "chunks_total": 1, "embedding_coverage_pct": 0
                    }
                ]
            },
            "cycle": { "last_full": null }
        });
        let s = map_status_from_snapshot(&v);
        assert!(s.healthy);
        assert_eq!(s.pages, Some(10)); // 9 + 1
        assert_eq!(s.chunks, Some(21));
        assert_eq!(s.staleness.as_deref(), Some("stale")); // worst wins
        assert_eq!(s.last_sync_at.as_deref(), Some("2026-06-13T23:00:00Z")); // most recent
        assert_eq!(s.embedding_coverage_pct, Some(0)); // laggard
        assert_eq!(s.unacknowledged_failures, Some(1));
        assert_eq!(s.source_count, Some(2));
    }

    #[test]
    fn map_status_from_identity_fallback_has_no_staleness() {
        let v = json!({ "version": "0.42.42.0", "page_count": 102, "chunk_count": 265 });
        let s = map_status_from_identity(&v);
        assert!(s.healthy);
        assert_eq!(s.pages, Some(102));
        assert_eq!(s.chunks, Some(265));
        assert_eq!(s.staleness, None);
    }

    #[test]
    fn map_status_tolerates_missing_fields() {
        let s = map_status_from_snapshot(&json!({}));
        assert!(s.healthy);
        assert_eq!(s.pages, None);
        assert_eq!(s.source_count, Some(0));
    }

    #[test]
    fn map_identity_reads_version_and_update() {
        let v = json!({
            "version": "0.42.42.0", "engine": "pglite",
            "page_count": 10, "chunk_count": 47,
            "update_available": true, "latest_version": "0.43.0.0"
        });
        let id = map_identity(&v);
        assert_eq!(id.version.as_deref(), Some("0.42.42.0"));
        assert_eq!(id.update_available, Some(true));
        assert_eq!(id.latest_version.as_deref(), Some("0.43.0.0"));
    }

    #[test]
    fn map_source_reads_snapshot_row() {
        let s = map_source(&json!({
            "id": "artifacts", "sync_enabled": true, "staleness_class": "fresh",
            "staleness_hours": 0.0, "last_sync_at": "2026-06-13T23:00:00Z",
            "last_commit": "2579f67", "pages": 1, "chunks_total": 1,
            "embedding_coverage_pct": 0
        }));
        assert_eq!(s.id, "artifacts");
        assert_eq!(s.staleness.as_deref(), Some("fresh"));
        assert_eq!(s.last_commit.as_deref(), Some("2579f67"));
        assert_eq!(s.chunks, Some(1));
    }

    #[test]
    fn map_page_reads_list_pages_row() {
        let p = map_page(&json!({
            "slug": "agents", "type": "note", "title": "Rules",
            "updated_at": "2026-06-13T22:59:19Z"
        }));
        assert_eq!(p.slug, "agents");
        assert_eq!(p.title, "Rules");
        assert_eq!(p.kind.as_deref(), Some("note"));
    }

    #[test]
    fn map_health_reads_get_health_shape() {
        let h = map_health(&json!({
            "page_count": 10, "brain_score": 10, "embed_coverage": 0,
            "stale_pages": 0, "orphan_pages": 10, "missing_embeddings": 47, "dead_links": 0
        }));
        assert_eq!(h.brain_score, Some(10));
        assert_eq!(h.orphan_pages, Some(10));
        assert_eq!(h.missing_embeddings, Some(47));
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
