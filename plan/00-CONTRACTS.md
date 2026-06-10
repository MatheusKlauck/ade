# ADE — CONTRACTS (single source of truth)

Everything here is **normative**. Tasks reference sections by number (e.g., "CONTRACTS §7").
Changing anything in this file requires a `plan/DECISIONS.md` entry in the same commit.

---

## §1. Dependencies (frozen at M0)

Added once in M0-T2 with `cargo add` / `npm install`, then **frozen by committing
`Cargo.lock` and `package-lock.json`**. Never upgraded afterwards.

**Rust (src-tauri/Cargo.toml):**
`tauri` (v2, features: default), `tauri-plugin-dialog` (v2), `portable-pty`, `tokio`
(features: full), `sqlx` (features: runtime-tokio, sqlite, migrate, chrono), `octocrab`,
`git2`, `keyring`, `serde` + `serde_json`, `toml`, `thiserror`, `chrono` (serde),
`uuid` (v4, serde). **dev-deps:** `wiremock`, `tempfile`.

**Frontend (package.json):**
`react`, `react-dom`, `typescript`, `vite`, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`,
`@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`,
`@atlaskit/pragmatic-drag-and-drop`, `zustand`. **dev:** `vitest`.

No other dependency is permitted.

## §2. Repository layout

```
src-tauri/src/
  main.rs            # tauri builder, command registration, state
  error.rs           # AdeError (§6)
  db.rs              # pool init, migrations runner
  models.rs          # structs mirroring §4 tables
  notify.rs          # emit_notify() helper (§7 evt:notify)
  tmux.rs            # all tmux invocations (§8) — no tmux call exists outside this file
  pty.rs             # portable-pty spawn/read/write/resize (§10)
  gitlocal.rs        # git2: repo detection, remote parsing (§9.2), branch logic (M4)
  gh/client.rs       # HTTP wrapper over octocrab raw methods (§11)
  gh/types.rs        # RemoteIssue etc. (§5)
  sync/engine.rs     # PURE functions: reconcile(), desired_column() (§12) — no I/O here
  sync/outbox.rs     # outbox table ops + sender loop (§13)
  sync/worker.rs     # tokio poll loop + rate budget (§14)
  ipc/*.rs           # #[tauri::command] handlers, one file per domain
src-tauri/migrations/0001_init.sql   (§4, verbatim)
src/
  store/*.ts         # zustand slices (workspaces, board, terminals, notifications)
  components/*       # React components
  lib/ipc.ts         # typed invoke wrappers + event subscriptions (one place)
plan/                # this plan; PROGRESS.md, DECISIONS.md
```

## §3. Naming

- tmux base session: `ade_<workspace.slug>` · viewer session: `ade_<slug>__v<8-char-uuid>`
- git branch for issue N: `issue-<N>` · tmux window for issue N: `<N>-<slugified-title>`
- GitHub labels: `kanban:doing` (#1f883d), `kanban:paused` (#d4a72c), `kanban:pr` (#8250df)
- Board columns (fixed, in order): `Backlog`, `Doing`, `Paused`, `PR`, `Done`
- Commits: `M<x>-T<y>: <subject>`

## §4. Database schema — migration 0001_init.sql (verbatim)

```sql
CREATE TABLE workspace (
  id            TEXT PRIMARY KEY,            -- uuid v4
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  root_path     TEXT NOT NULL,
  github_owner  TEXT,                        -- NULL = local-only workspace
  github_repo   TEXT,
  startup_command TEXT,                      -- NULL = use global default
  created_at    TEXT NOT NULL                -- ISO-8601 UTC
);

CREATE TABLE board_column (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,               -- one of §3 fixed names
  position      INTEGER NOT NULL             -- 0..4
);

CREATE TABLE card (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  column_id     TEXT NOT NULL REFERENCES board_column(id),
  title         TEXT NOT NULL,
  body_preview  TEXT,
  position      REAL NOT NULL,               -- ordering within column (§15)
  source        TEXT NOT NULL CHECK (source IN ('local','github')),
  github_issue_number INTEGER,
  github_state  TEXT CHECK (github_state IN ('open','closed')),
  assignee      TEXT,
  labels_json   TEXT,                        -- JSON array of label names
  remote_updated_at TEXT,                    -- issue.updated_at from last poll
  terminal_window_id TEXT,                   -- tmux window id (e.g. "@5"), may be stale
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_card_board ON card(workspace_id, column_id, position);
CREATE UNIQUE INDEX idx_card_issue ON card(workspace_id, github_issue_number)
  WHERE github_issue_number IS NOT NULL;

CREATE TABLE outbox (
  card_id       TEXT PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
  intent        TEXT NOT NULL,               -- always 'set_column' in v1
  payload_json  TEXT NOT NULL,               -- {"from_column_name":"Backlog","to_column_name":"Doing"}
  base_remote_updated_at TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE sync_state (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  last_sync     TEXT,                        -- ISO-8601, NULL = seed not done
  list_etag     TEXT
);

CREATE TABLE setting  (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE ui_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
```

Notes: `card.position REAL` supersedes "position TEXT (fractional index)" from
PLANO-ADE-v2 §4 — see §15. **Migrations are append-only:** never edit a migration
file after it has been applied — `sqlx::migrate!` validates checksums and a modified
already-applied file fails startup with "previously applied but has been modified". A
new column ⇒ a new numbered file (`0002_*`, `0003_*`, …), never an edit to `0001`.
DB opened with `PRAGMA journal_mode=WAL;` and `PRAGMA busy_timeout=5000;` (the sync
worker and IPC handlers write concurrently; without a busy timeout SQLite's
single-writer lock surfaces as `SQLITE_BUSY`).
GitHub token goes **only** in macOS Keychain via `keyring` (service `"ade"`,
user `"github_pat"`). Never in SQLite or TOML.

## §5. Core Rust types (copy verbatim into models.rs / gh/types.rs)

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RemoteIssue {
    pub number: u64,
    pub title: String,
    pub state: String,              // "open" | "closed"
    pub updated_at: String,         // ISO-8601
    pub assignee: Option<String>,   // login
    pub labels: Vec<String>,        // names only
    pub html_url: String,
    pub is_pull_request: bool,      // true if raw JSON has "pull_request" key
    pub body_preview: Option<String>, // first 280 chars of body
}

#[derive(Debug, Clone, PartialEq)]
pub enum SyncAction {
    CreateCard { issue: RemoteIssue, column: ColumnName },
    MoveCard   { card_id: String, to: ColumnName },
    RefreshCardFields { card_id: String },   // title/labels/assignee/remote_updated_at
    TouchRemoteUpdatedAt { card_id: String }, // echo: only bump remote_updated_at
    Ignore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnName { Backlog, Doing, Paused, Pr, Done }
```

## §6. Error type (error.rs, verbatim; extend variants only via DECISIONS)

```rust
#[derive(Debug, thiserror::Error)]
pub enum AdeError {
    #[error("database error: {0}")]      Db(#[from] sqlx::Error),
    #[error("tmux error: {0}")]          Tmux(String),
    #[error("tmux not found")]           TmuxMissing,
    #[error("tmux too old: {0}")]        TmuxTooOld(String),
    #[error("pty error: {0}")]           Pty(String),
    #[error("git error: {0}")]           Git(#[from] git2::Error),
    #[error("github error: {0}")]        GitHub(String),
    #[error("token invalid or missing")] TokenInvalid,
    #[error("rate limited until {0}")]   RateLimited(String),
    #[error("keychain error: {0}")]      Keychain(String),
    #[error("io error: {0}")]            Io(#[from] std::io::Error),
    #[error("{0}")]                      Other(String),
}
impl serde::Serialize for AdeError { /* serialize as {code, message}; code from §7 table */ }
```

## §7. IPC surface — commands, events, notification codes

**Commands** (`#[tauri::command]`; args/returns are serde JSON; all return `Result<_, AdeError>`):

