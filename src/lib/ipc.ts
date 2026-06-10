import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
