# Product

## Register

product

## Users

A solo developer (the author) working on their own repositories on macOS. Context:
deep-focus coding sessions, usually with an editor and terminal already open. They are
orchestrating their own work — turning GitHub issues into active, terminal-backed tasks,
moving cards across a fixed Kanban, and running build/agent commands in tmux-backed panes.

The job to be done: keep a project's tasks, terminals, and GitHub state in one fast native
surface, so dragging a card to "Doing" spins up the right terminal on the right branch
without a context switch.

## Product Purpose

ADE is a native macOS *agentic development workspace* (Tauri 2 + Rust core + React/TS) that
fuses three things into one window:

- a **fixed-column Kanban** (Backlog → Doing → Paused → PR → Done) synced bidirectionally
  with GitHub issues;
- **multi-terminal panes** backed by nested tmux attach, persistent across app restarts;
- **multi-workspace** project switching (each workspace = repo + tmux session + board).

Moving a card to Doing launches a terminal on the issue's branch and runs a configurable
startup command. ADE exists to collapse the loop between *what to work on* (the board /
issues) and *where the work happens* (the terminal), without ever leaving a single fast
surface. Success: the tool disappears into the flow — board, terminals, and sync state are
always legible, and the developer never has to wonder what is happening.

## Brand Personality

Terminal-native and dense, but calm. Three words: **precise, crafted, trustworthy.**

Voice is direct and technical — labels, errors, and copy speak the developer's language
with no hand-holding and no marketing gloss. The interface feels at home next to a terminal
(monospace where data and identifiers live, keyboard-first, information-dense) yet stays
quiet: nothing competes for attention, every consequential state reads at a glance, and the
small details signal it was *built with care*, not assembled. Dark-first.

## Anti-references

- **Generic SaaS dashboard** — gradient hero-metrics, identical rounded card grids,
  purple-blue accents, decoration for its own sake. The default AI-tool look.
- **Cluttered IDE chrome** — VS Code-style panel overload, busy toolbars, every control
  fighting for the same pixel. Density is welcome; clutter is not.
- **Flat Material / Google look** — Roboto, Google-blue (`#4a9eff` / `#1a73e8` today), flat
  uniform shadows. This is roughly where the current UI sits, and the thing to move away from.
- **Neon / cyberpunk "hacker costume"** — matrix green, glitch, terminal theatrics.
  Terminal-native here means authentic developer texture, not stage dressing. (Calm +
  crafted already rules this out.)

## Design Principles

1. **The tool disappears.** Earned familiarity over novelty. Standard affordances for
   standard tasks; surprise is reserved for small moments, never for core flows.
2. **State is never a guess.** Sync status, terminal health, card source (local vs GitHub),
   branch state — every consequential state has a clear, legible signal. Nothing fails
   silently (this mirrors the product's own rule: *nada falha em silêncio*).
3. **Dense but calm.** Information density is the goal; clutter is the enemy. Rhythm,
   hierarchy, and restraint are what make density readable instead of busy.
4. **Native speed, native feel.** A desktop app, not a web page. Fast, keyboard-first,
   respectful of macOS conventions; no orchestrated page-load theater.
5. **Crafted in the details.** The gap between *functional* and *trustworthy* lives in focus
   states, empty states, transitions, and consistency. Ship the whole component, not half.

## Accessibility & Inclusion

Solid defaults (no formal audit — solo tool):

- WCAG AA text contrast (≥4.5:1 body, ≥3:1 large text), verified against **both** dark and
  light surfaces.
- Visible, consistent focus states on every interactive element.
- Full `prefers-reduced-motion` alternative for every animation (crossfade or instant).
- Fully keyboard-navigable — the tool is keyboard-first by intent.
- Dark theme is primary and most-tuned; light theme stays supported and polished.
- Status signaling (terminal health, sync state, card state) must remain distinguishable
  beyond hue alone — pair color with icon, shape, or label for color-blind safety.