| Command | Args | Returns |
|---|---|---|
| `workspace_create` | `path: String` | `Workspace` (detects .git, parses remote §9.2, seeds 5 columns) |
| `workspace_list` | — | `Vec<Workspace>` |
| `board_get` | `workspace_id` | `{columns: Vec<Column>, cards: Vec<Card>}` |
| `card_create` | `workspace_id, column_id, title` | `Card` (source=local, position=append §15) |
| `card_update` | `card_id, title?, body_preview?` | `Card` |
| `card_move` | `card_id, to_column_id, before_card_id?, after_card_id?` | `Card` — **user drag only**; triggers M4 flow when target column is Doing |
| `card_delete` | `card_id` | — (deletes local card; emits `evt:board`) |
| `card_detail` | `card_id` | local: row fields; linked: fetch full issue via §11 |
| `card_promote` | `card_id` | `Card` — creates GitHub issue (§11), sets source=github. **If the card's column ≠ Backlog, also `add_label` the matching `kanban:*` label (§11) so the column is represented remotely — otherwise the next incremental poll reconciles the card to Backlog (§12 row 7)**. Synchronous, not via outbox |
| `terminal_open` | `workspace_id, window_id?` | `{pane_id, window_id}` (§8 flow) |
| `terminal_write` | `pane_id, data: String` | — |
| `terminal_resize` | `pane_id, cols, rows` | — |
| `terminal_close` | `pane_id` | — (detaches viewer; window survives) |
| `terminal_kill_window` | `workspace_id, window_id` | — |
| `github_set_token` | `token: String` | `{login}` — validates via GET /user, stores in Keychain |
| `sync_now` | `workspace_id` | — (kicks worker) |
| `setting_get` / `setting_set` | `key` / `key, value` | `Option<String>` / — |
| `ui_state_get` / `ui_state_set` | `key` / `key, value_json` | — |

