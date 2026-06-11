---
name: ADE
description: Terminal-native, dark-first workspace where the board, terminals, and GitHub state stay legible at a glance.
colors:
  bg-base: "#1a1a1a"
  surface-raised: "#222222"
  surface-panel: "#1e1e1e"
  surface-input: "#2a2a2a"
  ink: "#cccccc"
  ink-muted: "#999999"
  border: "#333333"
  border-input: "#444444"
  accent: "#4a9eff"
  on-accent: "#ffffff"
  source-github: "#8250df"
  source-local: "#6e7781"
  status-error: "#e74c3c"
  status-error-deep: "#c0392b"
  status-info: "#2980b9"
  status-warning: "#f39c12"
  focus-ring: "#3498db"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.05em"
  micro:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "6px 16px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "{colors.surface-input}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 16px"
    typography: "{typography.body}"
  button-disabled:
    backgroundColor: "{colors.surface-input}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.sm}"
    padding: "6px 16px"
  input:
    backgroundColor: "{colors.surface-input}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    typography: "{typography.body}"
  card:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  badge-github:
    backgroundColor: "{colors.source-github}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
    typography: "{typography.micro}"
  badge-local:
    backgroundColor: "{colors.source-local}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
    typography: "{typography.micro}"
  tab-active:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink}"
    padding: "8px 16px"
    typography: "{typography.body}"
  tab-inactive:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    padding: "8px 16px"
    typography: "{typography.body}"
---

# Design System: ADE

## 1. Overview

**Creative North Star: "The Control Room"**

ADE is a single dark window where a developer runs their own work: a GitHub-synced Kanban
on the bottom, terminal panes on top, one workspace per project. The system is tuned so the
operator is *always oriented*. Like a well-designed control room, every consequential
state — sync status, terminal health, whether a card is local or linked to a GitHub issue,
which branch a task lives on — is readable at a glance without hunting. Density is high, but
it never reads as busy: hairline structure, tonal layering, and a single reserved accent do
the organizing so the eye lands where it should.

It is **terminal-native and dark-first.** Monospace carries identifiers, numbers, and
anything the user would type or grep; the system sans carries labels and prose. The surface
sits comfortably beside a real terminal — not as costume (no neon, no glitch, no fake CRT)
but as genuine developer texture. The light theme is fully supported and polished, but dark
is the home and the most-tuned.

This system explicitly rejects three looks: the **generic SaaS dashboard** (gradient
hero-metrics, identical rounded card grids, decorative purple-blue), the **cluttered IDE**
(panel overload, busy toolbars, every control fighting for the same pixel), and the **flat
Material / Google** look the UI is moving away from (Roboto, Google-blue `#4a9eff`, flat
uniform shadows). Density is welcome; clutter is the enemy.

**Key Characteristics:**
- Dark-first; one calm surface, layered tonally rather than with shadows.
- A single reserved accent — action, current selection, and state only, never decoration.
- Monospace for identifiers and data; system sans for labels and prose.
- Every state has a legible, redundant signal (color + icon/shape/label).
- Tight, consistent radii (4px) and an 8px-based spacing rhythm.
- Restrained, fast motion that reports state — never choreography.

## 2. Colors

A near-black neutral base with cool blue accent and two semantic source hues; everything
else is grayscale. Values below are the **dark theme** (canonical). The light theme mirrors
each role at inverted lightness.

