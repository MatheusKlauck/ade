# ADE

Terminal-native workspace where a Kanban board, tmux terminals, and GitHub state stay legible at a glance. The vocabulary below is specific to how ADE coordinates AI coding agents; general programming terms are deliberately excluded.

## Language

**Gestor**:
The deterministic orchestration layer in the Rust core. It runs the control loop (when to plan, review, dispatch) as a state machine over SQLite; the LLM is invoked only at the edges, never owns the loop.
_Avoid_: orchestrator-bot, copilot, agent.

**Worker**:
The interactive coding agent that does the actual code work for a card — by default Claude Code running in a tmux window. The Gestor launches and instruments Workers but never does code work itself.
_Avoid_: agent (overloaded), bot.

**Border job** (_borda_):
A typed, one-shot LLM job at the entry or exit of the flow — `plan_issues` at intake (brief → grounded issue proposals) and `review_diff` at exit (diff → approve/needs_fixes verdict). Distinct from a Worker: a Border job reads and judges, it does not edit code.
_Avoid_: agent, assistant.

**Gestor job**:
A bounded LLM invocation with serde-validated JSON output. The four kinds are `plan_issues`, `review_diff`, `diagnose_stall`, `release_notes`. Every job records input, output, turns, and duration for audit.
_Avoid_: prompt, call.

**Autonomy level**:
The per-workspace trust dial L0–L3. L0 off; L1 copiloto (jobs on demand, never moves a card or opens a terminal); L2 supervised dispatch + merge gate; L3 autonomous with merge.
_Avoid_: mode, permission level.
