# ADE

Terminal-native workspace where a Kanban board, tmux terminals, and GitHub state stay legible at a glance. The vocabulary below is specific to how ADE coordinates AI coding agents; general programming terms are deliberately excluded.

## Language

### Orchestration

**Gestor**: The deterministic orchestration layer in the Rust core. It runs the control loop (when to plan, review, dispatch) as a state machine over SQLite; the LLM is invoked only at the edges, never owns the loop. _Avoid_: orchestrator-bot, copilot, agent.

**Worker**: The interactive coding agent that does the actual code work for a card — by default Claude Code running in a tmux window. The Gestor launches and instruments Workers but never does code work itself. _Avoid_: agent (overloaded), bot.

**Border job** (_borda_): A typed, one-shot LLM job at the entry or exit of the flow — `plan_issues` at intake (brief → grounded issue proposals) and `review_diff` at exit (diff → approve/needs_fixes verdict). Distinct from a Worker: a Border job reads and judges, it does not edit code. _Avoid_: agent, assistant.

**Gestor job**: A bounded LLM invocation with serde-validated JSON output. The four kinds are `plan_issues`, `review_diff`, `diagnose_stall`, `release_notes`. Every job records input, output, turns, and duration for audit. _Avoid_: prompt, call.

**Autonomy level**: The per-workspace trust dial L0–L3. L0 off; L1 copiloto (jobs on demand, never moves a card or opens a terminal); L2 supervised dispatch + merge gate; L3 autonomous with merge. _Avoid_: mode, permission level.

**Agent task** (`agent_task`): One automated run of a single card through the FSM — the unit the Gestor dispatches, instruments, and ships. Carries the branch, worktree, worker window, and attempt count. _Avoid_: bare "agent" (the entity is the run, not the model), "job" (that is the LLM-invocation kind).

**FSM** / **task state**: The deterministic agent_task lifecycle over SQLite (`queued → preparing → working → verifying → reviewing → pushing → pr_open → … → done`, plus `failed`/`aborted`). The single source of transition; every edge records an event. Shorthand working→verifying→publishing→shipped maps onto these granular states.

**Dispatch** (_despacho_): Enqueue a card and launch its Worker in an isolated worktree. There is one dispatch surface: a human dragging a card to Doing runs the exact same path as the autonomous loop. _Avoid_: "run", "spawn" (those are mechanics, not the act).

**Gate**: A verify/plan Skill run as a headless job that returns a typed verdict (`approve`/`needs_fixes`). Every `required` gate must approve to advance; `needs_fixes` reinjects feedback to the Worker. Includes the build/test gates and the L2 human **merge gate** (the human approving a PR before merge; L3 does it autonomously). _Avoid_: check, hook.

**Stall**: A Worker that has stopped making progress; `diagnose_stall` is the Gestor job that inspects the situation and decides recover vs fail.

### Board & cards

**Workspace**: One project: a repo + its tmux session + its board, optionally bound to a GitHub remote. The unit of project-switching — each workspace is one tab. _Avoid_: project (use only informally), repo (a workspace is more than its repo).

**Board**: The fixed five-column Kanban that is a live projection of card + task state, synced bidirectionally with GitHub issues. _Avoid_: kanban (use "board"), backlog (that is one column).

**Column**: One of the five fixed, non-editable board lanes — `Backlog → Doing → Paused → PR → Done` (canonical strings in `columns.ts`). _Avoid_: lane, status, stage.

**Card**: A unit of work on the board. Either `local` (created in ADE) or `github`/linked (mirrors a GitHub issue). Moving a card drives terminal + git side effects. _Avoid_: ticket, item, task.

**Source**: A card's binary origin — `local` (Local Slate badge) or `github`/**linked** (Linked Violet badge, mirrors an issue). The two-hue rule: no third source identity. _Avoid_: type, kind, origin.

**Issue proposal** (`issue_proposal`): A `plan_issues` output — a repo-grounded, not-yet-approved issue (`status: proposed`). Approving a batch turns each into a local Backlog card. The composer's "desdobrei em N tasks" means these proposals/cards, _not_ agent_tasks. _Avoid_: draft, suggestion, task.

**Projection**: How non-board state shows on the board: terminal/failed FSM states project onto a column (e.g. `failed`/`aborted` → Paused), and a human drag re-pins the card over the projection (the drag wins).

### Intake

**Brief**: The free-text feature description the developer types into the intake; `plan_issues` grounds it against the repo into proposals. _Avoid_: prompt, description, vision (UI copy should say "brief").

**Composer**: The hero-intake UI (`NewFeatureComposer`) — one input, one button — where a brief is unfolded into a flowing board. _Avoid_: compositor (PT spelling; keep code/term English).

**Hero flow** / **New feature**: The one-shot intake where a brief unfolds (_desdobra_) into proposals, all approved into Backlog, and the board starts flowing — ensuring the workspace is at least L2 first. The act of building is the consent to flow.

### Terminals

**tmux window** (`window_id`): The backend terminal process unit — one per card/Worker. Killing it stops the agent process, not just the viewer. Stored as `card.terminal_window_id` or on the agent_task. _Avoid_: terminal (ambiguous), tab.

**Pane** (`paneId`): A live PTY viewer attached to a window, rendered in xterm. One window can have several panes; collapsing a pane never unmounts it (the PTY survives). _Avoid_: terminal, view.

**Tile**: A cell in the terminal-area layout grid — a window placed in a row with a flex `weight`. Pure layout, distinct from the window/PTY it shows. _Avoid_: pane, split.

**Preset** (terminal preset): A named set of startup/close commands applied when a pane launches and closes (the default preset runs on move-to-Doing/Done). _Avoid_: profile, template.

**Skill**: A Claude Code `/skill` invocation. Tracked by frequency for the quick-launch tray, and bindable to loop **stages** (stage skills) as execute-preamble or verify/plan gates. _Avoid_: command, macro.

### Sync & audit

**Sync**: Bidirectional reconciliation between the board and GitHub issues; nothing fails silently (_nada falha em silêncio_). Surfaced by the SyncIndicator. _Avoid_: push, refresh.

**Outbox**: The durable queue of card-move **intents** the sync engine drains to GitHub, with attempts/last-error for retry. _Avoid_: queue (generic), buffer.

**Feed**: The append-only audit stream of `agent_event`s — every FSM transition and job recorded with cost/turns/duration. Read by the Gestor panel. _Avoid_: log, history.

**Ledger**: The frontend view where each row _is_ the terminal surface: a card row expands inline to render its live terminal full-width. Distinct from the Feed (audit) and the Board (projection). _Avoid_: feed, list.
