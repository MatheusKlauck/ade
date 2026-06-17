// Tests for client.rs — moved out of the inline `mod tests` to keep the
// production file readable. Still `crate::...::client::tests` via #[path],
// so `super::*` resolves to the parent module's items unchanged (#22).
use super::*;
use wiremock::matchers::{method, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Helper: build a JSON issue object.
fn issue_json(
    number: u64,
    title: &str,
    state: &str,
    extra: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "number": number,
        "title": title,
        "state": state,
        "updated_at": "2025-06-10T12:00:00Z",
        "assignee": serde_json::Value::Null,
        "labels": [],
        "html_url": format!("https://github.com/owner/repo/issues/{}", number),
        "body": serde_json::Value::Null,
    });
    if let Some(serde_json::Value::Object(ref map)) = extra {
        if let serde_json::Value::Object(ref mut obj_map) = obj {
            for (k, v) in map {
                obj_map.insert(k.clone(), v.clone());
            }
        }
    }
    obj
}

/// Helper: create a GitHubClient pointed at the mock server.
fn make_client(server: &MockServer) -> GitHubClient {
    GitHubClient::new(server.uri(), "test-token".to_string())
}

#[tokio::test]
async fn two_page_seed_paginates() {
    let server = MockServer::start().await;

    // Page 1: 100 issues (no PRs)
    let page1_items: Vec<serde_json::Value> = (1..=100)
        .map(|i| issue_json(i, &format!("Issue #{i}"), "open", None))
        .collect();
    let page1_body = serde_json::to_string(&page1_items).unwrap();

    Mock::given(method("GET"))
        .and(query_param("state", "open"))
        .and(query_param("per_page", "100"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_string(&page1_body))
        .mount(&server)
        .await;

    // Page 2: 3 issues
    let page2_items: Vec<serde_json::Value> = (101..=103)
        .map(|i| issue_json(i, &format!("Issue #{i}"), "open", None))
        .collect();
    let page2_body = serde_json::to_string(&page2_items).unwrap();

    Mock::given(method("GET"))
        .and(query_param("state", "open"))
        .and(query_param("per_page", "100"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(&page2_body))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.list_issues_seed("owner", "repo").await;
    let issues = result.expect("seed fetch should succeed");
    assert_eq!(issues.len(), 103, "should return all 103 non-PR issues");
    assert_eq!(issues[0].number, 1);
    assert_eq!(issues[102].number, 103);
}

#[tokio::test]
async fn pr_items_filtered() {
    let server = MockServer::start().await;

    let items = vec![
        issue_json(1, "Real issue", "open", None),
        issue_json(
            2,
            "A pull request",
            "open",
            Some(&serde_json::json!({ "pull_request": {} })),
        ),
        issue_json(3, "Another issue", "open", None),
    ];

    let body = serde_json::to_string(&items).unwrap();

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.list_issues_seed("owner", "repo").await;
    let issues = result.expect("seed fetch should succeed");
    assert_eq!(issues.len(), 2, "should filter out PRs");
    assert_eq!(issues[0].number, 1);
    assert_eq!(issues[1].number, 3);
}

#[tokio::test]
async fn since_sent_as_query_param() {
    let server = MockServer::start().await;

    let items: Vec<serde_json::Value> = vec![issue_json(10, "Updated issue", "open", None)];
    let body = serde_json::to_string(&items).unwrap();

    Mock::given(method("GET"))
        .and(query_param("since", "2025-06-09T00:00:00Z"))
        .and(query_param("state", "all"))
        .respond_with(ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client
        .list_issues_since("owner", "repo", "2025-06-09T00:00:00Z")
        .await;
    let issues = result.expect("incremental fetch should succeed");
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].number, 10);
}

#[tokio::test]
async fn body_preview_280_chars_multibyte_safe() {
    let server = MockServer::start().await;

    // Create a body with multibyte characters (emoji + accented chars) longer than 280 chars
    // "é" is 2 bytes in UTF-8, "🚀" is 4 bytes
    // We'll use a mix and ensure the truncation is char-based, not byte-based
    let long_body: String = "café🚀".repeat(100); // each "café🚀" is 5 chars, so 500 chars total
    assert!(long_body.chars().count() > 280);

    let items = vec![issue_json(
        42,
        "Unicode issue",
        "open",
        Some(&serde_json::json!({
            "body": long_body,
        })),
    )];
    let body = serde_json::to_string(&items).unwrap();

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(&body))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.list_issues_seed("owner", "repo").await;
    let issues = result.expect("seed fetch should succeed");
    assert_eq!(issues.len(), 1);

    let preview = issues[0]
        .body_preview
        .as_ref()
        .expect("body_preview should be set");
    assert_eq!(
        preview.chars().count(),
        280,
        "body_preview must be exactly 280 chars"
    );

    // Verify it's not truncated at a byte boundary that splits a multibyte char
    // The preview should be valid UTF-8
    assert!(preview.is_char_boundary(preview.len()));
}

