// Lists the Claude Code sessions recorded for a workspace's cwd so the user can
// resume one (`claude --resume <id>`) instead of always starting fresh. Claude
// stores transcripts at ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl,
// where the cwd is encoded by replacing every `/` and `.` with `-`.

use crate::error::AdeError;
use crate::AppState;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::State;

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct ClaudeSession {
    /// Session UUID — passed verbatim to `claude --resume <id>`.
    pub id: String,
    /// AI-generated title when present, else the first user prompt, else a stub.
    pub title: String,
    /// Last-modified time, epoch seconds (the file is appended to as the session runs).
    pub last_active: i64,
    pub git_branch: Option<String>,
}

/// Claude Code's project-dir encoding: each `/` and `.` becomes `-`.
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn projects_dir(cwd: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        Path::new(&home)
            .join(".claude")
            .join("projects")
            .join(encode_project_dir(cwd)),
    )
}

/// Extract title/branch from a transcript: first user prompt + git branch (early),
/// latest ai-title (anywhere). Pre-filters lines by substring so we only JSON-parse
/// the few that matter, keeping big transcripts cheap.
fn scan_transcript(path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(file) = fs::File::open(path) else {
        return (None, None, None);
    };
    let mut ai_title = None;
    let mut first_user = None;
    let mut branch = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.contains("\"ai-title\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                    if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                        ai_title = Some(t.to_string());
                    }
                }
            }
        } else if first_user.is_none() && line.contains("\"type\":\"user\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                    branch = v
                        .get("gitBranch")
                        .and_then(|b| b.as_str())
                        .filter(|b| !b.is_empty())
                        .map(str::to_string);
                    if let Some(c) = v.pointer("/message/content").and_then(|c| c.as_str()) {
                        let t: String = c.trim().chars().take(80).collect();
                        if !t.is_empty() {
                            first_user = Some(t);
                        }
                    }
                }
            }
        }
    }
    (ai_title, first_user, branch)
}

/// What we pull out of a transcript to feed the brain on close.
#[derive(Default)]
struct Harvest {
    ai_title: Option<String>,
    first_user: Option<String>,
    branch: Option<String>,
    last_assistant: Option<String>,
    turns: u32,
}

/// Concatenate the text blocks of an assistant message (`message.content` is an
/// array of typed blocks; tool calls/results are skipped).
fn assistant_text(v: &serde_json::Value) -> Option<String> {
    let blocks = v.pointer("/message/content")?.as_array()?;
    let mut out = String::new();
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                out.push_str(t);
            }
        }
    }
    let out = out.trim();
    (!out.is_empty()).then(|| out.chars().take(800).collect())
}

/// One pass over a transcript collecting everything the session note needs.
/// `turns` counts only real (string-content) user prompts, not tool-result
/// `user` rows, so it reads as "human turns".
fn harvest_scan(path: &Path) -> Harvest {
    let mut h = Harvest::default();
    let Ok(file) = fs::File::open(path) else {
        return h;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.contains("\"ai-title\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                    if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                        h.ai_title = Some(t.to_string());
                    }
                }
            }
        } else if line.contains("\"type\":\"user\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                    if let Some(c) = v.pointer("/message/content").and_then(|c| c.as_str()) {
                        h.turns += 1;
                        if h.first_user.is_none() {
                            h.branch = v
                                .get("gitBranch")
                                .and_then(|b| b.as_str())
                                .filter(|b| !b.is_empty())
                                .map(str::to_string);
                            let t: String = c.trim().chars().take(200).collect();
                            if !t.is_empty() {
                                h.first_user = Some(t);
                            }
                        }
                    }
                }
            }
        } else if line.contains("\"type\":\"assistant\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                    if let Some(text) = assistant_text(&v) {
                        h.last_assistant = Some(text);
                    }
                }
            }
        }
    }
    h
}

/// Render a harvest into a gbrain page: stable slug = `sessions/<uuid>` so a
/// re-harvest upserts instead of duplicating. Free-form text stays in the body
/// (never the YAML frontmatter) so it can't break the header.
fn build_note(uuid: &str, h: &Harvest) -> (String, String) {
    let title = h
        .ai_title
        .clone()
        .or_else(|| h.first_user.clone())
        .unwrap_or_else(|| "(untitled session)".into())
        .replace('\n', " ");
    let branch = h.branch.clone().unwrap_or_default();
    let first = h.first_user.clone().unwrap_or_default();
    let last = h.last_assistant.clone().unwrap_or_default();
    let content = format!(
        "---\ntype: session-log\nsession_id: {uuid}\nbranch: {branch}\n---\n\n\
         # {title}\n\n\
         - **branch:** {branch}\n- **turns:** {turns}\n- **first prompt:** {first}\n\n\
         ## Last assistant message\n\n{last}\n",
        turns = h.turns,
    );
    (format!("sessions/{uuid}"), content)
}

