import { create } from "zustand";
import { settingGet, settingSet, githubSetToken } from "../lib/ipc";

// Default values per CONTRACTS §7 and §17
export const DEFAULTS: Record<string, string> = {
  theme: "dark",
  accent: "#4a9eff",
  startup_command: "",
  startup_delay_secs: "3",
  sync_interval_secs: "30",
};

interface SettingsState {
  workspaceId: string | null;
  theme: string;
  accent: string;
  startupCommand: string;
  startupDelay: string;
  syncInterval: string;
  ghTokenDisplay: string;
  loaded: boolean;

  load: (workspaceId: string) => Promise<void>;
  setTheme: (theme: string) => Promise<void>;
  setAccent: (color: string) => Promise<void>;
  setStartupCommand: (cmd: string) => Promise<void>;
  setStartupDelay: (secs: string) => Promise<void>;
  setSyncInterval: (secs: string) => Promise<void>;
  setGhToken: (token: string) => Promise<string>; // returns login
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  workspaceId: null,
  theme: DEFAULTS.theme,
  accent: DEFAULTS.accent,
  startupCommand: DEFAULTS.startup_command,
  startupDelay: DEFAULTS.startup_delay_secs,
  syncInterval: DEFAULTS.sync_interval_secs,
  ghTokenDisplay: "",
  loaded: false,

  // Load the given workspace's settings. Settings are per-workspace, so this
  // runs on every workspace switch. A stale-load guard drops results if the
  // active workspace changed while the IPC calls were in flight.
  load: async (workspaceId: string) => {
    set({ workspaceId, loaded: false });
    const [t, a, sc, sd, si, tk] = await Promise.all([
      settingGet(workspaceId, "theme"),
      settingGet(workspaceId, "accent"),
      settingGet(workspaceId, "startup_command"),
      settingGet(workspaceId, "startup_delay_secs"),
      settingGet(workspaceId, "sync_interval_secs"),
      settingGet(workspaceId, "github_token_display"),
    ]);
    if (get().workspaceId !== workspaceId) return; // superseded by a newer load
    set({
      theme: t ?? DEFAULTS.theme,
      accent: a ?? DEFAULTS.accent,
      startupCommand: sc ?? DEFAULTS.startup_command,
      startupDelay: sd ?? DEFAULTS.startup_delay_secs,
      syncInterval: si ?? DEFAULTS.sync_interval_secs,
      ghTokenDisplay: tk ?? "",
      loaded: true,
    });
  },

  setTheme: async (theme: string) => {
    const wid = get().workspaceId;
    set({ theme });
    document.documentElement.setAttribute("data-theme", theme);
    if (wid) await settingSet(wid, "theme", theme);
  },

  setAccent: async (color: string) => {
    const wid = get().workspaceId;
    set({ accent: color });
    document.documentElement.style.setProperty("--accent", color);
    if (wid) await settingSet(wid, "accent", color);
  },

  setStartupCommand: async (cmd: string) => {
    const wid = get().workspaceId;
    set({ startupCommand: cmd });
    if (wid) await settingSet(wid, "startup_command", cmd);
  },

  setStartupDelay: async (secs: string) => {
    const val = parseInt(secs, 10);
    if (isNaN(val) || val < 0) {
      throw new Error("Startup delay must be a non-negative integer");
    }
    const wid = get().workspaceId;
    set({ startupDelay: String(val) });
    if (wid) await settingSet(wid, "startup_delay_secs", String(val));
  },

  setSyncInterval: async (secs: string) => {
    const val = parseInt(secs, 10);
    if (isNaN(val) || val < 10) {
      throw new Error("Sync interval must be at least 10 seconds");
    }
    const wid = get().workspaceId;
    set({ syncInterval: String(val) });
    if (wid) await settingSet(wid, "sync_interval_secs", String(val));
  },

  setGhToken: async (token: string) => {
    const wid = get().workspaceId;
    if (!wid) throw new Error("No active workspace");
    const result = await githubSetToken(wid, token.trim());
    const masked = token.trim().slice(0, 4) + "••••••••";
    set({ ghTokenDisplay: masked });
    await settingSet(wid, "github_token_display", masked);
    return result.login;
  },
}));