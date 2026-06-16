use crate::error::AdeError;
use crate::AppState;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// Coarse family used to group skills in the sidebar spine (Plan, Review,
    /// Design, …). Read from a `category:` frontmatter field when the skill
    /// opts in, otherwise inferred from the name; unknown skills get "Other".
    pub category: String,
}

/// Classify a skill into a coarse family for the sidebar spine. Prefer an
/// explicit `category:` from frontmatter; otherwise infer from the name with
/// ordered keyword rules (earlier rules win). Names are descriptive enough
/// (`plan-eng-review`, `design-shotgun`, `ios-qa`) that substring matching
/// buckets the common cases; anything unmatched falls into "Other", which the
/// UI surfaces as its own group alongside the "All" catch-all.
fn categorize(name: &str, frontmatter: Option<String>) -> String {
    if let Some(c) = frontmatter {
        return c;
    }
    let n = name.to_ascii_lowercase();
    let has = |kws: &[&str]| kws.iter().any(|k| n.contains(k));
    if n.starts_with("ios") {
        "iOS"
    } else if n.starts_with("plan")
        || has(&[
            "spec",
            "office-hours",
            "grill",
            "prd",
            "to-issues",
            "prototype",
            "triage",
            "autoplan",
        ])
    {
        "Plan"
    } else if n.starts_with("design") || n == "impeccable" {
        "Design"
    } else if has(&["review", "simplify", "security", "health", "retro", "cso"]) {
        "Review"
    } else if has(&["qa", "verify", "tdd"]) {
        "QA"
    } else if has(&["investigate", "diagnose", "debug"]) {
        "Debug"
    } else if has(&["ship", "deploy", "canary", "land", "release"]) {
        "Ship"
    } else if has(&["doc", "make-pdf", "handoff"]) {
        "Docs"
    } else if has(&[
        "research",
        "competitor",
        "customer",
        "influencer",
        "scrape",
        "sales",
    ]) {
        "Research"
    } else if has(&[
        "browse",
        "chrome",
        "cookies",
        "run",
        "benchmark",
        "skillify",
        "pair-agent",
    ]) {
        "Browser"
    } else if has(&[
        "setup",
        "config",
        "gbrain",
        "upgrade",
        "write-a-skill",
        "find-skills",
        "learn",
        "statusline",
        "keybind",
        "schedule",
        "loop",
        "freeze",
        "guard",
        "careful",
    ]) {
        "Setup"
    } else {
        "Other"
    }
    .to_string()
}

/// Directories scanned (relative to the workspace root) for `<dir>/<skill>/SKILL.md`.
const SKILL_DIRS: &[&str] = &[".claude/skills", "skills"];

/// Project-local skill directories, resolved against the workspace `root`.
fn project_skill_dirs(root: &Path) -> Vec<PathBuf> {
    SKILL_DIRS.iter().map(|d| root.join(d)).collect()
}

/// Ordered base directories scanned for `<base>/<skill>/SKILL.md`. Project dirs
/// come first so a project skill shadows a same-named one, followed by the
/// user's Claude Code skills (`~/.claude/skills`) so the global library is
/// listed alongside the project's own.
fn skill_base_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = project_skill_dirs(root);
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join(".claude").join("skills"));
    }
    dirs
}

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