#[tokio::test]
async fn rate_limit_403_maps_to_rate_limited() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "0")
                .insert_header("x-ratelimit-reset", "1718000000"),
        )
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.list_issues_seed("owner", "repo").await;
    match result {
        Err(AdeError::RateLimited(until)) => {
            assert_eq!(
                until, "1718000000",
                "should capture x-ratelimit-reset value"
            );
        }
        other => {
            panic!("expected RateLimited error, got: {:?}", other);
        }
    }
}

// ── M5-T2: write operation tests ───────────────────────────────

#[tokio::test]
async fn ensure_labels_ok() {
    use wiremock::matchers::{body_json, method as match_method, path};

    let server = MockServer::start().await;

    let label_specs = [
        ("kanban:doing", "1f883d"),
        ("kanban:paused", "d4a72c"),
        ("kanban:pr", "8250df"),
    ];

    for (name, color) in &label_specs {
        Mock::given(match_method("POST"))
            .and(path("/repos/owner/repo/labels"))
            .and(body_json(serde_json::json!({
                "name": name,
                "color": color,
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1,
                "name": name,
                "color": color,
            })))
            .mount(&server)
            .await;
    }

    let client = make_client(&server);
    let result = client.ensure_labels("owner", "repo").await;
    assert!(result.is_ok(), "ensure_labels should succeed with 201s");
}

#[tokio::test]
async fn ensure_labels_422_ok() {
    use wiremock::matchers::{method as match_method, path};

    let server = MockServer::start().await;

    // 422 means the label already exists — that's OK
    Mock::given(match_method("POST"))
        .and(path("/repos/owner/repo/labels"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "Validation Failed",
            "errors": [{ "code": "already_exists" }],
        })))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.ensure_labels("owner", "repo").await;
    assert!(result.is_ok(), "ensure_labels should treat 422 as OK");
}

