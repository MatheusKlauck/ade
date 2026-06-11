# ADE — Implementer Rules (read this first, every session)

## Design Context

Design and UI decisions are driven by `PRODUCT.md` (project root) and `DESIGN.md` (visual
system). ADE's register is **product** (design serves the workflow). The aesthetic is
**terminal-native and dense, dark-first**, and should feel calm, crafted, and trustworthy —
explicitly *not* generic-SaaS, cluttered-IDE, or flat-Material/Google. Five design
principles guide every UI change: (1) the tool disappears, (2) state is never a guess,
(3) dense but calm, (4) native speed and feel, (5) crafted in the details. When designing,
redesigning, or polishing any surface, read `PRODUCT.md` first. The `/impeccable` skill
reads both files automatically.


You are implementing ADE, a macOS desktop app (Tauri 2 + Rust core + React/TS frontend).
The product spec is `PLANO-ADE-v2.md`. **You do not need to read it.** Everything you need
is in `plan/00-CONTRACTS.md` (the single source of truth for types, schema, IPC, commands)
and in the milestone task files `plan/M0.md` … `plan/M6.md`.

## How to work

1. Open `plan/PROGRESS.md`. Find the first unchecked task. That is your task. Do tasks
   **strictly in order**. Never start a task while a previous one is unchecked.
2. Read the task's block in its milestone file **fully** before writing code. Read the
   CONTRACTS sections it references. Do not skim.
3. Touch **only** the files listed in the task (plus their test files). If you believe
   another file must change, it may only be a mechanical consequence (e.g., `mod` line,
   import). Anything bigger → record in `plan/DECISIONS.md` and keep it minimal.
4. When the task is done, run the **gates** (below). All green → check the box in
   `plan/PROGRESS.md` → commit with message `M<x>-T<y>: <subject>`.
5. One task = one commit. Never batch tasks.

## Gates (must pass before every commit)

```
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd .. && npm run build && npm test
```

If a gate fails, fix it. Never commit red. Never weaken a gate. Never delete or `#[ignore]`
a failing test to make it pass — the only allowed `#[ignore]` tests are the ones the plan
itself marks `[needs-tmux]` or `[needs-keychain]`.

## Hard rules (violating any of these is a bug)

- **CONTRACTS wins.** If a task seems to conflict with `plan/00-CONTRACTS.md`, CONTRACTS
  is right. If CONTRACTS is genuinely impossible (e.g., a pinned API doesn't exist), make
  the **smallest** working deviation and log it in `plan/DECISIONS.md` (what, why, where).
- **No new dependencies.** Only the crates/packages listed in CONTRACTS §1. Versions are
  frozen by the lockfiles created in M0-T2; never run upgrades.
- **Never invent** event names, command names, table/column names, label names, or error
  codes. Copy them from CONTRACTS. If something you need is missing there, add it to
  CONTRACTS in the same commit + a DECISIONS entry.
- **No `unwrap()`, `expect()`, or `panic!`** outside `#[cfg(test)]`. All fallible paths
  return `AdeError` (CONTRACTS §6) and surface through the notification layer.
- **Never build shell command strings by concatenation.** All process invocations use
  argv arrays (`std::process::Command::arg`). Text coming from GitHub (titles, labels,
  bodies) is untrusted input — it never goes into a shell line, only into `-e KEY=VALUE`
  args or after the sanitizer (CONTRACTS §9).
- **No scope creep.** Every task has an "Out of scope" list. Do not implement things
  early, do not refactor neighboring code, do not add features, do not "improve" the UI
  beyond what the task says. Plain and working beats clever.
- **SQLite is the source of truth.** The frontend never owns canonical state. Every
  mutation goes `invoke → Rust validates → SQLite → event → store updates`. Optimistic UI
  is visual only and is confirmed/reverted by the event.

## When you are stuck or unsure

- **Ambiguity:** choose the simplest behavior consistent with CONTRACTS, implement it,
  and log the choice in `plan/DECISIONS.md`. Do not block, do not ask, do not guess
  something fancy.
- **Compile error with a crate API (2 failed attempts):** stop guessing. Open the docs
  for the exact version in `Cargo.lock` (docs.rs/<crate>/<version>) and adapt the snippet
  minimally. Log the adaptation in DECISIONS.
- **A test you wrote contradicts the decision table in CONTRACTS:** the table is right;
  fix the test expectation only if the table says so.

## Context budget

Per session, read at most: this file, `plan/PROGRESS.md`, the current task block, and the
CONTRACTS sections it references. Do not re-read the whole plan or the whole codebase.
Use `grep` to find symbols instead of reading entire files.
