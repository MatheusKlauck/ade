import { create } from "zustand";
import { settingGet, settingSet, githubSetToken } from "../lib/ipc";

// Default values per CONTRACTS §7 and §17
export const DEFAULTS: Record<string, string> = {
  theme: "dark",
  accent: "#4a9eff",
  startup_command: "",
  sync_interval_secs: "30",
};

interface SettingsState {
  theme: string;
  accent: string;
  startupCommand: string;
  syncInterval: string;
  ghTokenDisplay: string;
  loaded: boolean;

  load: () => Promise<void>;
  setTheme: (theme: string) => Promise<void>;
  setAccent: (color: string) => Promise<void>;
  setStartupCommand: (cmd: string) => Promise<void>;
  setSyncInterval: (secs: string) => Promise<void>;
  setGhToken: (token: string) => Promise<string>; // returns login
}

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: DEFAULTS.theme,
  accent: DEFAULTS.accent,
  startupCommand: DEFAULTS.startup_command,
  syncInterval: DEFAULTS.sync_interval_secs,
  ghTokenDisplay: "",
  loaded: false,

  load: async () => {
    const [t, a, sc, si, tk] = await Promise.all([
      settingGet("theme"),
      settingGet("accent"),
      settingGet("startup_command"),
      settingGet("sync_interval_secs"),
      settingGet("github_token_display"),
    ]);
    set({
      theme: t ?? DEFAULTS.theme,
      accent: a ?? DEFAULTS.accent,
      startupCommand: sc ?? DEFAULTS.startup_command,
      syncInterval: si ?? DEFAULTS.sync_interval_secs,
      ghTokenDisplay: tk ?? "",
      loaded: true,
    });
  },

  setTheme: async (theme: string) => {
    set({ theme });
    document.documentElement.setAttribute("data-theme", theme);
    await settingSet("theme", theme);
  },

  setAccent: async (color: string) => {
    set({ accent: color });
    document.documentElement.style.setProperty("--accent", color);
    await settingSet("accent", color);
  },

  setStartupCommand: async (cmd: string) => {
    set({ startupCommand: cmd });
    await settingSet("startup_command", cmd);
  },

  setSyncInterval: async (secs: string) => {
    const val = parseInt(secs, 10);
    if (isNaN(val) || val < 10) {
      throw new Error("Sync interval must be at least 10 seconds");
    }
    set({ syncInterval: String(val) });
    await settingSet("sync_interval_secs", String(val));
  },

  setGhToken: async (token: string) => {
    const result = await githubSetToken(token.trim());
    const masked = token.trim().slice(0, 4) + "••••••••";
    set({ ghTokenDisplay: masked });
    await settingSet("github_token_display", masked);
    return result.login;
  },
}));