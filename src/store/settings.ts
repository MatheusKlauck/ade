import { create } from "zustand";
import { settingGet, settingSet, githubSetToken } from "../lib/ipc";

// Default values per CONTRACTS §7 and §17
export const DEFAULTS: Record<string, string> = {
  theme: "dark",
  accent: "#f02fc2",
  startup_command: "",
  startup_delay_secs: "3",
  sync_interval_secs: "30",
  terminal_presets: "[]",
  default_preset_id: "",
};

/** A named terminal launch config. Picking a preset when opening a terminal
 * runs `openCommands` (one after another) after `delaySecs` and, when the
 * terminal is tied to a card, optionally injects the task prompt (`injectTask`).
 * `closeCommands` run when the terminal is closed (manually, or — for the
 * workspace default preset — when the card moves to Done). Stored per-workspace
 * as a JSON array in the `terminal_presets` setting. */
export interface TerminalPreset {
  id: string;
  name: string;
  openCommands: string[];
  closeCommands: string[];
  delaySecs: number;
  injectTask: boolean;
}

/** Parse the stored JSON into a clean preset list, dropping anything malformed
 * so one bad record can't blank the whole picker. */
export function parsePresets(raw: string | null): TerminalPreset[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((item): TerminalPreset[] => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") return [];
    // Open commands: prefer the list; migrate a legacy single `command` string
    // into a one-element list so old stored presets keep working.
    const openCommands = Array.isArray(o.openCommands)
      ? o.openCommands.filter((c): c is string => typeof c === "string")
      : typeof o.command === "string" && o.command
        ? [o.command]
        : [];
    const closeCommands = Array.isArray(o.closeCommands)
      ? o.closeCommands.filter((c): c is string => typeof c === "string")
      : [];
    return [
      {
        id: o.id,
        name: o.name,
        openCommands,
        closeCommands,
        delaySecs:
          typeof o.delaySecs === "number" && o.delaySecs >= 0 ? o.delaySecs : 0,
        injectTask: o.injectTask === true,
      },
    ];
  });
}

/** Resolve the workspace's default preset object, or null when none is set or
 * the stored id no longer matches a preset. Exported so non-hook callers (e.g.
 * App.tsx scheduleStartupSequence) can read it from the store snapshot. */
export function getDefaultPreset(s: {
  presets: TerminalPreset[];
  defaultPresetId: string | null;
}): TerminalPreset | null {
  if (!s.defaultPresetId) return null;
  return s.presets.find((p) => p.id === s.defaultPresetId) ?? null;
}

/** Terminal look & feel, stored per-workspace as one JSON blob under
 * `terminal_appearance`. One blob (not a key per field) keeps the store + IPC
 * surface flat as knobs are added. `fontFamily: ""` means "use the app's
 * --font-mono". */
export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  background: string;
  foreground: string;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
}

export const TERMINAL_APPEARANCE_DEFAULT: TerminalAppearance = {
  fontFamily: "",
  fontSize: 13,
  background: "#0b0e14",
  foreground: "#e6e6e6",
  cursorStyle: "bar",
  cursorBlink: true,
};

const CURSOR_STYLES: readonly string[] = ["block", "bar", "underline"];

/** Merge a stored blob over the defaults so a missing or garbage field can't
 * break the terminal, clamping the two values a bad blob could make nonsensical
 * (font size, cursor style). */
export function parseTerminalAppearance(raw: string | null): TerminalAppearance {
  if (!raw) return TERMINAL_APPEARANCE_DEFAULT;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return TERMINAL_APPEARANCE_DEFAULT;
  }
  if (!o || typeof o !== "object") return TERMINAL_APPEARANCE_DEFAULT;
  const m = o as Record<string, unknown>;
  const d = TERMINAL_APPEARANCE_DEFAULT;
  return {
    fontFamily: typeof m.fontFamily === "string" ? m.fontFamily : d.fontFamily,
    fontSize:
      typeof m.fontSize === "number" && Number.isFinite(m.fontSize)
        ? Math.min(32, Math.max(8, m.fontSize))
        : d.fontSize,
    background: typeof m.background === "string" ? m.background : d.background,
    foreground: typeof m.foreground === "string" ? m.foreground : d.foreground,
    cursorStyle: CURSOR_STYLES.includes(m.cursorStyle as string)
      ? (m.cursorStyle as TerminalAppearance["cursorStyle"])
      : d.cursorStyle,
    cursorBlink: typeof m.cursorBlink === "boolean" ? m.cursorBlink : d.cursorBlink,
  };
}

