// autonomy.rs (#57): the per-workspace trust dial (PLANO §4, CONTEXT.md, D6).
// L0 off · L1 copilot (jobs on demand, never moves a card or opens a terminal) ·
// L2 supervised (dispatch + human merge gate) · L3 autonomous (+ auto-merge).
// S7 hardcoded L2; this makes it config. The runtime gates each capability on the
// level; worker permissions scale with it.
//
// ponytail: read by the runtime/dispatch; allow until those reads land everywhere.
#![allow(dead_code)]

use crate::db::DbPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AutonomyLevel {
    Off,        // L0
    Copilot,    // L1
    Supervised, // L2 (default)
    Autonomous, // L3
}

impl AutonomyLevel {
    /// Parse `L0`..`L3` (or bare `0`..`3`); anything else → the safe default L2.
    pub fn parse(s: &str) -> AutonomyLevel {
        match s.trim().to_ascii_uppercase().as_str() {
            "L0" | "0" | "OFF" => AutonomyLevel::Off,
            "L1" | "1" | "COPILOT" => AutonomyLevel::Copilot,
            "L3" | "3" | "AUTONOMOUS" => AutonomyLevel::Autonomous,
            _ => AutonomyLevel::Supervised,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AutonomyLevel::Off => "L0",
            AutonomyLevel::Copilot => "L1",
            AutonomyLevel::Supervised => "L2",
            AutonomyLevel::Autonomous => "L3",
        }
    }

    /// L1+: the gestor may run jobs (plan/review/notes) on demand.
    pub fn can_run_jobs(&self) -> bool {
        *self >= AutonomyLevel::Copilot
    }

    /// L2+: the gestor may dispatch workers — move cards, open terminals, verify,
    /// open PRs. L1 never touches the board or a terminal.
    pub fn can_dispatch(&self) -> bool {
        *self >= AutonomyLevel::Supervised
    }

    /// L3 only: merge without a human clicking it.
    pub fn can_auto_merge(&self) -> bool {
        *self >= AutonomyLevel::Autonomous
    }

    /// L2+: the two-leg fix_and_reverify gate (#50) is allowed.
    pub fn can_fix_and_reverify(&self) -> bool {
        *self >= AutonomyLevel::Supervised
    }

    /// Claude `--permission-mode` for workers at this level. L3 may opt into
    /// skipping permission prompts entirely (only ever inside a worktree, §4).
    pub fn worker_permission_mode(&self, l3_skip_permissions: bool) -> &'static str {
        match self {
            AutonomyLevel::Autonomous if l3_skip_permissions => "bypassPermissions",
            _ => "acceptEdits",
        }
    }
}

/// Load a workspace's autonomy level (setting `autonomy_level`, default L2).
pub async fn load(db: &DbPool, workspace_id: &str) -> AutonomyLevel {
    crate::ipc::settings::workspace_setting_value(db, workspace_id, "autonomy_level")
        .await
        .map(|v| AutonomyLevel::parse(&v))
        .unwrap_or(AutonomyLevel::Supervised)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsing_and_default() {
        assert_eq!(AutonomyLevel::parse("L0"), AutonomyLevel::Off);
        assert_eq!(AutonomyLevel::parse("1"), AutonomyLevel::Copilot);
        assert_eq!(AutonomyLevel::parse("L3"), AutonomyLevel::Autonomous);
        assert_eq!(AutonomyLevel::parse("garbage"), AutonomyLevel::Supervised);
    }

    #[test]
    fn capability_gates_per_level() {
        use AutonomyLevel::*;
        // L0: nothing
        assert!(!Off.can_run_jobs() && !Off.can_dispatch() && !Off.can_auto_merge());
        // L1: jobs only
        assert!(Copilot.can_run_jobs());
        assert!(!Copilot.can_dispatch() && !Copilot.can_fix_and_reverify());
        // L2: dispatch + fix_and_reverify, but no auto-merge
        assert!(Supervised.can_dispatch() && Supervised.can_fix_and_reverify());
        assert!(!Supervised.can_auto_merge());
        // L3: everything
        assert!(Autonomous.can_dispatch() && Autonomous.can_auto_merge());
    }

    #[test]
    fn permission_mode_scales() {
        assert_eq!(
            AutonomyLevel::Supervised.worker_permission_mode(true),
            "acceptEdits"
        );
        assert_eq!(
            AutonomyLevel::Autonomous.worker_permission_mode(false),
            "acceptEdits"
        );
        assert_eq!(
            AutonomyLevel::Autonomous.worker_permission_mode(true),
            "bypassPermissions"
        );
    }
}
