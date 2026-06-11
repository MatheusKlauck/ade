import { describe, it, expect } from "vitest";
import { useSettingsStore, DEFAULTS } from "./settings";

// Reset the store between tests
function resetStore() {
  useSettingsStore.setState({
    theme: DEFAULTS.theme,
    accent: DEFAULTS.accent,
    startupCommand: DEFAULTS.startup_command,
    syncInterval: DEFAULTS.sync_interval_secs,
    ghTokenDisplay: "",
    loaded: false,
  });
}

describe("settings store defaults", () => {
  it("maps defaults on initial state", () => {
    resetStore();
    const state = useSettingsStore.getState();
    expect(state.theme).toBe("dark");
    expect(state.accent).toBe("#4a9eff");
    expect(state.startupCommand).toBe("");
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
});