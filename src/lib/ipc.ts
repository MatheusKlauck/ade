import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { isTauri, mockInvoke, mockListen, MockChannel } from "./mockBackend";

// Single seam: under Tauri use the real bridge; in a plain browser (`vite dev`,
// e.g. the gstack /qa headless run) route to the in-memory mock backend so the
// whole UI is interactive at localhost:1420. See mockBackend.ts. `Channel` is
// kept as the real type; the mock channel is cast to it so consumers (store,
// TerminalPane) keep the unchanged public types.
const invoke = isTauri ? tauriInvoke : mockInvoke;
const listen = isTauri ? tauriListen : mockListen;
const ChannelCtor = isTauri ? Channel : (MockChannel as unknown as typeof Channel);

// ---- shared types (generated from Rust by ts-rs; see src/lib/bindings) ----
// Source of truth is the Rust struct. Regenerate with
// `cd src-tauri && cargo test export_bindings`. Re-exported here so existing
// `import { Card } from "../lib/ipc"` call sites keep working.
import type {
  Workspace,
  BoardColumn,
  Card,
  BoardGetResult,
  CardDetail,
  AgentTask,
  AgentEvent,
  IssueProposal,
} from "./bindings";
export type {
  Workspace,
  BoardColumn,
  Card,
  BoardGetResult,
  CardDetail,
  Label,
  IssueComment,
  AgentTask,
  AgentEvent,
  IssueProposal,
} from "./bindings";

// ---- notifications ----
export async function subscribeNotify(
  cb: (payload: {
    level: string;
    code: string;
    message: string;
  }) => void
) {
  return listen<{ level: string; code: string; message: string }>("evt:notify", (ev) => {
    cb(ev.payload);
  });
}

// ---- gestor (#56) ----
export function gestorPlan(
  workspaceId: string,
  brief: string
): Promise<IssueProposal[]> {
  return invoke("gestor_plan", { workspaceId, brief });
}

export function proposalApprove(
  workspaceId: string,
  proposalIds: string[]
): Promise<string[]> {
  return invoke("proposal_approve", { workspaceId, proposalIds });
}

/** Hero intake: brief → N Backlog cards that auto-flow to Doing (ensures L2).
 * Returns the proposals it unfolded so the UI can reveal them. */
export function gestorBuildFeature(
  workspaceId: string,
  brief: string
): Promise<IssueProposal[]> {
  return invoke("gestor_build_feature", { workspaceId, brief });
}

export function gestorEnqueueCard(
  workspaceId: string,
  cardId: string
): Promise<string> {
  return invoke("gestor_enqueue_card", { workspaceId, cardId });
}

export function gestorTasksList(workspaceId: string): Promise<AgentTask[]> {
  return invoke("gestor_tasks_list", { workspaceId });
}

export function gestorFeedList(
  workspaceId: string,
  limit: number
): Promise<AgentEvent[]> {
  return invoke("gestor_feed_list", { workspaceId, limit });
}

export function gestorReleaseNotes(workspaceId: string): Promise<string> {
  return invoke("gestor_release_notes", { workspaceId });
}

export function prMerge(workspaceId: string, taskId: string): Promise<void> {
  return invoke("pr_merge", { workspaceId, taskId });
}

export async function subscribeFeed(cb: (ev: AgentEvent) => void) {
  return listen<AgentEvent>("evt:feed", (ev) => cb(ev.payload));
}

// ---- settings (per-workspace) ----
export function githubSetToken(
  workspaceId: string,
  token: string
): Promise<{ login: string }> {
  return invoke("github_set_token", { workspaceId, token });
}

export function settingGet(
  workspaceId: string,
  key: string
): Promise<string | null> {
  return invoke("setting_get", { workspaceId, key });
}

export function settingSet(
  workspaceId: string,
  key: string,
  value: string
): Promise<void> {
  return invoke("setting_set", { workspaceId, key, value });
}

export function uiStateGet(key: string): Promise<string | null> {
  return invoke("ui_state_get", { key });
}

export function uiStateSet(key: string, valueJson: string): Promise<void> {
  return invoke("ui_state_set", { key, valueJson });
}

// ---- terminal ----
export interface TerminalOpenResult {
  paneId: string;
  windowId: string;
  channel: Channel<unknown>;
}