**Events** (Rust → frontend via `app.emit`):

| Event | Payload |
|---|---|
| `evt:board` | `{workspace_id, cards: Vec<Card>}` — full card list of the workspace (v1 keeps it simple: no diffs) |
| `evt:sync` | `{workspace_id, status: "idle"\|"syncing"\|"error", last_sync?}` |
| `evt:notify` | `{level: "info"\|"warn"\|"error", code, message}` |
| `evt:terminal_focus` | `{workspace_id, pane_id}` |

Terminal **output** does not use events: each pane gets a dedicated
`tauri::ipc::Channel` passed in `terminal_open` (§10).

**Notification codes** (exhaustive; copy as Rust consts):
`TMUX_MISSING`, `TMUX_TOO_OLD`, `TOKEN_INVALID`, `TOKEN_SCOPE`, `RATE_LIMITED`,
`SYNC_WRITE_FAILED`, `INTENT_DROPPED`, `BRANCH_DIRTY_WORKTREE`, `BRANCH_EXISTS_REUSED`,
`ISSUE_LIST_LARGE`, `REMOTE_NOT_GITHUB`, `DB_ERROR`, `INTERNAL`.

## §8. tmux invocations (all argv arrays, all inside tmux.rs)

Version gate at startup: run `tmux -V`, parse `tmux X.Y`; require **>= 3.2**, else
`TmuxTooOld`/`TmuxMissing` notification and terminals are disabled (app still runs).

| Purpose | argv |
|---|---|
| ensure base session | `tmux has-session -t =ade_<slug>` → if fails: `tmux new-session -d -s ade_<slug> -c <root_path>` then `tmux set-option -t ade_<slug>: -w -g window-size latest` |
| new app window | `tmux new-window -t ade_<slug>: -c <root_path> -P -F #{window_id}` → stdout = window id like `@7` |
| new issue window (M4) | `tmux new-window -t ade_<slug>: -n <winname> -c <root_path> -e ISSUE_NUMBER=<n> -e ISSUE_TITLE=<title> -e ISSUE_URL=<url> -P -F #{window_id}` — title goes RAW as one argv element (it is `-e` value, never shell) |
| viewer attach (runs INSIDE the pty) | `tmux new-session -A -t ade_<slug> -s <viewer> ; select-window -t <window_id>` — pass as argv: `["tmux","new-session","-A","-t",base,"-s",viewer,";","select-window","-t",win]` |
| viewer status off | `tmux set-option -t <viewer>: status off` (separate std Command, right after spawn) |
| startup command | `tmux send-keys -t <window_id> <command> Enter` (command is user-authored = trusted; still a single argv element) |
| window alive? | `tmux list-windows -t ade_<slug>: -F #{window_id}` → contains id? |
| kill window | `tmux kill-window -t <window_id>` |
| kill viewer on pane close | `tmux kill-session -t <viewer>` |

