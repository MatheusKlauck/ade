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
The current plan and design source of truth is `docs/PLANO-GESTOR-v1.md` (architecture,
data model, IPC surface, and the decision log D1–D13). The domain vocabulary lives in
`CONTEXT.md`; product/design intent in `PRODUCT.md` and `DESIGN.md`. Read only the section
relevant to your task; do not re-read the whole plan.

## How to work

1. Pick up your task from **GitHub Issues** (`gh issue list`; see
   `docs/agents/issue-tracker.md`). Work the assigned issue end to end.
2. Read the relevant section of `docs/PLANO-GESTOR-v1.md` and the matching `CONTEXT.md`
   terms **fully** before writing code. Do not skim.
3. Touch **only** the files the task needs (plus their test files). If you believe
   another file must change, it may only be a mechanical consequence (e.g., `mod` line,
   import). Anything bigger → note it on the issue and keep it minimal.
4. When the task is done, run the **gates** (below). All green → commit, referencing the
   issue (e.g. `feat: <subject> (#<n>)`).
5. One logical change = one commit. Never batch unrelated work.

## Gates (must pass before every commit)

```
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd .. && npm run build && npm test
```

If a gate fails, fix it. Never commit red. Never weaken a gate. Never delete or `#[ignore]`
a failing test to make it pass — the only allowed `#[ignore]` tests are the ones the plan
itself marks `[needs-tmux]` or `[needs-keychain]`.

## Hard rules (violating any of these is a bug)

- **The plan wins.** If a task seems to conflict with `docs/PLANO-GESTOR-v1.md` or the
  decisions D1–D13, the plan is right. If it is genuinely impossible (e.g., a pinned API
  doesn't exist), make the **smallest** working deviation and record it on the issue
  (what, why, where).
- **No new dependencies.** Only the crates/packages already in the lockfiles; never run
  upgrades (the plan adds no mandatory crate — see `docs/PLANO-GESTOR-v1.md` §10).
- **Never invent** event names, command names, table/column names, label names, or error
  codes. Copy them from `docs/PLANO-GESTOR-v1.md` (§5 schema, §6 IPC) and the terms in
  `CONTEXT.md`. If something you need is missing, propose it on the issue first.
- **No `unwrap()`, `expect()`, or `panic!`** outside `#[cfg(test)]`. All fallible paths
  return `AdeError` and surface through the notification layer.
- **Never build shell command strings by concatenation.** All process invocations use
  argv arrays (`std::process::Command::arg`). Text coming from GitHub (titles, labels,
  bodies) is untrusted input — it never goes into a shell line, only into `-e KEY=VALUE`
  args or after the sanitizer.
- **No scope creep.** Every task has an "Out of scope" list. Do not implement things
  early, do not refactor neighboring code, do not add features, do not "improve" the UI
  beyond what the task says. Plain and working beats clever.
- **SQLite is the source of truth.** The frontend never owns canonical state. Every
  mutation goes `invoke → Rust validates → SQLite → event → store updates`. Optimistic UI
  is visual only and is confirmed/reverted by the event.

## When you are stuck or unsure

- **Ambiguity:** choose the simplest behavior consistent with the plan, implement it,
  and note the choice on the issue. Do not block, do not ask, do not guess
  something fancy.
- **Compile error with a crate API (2 failed attempts):** stop guessing. Open the docs
  for the exact version in `Cargo.lock` (docs.rs/<crate>/<version>) and adapt the snippet
  minimally. Note the adaptation on the issue.
- **A test you wrote contradicts a decision table in the plan:** the table is right;
  fix the test expectation only if the table says so.

## Context budget

Per session, read at most: this file, the issue you're working, the relevant section of
`docs/PLANO-GESTOR-v1.md`, and the `CONTEXT.md` terms it references. Do not re-read the
whole plan or the whole codebase. Use `grep` to find symbols instead of reading entire
files.