### Primary
- **Signal Blue** (`#4a9eff`): The one accent. Primary buttons, active tab underline,
  current selection, the syncing spinner, and the focus ring family. Reserved for action and
  state — it should never appear as decoration. *Light theme:* a denser `#1a73e8`.
  *(This is the inherited Google-blue and the top candidate to evolve toward a more
  terminal-native hue; see Don'ts.)*

### Secondary — Source identity
- **Linked Violet** (`#8250df`): Marks a card mirrored from a GitHub issue (badge, the
  `owner/repo` tag in tabs). Borrowed from GitHub's own palette so the association reads
  instantly.
- **Local Slate** (`#6e7781`): Marks a local-only card (badge, `local` tag). Deliberately
  muted so linked cards read as the "promoted" state.

### Neutral — the surface stack
Depth is built from four near-black layers, lightest sitting on top:
- **Base** (`#1a1a1a`): The app background, behind everything.
- **Raised** (`#222222`): Kanban columns and grouped regions that lift off the base.
- **Panel** (`#1e1e1e`): Cards, the active tab, modals, terminal chrome.
- **Input** (`#2a2a2a`): Field fills and ghost-button rest state.
- **Ink** (`#cccccc`): Primary text. **Ink-Muted** (`#999999`): labels, metadata,
  secondary text.
- **Border** (`#333333`) / **Border-Input** (`#444444`): hairline dividers and field strokes.

### Tertiary — semantic status
- **Error** (`#e74c3c`) / **Error-Deep** (`#c0392b`): sync failures, validation, the error
  toast fill.
- **Info** (`#2980b9`): the info toast fill.
- **Warning** (`#f39c12`): degraded / attention states (tmux missing, dirty worktree).
- **Focus Ring** (`#3498db`): the terminal-pane focus indicator.

### Named Rules
**The One Accent Rule.** Signal Blue carries action and state, nothing else. If you reach
for it to "add color," stop — the answer is hierarchy or a neutral, not more blue.

**The Two-Hue Source Rule.** Only Linked Violet and Local Slate carry meaning beyond the
neutral/accent system. Don't introduce a third identity hue; card state is a binary.

## 3. Typography

**Display / Body Font:** the native macOS system stack (`-apple-system, BlinkMacSystemFont,
"Segoe UI", Roboto, sans-serif`) — one family across headings, labels, prose, and controls.
**Mono Font:** `ui-monospace, SFMono-Regular, Menlo, …` for identifiers, issue numbers,
tokens, commands, and terminal content.

**Character:** Quiet and utilitarian. A product UI doesn't need a display/body pairing; the
system sans does the work and disappears into the OS, while monospace appears wherever the
content is something a developer would type, copy, or scan column-aligned. The contrast axis
is sans-vs-mono, not two near-identical sans faces.

### Hierarchy
- **Display** (600, 24px, lh 1.2): the largest in-app heading — empty-state and onboarding
  prompts. Rare.
- **Headline** (600, 18px): section/modal-group headers.
- **Title** (600, 16px): modal titles ("Settings"), detail-panel headers.
- **Body** (400, 13px, lh 1.5): the workhorse — card titles (500), control text, prose.
  Cap prose blocks (issue bodies, comments) at 65–75ch.
- **Label** (600, 11px, +0.05em, often UPPERCASE): toolbar eyebrows ("TERMINALS · 3"),
  field labels.
- **Micro** (500, 10px): source badges and counts only.
- **Mono** (400, 12px): issue numbers, branch names, tokens, command snippets, terminal.

### Named Rules
**The Mono-for-Machines Rule.** Anything the machine owns or the user would type —
`#123`, `issue-42`, `ghp_…`, branch names, commands — is set in mono. Anything the human
reads as language is set in the sans. Never blur the two.

## 4. Elevation

**Flat by default.** ADE conveys depth through tonal layering of near-black surfaces
(base → raised → panel → input) plus hairline borders — not drop shadows. At rest, no
surface casts a shadow. This keeps a dense, dark UI calm and avoids the "2014 app" look of
soft gray shadows on a light card.

Shadow-like treatments are reserved for two non-resting moments:
- **Modal scrim:** a `rgba(0,0,0,0.6)` overlay dims the app behind dialogs (Settings,
  Card detail).
- **Focus ring:** a brief Signal-Blue / Focus-Ring glow announces a terminal pane that was
  just focused or auto-launched (see Components).

### Named Rules
**The Flat-At-Rest Rule.** If a surface needs to feel "above" another, move it up the tonal
stack (raised/panel/input), don't add a shadow. Shadows are a response to state (focus,
overlay), never a default decoration. *Audit test:* if you see a soft gray box-shadow under a
card at rest, it's wrong.

## 5. Components

Components are **precise and restrained**: hairline borders, flat fills, tight 4px radii,
accent reserved for action and state. Quiet until you interact.

### Buttons
- **Shape:** 4px radius (`{rounded.sm}`); larger empty-state CTAs use 6px (`{rounded.md}`).
- **Primary:** Signal-Blue fill, white text, no border, `6px 16px` padding. The single
  affirmative action per surface.
- **Ghost / Secondary:** Input-fill or transparent with a 1px Border-Input stroke, Ink or
  Ink-Muted text. Close, Replace, the `+` add-workspace, settings gear.
- **Hover / Focus:** *Gap to close.* States are not yet defined. Target: hover lightens the
  fill one tonal step (or accent → a slightly brighter blue) over 150ms; focus shows a
  2px Signal-Blue ring. Ship the whole set, not just the default.