Rules: window ids (`@N`) are the only handle persisted (`card.terminal_window_id`).
Always verify "window alive?" before focusing a stored id; if dead, clear the column and
create fresh. Startup command runs **once per new window created by the app** (not on
re-attach).

## §9. Sanitization & parsing (pure functions + mandatory test vectors)

### 9.1 `slugify(input: &str, fallback: &str) -> String`
Lowercase ASCII; every run of chars outside `[a-z0-9]` becomes a single `-`; trim leading/
trailing `-`; truncate to 40 chars (then trim `-` again); if empty → `fallback`.

| input | output |
|---|---|
| `Fix: login broken!!` | `fix-login-broken` |
| `$(rm -rf ~)` + backtick `id` backtick | `rm-rf-id` |
| `ÁÉÍ déjà vu 🚀` | `d-j-vu` |
| `""` (empty) | fallback (e.g. `card-ab12`) |
| 60 ×`a` | 40 ×`a` |

Used for: workspace slug (fallback `ws-<uuid8>`), window names (`<n>-<slug>`, fallback
`issue-<n>`), nothing else. Branch name is always literally `issue-<n>` in v1.

### 9.2 `parse_github_remote(url: &str) -> Option<(String, String)>`

| input | output |
|---|---|
| `git@github.com:o/r.git` | `("o","r")` |
| `https://github.com/o/r.git` | `("o","r")` |
| `https://github.com/o/r` | `("o","r")` |
| `ssh://git@github.com/o/r.git` | `("o","r")` |
| `https://gitlab.com/o/r.git` | `None` → notify `REMOTE_NOT_GITHUB`, workspace stays local |

## §10. PTY ↔ frontend pipeline (reference snippet — copy then adapt)

```rust
// pty.rs — one PtyPane per open pane
let pty_system = portable_pty::native_pty_system();
let pair = pty_system.openpty(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
    .map_err(|e| AdeError::Pty(e.to_string()))?;
let mut cmd = portable_pty::CommandBuilder::new("tmux");
for a in viewer_attach_args { cmd.arg(a); }            // §8 viewer attach
cmd.cwd(&root_path);
let child = pair.slave.spawn_command(cmd).map_err(|e| AdeError::Pty(e.to_string()))?;
let mut reader = pair.master.try_clone_reader().map_err(|e| AdeError::Pty(e.to_string()))?;
let writer = pair.master.take_writer().map_err(|e| AdeError::Pty(e.to_string()))?;
// reader thread: 8 KiB buffer → send raw bytes through the tauri Channel
std::thread::spawn(move || {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => { let _ = channel.send(tauri::ipc::InvokeResponseBody::Raw(buf[..n].to_vec())); }
        }
    }
});
```

`terminal_open` takes `channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>` as a
command argument (frontend constructs `new Channel()` from `@tauri-apps/api/core` and
sets `onmessage`; messages arrive as `ArrayBuffer` → `term.write(new Uint8Array(buf))`).
If `InvokeResponseBody::Raw` does not exist in the locked tauri version, the fallback is a
`Channel<String>` carrying base64 (decode with `atob` → Uint8Array) — log in DECISIONS;
**never** send `Vec<u8>` as JSON arrays.

Frontend pane: `@xterm/xterm` + try `WebglAddon` in try/catch (fallback = default canvas
renderer); `FitAddon` on container resize → `terminal_resize`; buffer incoming chunks in
an array and flush with `requestAnimationFrame` (one `term.write` per frame);
`term.onData(d => invoke("terminal_write", {paneId, data: d}))`. On unmount: dispose
WebGL addon **before** disposing the terminal, then `invoke("terminal_close")`.

## §11. GitHub API usage (all inside gh/client.rs; octocrab raw `_get`/`_post` etc.)

Base: `https://api.github.com`. Auth header from Keychain token. All requests authenticated.

