// Browser mock backend — activates when the frontend runs outside Tauri (plain
// `vite dev`, so `window.__TAURI_INTERNALS__` is absent). It lets the gstack
// /qa headless browser drive the whole UI at http://localhost:1420 with
// deterministic, interactive data: reads return seeded fixtures, writes mutate
// an in-memory board so creating/moving/deleting cards reflects on screen.
//
// ponytail: in-memory only, resets on reload — QA fixtures don't need to persist.
// Real persistence lives in the Rust/SQLite backend; this never runs there.

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

// ---- seed state (mutable) ----
const WS = "ws-mock";
const workspaces: Workspace[] = [
  {
    id: WS,
    name: "ade",
    slug: "ade",
    root_path: "/Users/mk/dev/ade",
    github_owner: "MatheusKlauck",
    github_repo: "ade",
    startup_command: "claude",
    created_at: NOW,
  },
  {
    id: "ws-mock-2",
    name: "gstack",
    slug: "gstack",
    root_path: "/Users/mk/dev/gstack",
    github_owner: null,
    github_repo: null,
    startup_command: null,
    created_at: NOW,
  },
];

const COL_NAMES = ["Backlog", "Doing", "Paused", "PR", "Done"];
const columns: BoardColumn[] = COL_NAMES.map((name, i) => ({
  id: `col-${i}`,
  workspace_id: WS,
  name,
  position: i,
}));

