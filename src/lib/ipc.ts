import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Channel } from "@tauri-apps/api/core";

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

// ---- settings ----
export function githubSetToken(token: string): Promise<{ login: string }> {
  return invoke("github_set_token", { token });
}

export function settingGet(key: string): Promise<string | null> {
  return invoke("setting_get", { key });
}

export function settingSet(key: string, value: string): Promise<void> {
  return invoke("setting_set", { key, value });
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
  const channel = new Channel<unknown>();
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

// ---- board ----
export interface BoardGetResult {
  columns: BoardColumn[];
  cards: Card[];
}

export interface BoardColumn {
  id: string;
  workspace_id: string;
  name: string;
  position: number;
}

export interface Card {
  id: string;
  workspace_id: string;
  column_id: string;
  title: string;
  body_preview: string | null;
  position: number;
  source: string;
  github_issue_number: number | null;
  github_state: string | null;
  assignee: string | null;
  labels_json: string | null;
  remote_updated_at: string | null;
  terminal_window_id: string | null;
  created_at: string;
  updated_at: string;
}

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

export interface IssueComment {
  id: number;
  user: string;
  body: string;
  created_at: string;
}

export interface CardDetail {
  card: Card;
  body: string | null;
  comments: IssueComment[];
}

export function cardDetail(cardId: string): Promise<CardDetail> {
  return invoke<CardDetail>("card_detail", { cardId });
}

export function cardPromote(cardId: string): Promise<Card> {
  return invoke<Card>("card_promote", { cardId });
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
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  root_path: string;
  github_owner: string | null;
  github_repo: string | null;
  startup_command: string | null;
  created_at: string;
}

export function workspaceList(): Promise<Workspace[]> {
  return invoke<Workspace[]>("workspace_list");
}

export function workspaceCreate(path: string): Promise<Workspace> {
  return invoke<Workspace>("workspace_create", { path });
}

// ---- events ----
export function subscribeTerminalFocus(
  cb: (payload: { workspace_id: string; window_id: string }) => void
) {
  return listen<{ workspace_id: string; window_id: string }>("evt:terminal_focus", (ev) => {
    cb(ev.payload);
  });
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
