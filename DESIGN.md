---
name: ADE
description: Terminal-native, dark-first workspace where the board, terminals, and GitHub state stay legible at a glance.
colors:
  bg-base: "#14122b"
  surface-raised: "#241d40"
  surface-panel: "#1b1633"
  surface-input: "#221c3a"
  ink: "#d6d2e2"
  ink-muted: "#a39cba"
  border: "#3a2f55"
  border-input: "#463a66"
  accent: "#f02fc2"
  accent-cyan: "#2fdce4"
  on-accent: "#ffffff"
  accent-ink: "#1a1a1a"
  source-github: "#a371f7"
  source-local: "#8b949e"
  status-error: "#e74c3c"
  status-error-deep: "#c0392b"
  status-info: "#0e7c8a"
  status-warning: "#f39c12"
  status-success: "#3fe07a"
  focus-ring: "#f02fc2"
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
    textColor: "{colors.accent-ink}"
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
Material / Google** look the UI was born in and has now left behind (Roboto, the retired
Google-blue `#4a9eff`, flat uniform shadows). The accent has since evolved to a deliberate
brand magenta (`#f02fc2`) on a deep indigo base; that move is done, not pending. Density is
welcome; clutter is the enemy.

**Key Characteristics:**
- Dark-first; one calm surface, layered tonally rather than with shadows.
- A single reserved accent (brand magenta) — action, current selection, and state only,
  never decoration.
- Monospace for identifiers and data; system sans for labels and prose.
- Every state has a legible, redundant signal (color + icon/shape/label).
- Tight, consistent radii (4px) and an 8px-based spacing rhythm.
- Motion that reports state *and keeps the surface alive*: live work breathes (pulsing
  status dots), things that appear announce themselves (overshoot + accent-glow entrances),
  the board lifts under your hand (drag-lift, breathing drop zones), and the app arrives on
  cold start (a one-shot staggered shell cascade). Energy is reserved for where work actually
  is — idle surfaces stay still.

## 2. Colors

A deep indigo→plum neutral base, tinted toward the magenta brand hue, carrying one magenta
accent and two semantic source hues; everything else is a tinted near-black grayscale. Values
below are the **dark theme** (canonical). The light theme mirrors each surface at inverted
lightness, but the brand hues (accent, cyan) hold their value across both themes — the
surfaces invert, the brand does not.