interface SettingsState {
  workspaceId: string | null;
  theme: string;
  accent: string;
  startupCommand: string;
  startupDelay: string;
  syncInterval: string;
  presets: TerminalPreset[];
  defaultPresetId: string | null;
  terminalAppearance: TerminalAppearance;
  ghTokenDisplay: string;
  loaded: boolean;

  load: (workspaceId: string) => Promise<void>;
  setTheme: (theme: string) => Promise<void>;
  setAccent: (color: string) => Promise<void>;
  setStartupCommand: (cmd: string) => Promise<void>;
  setStartupDelay: (secs: string) => Promise<void>;
  setSyncInterval: (secs: string) => Promise<void>;
  setPresets: (presets: TerminalPreset[]) => Promise<void>;
  setDefaultPreset: (id: string | null) => Promise<void>;
  setTerminalAppearance: (a: TerminalAppearance) => Promise<void>;
  setGhToken: (token: string) => Promise<string>; // returns login
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  workspaceId: null,
  theme: DEFAULTS.theme,
  accent: DEFAULTS.accent,
  startupCommand: DEFAULTS.startup_command,
  startupDelay: DEFAULTS.startup_delay_secs,
  syncInterval: DEFAULTS.sync_interval_secs,
  presets: [],
  defaultPresetId: null,
  terminalAppearance: TERMINAL_APPEARANCE_DEFAULT,
  ghTokenDisplay: "",
  loaded: false,

  // Load the given workspace's settings. Settings are per-workspace, so this
  // runs on every workspace switch. A stale-load guard drops results if the
  // active workspace changed while the IPC calls were in flight.
  load: async (workspaceId: string) => {
    set({ workspaceId, loaded: false });
    const [t, a, sc, sd, si, pr, dp, ta, tk] = await Promise.all([
      settingGet(workspaceId, "theme"),
      settingGet(workspaceId, "accent"),
      settingGet(workspaceId, "startup_command"),
      settingGet(workspaceId, "startup_delay_secs"),
      settingGet(workspaceId, "sync_interval_secs"),
      settingGet(workspaceId, "terminal_presets"),
      settingGet(workspaceId, "default_preset_id"),
      settingGet(workspaceId, "terminal_appearance"),
      settingGet(workspaceId, "github_token_display"),
    ]);
    if (get().workspaceId !== workspaceId) return; // superseded by a newer load
    set({
      theme: t ?? DEFAULTS.theme,
      accent: a ?? DEFAULTS.accent,
      startupCommand: sc ?? DEFAULTS.startup_command,
      startupDelay: sd ?? DEFAULTS.startup_delay_secs,
      syncInterval: si ?? DEFAULTS.sync_interval_secs,
      presets: parsePresets(pr),
      defaultPresetId: dp ? dp : null,
      terminalAppearance: parseTerminalAppearance(ta),
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

  setPresets: async (presets: TerminalPreset[]) => {
    const wid = get().workspaceId;
    set({ presets });
    if (wid) await settingSet(wid, "terminal_presets", JSON.stringify(presets));
  },

  setDefaultPreset: async (id: string | null) => {
    const wid = get().workspaceId;
    set({ defaultPresetId: id });
    if (wid) await settingSet(wid, "default_preset_id", id ?? "");
  },

  setTerminalAppearance: async (a: TerminalAppearance) => {
    const wid = get().workspaceId;
    set({ terminalAppearance: a });
    if (wid) await settingSet(wid, "terminal_appearance", JSON.stringify(a));
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