- **Disabled:** Input fill, Ink-Muted text, `not-allowed` cursor, 0.5 opacity.

### Cards (Kanban)
- **Corner / Padding:** 4px radius, `8px 12px` padding, 8px vertical gap between cards.
- **Background:** Panel (`#1e1e1e`) at rest; **drag** = one step lighter; **drop-target** =
  an accent-tinted fill (Signal Blue at ~8% over the surface), *not* a hardcoded light blue.
- **Source badge:** a pill (10px radius, 10px micro text) — Linked Violet `#123` for GitHub
  cards, Local Slate `local` for local cards. Issue number set in the badge.
- **Assignee:** two-letter initials, 11px Ink-Muted, below the title.

### Columns
- **Background:** Raised (`#222222`) — a single tonal step above the base, never a light gray.
- **Header:** 14px/600 column name; drop-over tints the column with accent-at-low-alpha.
- **Width:** 260–320px; horizontal scroll when columns overflow.

### Inputs / Fields
- **Style:** Input fill, 1px Border-Input stroke, 4px radius, `8px 12px`, 13px text.
- **Focus:** *Gap to close.* Currently `outline: none` with no replacement — fails keyboard
  accessibility. Target: a 1px Signal-Blue border + soft Signal-Blue ring on `:focus-visible`.
- **Mono fields:** token/identifier inputs use the mono face.

### Navigation (Workspace Tabs)
- **Style:** a top tab bar over the base; active tab = Panel fill + 2px Signal-Blue bottom
  border + Ink/600 text; inactive = transparent + Ink-Muted/400. Each tab shows the
  `owner/repo` (Linked Violet) or `local` (Local Slate) tag and a live SyncIndicator.

### Signature: SyncIndicator
The clearest expression of "state is never a guess." Three states, each color **plus** an
icon and label so it survives color-blindness and grayscale:
- **Syncing:** Signal-Blue spinner + "Syncing…".
- **Idle:** "✓ Synced {relative time}" in muted ink.
- **Error:** "⚠ Sync error" in Error red, with a tooltip.

### Signature: Terminal pane focus glow
When a pane is focused or auto-launched from a card moving to Doing, its border animates a
1s Signal-Blue glow → border, then settles. This is the one piece of "alive" motion; keep it
brief and provide a reduced-motion fallback (instant border, no glow).

## 6. Do's and Don'ts

### Do:
- **Do** keep the surface flat at rest and build depth with the tonal stack
  (base `#1a1a1a` → raised `#222222` → panel `#1e1e1e` → input `#2a2a2a`).
- **Do** reserve Signal-Blue for action, current selection, and state. Decoration uses
  neutrals or hierarchy.
- **Do** set every identifier, issue number, branch, token, and command in the mono face.
- **Do** give every state a redundant signal: color **and** an icon, shape, or label
  (the SyncIndicator is the model).
- **Do** route every color through a theme token so both dark and light themes stay correct.
- **Do** define hover, focus-visible, active, disabled, and loading for every interactive
  component — and a `prefers-reduced-motion` alternative for every animation.
- **Do** keep transitions in the 150–250ms range; motion reports state, it doesn't perform.

### Don't:
- **Don't** hardcode light grays for Kanban columns/cards (`#f5f5f5`, `#f0f6ff`, `#d0e8ff`,
  `#e8e8e8`, `#666`). They ignore the theme and break dark mode — the single biggest defect
  to fix. Use `surface-raised`, `surface-panel`, and accent-at-low-alpha tokens.
- **Don't** drift toward the **generic SaaS dashboard**: no gradient hero-metrics, no
  identical rounded card grids as decoration, no decorative purple-blue.
- **Don't** build **cluttered IDE chrome**: no toolbar overload, no panel-in-panel nesting,
  no control shown "just in case."
- **Don't** lean on the **flat Material / Google** look — and treat the inherited Google-blue
  `#4a9eff` as provisional; evolve the accent toward a more deliberate, terminal-native hue.
- **Don't** play **terminal costume**: no neon/matrix green, no glitch, no fake-CRT scanlines.
  Terminal-native here is real density and mono, not theatrics.
- **Don't** add box-shadows to resting surfaces, or `outline: none` without a visible
  focus replacement.
- **Don't** invent a third source-identity hue; card state is local-vs-linked, full stop.
- **Don't** use arbitrary z-index values (`9999`, `10000`); use a named scale
  (dropdown → sticky → modal-scrim → modal → toast → tooltip).