export function terminalOpen(
  workspaceId: string,
  windowId?: string
): Promise<TerminalOpenResult> {
  const channel = new ChannelCtor<unknown>();
  return invoke("terminal_open", { workspaceId, windowId, channel }).then(
    (res: unknown) => {
      // Backend serializes snake_case (TerminalOpenResult { pane_id, window_id }),
      // per CONTRACTS §7. Read those keys, not camelCase.
      const r = res as { pane_id: string; window_id: string };
      return { paneId: r.pane_id, windowId: r.window_id, channel };
    }
  );
}

export function terminalWrite(paneId: string, data: string): Promise<void> {
  return invoke("terminal_write", { paneId, data });
}

export function terminalResize(
  paneId: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke("terminal_resize", { paneId, cols, rows });
}

export function terminalClose(paneId: string): Promise<void> {
  return invoke("terminal_close", { paneId });
}

export function terminalKillWindow(
  workspaceId: string,
  windowId: string
): Promise<void> {
  return invoke("terminal_kill_window", { workspaceId, windowId });
}

// ---- claude sessions ----
export interface ClaudeSession {
  id: string;
  title: string;
  lastActive: number; // epoch seconds
  gitBranch: string | null;
}

/** Resumable Claude Code sessions recorded for the workspace's cwd, newest first. */
export function claudeSessions(workspaceId: string): Promise<ClaudeSession[]> {
  return invoke("claude_sessions", { workspaceId }).then((res: unknown) =>
    (res as Array<Record<string, unknown>>).map((s) => ({
      id: s.id as string,
      title: s.title as string,
      lastActive: s.last_active as number,
      gitBranch: (s.git_branch as string | null) ?? null,
    }))
  );
}

// ---- board ----
export function boardGet(workspaceId: string): Promise<BoardGetResult> {
  return invoke("board_get", { workspaceId });
}

export function cardCreate(
  workspaceId: string,
  columnId: string,
  title: string
): Promise<Card> {
  return invoke("card_create", { workspaceId, columnId, title });
}

export function cardUpdate(
  cardId: string,
  title?: string,
  bodyPreview?: string
): Promise<Card> {
  return invoke("card_update", { cardId, title, bodyPreview });
}

export function cardDelete(cardId: string): Promise<void> {
  return invoke("card_delete", { cardId });
}

export function cardDetail(cardId: string): Promise<CardDetail> {
  return invoke<CardDetail>("card_detail", { cardId });
}

export function cardPromote(cardId: string): Promise<Card> {
  return invoke<Card>("card_promote", { cardId });
}

/** Edit a linked GitHub issue's title/body and push to GitHub (direct write). */
export function cardUpdateGithub(
  cardId: string,
  title: string,
  body: string
): Promise<Card> {
  return invoke<Card>("card_update_github", { cardId, title, body });
}

export function cardMove(
  cardId: string,
  toColumnId: string,
  beforeCardId?: string,
  afterCardId?: string
): Promise<Card> {
  return invoke("card_move", { cardId, toColumnId, beforeCardId, afterCardId });
}

// ---- workspace ----
export function workspaceList(): Promise<Workspace[]> {
  return invoke<Workspace[]>("workspace_list");
}

export function workspaceCreate(path: string): Promise<Workspace> {
  return invoke<Workspace>("workspace_create", { path });
}

export function workspaceClose(workspaceId: string): Promise<void> {
  return invoke("workspace_close", { workspaceId });
}

// ---- skills ----
export interface SkillInfo {
  name: string;
  description: string;
  // Coarse family for grouping in the sidebar spine (Plan, Review, Design, …);
  // computed by the backend, "Other" when it can't be inferred.
  category: string;
}

// Scan the workspace root for skills (`.claude/skills/*/SKILL.md`, `skills/*/SKILL.md`).
export function skillsList(workspaceId: string): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("skills_list", { workspaceId });
}

// Kick an immediate sync cycle for a workspace's GitHub worker (the backend
// `notify`s the running worker; it's a no-op for local-only workspaces).
export function syncNow(workspaceId: string): Promise<void> {
  return invoke("sync_now", { workspaceId });
}

// ---- gbrain (shared local `gbrain serve --http`) ----

// Compact brain health for the StatusBar pill. Fields are optional because the
// snapshot shape varies by gbrain version; `healthy` is false while the
// app-owned serve is still coming up (rendered as "offline"). `staleness` is the
// worst sync class across sources ("fresh" | "aging" | "stale") and drives the
// pill colour.
export interface GbrainStatus {
  healthy: boolean;
  pages?: number;
  chunks?: number;
  staleness?: string;
  last_sync_at?: string;
  embedding_coverage_pct?: number;
  unacknowledged_failures?: number;
  source_count?: number;
}

