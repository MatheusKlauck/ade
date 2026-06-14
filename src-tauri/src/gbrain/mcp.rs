//! Minimal MCP-over-HTTP (Streamable HTTP) client for talking to a local
//! `gbrain serve --http`.
//!
//! The app is one of several clients of a single shared `gbrain serve --http`
//! (the other being Claude Code). The serve speaks only MCP — there is no plain
//! REST surface — so reads (status, search) go through the MCP `tools/call`
//! method. We deliberately re-implement the tiny slice of the Streamable HTTP
//! transport we need rather than depend on gbrain's CLI thin-client routing
//! (which spawns bun per call and carries version-specific quirks): one bearer
//! header, a stateless initialize → initialized → tools/call handshake per
//! request. Localhost round-trips are cheap, and status polling / on-demand
//! search don't need a persistent session.

use crate::error::AdeError;
use serde_json::{json, Value};

/// MCP protocol revision we advertise on `initialize`. The server negotiates and
/// echoes its own supported revision; a recent date is enough for it to proceed.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// A short, self-contained client bound to one serve endpoint + bearer token.
pub struct McpClient {
    /// Full POST endpoint, e.g. `http://127.0.0.1:7777/mcp`.
    endpoint: String,
    token: String,
    http: reqwest::Client,
}

impl McpClient {
    /// `base_url` is the serve origin (no `/mcp`), e.g. `http://127.0.0.1:7777`.
    pub fn new(base_url: &str, token: &str) -> Self {
        Self::with_client(base_url, token, reqwest::Client::new())
    }

    /// Test seam: inject a reqwest client (e.g. with a short timeout).
    pub fn with_client(base_url: &str, token: &str, http: reqwest::Client) -> Self {
        Self {
            endpoint: format!("{}/mcp", base_url.trim_end_matches('/')),
            token: token.to_string(),
            http,
        }
    }

    async fn post(&self, session: Option<&str>, payload: &Value) -> Result<reqwest::Response, AdeError> {
        let mut req = self
            .http
            .post(&self.endpoint)
            .header("Accept", "application/json, text/event-stream")
            .header("Authorization", format!("Bearer {}", self.token))
            .json(payload);
        if let Some(s) = session {
            req = req.header("Mcp-Session-Id", s);
        }
        req.send().await.map_err(net_err)
    }

    /// Readiness probe: run just the `initialize` step and confirm the server
    /// answered without a JSON-RPC error. Cheap and side-effect-free — used to
    /// wait out the serve's startup window.
    pub async fn ping(&self) -> Result<(), AdeError> {
        let init = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "ade", "version": env!("CARGO_PKG_VERSION") }
            }
        });
        let resp = self.post(None, &init).await?;
        let ct = content_type(&resp);
        let body = resp.text().await.map_err(net_err)?;
        check_rpc_error(&extract_jsonrpc(&body, &ct)?)
    }

    /// Run a stateless handshake and invoke one tool, returning its raw result
    /// payload (the JSON-RPC `result` object). Callers usually want
    /// [`call_tool_json`], which unwraps the text content into JSON.
    pub async fn call_tool_raw(&self, name: &str, arguments: Value) -> Result<Value, AdeError> {
        // 1. initialize — capture the session id the server may pin responses to.
        let init = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "ade", "version": env!("CARGO_PKG_VERSION") }
            }
        });
        let resp = self.post(None, &init).await?;
        let session = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let ct = content_type(&resp);
        let body = resp.text().await.map_err(net_err)?;
        check_rpc_error(&extract_jsonrpc(&body, &ct)?)?;

        // 2. initialized notification — required by spec before normal ops.
        //    Best-effort: a server that doesn't care won't fault the tool call.
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let _ = self.post(session.as_deref(), &note).await;

        // 3. tools/call
        let call = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        });
        let resp = self.post(session.as_deref(), &call).await?;
        let ct = content_type(&resp);
        let body = resp.text().await.map_err(net_err)?;
        let rpc = extract_jsonrpc(&body, &ct)?;
        check_rpc_error(&rpc)?;
        rpc.get("result")
            .cloned()
            .ok_or_else(|| AdeError::Other("MCP response missing result".into()))
    }

    /// Invoke a tool and parse its text content as JSON. gbrain's read tools
    /// (`get_status_snapshot`, `query`, `search`, …) return a single text block
    /// that is itself a JSON document.
    pub async fn call_tool_json(&self, name: &str, arguments: Value) -> Result<Value, AdeError> {
        let result = self.call_tool_raw(name, arguments).await?;
        let text = tool_result_text(&result)?;
        serde_json::from_str::<Value>(text.trim())
            .map_err(|e| AdeError::Other(format!("tool {name} returned non-JSON text: {e}")))
    }
}

