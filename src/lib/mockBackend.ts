// Browser mock backend — activates when the frontend runs outside Tauri (plain
// `vite dev`, so `window.__TAURI_INTERNALS__` is absent). It lets the gstack
// /qa headless browser drive the whole UI at http://localhost:1420 with
// deterministic, interactive data.
//
// This mock is intentionally faithful to the backend CONTRACT so /qa exercises
// the app's *logic*, not just the initial render:
//   - per-workspace boards (a github workspace and a local-only one);
//   - the event-driven path (invoke → state → evt:* → store), so optimistic UI
//     is confirmed by events the way the real Rust/SQLite backend does it;
//   - a sync state machine (syncing → idle), board updates from a simulated
//     "remote", local-only sync notifications, and terminal started/completed
//     alerts that drive the working-comet / badge / ledger logic;
//   - a terminal channel that echoes keystrokes so the xterm write path runs.
//
// ponytail: in-memory only, resets on reload — QA fixtures don't need to
// persist. Real persistence/PTY live in the Rust backend; this never runs there.

import type {
  BoardColumn,
  Card,
  CardDetail,
  GbrainHealth,
  GbrainHit,
  GbrainIdentity,
  GbrainLiveness,
  GbrainPage,
  GbrainSource,
  GbrainStatus,
  SkillInfo,
  Workspace,
} from "./ipc";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const NOW = "2026-06-14T12:00:00Z";

// ---- event bus ----
// ipc.ts wraps each subscribe as `listen(event, (ev) => cb(ev.payload))`, so the
// registered handler expects an object with a `.payload`. emit() mirrors Tauri.
type Listener = (ev: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();

export function mockListen<T>(
  event: string,
  handler: (ev: { payload: T }) => void,
): Promise<() => void> {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler as Listener);
  return Promise.resolve(() => set!.delete(handler as Listener));
}

function emit(event: string, payload: unknown): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const h of set) h({ payload });
}

const later = (fn: () => void, ms: number) =>
  (globalThis.setTimeout as typeof setTimeout)(fn, ms);

// ---- seed state (mutable, per workspace) ----
const WS_GH = "ws-mock"; // github-backed
const WS_LOCAL = "ws-mock-2"; // local only

const workspaces: Workspace[] = [
  {
    id: WS_GH,
    name: "ade",
    slug: "ade",
    root_path: "/Users/mk/dev/ade",
    github_owner: "MatheusKlauck",
    github_repo: "ade",
    startup_command: "claude",
    created_at: NOW,
  },
  {
    id: WS_LOCAL,
    name: "gstack",
    slug: "gstack",
    root_path: "/Users/mk/dev/gstack",
    github_owner: null,
    github_repo: null,
    startup_command: null,
    created_at: NOW,
  },
];

interface Board {
  columns: BoardColumn[];
  cards: Card[];
}

const COL_NAMES = ["Backlog", "Doing", "Paused", "PR", "Done"];
const boards = new Map<string, Board>();
// Per-session workspace_setting store (key: `${workspaceId}:${key}`) so the
// Gestor settings tab round-trips in browser/QA mode.
const mockSettings = new Map<string, string>();