export function gbrainStatus(): Promise<GbrainStatus> {
  return invoke<GbrainStatus>("gbrain_status");
}

// One brain-search hit. `slug` identifies the page; the rest are best-effort.
export interface GbrainHit {
  slug: string;
  title: string;
  snippet: string;
  source?: string;
  score?: number;
}

export function gbrainQuery(q: string, limit?: number): Promise<GbrainHit[]> {
  return invoke<GbrainHit[]>("gbrain_query", { q, limit });
}

// Brain identity for the panel header (version + update availability).
export interface GbrainIdentity {
  version?: string;
  engine?: string;
  pages?: number;
  chunks?: number;
  update_available?: boolean;
  latest_version?: string;
}

export function gbrainIdentity(): Promise<GbrainIdentity> {
  return invoke<GbrainIdentity>("gbrain_identity");
}

// One federated source's sync state, for the "stale" panel.
export interface GbrainSource {
  id: string;
  sync_enabled?: boolean;
  staleness?: string;
  staleness_hours?: number;
  last_sync_at?: string;
  last_commit?: string;
  pages?: number;
  chunks?: number;
  embedding_coverage_pct?: number;
}

export function gbrainSources(): Promise<GbrainSource[]> {
  return invoke<GbrainSource[]>("gbrain_sources");
}

// One page row for the explore/browse list.
export interface GbrainPage {
  slug: string;
  title: string;
  kind?: string;
  updated_at?: string;
}

export function gbrainRecentPages(limit?: number): Promise<GbrainPage[]> {
  return invoke<GbrainPage[]>("gbrain_recent_pages", { limit });
}

// Brain quality metrics from `get_health`, for the offline/diagnostic panel.
export interface GbrainHealth {
  brain_score?: number;
  page_count?: number;
  embed_coverage?: number;
  stale_pages?: number;
  orphan_pages?: number;
  missing_embeddings?: number;
  dead_links?: number;
}

export function gbrainHealth(): Promise<GbrainHealth> {
  return invoke<GbrainHealth>("gbrain_health");
}

// Unauthenticated liveness probe (`GET /health`).
export interface GbrainLiveness {
  reachable: boolean;
  status?: string;
  version?: string;
  engine?: string;
}

export function gbrainLiveness(): Promise<GbrainLiveness> {
  return invoke<GbrainLiveness>("gbrain_liveness");
}

// Trigger a brain sync (enqueues a sync job); resolves to a job id when known.
export function gbrainSync(full?: boolean): Promise<string> {
  return invoke<string>("gbrain_sync", { full });
}

// Restart the app-owned serve in place.
export function gbrainRestart(): Promise<void> {
  return invoke<void>("gbrain_restart");
}

// ---- events ----
export function subscribeTerminalFocus(
  cb: (payload: { workspace_id: string; window_id: string; card_id?: string }) => void
) {
  return listen<{ workspace_id: string; window_id: string; card_id?: string }>(
    "evt:terminal_focus",
    (ev) => {
      cb(ev.payload);
    }
  );
}

export function subscribeTerminalClose(
  cb: (payload: { workspace_id: string; window_id: string }) => void
) {
  return listen<{ workspace_id: string; window_id: string }>(
    "evt:terminal_close",
    (ev) => {
      cb(ev.payload);
    }
  );
}

export function subscribeBoard(
  cb: (payload: { workspace_id: string; columns: BoardColumn[]; cards: Card[] }) => void
) {
  return listen<{ workspace_id: string; columns: BoardColumn[]; cards: Card[] }>("evt:board", (ev) => {
    cb(ev.payload);
  });
}

export function subscribeSync(
  handler: (payload: { workspace_id: string; status: string; last_sync?: string }) => void
): Promise<() => void> {
  return listen<{ workspace_id: string; status: string; last_sync?: string }>("evt:sync", (ev) => {
    handler(ev.payload);
  });
}

export interface TerminalAlertPayload {
  workspace_id: string;
  window_id: string;
  kind: "started" | "completed" | "bell" | "app" | "gone" | "claude";
  // For kind "claude": the session state ("turn-start" | "turn-end" | "waiting").
  detail: string;
}

// Emitted by the backend completion monitor (term_monitor) when a command or app
// inside a tmux window finishes / rings the bell / posts a notification.
export function subscribeTerminalAlert(
  handler: (payload: TerminalAlertPayload) => void
): Promise<() => void> {
  return listen<TerminalAlertPayload>("evt:terminal-alert", (ev) => {
    handler(ev.payload);
  });
}