/// Lowercased `Content-Type` of a response (empty string when absent).
fn content_type(resp: &reqwest::Response) -> String {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Map a transport error to `AdeError`, flagging an unreachable serve so the UI
/// can render "offline" rather than a generic failure.
fn net_err(e: reqwest::Error) -> AdeError {
    if e.is_connect() || e.is_timeout() {
        AdeError::Other(format!("gbrain serve unreachable: {e}"))
    } else {
        AdeError::Other(format!("gbrain request failed: {e}"))
    }
}

/// Pull the JSON-RPC envelope out of a Streamable HTTP response body. The server
/// may answer with `application/json` (one object) or `text/event-stream` (SSE
/// frames, where the payload rides on `data:` lines). For SSE we take the last
/// `data:` line that parses as JSON — single request/response exchanges carry
/// exactly one message, and the final frame is the answer we want.
fn extract_jsonrpc(body: &str, content_type: &str) -> Result<Value, AdeError> {
    if content_type.contains("text/event-stream") {
        let mut last: Option<Value> = None;
        for line in body.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                if let Ok(v) = serde_json::from_str::<Value>(rest.trim()) {
                    last = Some(v);
                }
            }
        }
        last.ok_or_else(|| AdeError::Other("no JSON data frame in SSE response".into()))
    } else {
        serde_json::from_str(body.trim())
            .map_err(|e| AdeError::Other(format!("invalid JSON-RPC response: {e}")))
    }
}

/// Surface a JSON-RPC transport-level `error` object as an `AdeError`.
fn check_rpc_error(rpc: &Value) -> Result<(), AdeError> {
    if let Some(err) = rpc.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown MCP error");
        return Err(AdeError::Other(format!("MCP error: {msg}")));
    }
    Ok(())
}

/// Concatenate the `text` blocks of a `tools/call` result. A result flagged
/// `isError: true` is treated as a failure (its text carries the reason).
fn tool_result_text(result: &Value) -> Result<String, AdeError> {
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| AdeError::Other("tool result missing content[]".into()))?;
    let text: String = content
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
        return Err(AdeError::Other(format!("tool reported error: {text}")));
    }
    if text.is_empty() {
        return Err(AdeError::Other("tool result had no text content".into()));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    #[test]
    fn extract_jsonrpc_parses_plain_json() {
        let v = extract_jsonrpc(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#, "application/json").unwrap();
        assert_eq!(v["result"]["ok"], json!(true));
    }

    #[test]
    fn extract_jsonrpc_parses_sse_last_data_frame() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"n\":1}}\n\n";
        let v = extract_jsonrpc(body, "text/event-stream; charset=utf-8").unwrap();
        assert_eq!(v["result"]["n"], json!(1));
    }

    #[test]
    fn extract_jsonrpc_sse_without_data_is_error() {
        assert!(extract_jsonrpc("event: ping\n\n", "text/event-stream").is_err());
    }

    #[test]
    fn check_rpc_error_surfaces_message() {
        let rpc = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}});
        let err = check_rpc_error(&rpc).unwrap_err();
        assert!(err.to_string().contains("method not found"));
    }

    #[test]
    fn tool_result_text_joins_blocks() {
        let result = json!({"content":[{"type":"text","text":"{\"a\":"},{"type":"text","text":"1}"}]});
        assert_eq!(tool_result_text(&result).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn tool_result_text_is_error_fails() {
        let result = json!({"content":[{"type":"text","text":"boom"}],"isError":true});
        assert!(tool_result_text(&result).is_err());
    }

    /// Mock the two-step handshake: `initialize` then `tools/call`. Returns the
    /// status snapshot as a JSON text block, mirroring gbrain's read tools.
    struct McpResponder;
    impl Respond for McpResponder {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            let method = body.get("method").and_then(Value::as_str).unwrap_or("");
            match method {
                "initialize" => ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .insert_header("mcp-session-id", "sess-123")
                    .set_body_json(json!({
                        "jsonrpc":"2.0","id":1,
                        "result":{"protocolVersion":PROTOCOL_VERSION,"capabilities":{},"serverInfo":{"name":"gbrain"}}
                    })),
                "tools/call" => ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(json!({
                        "jsonrpc":"2.0","id":2,
                        "result":{"content":[{"type":"text","text":"{\"healthy\":true,\"pages\":42}"}]}
                    })),
                // notifications/initialized has no id → 202 Accepted, empty body.
                _ => ResponseTemplate::new(202),
            }
        }
    }

    #[tokio::test]
    async fn call_tool_json_runs_handshake_and_parses_result() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/mcp"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(McpResponder)
            .mount(&server)
            .await;

        let client = McpClient::new(&server.uri(), "test-token");
        let out = client
            .call_tool_json("get_status_snapshot", json!({}))
            .await
            .unwrap();
        assert_eq!(out["healthy"], json!(true));
        assert_eq!(out["pages"], json!(42));
    }

    #[tokio::test]
    async fn call_tool_reports_unreachable_when_serve_down() {
        // Nothing listening on this port → connect error → "unreachable".
        let client = McpClient::with_client(
            "http://127.0.0.1:0",
            "t",
            reqwest::Client::builder()
                .timeout(Duration::from_millis(200))
                .build()
                .unwrap(),
        );
        let err = client.call_tool_json("get_status_snapshot", json!({})).await.unwrap_err();
        assert!(err.to_string().contains("unreachable") || err.to_string().contains("failed"));
    }
}