/// Scan the given base directories for skills: any `SKILL.md` (case-insensitive)
/// one level under each base. Name falls back to the containing folder; missing
/// files/dirs are simply skipped. The first occurrence of a name wins (earlier
/// dirs shadow later ones), and the result is sorted by name.
fn scan_skills(dirs: &[PathBuf]) -> Vec<SkillInfo> {
    let mut skills: Vec<SkillInfo> = Vec::new();
    for base in dirs {
        let Ok(entries) = std::fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(md) = std::fs::read_dir(&path).ok().and_then(|sub| {
                sub.flatten().map(|e| e.path()).find(|p| {
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
            let category = categorize(&name, frontmatter_value(&content, "category"));
            if !skills.iter().any(|s| s.name == name) {
                skills.push(SkillInfo {
                    name,
                    description,
                    category,
                });
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
    let dirs = skill_base_dirs(Path::new(&root));
    // Directory walking is sync fs I/O; keep it off the tokio workers that
    // serve keystrokes, same as terminal_open does for tmux.
    tokio::task::spawn_blocking(move || scan_skills(&dirs))
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
        let skills = scan_skills(&project_skill_dirs(tmp.path()));
        assert_eq!(
            skills,
            vec![
                SkillInfo {
                    name: "alpha".into(),
                    description: "First one".into(),
                    category: "Other".into()
                },
                SkillInfo {
                    name: "zeta".into(),
                    description: "Last one".into(),
                    category: "Other".into()
                },
            ]
        );
    }

    #[test]
    fn falls_back_to_dir_name_without_frontmatter() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            "skills",
            "my-skill",
            "Just a body, no frontmatter.",
        );
        let skills = scan_skills(&project_skill_dirs(tmp.path()));
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "my-skill");
        assert_eq!(skills[0].description, "");
    }

    #[test]
    fn missing_dirs_yield_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_skills(&project_skill_dirs(tmp.path())).is_empty());
    }

    #[test]
    fn dedupes_same_name_across_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(tmp.path(), ".claude/skills", "dup", "---\nname: dup\n---\n");
        write_skill(tmp.path(), "skills", "dup", "---\nname: dup\n---\n");
        assert_eq!(scan_skills(&project_skill_dirs(tmp.path())).len(), 1);
    }

    #[test]
    fn includes_global_claude_skills_with_project_precedence() {
        // Two roots: one stands in for the workspace, one for ~/.claude.
        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write_skill(
            project.path(),
            ".claude/skills",
            "shared",
            "---\nname: shared\ndescription: from project\n---\n",
        );
        write_skill(
            home.path(),
            ".claude/skills",
            "shared",
            "---\nname: shared\ndescription: from global\n---\n",
        );
        write_skill(
            home.path(),
            ".claude/skills",
            "global-only",
            "---\nname: global-only\ndescription: ship\n---\n",
        );

        // Project dirs first, global last — mirrors skill_base_dirs ordering.
        let mut dirs = project_skill_dirs(project.path());
        dirs.push(home.path().join(".claude").join("skills"));
        let skills = scan_skills(&dirs);

        let shared = skills.iter().find(|s| s.name == "shared").unwrap();
        assert_eq!(shared.description, "from project"); // project shadows global
        assert!(skills.iter().any(|s| s.name == "global-only"));
    }

    #[test]
    fn categorize_infers_from_name() {
        assert_eq!(categorize("plan-eng-review", None), "Plan");
        assert_eq!(categorize("design-shotgun", None), "Design");
        assert_eq!(categorize("review", None), "Review");
        assert_eq!(categorize("ios-qa", None), "iOS"); // ios prefix wins over qa
        assert_eq!(categorize("qa", None), "QA");
        assert_eq!(categorize("investigate", None), "Debug");
        assert_eq!(categorize("ship", None), "Ship");
        assert_eq!(categorize("totally-unknown-thing", None), "Other");
    }

    #[test]
    fn categorize_prefers_explicit_frontmatter() {
        // An explicit category overrides name inference.
        assert_eq!(categorize("ship", Some("Custom".into())), "Custom");
    }

    #[test]
    fn scan_reads_category_from_frontmatter() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".claude/skills",
            "tagged",
            "---\nname: tagged\ndescription: x\ncategory: Workflows\n---\n",
        );
        let skills = scan_skills(&project_skill_dirs(tmp.path()));
        assert_eq!(skills[0].category, "Workflows");
    }

    #[test]
    fn skill_base_dirs_appends_home_claude_skills() {
        let root = Path::new("/tmp/ws");
        let dirs = skill_base_dirs(root);
        // Project dirs are first; the home dir (when HOME is set) is appended last.
        assert_eq!(dirs[0], root.join(".claude/skills"));
        assert_eq!(dirs[1], root.join("skills"));
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(
                dirs.last().unwrap(),
                &Path::new(&home).join(".claude").join("skills")
            );
        }
    }
}
