import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalsStore } from "./terminals";
import type { TerminalPreset } from "./settings";

const preset = (id: string): TerminalPreset => ({
  id,
  name: `preset-${id}`,
  openCommands: [`run-${id}`],
  closeCommands: [],
  delaySecs: 0,
  injectTask: true,
});

beforeEach(() => {
  useTerminalsStore.setState({ pendingPresetByCardId: {} });
});

describe("pending preset bridge", () => {
  it("returns undefined when no preset is pending for a card", () => {
    expect(useTerminalsStore.getState().takePendingPreset("card-1")).toBeUndefined();
  });

  it("stores a preset for a card and returns it on take", () => {
    const p = preset("a");
    useTerminalsStore.getState().setPendingPreset("card-1", p);
    expect(useTerminalsStore.getState().takePendingPreset("card-1")).toEqual(p);
  });

  it("clears the preset after it is taken (read-once)", () => {
    useTerminalsStore.getState().setPendingPreset("card-1", preset("a"));
    useTerminalsStore.getState().takePendingPreset("card-1");
    expect(useTerminalsStore.getState().takePendingPreset("card-1")).toBeUndefined();
    expect(useTerminalsStore.getState().pendingPresetByCardId).toEqual({});
  });

  it("keeps presets for other cards independent", () => {
    useTerminalsStore.getState().setPendingPreset("card-1", preset("a"));
    useTerminalsStore.getState().setPendingPreset("card-2", preset("b"));
    expect(useTerminalsStore.getState().takePendingPreset("card-1")?.id).toBe("a");
    // Taking card-1 must not disturb card-2's pending preset.
    expect(useTerminalsStore.getState().takePendingPreset("card-2")?.id).toBe("b");
  });

  it("overwrites an existing pending preset for the same card", () => {
    useTerminalsStore.getState().setPendingPreset("card-1", preset("a"));
    useTerminalsStore.getState().setPendingPreset("card-1", preset("b"));
    expect(useTerminalsStore.getState().takePendingPreset("card-1")?.id).toBe("b");
  });
});
