// M2-T7: GitHub client with injectable base URL for wiremock testing.

use crate::error::AdeError;
use crate::gh::types::RemoteIssue;

/// HTTP client for the GitHub Issues API.
///
/// `base_url` defaults to `https://api.github.com` in production but can be
/// overridden with a wiremock URL in tests.
#[allow(dead_code)]
pub struct GitHubClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

#[allow(dead_code)]
impl GitHubClient {
    pub fn new(base_url: String, token: String) -> Self {
        Self {
            base_url,
            token,
            http: reqwest::Client::new(),
        }
    }

    /// Seed fetch: GET /repos/{owner}/{repo}/issues?state=open&per_page=100&page=N
    /// Paginate until a page has fewer than 100 items.
    /// Filter out PRs (items with "pull_request" key in raw JSON).
    /// Map each remaining item to RemoteIssue.
    pub async fn list_issues_seed(
        &self,
        owner: &str,
        repo: &str,
    ) -> Result<Vec<RemoteIssue>, AdeError> {
        let mut all_issues = Vec::new();
        let mut page: u32 = 1;

        loop {
            let url = format!(
                "{}/repos/{}/{}/issues?state=open&per_page=100&page={}",
                self.base_url, owner, repo, page
            );
            let response = self.get(&url).await?;
            let items: Vec<serde_json::Value> = response
                .json()
                .await
                .map_err(|e| AdeError::GitHub(format!("failed to parse seed response: {e}")))?;

            let page_len = items.len();
            let issues = self.map_issues(items)?;
            all_issues.extend(issues);

            if page_len < 100 {
                break;
            }
            page += 1;
        }

        Ok(all_issues)
    }

    /// Incremental fetch: GET /repos/{owner}/{repo}/issues?state=all&per_page=100&since={since}
    /// Paginate, filter PRs, map to RemoteIssue.
    /// Per CONTRACTS §11, no If-None-Match/ETag on incremental — since changes the URL each time.
    pub async fn list_issues_since(
        &self,
        owner: &str,
        repo: &str,
        since: &str,
    ) -> Result<Vec<RemoteIssue>, AdeError> {
        let mut all_issues = Vec::new();
        let mut page: u32 = 1;

        loop {
            let url = format!(
                "{}/repos/{}/{}/issues?state=all&per_page=100&since={}&page={}",
                self.base_url, owner, repo, since, page
            );
            let response = self.get(&url).await?;
            let items: Vec<serde_json::Value> = response.json().await.map_err(|e| {
                AdeError::GitHub(format!("failed to parse incremental response: {e}"))
            })?;

            let page_len = items.len();
            let issues = self.map_issues(items)?;
            all_issues.extend(issues);

            if page_len < 100 {
                break;
            }
            page += 1;
        }

        Ok(all_issues)
    }

    /// Send an authenticated GET request to the given URL.
    /// Handles rate limiting (403/429) per CONTRACTS §11.
    async fn get(&self, url: &str) -> Result<reqwest::Response, AdeError> {
        let response = self
            .http
            .get(url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("User-Agent", "ade")
            .send()
            .await
            .map_err(|e| AdeError::GitHub(format!("request failed: {e}")))?;

        let status = response.status();
        if status.as_u16() == 403 || status.as_u16() == 429 {
            // Check for rate limiting headers
            let headers = response.headers();
            if let Some(remaining) = headers.get("x-ratelimit-remaining") {
                if remaining.to_str().unwrap_or("") == "0" {
                    let until = headers
                        .get("x-ratelimit-reset")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("0")
                        .to_string();
                    return Err(AdeError::RateLimited(until));
                }
            }
            if let Some(retry_after) = headers.get("retry-after") {
                let until = retry_after.to_str().unwrap_or("0").to_string();
                return Err(AdeError::RateLimited(until));
            }
            // 403/429 without rate-limit headers — still treat as GitHub error
            let body = response.text().await.unwrap_or_default();
            return Err(AdeError::GitHub(format!(
                "HTTP {}: {}",
                status.as_u16(),
                body.chars().take(200).collect::<String>()
            )));
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AdeError::GitHub(format!(
                "HTTP {}: {}",
                status.as_u16(),
                body.chars().take(200).collect::<String>()
            )));
        }

        Ok(response)
    }

    /// Map a JSON array of GitHub issue objects to RemoteIssue, filtering out PRs.
    fn map_issues(&self, items: Vec<serde_json::Value>) -> Result<Vec<RemoteIssue>, AdeError> {
        let mut result = Vec::new();
        for item in items {
            // Filter out PRs: items with "pull_request" key
            if item.get("pull_request").is_some() {
                continue;
            }
            let issue = self.map_issue(&item)?;
            result.push(issue);
        }
        Ok(result)
    }

    /// Map a single GitHub issue JSON object to RemoteIssue.
    fn map_issue(&self, item: &serde_json::Value) -> Result<RemoteIssue, AdeError> {
        let number = item["number"]
            .as_u64()
            .ok_or_else(|| AdeError::GitHub("missing number field".to_string()))?;
        let title = item["title"].as_str().unwrap_or("").to_string();
        let state = item["state"].as_str().unwrap_or("open").to_string();
        let updated_at = item["updated_at"].as_str().unwrap_or("").to_string();

        let assignee = item
            .get("assignee")
            .and_then(|a| a.get("login"))
            .and_then(|l| l.as_str())
            .map(|s| s.to_string());

        let labels = item
            .get("labels")
            .and_then(|l| l.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| {
                        l.get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let html_url = item["html_url"].as_str().unwrap_or("").to_string();

        let is_pull_request = item.get("pull_request").is_some();

        let body_preview = item.get("body").and_then(|b| b.as_str()).map(|body| {
            let chars: Vec<char> = body.chars().collect();
            if chars.len() <= 280 {
                chars.into_iter().collect()
            } else {
                chars[..280].iter().collect()
            }
        });

        Ok(RemoteIssue {
            number,
            title,
            state,
            updated_at,
            assignee,
            labels,
            html_url,
            is_pull_request,
            body_preview,
        })
    }
}

#[cfg(test)]
mod tests {
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
}
