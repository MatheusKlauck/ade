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
      const r = res as { paneId: string; windowId: string };
      return { paneId: r.paneId, windowId: r.windowId, channel };
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