| Purpose | Request |
|---|---|
| validate token | `GET /user` → 401 ⇒ `TOKEN_INVALID` |
| seed | `GET /repos/{o}/{r}/issues?state=open&per_page=100&page=N` until short page. **Skip every item whose raw JSON contains key `"pull_request"`** (the endpoint returns PRs too) |
| incremental | `GET /repos/{o}/{r}/issues?state=all&per_page=100&since=<last_sync>` (+ pagination, + same PR filter). **No `If-None-Match` here:** `since` advances every cycle, so the request URL changes and a stored ETag would never match — conditional requests buy nothing. `since` already bounds the payload to changed issues. (`sync_state.list_etag` is unused in v1; reserved.) |
| ensure labels | `POST /repos/{o}/{r}/labels` `{name,color}` for the 3 §3 labels; HTTP 422 "already_exists" ⇒ OK |
| add label | `POST /repos/{o}/{r}/issues/{n}/labels` `{labels:[name]}` |
| remove label | `DELETE /repos/{o}/{r}/issues/{n}/labels/{name}` (404 ⇒ OK, already gone) |
| close / reopen | `PATCH /repos/{o}/{r}/issues/{n}` `{state:"closed"}` / `{state:"open"}` |
| create issue (promote) | `POST /repos/{o}/{r}/issues` `{title, body}` |
| full issue + comments (detail) | `GET .../issues/{n}` + `GET .../issues/{n}/comments?per_page=30` |

`last_sync` is set to the timestamp **captured before** the request started (avoids gaps).
403/429 with `retry-after` or `x-ratelimit-remaining: 0` ⇒ raise `RateLimited(until)`.

## §12. Reconcile decision table (sync/engine.rs — PURE, fully unit-tested)

```
desired_column(issue): closed → Done
                       has label kanban:doing  → Doing
                       has label kanban:paused → Paused
                       has label kanban:pr     → Pr
                       else                    → Backlog
```

`reconcile(remote: &RemoteIssue, local: Option<&CardSnapshot>, pending: Option<&PendingIntent>) -> SyncAction`

| # | Condition (first match wins) | Action |
|---|---|---|
| 1 | `remote.is_pull_request` | `Ignore` |
| 2 | local none ∧ remote open | `CreateCard{column: desired_column(remote)}` |
| 3 | local none ∧ remote closed | `Ignore` |
| 4 | `pending.is_some()` | `Ignore` (a queued write suspends reconciliation for this card) |
| 5 | `remote.updated_at == local.remote_updated_at` | `Ignore` (nothing new) |
| 6 | `desired_column(remote) == local.column` | `RefreshCardFields` (echo of our own write, or metadata-only change: update title/labels/assignee/remote_updated_at; **never move, never trigger terminal**) |
| 7 | otherwise | `MoveCard{to: desired_column(remote)}` + refresh fields (**never triggers terminal**) |

Each row is one named unit test: `reconcile_ignores_prs`, `reconcile_creates_open_unknown`,
`reconcile_ignores_closed_unknown`, `reconcile_skips_pending_intent`,
`reconcile_noop_same_updated_at`, `reconcile_echo_refreshes_fields`,
`reconcile_applies_remote_move`.

## §13. Outbox protocol (sync/outbox.rs)

- **Enqueue** (called by `card_move` on linked cards): UPSERT by `card_id` — a newer move
  **replaces** the pending intent (never two intents per card). `base_remote_updated_at` =
  card's current `remote_updated_at`; `from_column_name` = card's column **before** this
  move (the source column).
