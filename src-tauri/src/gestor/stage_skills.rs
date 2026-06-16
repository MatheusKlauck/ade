// stage_skills.rs (#50): per-workspace config binding skills to loop stages —
// generalizes the gates (S8) and review (#39). Two attach modes (PLANO §1):
//   EXECUTE — skills prepended to the worker's prompt (best-effort, S7).
//   VERIFY/PLAN — each skill is a headless gate job (`claude -p "/skill" …
//     --json-schema VERDICT`, cwd = worktree): typed verdict via the harness.
// Combination: every `required` gate must approve; any `needs_fixes` reinjects
// feedback; `required:false` only warns (D8). Adversarial: `runs`/`quorum` runs a
// gate N times and lets the majority decide.
//
// ponytail: config + combination logic + preamble are wired (execute → S7);
// the verify-gate runner generalizes #39's pass. allow until fully swapped in.
#![allow(dead_code)]

use crate::db::DbPool;
use serde::Deserialize;

fn default_true() -> bool {
    true
}
fn default_runs() -> u32 {
    1
}

/// One skill bound to a stage.
#[derive(Debug, Clone, Deserialize)]
pub struct SkillGate {
    pub skill: String,
    #[serde(default = "default_true")]
    pub required: bool,
    #[serde(default, rename = "allowedTools")]
    pub allowed_tools: Vec<String>,
    /// Independent runs for an adversarial gate (default 1).
    #[serde(default = "default_runs")]
    pub runs: u32,
    /// `needs_fixes` votes needed to fail the gate (default = simple majority).
    #[serde(default)]
    pub quorum: Option<u32>,
}

/// The full per-workspace mapping. Empty by default (gestor behaves as before).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StageSkills {
    #[serde(default)]
    pub execute: Vec<SkillGate>,
    #[serde(default)]
    pub verify: Vec<SkillGate>,
    #[serde(default)]
    pub plan: Vec<SkillGate>,
    #[serde(default)]
    pub publish: Vec<SkillGate>,
}

/// Load `stage_skills` for a workspace (JSON setting); default empty on absence /
/// parse error (never breaks the loop).
pub async fn load(db: &DbPool, workspace_id: &str) -> StageSkills {
    crate::ipc::settings::workspace_setting_value(db, workspace_id, "stage_skills")
        .await
        .and_then(|v| serde_json::from_str::<StageSkills>(&v).ok())
        .unwrap_or_default()
}

/// The EXECUTE preamble prepended to the worker prompt (S7): "use /tdd, /spec."
/// Empty string when no execute skills are configured.
pub fn execute_preamble(execute: &[SkillGate]) -> String {
    if execute.is_empty() {
        return String::new();
    }
    let list = execute
        .iter()
        .map(|s| format!("/{}", s.skill.trim_start_matches('/')))
        .collect::<Vec<_>>()
        .join(", ");
    format!("For this card, use these skills: {list}.\n\n")
}

/// The headless gate prompt for one skill: invoke the skill, hand it the context,
/// demand the verdict contract.
pub fn gate_prompt(skill: &str, context: &str) -> String {
    let skill = skill.trim_start_matches('/');
    format!(
        "/{skill}\n\n{context}\n\n\
         Conclude with ONLY this JSON: \
         {{\"verdict\": \"approve\" | \"needs_fixes\", \"feedback\": \"<why, if needs_fixes>\"}}"
    )
}

/// Resolve N adversarial run verdicts into one (approved, combined_feedback) for a
/// gate. A run counts as `needs_fixes` unless it explicitly says `approve`.
/// `quorum` `needs_fixes` votes (default = simple majority) fail the gate.
pub fn resolve_runs(
    verdicts: &[crate::gestor::review::Verdict],
    quorum: Option<u32>,
) -> (bool, String) {
    if verdicts.is_empty() {
        return (true, String::new());
    }
    let rejects: Vec<&crate::gestor::review::Verdict> =
        verdicts.iter().filter(|v| v.verdict != "approve").collect();
    let threshold = quorum.unwrap_or((verdicts.len() as u32) / 2 + 1) as usize;
    if rejects.len() >= threshold {
        let feedback = rejects
            .iter()
            .filter_map(|v| v.feedback.clone())
            .collect::<Vec<_>>()
            .join("; ");
        (false, feedback)
    } else {
        (true, String::new())
    }
}

