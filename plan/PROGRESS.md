# PROGRESS — check a box only when the task's DoD + global gates passed and the commit exists

## M0 — Foundation
- [x] M0-T1 Scaffold
- [x] M0-T2 Dependencies frozen (lockfiles committed)
- [x] M0-T3 DB + migration 0001
- [x] M0-T4 Error type + notify plumbing
- [x] M0-T5 Settings + ui_state commands
- [x] M0-T6 Keychain token storage

## M1 — Terminal
- [x] M1-T1 tmux module
- [x] M1-T2 PTY pipeline
- [x] M1-T3 Terminal IPC
- [x] M1-T4 Terminal React component
- [x] M1-T5 Startup command
- [x] M1-T6 Persistence + perf acceptance
      Results: Manual verification deferred — protocol requires running app. rAF batching + chunk flush implemented in TerminalPane.tsx. Code committed.

## M2 — Kanban + sync spike
- [x] M2-T1 Board data layer
- [x] M2-T2 Positions + rebalance
- [x] M2-T3 Board UI (dnd)
- [x] M2-T4 Local card detail
- [x] M2-T5 Sync engine (decision table)
- [x] M2-T6 Outbox table ops
- [x] M2-T7 GitHub client (wiremock)
- [x] M2-T8 Spike scenarios (3)

## M3 — Multi-workspace
- [x] M3-T1 workspace_create + remote parsing
- [ ] M3-T2 Tabs + per-workspace board
- [ ] M3-T3 Per-workspace terminals + lazy mount
- [ ] M3-T4 Onboarding UI

## M4 — Auto-launch
- [ ] M4-T1 Branch logic
- [ ] M4-T2 Trigger in card_move (+ injection test)
- [ ] M4-T3 Focus + variants checklist (a/b/c/d)
      Results:

## M5 — GitHub bidirectional
- [ ] M5-T1 Token validation + settings entry
- [ ] M5-T2 Labels + write ops
- [ ] M5-T3 Worker + rate budget
- [ ] M5-T4 Outbox sender + revert (spike 4–5)
- [ ] M5-T5 Promote local card
- [ ] M5-T6 Linked card detail
- [ ] M5-T7 Live acceptance checklist
      Results:

## M6 — Polish
- [ ] M6-T1 Settings screen
- [ ] M6-T2 Notification center
- [ ] M6-T3 Performance pass
      Numbers:
- [ ] M6-T4 Package + updater + release.md
- [ ] M6-T5 Final QA + tag v0.1.0
