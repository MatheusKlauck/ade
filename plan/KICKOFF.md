# Kickoff prompt for the implementer agent

Paste the block below as the initial prompt. Prerequisites on the machine: macOS,
Rust stable + Xcode CLT, Node 20+, tmux >= 3.2, repo opened at the project root.

---

You are the implementer of the ADE project. Your rulebook is `AGENTS.md` at the repo
root — read it now and obey it for the entire job. The plan lives in `plan/`:
`00-CONTRACTS.md` is the single source of truth; `M0.md`–`M6.md` contain your tasks;
`PROGRESS.md` is your checklist; `DECISIONS.md` already contains pre-M0 patches that are
part of the contract — read it before starting and append to it as the rules require.
Do NOT read `PLANO-ADE-v1.md`, `PLANO-ADE-v2.md` or `REVIEW-ADE-v1.md`; they are
superseded by the plan files for your purposes.

Execute this loop until the end of M6:

1. Open `plan/PROGRESS.md`; take the first unchecked task, in order. Never skip, never
   reorder, never work on two tasks at once.
2. Read the task block in its `plan/M<x>.md` file fully, plus the CONTRACTS sections it
   references. Implement exactly what it says — nothing more.
3. Run the gates from `AGENTS.md`. All green → check the box in PROGRESS.md → commit as
   `M<x>-T<y>: <subject>` → next task.

Rules for situations the loop doesn't cover:

- **Manual steps you cannot perform** (UI interaction checklists, the live-GitHub
  checklist M5-T7, signing/notarization in M6-T4, stopwatch measurements): do everything
  automatable (write the scripts, the code, the docs), then mark the item in PROGRESS.md
  as `PENDING-HUMAN: <what the human must do and how to record the result>` and continue
  to the next task. Never invent a result for a manual check.
- **`[needs-tmux]` / `[needs-keychain]` tests:** write them, run them locally once if the
  environment allows (`cargo test -- --ignored <name>`); if the environment blocks them,
  leave them ignored and note it in PROGRESS.md.
- **Ambiguity or a contract that won't compile:** follow the AGENTS.md protocol (simplest
  consistent choice / minimal adaptation + `DECISIONS.md` entry). Do not stop to ask.
- **Stop and report only if:** a gate is red after 3 distinct fix attempts, or completing
  a task would force you to break a Hard Rule in AGENTS.md. In that case, write a
  `BLOCKED:` entry in PROGRESS.md under the task stating exactly what you tried.

Definition of finished: every box in PROGRESS.md is either checked or `PENDING-HUMAN`,
the final gates are green, and your last message lists (a) all PENDING-HUMAN items,
(b) all DECISIONS entries you added, (c) the commit count per milestone.

Begin with M0-T1.
