import { describe, it, expect } from "vitest";
import {
  useSettingsStore,
  DEFAULTS,
  parsePresets,
  getDefaultPreset,
} from "./settings";

// Reset the store between tests
function resetStore() {
  useSettingsStore.setState({
    workspaceId: null,
    theme: DEFAULTS.theme,
    accent: DEFAULTS.accent,
    startupCommand: DEFAULTS.startup_command,
    startupDelay: DEFAULTS.startup_delay_secs,
    syncInterval: DEFAULTS.sync_interval_secs,
    presets: [],
    defaultPresetId: null,
    ghTokenDisplay: "",
    loaded: false,
  });
}

describe("settings store defaults", () => {
  it("maps defaults on initial state", () => {
    resetStore();
    const state = useSettingsStore.getState();
    expect(state.theme).toBe("dark");
    expect(state.accent).toBe("#f02fc2");
    expect(state.startupCommand).toBe("");
    expect(state.startupDelay).toBe("3");
    expect(state.syncInterval).toBe("30");
    expect(state.ghTokenDisplay).toBe("");
    expect(state.loaded).toBe(false);
  });

  it("allows theme to be changed in state", () => {
    resetStore();
    useSettingsStore.setState({ theme: "light" });
    expect(useSettingsStore.getState().theme).toBe("light");
  });

  it("allows accent color to be changed in state", () => {
    resetStore();
    useSettingsStore.setState({ accent: "#ff0000" });
    expect(useSettingsStore.getState().accent).toBe("#ff0000");
  });

  it("allows sync interval to be changed in state", () => {
    resetStore();
    useSettingsStore.setState({ syncInterval: "60" });
    expect(useSettingsStore.getState().syncInterval).toBe("60");
  });

  it("allows startup command to be changed in state", () => {
    resetStore();
    useSettingsStore.setState({ startupCommand: "nvim" });
    expect(useSettingsStore.getState().startupCommand).toBe("nvim");
  });

  it("allows ghTokenDisplay to be set", () => {
    resetStore();
    useSettingsStore.setState({ ghTokenDisplay: "ghp_••••••••" });
    expect(useSettingsStore.getState().ghTokenDisplay).toBe("ghp_••••••••");
  });

  it("setSyncInterval rejects values below 10", async () => {
    resetStore();
    await expect(
      useSettingsStore.getState().setSyncInterval("5")
    ).rejects.toThrow("Sync interval must be at least 10 seconds");
  });

  it("setSyncInterval accepts value of 10", async () => {
    resetStore();
    // This will call settingSet which will fail in test without Tauri,
    // but the state update happens before the IPC call. We test validation only.
    try {
      await useSettingsStore.getState().setSyncInterval("10");
    } catch {
      // IPC will fail in vitest, that's expected
    }
    // The store should have been updated before IPC
    expect(useSettingsStore.getState().syncInterval).toBe("10");
  });

  it("startupDelay default is 3", () => {
    resetStore();
    expect(useSettingsStore.getState().startupDelay).toBe("3");
  });

  it("setStartupDelay rejects negative values", async () => {
    resetStore();
    await expect(
      useSettingsStore.getState().setStartupDelay("-1")
    ).rejects.toThrow("Startup delay must be a non-negative integer");
  });

  it("setStartupDelay rejects NaN", async () => {
    resetStore();
    await expect(
      useSettingsStore.getState().setStartupDelay("abc")
    ).rejects.toThrow("Startup delay must be a non-negative integer");
  });

  it("setStartupDelay accepts zero", async () => {
    resetStore();
    try {
      await useSettingsStore.getState().setStartupDelay("0");
    } catch {
      // IPC will fail in vitest, that's expected
    }
    expect(useSettingsStore.getState().startupDelay).toBe("0");
  });

  it("setStartupDelay accepts positive integer", async () => {
    resetStore();
    try {
      await useSettingsStore.getState().setStartupDelay("5");
    } catch {
      // IPC will fail in vitest, that's expected
    }
    expect(useSettingsStore.getState().startupDelay).toBe("5");
  });
});

describe("parsePresets", () => {
  it("migrates a legacy single `command` into openCommands", () => {
    const [p] = parsePresets(
      JSON.stringify([{ id: "a", name: "claude", command: "claude" }])
    );
    expect(p.openCommands).toEqual(["claude"]);
    expect(p.closeCommands).toEqual([]);
  });

  it("keeps openCommands/closeCommands arrays and drops non-strings", () => {
    const [p] = parsePresets(
      JSON.stringify([
        {
          id: "a",
          name: "dev",
          openCommands: ["nvm use 20", 5, "npm run dev"],
          closeCommands: ["git stash", null],
          delaySecs: 2,
          injectTask: true,
        },
      ])
    );
    expect(p.openCommands).toEqual(["nvm use 20", "npm run dev"]);
    expect(p.closeCommands).toEqual(["git stash"]);
    expect(p.delaySecs).toBe(2);
    expect(p.injectTask).toBe(true);
  });

  it("drops records missing id/name", () => {
    expect(parsePresets(JSON.stringify([{ name: "x" }, { id: "y" }]))).toEqual(
      []
    );
  });

  it("returns [] for malformed or non-array JSON", () => {
    expect(parsePresets("not json")).toEqual([]);
    expect(parsePresets(JSON.stringify({ id: "a" }))).toEqual([]);
    expect(parsePresets(null)).toEqual([]);
  });
});

describe("getDefaultPreset", () => {
  const presets = [
    {
      id: "a",
      name: "A",
      openCommands: [],
      closeCommands: [],
      delaySecs: 0,
      injectTask: false,
    },
    {
      id: "b",
      name: "B",
      openCommands: [],
      closeCommands: [],
      delaySecs: 0,
      injectTask: false,
    },
  ];

  it("returns the matching preset", () => {
    expect(getDefaultPreset({ presets, defaultPresetId: "b" })?.id).toBe("b");
  });

  it("returns null when unset or unmatched", () => {
    expect(getDefaultPreset({ presets, defaultPresetId: null })).toBeNull();
    expect(getDefaultPreset({ presets, defaultPresetId: "zzz" })).toBeNull();
  });
});