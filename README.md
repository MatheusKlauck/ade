# ADE

ADE is a native macOS agentic development workspace that fuses a fixed-column Kanban
board, multi-terminal tmux-backed panes, and bidirectional GitHub issue sync into one
fast window. Moving a card to **Doing** spins up a terminal on the issue's branch and runs
a configurable startup command, collapsing the loop between *what to work on* (the board /
issues) and *where the work happens* (the terminal) — without leaving a single surface.
It also includes the **Gestor**: a deterministic orchestration layer that coordinates AI
coding agents (Claude Code and similar) through the board's state machine.

For the design intent see `PRODUCT.md` / `DESIGN.md`, the domain vocabulary `CONTEXT.md`,
the architecture and plan `docs/PLANO-GESTOR-v1.md`, and the implementer rules `AGENTS.md`.

## Tech stack

- **Backend (core):** Rust, packaged with [Tauri 2](https://tauri.app/). SQLite is the
  source of truth; terminals run on tmux + PTY; GitHub access via a self-contained REST
  client (token in the macOS Keychain).
- **Frontend:** React 19 + TypeScript, built with Vite. Terminals render with xterm.js;
  drag-and-drop via Atlaskit Pragmatic drag-and-drop.

## Prerequisites

- macOS
- [Rust](https://rustup.rs/) (stable) and the Tauri 2 system dependencies
- Node.js + npm
- `tmux ≥ 3.2`

## Development

```sh
npm install              # install frontend deps
npm run tauri:dev        # run the desktop app (Tauri + Vite dev server)
```

`npm run dev` runs only the Vite frontend in a browser (no native shell).

## Build

```sh
npm run build            # type-check + build the frontend
npm run tauri build      # produce the macOS app bundle
```

## Test

```sh
npm test                                 # frontend (vitest)
cd src-tauri && cargo test               # backend (Rust)
```

Full pre-commit gates (see `AGENTS.md`):

```sh
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd .. && npm run build && npm test
```