- **Sender loop** (after each poll cycle, then on backoff timers), per pending row:
  1. Compute `desired_column(remote_now)` from the latest known issue state (the card's
     cached labels/state, refreshed by this cycle's poll). **If it equals
     `from_column_name`** ⇒ the remote has not moved the card itself; an unrelated change
     (comment, assignee, body) merely bumped `updated_at`. The intent is still valid ⇒
     **proceed to step 2**. **If it differs from `from_column_name`** ⇒ the remote moved
     the card to another column ⇒ **drop intent**, notify `INTENT_DROPPED` ("issue #N was
     moved on GitHub; your move was discarded"), reconcile card to remote state. (Remote
     wins on genuine column conflicts — only those.)
  2. Map intent to API calls: target Done ⇒ remove kanban labels + close; source column
     Done ⇒ reopen + add target label; otherwise ⇒ remove old kanban label + add new one.
     Backlog target ⇒ remove kanban labels only.
  3. Success ⇒ delete outbox row; set `card.remote_updated_at` from the PATCH/POST
     response (or re-fetch the issue if responses lack it).
  4. Failure ⇒ `attempts += 1`, store `last_error`; retry delays: `5s, 30s, 2m, 10m`.
     After the 4th failure ⇒ delete row, **revert card to remote state**, notify
     `SYNC_WRITE_FAILED`. Reverting never closes an open terminal (M4 rule).

## §14. Sync worker & rate budget (sync/worker.rs)

One tokio task per workspace with a GitHub repo; interval = `setting sync_interval_secs`
(default `30`). Each cycle: incremental fetch (§11) → run §12 per issue → apply actions in
one DB transaction → emit `evt:board` if anything changed → run outbox sender (§13) →
update `sync_state`. Seed cycle (when `last_sync IS NULL`): full `state=open` fetch; if
issue count > 500 notify `ISSUE_LIST_LARGE` once and continue.

**RateBudget** (one global instance, shared by all workspaces): a `tokio::sync::Mutex`
holding `paused_until: Option<Instant>`. Every GitHub call acquires it first; on
`RateLimited(until)` set `paused_until` and emit `evt:sync{status:"error"}` +
`RATE_LIMITED` once. Calls while paused return early without hitting the network.

## §15. Card ordering (REAL positions)

- First card in a column: `1024.0`. Append: `max(position) + 1024.0`.
- Insert between a and b: `(a + b) / 2.0`.
- If `b - a < 1e-6`: **rebalance** the whole column in the same transaction
  (ordered cards get `1024.0 * (i+1)`), then place the moved card.
- Tests: `insert_between`, `append`, `rebalance_triggers_below_epsilon`,
  `rebalance_preserves_order`.

## §16. Feature-6 trigger (auto-launch) — exact rules

Trigger lives **only** inside the `card_move` IPC handler (= user drag). The sync engine
moves cards via an internal function that **cannot** trigger it.

On user drag into `Doing`:
1. If `card.terminal_window_id` is set and the window is alive (§8) ⇒ emit
   `evt:terminal_focus` for it. Done — never duplicate.
2. Else, linked card: window name `slugify` per §9.1 (`<n>-<slug>`), env via `-e` only
   (§8 issue window); optional branch step if `setting auto_branch = "true"` (default true):
   branch `issue-<n>` exists ⇒ plain checkout + notify `BRANCH_EXISTS_REUSED`; worktree
   dirty ⇒ **skip branch entirely** + notify `BRANCH_DIRTY_WORKTREE`; else create via git2.
3. Local card: same window creation without `-e` envs and without branch step; window
   name = `slugify(title, "card-<id8>")`.
4. Run startup command (§8) in the new window; store `terminal_window_id` on the card;
   emit `evt:terminal_focus`.
5. An outbox revert (§13.4) does **not** close the window — notification only.

## §17. Frontend state contract

- `lib/ipc.ts` is the only file that calls `invoke`/`listen`. Components never import
  `@tauri-apps/api` directly.
- Zustand slices: `workspaces`, `board` (cards keyed by column), `terminals` (open panes),
  `notifications` (toast queue + history). `evt:board` **replaces** the workspace's card
  list (no merging logic in the frontend).
- Optimistic drag: move the card visually, fire `card_move`; on `AdeError` revert from the
  next `evt:board`. No retry logic in the frontend.
- Theme: CSS variables `--bg --fg --panel --accent` on `:root[data-theme="light"|"dark"]`.

## §18. Global Definition of Done (applies to every task, plus the task's own DoD)

- Gates pass (see AGENTS.md). New logic in `sync/engine.rs`, §9, §15 functions has unit
  tests. Tests needing a live tmux are `#[ignore]`-marked `[needs-tmux]`; needing Keychain:
  `[needs-keychain]`. GitHub HTTP is tested with `wiremock` fixtures — never live network
  in tests.
- Every user-visible failure path ends in `emit_notify` with a §7 code. No silent `Err` drops.