/// The newest Claude transcript under `cwd`, as (uuid, path, mtime_secs).
fn newest_transcript(cwd: &str) -> Option<(String, PathBuf, i64)> {
    let dir = projects_dir(cwd)?;
    fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let mtime = e
                .metadata()
                .ok()?
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_secs() as i64;
            Some((id, path, mtime))
        })
        .max_by_key(|(_, _, m)| *m)
}

/// Build the gbrain page (slug, markdown) for the Claude session that was just
/// running under `cwd`, or None when there's no transcript or the newest one is
/// stale. ponytail: "just running" = touched within 15 min; tighten by recording
/// pane spawn time if idle shells in the same workspace cause false harvests.
pub(crate) fn session_note_for(cwd: &str) -> Option<(String, String)> {
    let (uuid, path, mtime) = newest_transcript(cwd)?;
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    if now - mtime > 15 * 60 {
        return None;
    }
    Some(build_note(&uuid, &harvest_scan(&path)))
}

/// Read all sessions under a workspace cwd, newest first.
fn read_sessions(cwd: &str) -> Vec<ClaudeSession> {
    let Some(dir) = projects_dir(cwd) else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![]; // no sessions yet for this cwd
    };
    let mut out: Vec<ClaudeSession> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let last_active = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let (ai_title, first_user, git_branch) = scan_transcript(&path);
            let title = ai_title
                .or(first_user)
                .unwrap_or_else(|| "(untitled session)".to_string());
            Some(ClaudeSession {
                id,
                title,
                last_active,
                git_branch,
            })
        })
        .collect();
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    out
}

#[tauri::command]
pub async fn claude_sessions(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
) -> Result<Vec<ClaudeSession>, AdeError> {
    let ws = crate::repo::workspace_by_id(&state.db, &workspace_id).await?;
    let cwd = ws.root_path.clone();
    // File I/O off the tokio workers that serve keystrokes (same as skills_list).
    tokio::task::spawn_blocking(move || read_sessions(&cwd))
        .await
        .map_err(|e| AdeError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_cwd_like_claude_code() {
        assert_eq!(encode_project_dir("/Users/mk/dev/ade"), "-Users-mk-dev-ade");
        // `/.claude-worktrees` → `--claude-worktrees` (both `/` and `.` map to `-`).
        assert_eq!(
            encode_project_dir("/Users/mk/dev/QC/.claude-worktrees/x"),
            "-Users-mk-dev-QC--claude-worktrees-x"
        );
    }

    #[test]
    fn scans_titles_branches_and_ignores_non_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join(".claude/projects/-tmp-ws");
        fs::create_dir_all(&proj).unwrap();
        // Session with an ai-title (latest wins) and a first user prompt + branch.
        fs::write(
            proj.join("aaa.jsonl"),
            "{\"type\":\"user\",\"gitBranch\":\"main\",\"message\":{\"content\":\"do the thing\"}}\n\
             {\"type\":\"ai-title\",\"aiTitle\":\"old\"}\n\
             {\"type\":\"ai-title\",\"aiTitle\":\"Final Title\"}\n",
        )
        .unwrap();
        // Session with no ai-title → falls back to first user prompt.
        fs::write(
            proj.join("bbb.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"just a prompt\"}}\n",
        )
        .unwrap();
        // A non-jsonl sibling is ignored.
        fs::write(proj.join("note.txt"), "x").unwrap();

        // read_sessions reads $HOME/.claude/projects; point HOME at the temp dir.
        std::env::set_var("HOME", dir.path());
        let sessions = read_sessions("/tmp/ws");

        assert_eq!(sessions.len(), 2);
        let by_id = |id: &str| sessions.iter().find(|s| s.id == id).unwrap();
        assert_eq!(by_id("aaa").title, "Final Title");
        assert_eq!(by_id("aaa").git_branch.as_deref(), Some("main"));
        assert_eq!(by_id("bbb").title, "just a prompt");
        assert_eq!(by_id("bbb").git_branch, None);
    }

    #[test]
    fn harvests_title_branch_turns_and_last_assistant() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sess.jsonl");
        fs::write(
            &path,
            "{\"type\":\"user\",\"gitBranch\":\"feat/x\",\"message\":{\"content\":\"build the thing\"}}\n\
             {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"first reply\"}]}}\n\
             {\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"x\"}]}}\n\
             {\"type\":\"user\",\"message\":{\"content\":\"and now this\"}}\n\
             {\"type\":\"ai-title\",\"aiTitle\":\"Build The Thing\"}\n\
             {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"final reply\"}]}}\n",
        )
        .unwrap();

        let (slug, content) = build_note("uuid-1", &harvest_scan(&path));
        assert_eq!(slug, "sessions/uuid-1");
        assert!(content.contains("# Build The Thing"));
        assert!(content.contains("branch:** feat/x"));
        // Two string-content user prompts; the tool_result `user` row is excluded.
        assert!(content.contains("turns:** 2"));
        assert!(content.contains("first prompt:** build the thing"));
        // Latest assistant text wins.
        assert!(content.contains("final reply"));
        assert!(!content.contains("first reply"));
    }
}