let seq = 0;
function mkCard(columnId: string, title: string, extra: Partial<Card> = {}): Card {
  seq += 1;
  return {
    id: `card-${seq}`,
    workspace_id: WS,
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

// ~15 cards. Backlog gets 12 so the 10/column pagination is exercised.
const cards: Card[] = [
  ...Array.from({ length: 12 }, (_, i) =>
    mkCard("col-0", `Backlog task #${i + 1}`, {
      source: i % 2 === 0 ? "github" : "local",
      github_issue_number: i % 2 === 0 ? 100 + i : null,
      github_state: i % 2 === 0 ? "open" : null,
      labels_json: i % 3 === 0 ? JSON.stringify(["bug", "p1"]) : null,
    })
  ),
  mkCard("col-1", "Wire mock IPC for QA", {
    source: "github",
    github_issue_number: 42,
    github_state: "open",
    assignee: "MatheusKlauck",
    labels_json: JSON.stringify(["enhancement"]),
  }),
  mkCard("col-2", "Paused: flaky sync test"),
  mkCard("col-3", "PR: terminal order fix", {
    source: "github",
    github_issue_number: 7,
    github_state: "open",
  }),
  mkCard("col-4", "Done: per-state brain panel", {
    github_state: "closed",
  }),
];

function boardSnapshot() {
  return { columns, cards: [...cards] };
}

// ---- mock invoke ----
export function mockInvoke<T = unknown>(cmd: string, args?: any): Promise<T> {
  const a = args ?? {};
  switch (cmd) {
    // reads
    case "workspace_list":
      return Promise.resolve(workspaces as unknown as T);
    case "board_get":
      return Promise.resolve(boardSnapshot() as unknown as T);
    case "skills_list":
      return Promise.resolve(MOCK_SKILLS as unknown as T);
    case "setting_get":
    case "ui_state_get":
      return Promise.resolve(null as unknown as T);
    case "card_detail": {
      const card = cards.find((c) => c.id === a.cardId) ?? cards[0];
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
      return Promise.resolve(detail as unknown as T);
    }

    // writes that return an entity
    case "card_create": {
      const card = mkCard(a.columnId, a.title);
      cards.push(card);
      return Promise.resolve(card as unknown as T);
    }
    case "card_update": {
      const card = cards.find((c) => c.id === a.cardId);
      if (card) {
        if (a.title != null) card.title = a.title;
        if (a.bodyPreview != null) card.body_preview = a.bodyPreview;
      }
      return Promise.resolve((card ?? cards[0]) as unknown as T);
    }
    case "card_update_github": {
      const card = cards.find((c) => c.id === a.cardId);
      if (card && a.title != null) card.title = a.title;
      return Promise.resolve((card ?? cards[0]) as unknown as T);
    }
    case "card_promote": {
      const card = cards.find((c) => c.id === a.cardId) ?? cards[0];
      card.source = "github";
      card.github_issue_number = card.github_issue_number ?? 999;
      card.github_state = "open";
      return Promise.resolve(card as unknown as T);
    }
    case "card_move": {
      const card = cards.find((c) => c.id === a.cardId);
      if (card) card.column_id = a.toColumnId;
      return Promise.resolve((card ?? cards[0]) as unknown as T);
    }
    case "card_delete": {
      const i = cards.findIndex((c) => c.id === a.cardId);
      if (i >= 0) cards.splice(i, 1);
      return Promise.resolve(undefined as unknown as T);
    }

    // terminal
    case "terminal_open":
      return Promise.resolve({
        pane_id: `pane-${++seq}`,
        window_id: a.windowId ?? `win-${seq}`,
      } as unknown as T);

    // gbrain
    case "gbrain_status":
      return Promise.resolve({
        healthy: true,
        pages: 128,
        chunks: 540,
        staleness: "fresh",
        last_sync_at: NOW,
        embedding_coverage_pct: 0,
        unacknowledged_failures: 0,
        source_count: 2,
      } as GbrainStatus as unknown as T);
    case "gbrain_identity":
      return Promise.resolve({
        version: "0.9.0",
        engine: "pglite",
        pages: 128,
        chunks: 540,
        update_available: false,
      } as GbrainIdentity as unknown as T);
    case "gbrain_liveness":
      return Promise.resolve({
        reachable: true,
        status: "ok",
        version: "0.9.0",
        engine: "pglite",
      } as GbrainLiveness as unknown as T);
    case "gbrain_health":
      return Promise.resolve({
        brain_score: 0.86,
        page_count: 128,
        embed_coverage: 0,
        stale_pages: 3,
        orphan_pages: 1,
        missing_embeddings: 128,
        dead_links: 0,
      } as GbrainHealth as unknown as T);
    case "gbrain_sources":
      return Promise.resolve([
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
      ] as GbrainSource[] as unknown as T);
    case "gbrain_recent_pages":
      return Promise.resolve([
        { slug: "ade-overview", title: "ADE overview", kind: "doc", updated_at: NOW },
        { slug: "qa-strategy", title: "QA strategy", kind: "doc", updated_at: NOW },
      ] as GbrainPage[] as unknown as T);
    case "gbrain_query":
      return Promise.resolve([
        {
          slug: "qa-strategy",
          title: "QA strategy",
          snippet: `Match for "${a.q}" — mock result.`,
          source: "gstack-code-ade",
          score: 0.91,
        },
      ] as GbrainHit[] as unknown as T);
    case "gbrain_sync":
      return Promise.resolve("job-mock-1" as unknown as T);

    case "github_set_token":
      return Promise.resolve({ login: "MatheusKlauck" } as unknown as T);

    // workspace mutations
    case "workspace_create":
      return Promise.resolve(workspaces[0] as unknown as T);

    // fire-and-forget writes / no-ops
    case "setting_set":
    case "ui_state_set":
    case "terminal_write":
    case "terminal_resize":
    case "terminal_close":
    case "terminal_kill_window":
    case "workspace_close":
    case "sync_now":
    case "gbrain_restart":
      return Promise.resolve(undefined as unknown as T);

    default:
      // Unknown command: resolve undefined rather than reject, so an unmocked
      // call degrades to a no-op instead of crashing the QA session.
      return Promise.resolve(undefined as unknown as T);
  }
}

const MOCK_SKILLS: SkillInfo[] = [
  { name: "qa", description: "Systematically QA test a web app and fix bugs.", category: "Review" },
  { name: "review", description: "Pre-landing PR review.", category: "Review" },
  { name: "spec", description: "Turn vague intent into an executable spec.", category: "Plan" },
  { name: "impeccable", description: "Improve a frontend interface.", category: "Design" },
];

// ---- mock event bus ----
// Tauri's `listen` returns an unlisten fn; the mock never emits, so subscribing
// is a no-op that hands back a no-op unlisten.
export function mockListen<T>(
  _event: string,
  _handler: (ev: { payload: T }) => void
): Promise<() => void> {
  return Promise.resolve(() => {});
}

// ---- mock terminal channel ----
// Mirrors @tauri-apps/api Channel's surface that the app uses: an `onmessage`
// setter that receives ArrayBuffer chunks. Emits a one-line banner so a pane
// renders something instead of staying blank.
export class MockChannel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
  constructor() {
    queueMicrotask(() => {
      const banner = "\x1b[2m[mock terminal — QA mode, no real PTY]\x1b[0m\r\n";
      this.onmessage(new TextEncoder().encode(banner).buffer as unknown as T);
    });
  }
}