### Primary
- **Signal Magenta** (`#f02fc2`): The one action accent. Primary buttons, active tab
  underline, current selection, the sync spinner, and the focus-ring family
  (`focus-ring` is the same magenta). Reserved for action and state — it should never appear
  as decoration. Holds at `#f02fc2` in both themes. *(This is the brand hue from the app icon;
  it replaced the retired Google-blue `#4a9eff` — see Overview and Don'ts.)*
  - **Accent-Ink** (`#1a1a1a` static fallback): the text color *on* the magenta button,
    auto-computed at runtime (`contrastingTextColor`, App.tsx) so it stays legible for any
    user-chosen accent. Saturated chips/status keep white text via **On-Accent** (`#ffffff`).
- **Data Cyan** (`#2fdce4`): The brand's second hue, from the icon's cyan "data" mark.
  Reserved narrowly for live/in-progress data signaling (sync, in-flight state) — the only
  sanctioned non-magenta brand color, and still never decoration. *Light theme:* a deepened
  `#0c7a86`.

### Secondary — Source identity
- **Linked Violet** (`#a371f7`): Marks a card mirrored from a GitHub issue (badge, the
  `owner/repo` tag in tabs). Borrowed from GitHub's own palette so the association reads
  instantly; lightened on the dark base so the 10–11px tags clear WCAG AA (≈5.6:1).
  *Light theme:* a denser `#6639ba`.
- **Local Slate** (`#8b949e`): Marks a local-only card (badge, `local` tag). Deliberately
  muted so linked cards read as the "promoted" state. *Light theme:* `#57606a`.

### Neutral — the surface stack
Depth is built from four indigo-plum layers (no shadow), each tinted toward the magenta brand
hue. Listed darkest → lightest; depth comes from going *lighter*, not from shadow:
- **Base** (`#14122b`): The app background, behind everything — the darkest surface.
- **Panel** (`#1b1633`): Cards, the active tab, modals, terminal chrome.
- **Input** (`#221c3a`): Field fills and ghost-button rest state.
- **Raised** (`#241d40`): Kanban columns and grouped regions that lift off the base — the
  lightest surface.
- **Ink** (`#d6d2e2`): Primary text. **Ink-Muted** (`#a39cba`): labels, metadata,
  secondary text.
- **Border** (`#3a2f55`) / **Border-Input** (`#463a66`): hairline dividers and field strokes.

### Tertiary — semantic status
- **Error** (`#e74c3c`) / **Error-Deep** (`#c0392b`): sync failures, validation, the error
  toast fill.
- **Info** (`#0e7c8a`): the info toast fill (a deep teal, distinct from Data Cyan).
- **Warning** (`#f39c12`): degraded / attention states (tmux missing, dirty worktree).
- **Success** (`#3fe07a`): confirmed/healthy state. *Light theme:* a denser `#107a39`.
- **Focus Ring** (`#f02fc2`): the terminal-pane focus indicator — the brand magenta.

### Named Rules
**The One Accent Rule.** Signal Magenta carries action and state, nothing else. If you reach
for it to "add color," stop — the answer is hierarchy or a neutral, not more magenta. Data
Cyan is the lone exception, and only for live/in-progress data — never for emphasis.

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
- **Focus ring:** a brief magenta (`focus-ring` `#f02fc2`) glow announces a terminal pane that
  was just focused or auto-launched (see Components).

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
- **Primary:** Signal-Magenta fill, auto-contrasting Accent-Ink text, no border, `6px 16px`
  padding. The single affirmative action per surface.
- **Ghost / Secondary:** Input-fill or transparent with a 1px Border-Input stroke, Ink or
  Ink-Muted text. Close, Replace, the `+` add-workspace, settings gear.
- **Hover / Focus:** hover lifts the fill via `brightness(1.08)` over ~180ms (active dims to
  `0.94`); `:focus-visible` shows a 2px magenta (`focus-ring`) ring at `2px` offset. Defined
  globally in `styles.css` so every button inherits the set.
- **Disabled:** Input fill, Ink-Muted text, `not-allowed` cursor, 0.5 opacity.

### Cards (Kanban)
- **Corner / Padding:** 4px radius, `8px 12px` padding, 8px vertical gap between cards.
- **Background:** Panel (`#1b1633`) at rest; **drag** = one step lighter; **drop-target** =
  an accent-tinted fill (`drop-target`: Signal Magenta at ~12% over the surface via
  `color-mix`), *not* a hardcoded light blue.
- **Source badge:** a pill (10px radius, 10px micro text) — Linked Violet `#123` for GitHub
  cards, Local Slate `local` for local cards. Issue number set in the badge.
- **Assignee:** two-letter initials, 11px Ink-Muted, below the title.

### Columns
- **Background:** Raised (`#241d40`) — the lightest tonal step above the base, never a light gray.
- **Header:** 14px/600 column name; drop-over tints the column with accent-at-low-alpha.
- **Width:** 260–320px; horizontal scroll when columns overflow.

### Inputs / Fields
- **Style:** Input fill, 1px Border-Input stroke, 4px radius, `8px 12px`, 13px text.
- **Focus:** a magenta (`accent`) border plus a soft `3px` magenta ring (`color-mix` at 25%)
  on `:focus-visible`, defined globally in `styles.css`.
- **Mono fields:** token/identifier inputs use the mono face.

### Navigation (Workspace Tabs)
- **Style:** a top tab bar over the base; active tab = Panel fill + 2px magenta (`accent`)
  bottom border + Ink/600 text; inactive = transparent + Ink-Muted/400. Each tab shows the
  `owner/repo` (Linked Violet) or `local` (Local Slate) tag and a live SyncIndicator.

### Signature: SyncIndicator
The clearest expression of "state is never a guess." Three states, each color **plus** an
icon and label so it survives color-blindness and grayscale:
- **Syncing:** magenta (`accent`) spinner + "Syncing…".
- **Idle:** "✓ Synced {relative time}" in muted ink.
- **Error:** "⚠ Sync error" in Error red, with a tooltip.

### Signature: Terminal pane focus glow
When a pane is focused or auto-launched from a card moving to Doing, its border animates a
1s magenta (`focus-ring`) glow → border, then settles. Provide a reduced-motion fallback
(instant border, no glow).

### Signature: Live-state pulse
The resting heartbeat of the board and ledger. Any status dot that means *something is
happening right now* breathes a soft glow ring in its own hue (`--pulse-color`), so a dense
field of issues reads as alive at a glance instead of a grid of dead dots. Two intensities,
both defined in `styles.css` and both killed by the global `prefers-reduced-motion` rule:
- **`.ade-pulse`** — calm, ~2s: a terminal running, an agent mid-flight (working / verifying).
- **`.ade-pulse-attn`** — urgent, ~1.1s, with a scale beat: input needed, a failed run. It
  demands the eye, matching the redundant color + label the dot already carries.
The pulse colours the dot's *own* hue, never adds magenta — it amplifies the existing state
signal, it doesn't introduce a new one. A dot at rest (queued, paused, done) does not pulse.

## 6. Do's and Don'ts

### Do:
- **Do** keep the surface flat at rest and build depth with the tonal stack
  (base `#14122b` → panel `#1b1633` → input `#221c3a` → raised `#241d40`).
- **Do** reserve Signal-Magenta for action, current selection, and state. Decoration uses
  neutrals or hierarchy. Data Cyan is allowed only for live/in-progress data.
- **Do** set every identifier, issue number, branch, token, and command in the mono face.
- **Do** give every state a redundant signal: color **and** an icon, shape, or label
  (the SyncIndicator is the model).
- **Do** route every color through a theme token so both dark and light themes stay correct.
- **Do** define hover, focus-visible, active, disabled, and loading for every interactive
  component — and a `prefers-reduced-motion` alternative for every animation.
- **Do** keep state transitions in the 150–250ms range. Lifecycle moments earn longer: ~320ms
  for entrances (cards/panes appearing), ~460ms for the one-shot shell arrival. Continuous
  pulses (live-state) run 1–2s loops. Motion reports state and energizes live work; idle
  surfaces still stay still.

### Don't:
- **Don't** hardcode light grays for Kanban columns/cards (`#f5f5f5`, `#f0f6ff`, `#d0e8ff`,
  `#e8e8e8`, `#666`). They ignore the theme and break dark mode — the single biggest defect
  to fix. Use `surface-raised`, `surface-panel`, and accent-at-low-alpha tokens.
- **Don't** drift toward the **generic SaaS dashboard**: no gradient hero-metrics, no
  identical rounded card grids as decoration, no decorative purple-blue.
- **Don't** build **cluttered IDE chrome**: no toolbar overload, no panel-in-panel nesting,
  no control shown "just in case."
- **Don't** lean on the **flat Material / Google** look, and don't reintroduce the retired
  Google-blue `#4a9eff` (Roboto, uniform shadows). The accent is now a deliberate brand
  magenta `#f02fc2` on a deep indigo base — that evolution is complete; keep it.
- **Don't** play **terminal costume**: no neon/matrix green, no glitch, no fake-CRT scanlines.
  Terminal-native here is real density and mono, not theatrics.
- **Don't** add box-shadows to resting surfaces, or `outline: none` without a visible
  focus replacement.
- **Don't** invent a third source-identity hue; card state is local-vs-linked, full stop.
- **Don't** use arbitrary z-index values (`9999`, `10000`); use a named scale
  (dropdown → sticky → modal-scrim → modal → toast → tooltip).