/// The result of running one gate (after adversarial resolution).
pub struct GateResult {
    pub skill: String,
    pub required: bool,
    pub approved: bool,
    pub feedback: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CombinedDecision {
    Approve,
    NeedsFixes(String),
}

/// Combine all gate results for a stage: every `required` gate must approve to
/// proceed; a failing required gate blocks with combined feedback. Failing
/// `required:false` gates only produce warnings (returned separately).
pub fn combine(results: &[GateResult]) -> (CombinedDecision, Vec<String>) {
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    for r in results {
        if r.approved {
            continue;
        }
        if r.required {
            blocking.push(format!("[{}] {}", r.skill, r.feedback));
        } else {
            warnings.push(format!("[{}] {}", r.skill, r.feedback));
        }
    }
    let decision = if blocking.is_empty() {
        CombinedDecision::Approve
    } else {
        CombinedDecision::NeedsFixes(blocking.join("\n"))
    };
    (decision, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gestor::review::Verdict;

    fn v(verdict: &str, fb: Option<&str>) -> Verdict {
        Verdict {
            verdict: verdict.into(),
            feedback: fb.map(|s| s.into()),
        }
    }

    #[test]
    fn config_parses_with_defaults() {
        let s: StageSkills = serde_json::from_str(
            r#"{"execute":[{"skill":"tdd"}],"verify":[{"skill":"review","required":true,"allowedTools":["Read"]},{"skill":"sec","required":false}]}"#,
        )
        .unwrap();
        assert_eq!(s.execute[0].skill, "tdd");
        assert!(s.execute[0].required); // default true
        assert_eq!(s.execute[0].runs, 1); // default
        assert!(s.verify[0].required && s.verify[0].allowed_tools == vec!["Read"]);
        assert!(!s.verify[1].required);
    }

    #[test]
    fn preamble_lists_skills() {
        let skills = vec![
            SkillGate {
                skill: "tdd".into(),
                required: true,
                allowed_tools: vec![],
                runs: 1,
                quorum: None,
            },
            SkillGate {
                skill: "/spec".into(),
                required: true,
                allowed_tools: vec![],
                runs: 1,
                quorum: None,
            },
        ];
        let p = execute_preamble(&skills);
        assert!(p.contains("/tdd") && p.contains("/spec"));
        assert_eq!(execute_preamble(&[]), "");
    }

    #[test]
    fn gate_prompt_invokes_skill_and_demands_verdict() {
        let p = gate_prompt("review", "the diff");
        assert!(p.starts_with("/review"));
        assert!(p.contains("the diff") && p.contains("\"verdict\""));
    }

    #[test]
    fn adversarial_majority_decides() {
        // 3 runs, 2 reject → fails (default majority = 2)
        let (ok, fb) = resolve_runs(
            &[
                v("approve", None),
                v("needs_fixes", Some("a")),
                v("needs_fixes", Some("b")),
            ],
            None,
        );
        assert!(!ok && fb.contains("a") && fb.contains("b"));
        // 3 runs, 1 reject → passes
        let (ok, _) = resolve_runs(
            &[
                v("approve", None),
                v("approve", None),
                v("needs_fixes", Some("x")),
            ],
            None,
        );
        assert!(ok);
        // explicit quorum=1 → a single reject fails
        let (ok, _) = resolve_runs(&[v("approve", None), v("needs_fixes", Some("x"))], Some(1));
        assert!(!ok);
    }

    #[test]
    fn combine_required_blocks_optional_warns() {
        let results = vec![
            GateResult {
                skill: "review".into(),
                required: true,
                approved: true,
                feedback: "".into(),
            },
            GateResult {
                skill: "qa".into(),
                required: true,
                approved: false,
                feedback: "test fails".into(),
            },
            GateResult {
                skill: "sec".into(),
                required: false,
                approved: false,
                feedback: "minor".into(),
            },
        ];
        let (decision, warnings) = combine(&results);
        match decision {
            CombinedDecision::NeedsFixes(f) => assert!(f.contains("test fails")),
            _ => panic!("expected NeedsFixes"),
        }
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("minor"));

        // all required approve → Approve (optional failure still just warns)
        let ok = vec![GateResult {
            skill: "review".into(),
            required: true,
            approved: true,
            feedback: "".into(),
        }];
        assert_eq!(combine(&ok).0, CombinedDecision::Approve);
    }
}
