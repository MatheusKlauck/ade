// M3-T1: slug + remote parsing (§9.1, §9.2). M4-T1 adds branch logic.

/// §9.1 — Lowercase ASCII; every run of chars outside `[a-z0-9]` becomes a single
/// `-`; trim leading/trailing `-`; truncate to 40 chars (then trim `-` again); if
/// empty → `fallback`.
pub fn slugify(input: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in input.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    // Trim leading/trailing dashes.
    let trimmed = out.trim_matches('-');
    // Truncate to 40 chars, then trim dashes again.
    let truncated: String = trimmed.chars().take(40).collect();
    let result = truncated.trim_matches('-').to_string();
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

/// §9.2 — Parse a git remote URL into `(owner, repo)` if it points at github.com,
/// else `None`.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();

    // Forms:
    //   git@github.com:o/r.git           (scp-like)
    //   https://github.com/o/r.git
    //   https://github.com/o/r
    //   ssh://git@github.com/o/r.git
    let rest = [
        "git@github.com:",
        "https://github.com/",
        "ssh://git@github.com/",
        "ssh://github.com/",
        "http://github.com/",
    ]
    .iter()
    .find_map(|prefix| url.strip_prefix(prefix))?;

    // Strip a trailing ".git" suffix if present.
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let rest = rest.trim_end_matches('/');

    let (owner, repo) = rest.split_once('/')?;

    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }

    Some((owner.to_string(), repo.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_fix_login_broken() {
        assert_eq!(slugify("Fix: login broken!!", "fb"), "fix-login-broken");
    }

    #[test]
    fn slugify_injection_chars() {
        // `$(rm -rf ~)` + backtick id backtick
        assert_eq!(slugify("$(rm -rf ~)`id`", "fb"), "rm-rf-id");
    }

    #[test]
    fn slugify_unicode() {
        assert_eq!(slugify("ÁÉÍ déjà vu 🚀", "fb"), "d-j-vu");
    }

    #[test]
    fn slugify_empty_uses_fallback() {
        assert_eq!(slugify("", "card-ab12"), "card-ab12");
    }

    #[test]
    fn slugify_all_symbols_uses_fallback() {
        assert_eq!(slugify("!!!", "fb"), "fb");
    }

    #[test]
    fn slugify_truncates_to_40() {
        let input = "a".repeat(60);
        assert_eq!(slugify(&input, "fb"), "a".repeat(40));
    }

    #[test]
    fn parse_scp_with_git_suffix() {
        assert_eq!(
            parse_github_remote("git@github.com:o/r.git"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_https_with_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/o/r.git"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_https_without_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/o/r"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_ssh_scheme_with_git_suffix() {
        assert_eq!(
            parse_github_remote("ssh://git@github.com/o/r.git"),
            Some(("o".to_string(), "r".to_string()))
        );
    }

    #[test]
    fn parse_non_github_returns_none() {
        assert_eq!(parse_github_remote("https://gitlab.com/o/r.git"), None);
    }
}