#[tokio::test]
async fn add_label_ok() {
    use wiremock::matchers::{body_json, method as match_method, path};

    let server = MockServer::start().await;

    Mock::given(match_method("POST"))
        .and(path("/repos/owner/repo/issues/42/labels"))
        .and(body_json(serde_json::json!({
            "labels": ["kanban:doing"],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.add_label("owner", "repo", 42, "kanban:doing").await;
    assert!(result.is_ok(), "add_label should succeed with 200");
}

#[tokio::test]
async fn remove_label_ok() {
    use wiremock::matchers::{method as match_method, path};

    let server = MockServer::start().await;

    Mock::given(match_method("DELETE"))
        .and(path("/repos/owner/repo/issues/42/labels/kanban:doing"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client
        .remove_label("owner", "repo", 42, "kanban:doing")
        .await;
    assert!(result.is_ok(), "remove_label should succeed with 204");
}

#[tokio::test]
async fn remove_label_404_ok() {
    use wiremock::matchers::{method as match_method, path};

    let server = MockServer::start().await;

    Mock::given(match_method("DELETE"))
        .and(path("/repos/owner/repo/issues/42/labels/kanban:doing"))
        .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client
        .remove_label("owner", "repo", 42, "kanban:doing")
        .await;
    assert!(
        result.is_ok(),
        "remove_label should treat 404 as OK (label already gone)"
    );
}

#[tokio::test]
async fn set_issue_state_close() {
    use wiremock::matchers::{body_json, method as match_method, path};

    let server = MockServer::start().await;

    let issue_resp = issue_json(42, "Test issue", "closed", None);

    Mock::given(match_method("PATCH"))
        .and(path("/repos/owner/repo/issues/42"))
        .and(body_json(serde_json::json!({
            "state": "closed",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(&issue_resp))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.set_issue_state("owner", "repo", 42, "closed").await;
    assert!(result.is_ok(), "set_issue_state should succeed with 200");
}

#[tokio::test]
async fn create_issue_ok() {
    use wiremock::matchers::{body_json, method as match_method, path};

    let server = MockServer::start().await;

    let issue_resp = issue_json(99, "New issue", "open", None);

    Mock::given(match_method("POST"))
        .and(path("/repos/owner/repo/issues"))
        .and(body_json(serde_json::json!({
            "title": "New issue",
            "body": serde_json::Value::Null,
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(&issue_resp))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client
        .create_issue("owner", "repo", "New issue", None)
        .await;
    let issue = result.expect("create_issue should succeed");
    assert_eq!(issue.number, 99);
    assert_eq!(issue.title, "New issue");
    assert_eq!(issue.state, "open");
}

#[tokio::test]
async fn get_issue_ok() {
    use wiremock::matchers::{method as match_method, path};

    let server = MockServer::start().await;

    let issue_resp = issue_json(7, "Fetched issue", "open", None);

    Mock::given(match_method("GET"))
        .and(path("/repos/owner/repo/issues/7"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&issue_resp))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.get_issue("owner", "repo", 7).await;
    let issue = result.expect("get_issue should succeed");
    assert_eq!(issue.number, 7);
    assert_eq!(issue.title, "Fetched issue");
}

#[tokio::test]
async fn get_issue_comments_ok() {
    use wiremock::matchers::{method as match_method, path, query_param};

    let server = MockServer::start().await;

    let comments = vec![
        serde_json::json!({
            "id": 1,
            "user": { "login": "alice" },
            "body": "First comment",
            "created_at": "2025-06-10T10:00:00Z",
            "updated_at": "2025-06-10T10:00:00Z",
        }),
        serde_json::json!({
            "id": 2,
            "user": { "login": "bob" },
            "body": "Second comment",
            "created_at": "2025-06-10T11:00:00Z",
            "updated_at": "2025-06-10T11:00:00Z",
        }),
    ];

    Mock::given(match_method("GET"))
        .and(path("/repos/owner/repo/issues/7/comments"))
        .and(query_param("per_page", "30"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&comments))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let result = client.get_issue_comments("owner", "repo", 7).await;
    let comments = result.expect("get_issue_comments should succeed");
    assert_eq!(comments.len(), 2);
    assert_eq!(comments[0].id, 1);
    assert_eq!(comments[0].user_login, "alice");
    assert_eq!(comments[0].body, "First comment");
    assert_eq!(comments[1].id, 2);
    assert_eq!(comments[1].user_login, "bob");
}

#[tokio::test]
async fn create_and_get_pr_ok() {
    use wiremock::matchers::{body_json, method as match_method, path};

    let server = MockServer::start().await;
    let pr_resp = serde_json::json!({
        "number": 42,
        "html_url": "https://github.com/owner/repo/pull/42",
        "state": "open",
    });

    Mock::given(match_method("POST"))
        .and(path("/repos/owner/repo/pulls"))
        .and(body_json(serde_json::json!({
            "title": "My change",
            "head": "issue-7",
            "base": "main",
            "body": "closes #7",
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(&pr_resp))
        .mount(&server)
        .await;
    Mock::given(match_method("GET"))
        .and(path("/repos/owner/repo/pulls/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&pr_resp))
        .mount(&server)
        .await;

    let client = make_client(&server);
    let pr = client
        .create_pr(
            "owner",
            "repo",
            "issue-7",
            "main",
            "My change",
            Some("closes #7"),
        )
        .await
        .expect("create_pr should succeed");
    assert_eq!(pr.number, 42);
    assert_eq!(pr.html_url, "https://github.com/owner/repo/pull/42");
    assert_eq!(pr.state, "open");

    let fetched = client.get_pr("owner", "repo", 42).await.expect("get_pr");
    assert_eq!(fetched.number, 42);
}

#[tokio::test]
async fn check_runs_and_merge() {
    use wiremock::matchers::{method as match_method, path};

    let server = MockServer::start().await;
    Mock::given(match_method("GET"))
        .and(path("/repos/owner/repo/commits/abc123/check-runs"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(&serde_json::json!({
                "total_count": 2,
                "check_runs": [
                    { "status": "completed", "conclusion": "success" },
                    { "status": "completed", "conclusion": "success" },
                ],
            })),
        )
        .mount(&server)
        .await;
    Mock::given(match_method("PUT"))
        .and(path("/repos/owner/repo/pulls/42/merge"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(&serde_json::json!({
                "merged": true,
                "sha": "deadbeef",
            })),
        )
        .mount(&server)
        .await;

    let client = make_client(&server);
    let runs = client
        .list_check_runs("owner", "repo", "abc123")
        .await
        .expect("check-runs");
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].conclusion.as_deref(), Some("success"));

    let merged = client.merge_pr("owner", "repo", 42).await.expect("merge");
    assert!(merged);
}