let seq = 0;
function mkCard(
  wsId: string,
  columnId: string,
  title: string,
  extra: Partial<Card> = {},
): Card {
  seq += 1;
  return {
    id: `card-${seq}`,
    workspace_id: wsId,
    column_id: columnId,
    title,
    body_preview: extra.body_preview ?? `Preview for ${title}.`,
    position: seq,
    source: extra.source ?? "local",
    github_issue_number: extra.github_issue_number ?? null,
    github_state: extra.github_state ?? null,
    assignee: extra.assignee ?? null,
    labels_json: extra.labels_json ?? null,
    remote_updated_at: extra.remote_updated_at ?? null,
    terminal_window_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

function columnsFor(wsId: string): BoardColumn[] {
  return COL_NAMES.map((name, i) => ({
    id: `${wsId}-col-${i}`,
    workspace_id: wsId,
    name,
    position: i,
  }));
}

function colId(wsId: string, name: string): string {
  return `${wsId}-col-${COL_NAMES.indexOf(name)}`;
}

// ade (github): ~15 cards, 12 in Backlog to exercise pagination.
{
  const cols = columnsFor(WS_GH);
  const cards: Card[] = [
    ...Array.from({ length: 12 }, (_, i) =>
      mkCard(WS_GH, colId(WS_GH, "Backlog"), `Backlog task #${i + 1}`, {
        source: i % 2 === 0 ? "github" : "local",
        github_issue_number: i % 2 === 0 ? 100 + i : null,
        github_state: i % 2 === 0 ? "open" : null,
        labels_json: i % 3 === 0 ? JSON.stringify(["bug", "p1"]) : null,
      }),
    ),
    mkCard(WS_GH, colId(WS_GH, "Doing"), "Wire mock IPC for QA", {
      source: "github",
      github_issue_number: 42,
      github_state: "open",
      assignee: "MatheusKlauck",
      labels_json: JSON.stringify(["enhancement"]),
    }),
    mkCard(WS_GH, colId(WS_GH, "Paused"), "Paused: flaky sync test"),
    mkCard(WS_GH, colId(WS_GH, "PR"), "PR: terminal order fix", {
      source: "github",
      github_issue_number: 7,
      github_state: "open",
    }),
    mkCard(WS_GH, colId(WS_GH, "Done"), "Done: per-state brain panel", {
      github_state: "closed",
    }),
  ];
  boards.set(WS_GH, { columns: cols, cards });
}

// gstack (local only): distinct, smaller board, no github issue numbers — so /qa
// can verify workspace isolation (closes the spirit of the board_get caveat).
{
  const cols = columnsFor(WS_LOCAL);
  const cards: Card[] = [
    mkCard(WS_LOCAL, colId(WS_LOCAL, "Backlog"), "Configurar CI local"),
    mkCard(WS_LOCAL, colId(WS_LOCAL, "Backlog"), "Escrever testes do parser"),
    mkCard(WS_LOCAL, colId(WS_LOCAL, "Doing"), "Refatorar store de ledger"),
    mkCard(WS_LOCAL, colId(WS_LOCAL, "Done"), "Setup inicial do repo"),
  ];
  boards.set(WS_LOCAL, { columns: cols, cards });
}

function boardOf(wsId: string): Board {
  return boards.get(wsId) ?? { columns: columnsFor(wsId), cards: [] };
}

function snapshot(wsId: string) {
  const b = boardOf(wsId);
  return { columns: b.columns, cards: [...b.cards] };
}

function emitBoard(wsId: string) {
  const b = boardOf(wsId);
  emit("evt:board", {
    workspace_id: wsId,
    columns: b.columns,
    cards: b.cards,
  });
}

function findCard(
  cardId: string,
): { wsId: string; board: Board; card: Card } | null {
  for (const [wsId, board] of boards) {
    const card = board.cards.find((c) => c.id === cardId);
    if (card) return { wsId, board, card };
  }
  return null;
}

// ---- terminal channels (for keystroke echo) ----
const channels = new Map<string, MockChannel<unknown>>();
const enc = (s: string) => new TextEncoder().encode(s).buffer;

// ---- mock invoke ----
export function mockInvoke<T = unknown>(cmd: string, args?: any): Promise<T> {
  const a = args ?? {};
  const ok = <V>(v: V) => Promise.resolve(v as unknown as T);

  switch (cmd) {
    // ---- reads ----
    case "workspace_list":
      return ok(workspaces);
    case "board_get":
      return ok(snapshot(a.workspaceId));
    case "skills_list":
      return ok(MOCK_SKILLS);
    // ---- gestor (#56): representative data so the panel's populated states
    // (proposals, feed rows, tasks) are exercisable in browser QA ----
    case "gestor_tasks_list":
      return ok(MOCK_GESTOR_TASKS);
    case "gestor_feed_list":
      return ok(MOCK_GESTOR_FEED);
    case "gestor_plan":
      return ok(MOCK_GESTOR_PROPOSALS);
    case "proposal_approve":
      return ok((a.proposalIds as string[]) ?? []);
    case "gestor_enqueue_card":
      return ok("mock-task");
    case "gestor_release_notes":
      return ok("_No changes since the last tag._");
    case "setting_get":
      return ok(mockSettings.get(`${a.workspaceId}:${a.key}`) ?? null);
    case "ui_state_get":
      return ok(null);
    case "card_detail": {
      const found = findCard(a.cardId);
      const card = found?.card ?? boardOf(WS_GH).cards[0];
      const detail: CardDetail = {
        card,
        body: `# ${card.title}\n\nMock issue body for QA.`,
        comments: card.github_issue_number
          ? [
              {
                id: 1,
                user_login: "MatheusKlauck",
                user_avatar_url: null,
                body: "Looks good to me.",
                created_at: NOW,
                updated_at: NOW,
              },
            ]
          : [],
        labels: card.labels_json
          ? (JSON.parse(card.labels_json) as string[]).map((name) => ({
              name,
              color: "3b82f6",
            }))
          : [],
        assignee_avatar_url: null,
      };
      return ok(detail);
    }

    // ---- board mutations (return entity AND emit evt:board) ----
    case "card_create": {
      const card = mkCard(a.workspaceId, a.columnId, a.title);
      boardOf(a.workspaceId).cards.push(card);
      emitBoard(a.workspaceId);
      return ok(card);
    }
    case "card_update": {
      const found = findCard(a.cardId);
      if (found) {
        if (a.title != null) found.card.title = a.title;
        if (a.bodyPreview != null) found.card.body_preview = a.bodyPreview;
        emitBoard(found.wsId);
      }
      return ok(found?.card ?? boardOf(WS_GH).cards[0]);
    }
    case "card_update_github": {
      const found = findCard(a.cardId);
      if (found && a.title != null) {
        found.card.title = a.title;
        emitBoard(found.wsId);
      }
      return ok(found?.card ?? boardOf(WS_GH).cards[0]);
    }
    case "card_promote": {
      const found = findCard(a.cardId);
      const card = found?.card ?? boardOf(WS_GH).cards[0];
      card.source = "github";
      card.github_issue_number = card.github_issue_number ?? 900 + seq;
      card.github_state = "open";
      if (found) emitBoard(found.wsId);
      return ok(card);
    }
    case "card_move": {
      const found = findCard(a.cardId);
      if (found) {
        found.card.column_id = a.toColumnId;
        emitBoard(found.wsId);
      }
      return ok(found?.card ?? boardOf(WS_GH).cards[0]);
    }
    case "card_delete": {
      const found = findCard(a.cardId);
      if (found) {
        const i = found.board.cards.indexOf(found.card);
        if (i >= 0) found.board.cards.splice(i, 1);
        emitBoard(found.wsId);
      }
      return ok(undefined);
    }

    // ---- sync state machine ----
    case "sync_now": {
      const wsId = a.workspaceId;
      emit("evt:sync", { workspace_id: wsId, status: "syncing" });
      later(() => {
        const ws = workspaces.find((w) => w.id === wsId);
        emit("evt:sync", {
          workspace_id: wsId,
          status: "idle",
          last_sync: new Date().toISOString(),
        });
        if (ws && ws.github_owner) {
          // Simulate a remote change so subscribeBoard → setBoard logic runs and
          // the Backlog count ticks up — visible proof the board reacts to events.
          const b = boardOf(wsId);
          const n = 200 + seq;
          b.cards.push(
            mkCard(wsId, colId(wsId, "Backlog"), `Synced issue #${n}`, {
              source: "github",
              github_issue_number: n,
              github_state: "open",
            }),
          );
          emitBoard(wsId);
          // Reachable notification path: a github sync surfaces a notice in the
          // bell so /qa can exercise the notify → toast → history logic.
          emit("evt:notify", {
            level: "warn",
            code: "ISSUE_LIST_LARGE",
            message: `Sincronizado: +1 issue (${b.cards.length} cards no board).`,
          });
        } else {
          // Local-only workspace: nothing to sync — exercise the notify path.
          emit("evt:notify", {
            level: "warn",
            code: "REMOTE_NOT_GITHUB",
            message: "Workspace local: nada para sincronizar.",
          });
        }
      }, 700);
      return ok(undefined);
    }

    // ---- terminal ----
    case "terminal_open": {
      const wsId = a.workspaceId;
      const windowId = a.windowId ?? `win-${++seq}`;
      const paneId = `pane-${++seq}`;
      const channel = a.channel as MockChannel<unknown> | undefined;
      if (channel) {
        channels.set(paneId, channel);
        channel.push(
          enc(
            "\x1b[2m[mock terminal — QA mode] digite e veja o eco. Sem PTY real.\x1b[0m\r\n$ ",
          ),
        );
      }
      // Drive the working-comet → completion logic on the tab/workspace.
      later(
        () =>
          emit("evt:terminal-alert", {
            workspace_id: wsId,
            window_id: windowId,
            kind: "started",
            detail: "",
          }),
        200,
      );
      later(
        () =>
          emit("evt:terminal-alert", {
            workspace_id: wsId,
            window_id: windowId,
            kind: "completed",
            detail: "0",
          }),
        1800,
      );
      return ok({ pane_id: paneId, window_id: windowId });
    }
    case "terminal_write": {
      const ch = channels.get(a.paneId);
      if (ch) ch.push(enc(a.data)); // echo keystrokes so the xterm write path runs
      return ok(undefined);
    }
    case "terminal_close": {
      channels.delete(a.paneId);
      return ok(undefined);
    }

    // ---- gbrain ----
    case "gbrain_status":
      return ok({
        healthy: true,
        pages: 128,
        chunks: 540,
        staleness: "fresh",
        last_sync_at: NOW,
        embedding_coverage_pct: 0,
        unacknowledged_failures: 0,
        source_count: 2,
      } as GbrainStatus);
    case "gbrain_identity":
      return ok({
        version: "0.9.0",
        engine: "pglite",
        pages: 128,
        chunks: 540,
        update_available: false,
      } as GbrainIdentity);
    case "gbrain_liveness":
      return ok({
        reachable: true,
        status: "ok",
        version: "0.9.0",
        engine: "pglite",
      } as GbrainLiveness);
    case "gbrain_health":
      return ok({
        brain_score: 0.86,
        page_count: 128,
        embed_coverage: 0,
        stale_pages: 3,
        orphan_pages: 1,
        missing_embeddings: 128,
        dead_links: 0,
      } as GbrainHealth);
    case "gbrain_sources":
      return ok([
        {
          id: "gstack-code-ade",
          sync_enabled: true,
          staleness: "fresh",
          staleness_hours: 0,
          last_sync_at: NOW,
          pages: 96,
          chunks: 400,
          embedding_coverage_pct: 0,
        },
        {
          id: "gstack-brain-mk",
          sync_enabled: true,
          staleness: "aging",
          staleness_hours: 30,
          last_sync_at: NOW,
          pages: 32,
          chunks: 140,
          embedding_coverage_pct: 0,
        },
      ] as GbrainSource[]);
    case "gbrain_recent_pages":
      return ok([
        {
          slug: "ade-overview",
          title: "ADE overview",
          kind: "doc",
          updated_at: NOW,
        },
        {
          slug: "qa-strategy",
          title: "QA strategy",
          kind: "doc",
          updated_at: NOW,
        },
      ] as GbrainPage[]);
    case "gbrain_query":
      return ok([
        {
          slug: "qa-strategy",
          title: "QA strategy",
          snippet: `Match for "${a.q}" — mock result.`,
          source: "gstack-code-ade",
          score: 0.91,
        },
      ] as GbrainHit[]);
    case "gbrain_sync":
      return ok("job-mock-1");

    case "github_set_token":
      return ok({ login: "MatheusKlauck" });
    case "workspace_create":
      return ok(workspaces[0]);

    case "setting_set":
      mockSettings.set(`${a.workspaceId}:${a.key}`, a.value as string);
      return ok(undefined);

    // ---- fire-and-forget writes / no-ops ----
    case "ui_state_set":
    case "terminal_resize":
    case "terminal_kill_window":
    case "workspace_close":
    case "gbrain_restart":
      return ok(undefined);

    default:
      // Unknown command: resolve undefined rather than reject, so an unmocked
      // call degrades to a no-op instead of crashing the QA session.
      return ok(undefined);
  }
}

const MOCK_GESTOR_PROPOSALS = [
  {
    id: "prop-1",
    job_id: "job-1",
    workspace_id: "ws-mock",
    ord: 0,
    title: "Add the Gestor config view to the top bar",
    body: "New surface in App.tsx + store/settings.ts.",
    labels_json: '["ui"]',
    depends_on_json: "[]",
    acceptance_json: '["renders in the top bar","persists toggle"]',
    priority: "high",
    status: "proposed",
    card_id: null,
  },
  {
    id: "prop-2",
    job_id: "job-1",
    workspace_id: "ws-mock",
    ord: 1,
    title: "Wire the settings store",
    body: "settings.ts read/write of gestor_enabled.",
    labels_json: "[]",
    depends_on_json: "[0]",
    acceptance_json: '["round-trips through the DB"]',
    priority: "medium",
    status: "proposed",
    card_id: null,
  },
];

const MOCK_GESTOR_TASKS = [
  {
    id: "task-1",
    workspace_id: "ws-mock",
    card_id: "card-1",
    state: "working",
    attempt: 2,
    max_attempts: 3,
    branch: "issue-42",
    fail_reason: null,
    created_at: "2026-06-15T20:00:00Z",
    updated_at: "2026-06-15T20:05:00Z",
  },
  {
    id: "task-2",
    workspace_id: "ws-mock",
    card_id: "card-2",
    state: "verifying",
    attempt: 1,
    max_attempts: 3,
    branch: "issue-43",
    fail_reason: null,
    created_at: "2026-06-15T20:01:00Z",
    updated_at: "2026-06-15T20:06:00Z",
  },
];

const MOCK_GESTOR_FEED = [
  {
    id: 3,
    workspace_id: "ws-mock",
    task_id: "task-1",
    job_id: null,
    ts: "2026-06-15T20:06:00Z",
    kind: "task_transition",
    level: "info",
    payload_json: '{"from":"working","to":"verifying"}',
    cost_usd: null,
    num_turns: null,
    duration_ms: null,
  },
  {
    id: 2,
    workspace_id: "ws-mock",
    task_id: "task-2",
    job_id: "job-2",
    ts: "2026-06-15T20:05:30Z",
    kind: "job_done",
    level: "info",
    payload_json: '{"verdict":"approve"}',
    cost_usd: 0.042,
    num_turns: 5,
    duration_ms: 1234,
  },
  {
    id: 1,
    workspace_id: "ws-mock",
    task_id: "task-1",
    job_id: null,
    ts: "2026-06-15T20:01:00Z",
    kind: "job_failed",
    level: "error",
    payload_json: '{"error":"schema validation failed"}',
    cost_usd: null,
    num_turns: null,
    duration_ms: null,
  },
];

const MOCK_SKILLS: SkillInfo[] = [
  {
    name: "qa",
    description: "Systematically QA test a web app and fix bugs.",
    category: "Review",
  },
  { name: "review", description: "Pre-landing PR review.", category: "Review" },
  {
    name: "spec",
    description: "Turn vague intent into an executable spec.",
    category: "Plan",
  },
  {
    name: "impeccable",
    description: "Improve a frontend interface.",
    category: "Design",
  },
];

// ---- mock terminal channel ----
// Mirrors @tauri-apps/api Channel's surface that the app uses: an `onmessage`
// setter receiving ArrayBuffer chunks. Buffers messages pushed before the
// consumer (TerminalPane) assigns onmessage, then flushes on assignment — so
// the open banner isn't lost to a render-order race.
export class MockChannel<T = unknown> {
  private handler: ((m: T) => void) | null = null;
  private buffer: T[] = [];

  set onmessage(fn: (m: T) => void) {
    this.handler = fn;
    if (fn) {
      for (const m of this.buffer) fn(m);
      this.buffer = [];
    }
  }
  get onmessage(): (m: T) => void {
    return this.handler ?? (() => {});
  }

  push(m: T): void {
    if (this.handler) this.handler(m);
    else this.buffer.push(m);
  }
}
