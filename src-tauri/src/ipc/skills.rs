use crate::error::AdeError;
use crate::AppState;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

/// Directories scanned (relative to the workspace root) for `<dir>/<skill>/SKILL.md`.
const SKILL_DIRS: &[&str] = &[".claude/skills", "skills"];

/// Extract a `key: value` entry from YAML frontmatter delimited by `---` lines.
/// Minimal on purpose — skill frontmatter is flat `name:`/`description:` pairs,
/// so a YAML dependency isn't warranted.
fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            return None;
        }
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(value) = rest.strip_prefix(':') {
                let v = value.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Scan a workspace root for skills: any `SKILL.md` (case-insensitive) one
/// level under the known skill directories. Name falls back to the containing
/// folder; missing files/dirs are simply skipped. Result is sorted by name.
fn scan_skills(root: &Path) -> Vec<SkillInfo> {
    let mut skills: Vec<SkillInfo> = Vec::new();
    for dir in SKILL_DIRS {
        let base = root.join(dir);
        let Ok(entries) = std::fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(md) = std::fs::read_dir(&path).ok().and_then(|sub| {
                sub.flatten()
                    .map(|e| e.path())
                    .find(|p| {
                        p.is_file()
                            && p.file_name()
                                .and_then(|n| n.to_str())
                                .is_some_and(|n| n.eq_ignore_ascii_case("skill.md"))
                    })
            }) else {
                continue;
            };
            let content = std::fs::read_to_string(&md).unwrap_or_default();
            let dir_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let name = frontmatter_value(&content, "name").unwrap_or(dir_name);
            if name.is_empty() {
                continue;
            }
            let description = frontmatter_value(&content, "description").unwrap_or_default();
            if !skills.iter().any(|s| s.name == name) {
                skills.push(SkillInfo { name, description });
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

#[tauri::command]
pub async fn skills_list(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
) -> Result<Vec<SkillInfo>, AdeError> {
    let ws = crate::repo::workspace_by_id(&state.db, &workspace_id).await?;
    let root = ws.root_path.clone();
    // Directory walking is sync fs I/O; keep it off the tokio workers that
    // serve keystrokes, same as terminal_open does for tmux.
    tokio::task::spawn_blocking(move || scan_skills(Path::new(&root)))
        .await
        .map_err(|e| AdeError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, rel_dir: &str, name: &str, content: &str) {
        let dir = root.join(rel_dir).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    #[test]
    fn scans_and_sorts_skills() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".claude/skills",
            "zeta",
            "---\nname: zeta\ndescription: Last one\n---\nbody",
        );
        write_skill(
            tmp.path(),
            ".claude/skills",
            "alpha",
            "---\nname: alpha\ndescription: \"First one\"\n---\n",
        );
        let skills = scan_skills(tmp.path());
        assert_eq!(
            skills,
            vec![
                SkillInfo {
                    name: "alpha".into(),
                    description: "First one".into()
                },
                SkillInfo {
                    name: "zeta".into(),
                    description: "Last one".into()
                },
            ]
        );
    }

    #[test]
    fn falls_back_to_dir_name_without_frontmatter() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(tmp.path(), "skills", "my-skill", "Just a body, no frontmatter.");
        let skills = scan_skills(tmp.path());
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "my-skill");
        assert_eq!(skills[0].description, "");
    }

    #[test]
    fn missing_dirs_yield_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_skills(tmp.path()).is_empty());
    }

    #[test]
    fn dedupes_same_name_across_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(tmp.path(), ".claude/skills", "dup", "---\nname: dup\n---\n");
        write_skill(tmp.path(), "skills", "dup", "---\nname: dup\n---\n");
        assert_eq!(scan_skills(tmp.path()).len(), 1);
    }
}
