import { describe, it, expect, vi, beforeEach } from "vitest";

// The backend (TerminalOpenResult) serializes snake_case: { pane_id, window_id }.
// Regression guard for BUG-001: terminalOpen used to read camelCase keys
// (res.paneId/res.windowId), which were always undefined — so every opened
// terminal had an undefined paneId/windowId and never rendered.
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  // Minimal Channel stub — terminalOpen constructs one and passes it through.
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { terminalOpen } from "./ipc";

describe("terminalOpen wire mapping", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("maps snake_case backend keys to camelCase result", async () => {
    invokeMock.mockResolvedValue({ pane_id: "ws1__@7", window_id: "@7" });

    const result = await terminalOpen("ws1");

    expect(result.paneId).toBe("ws1__@7");
    expect(result.windowId).toBe("@7");
    expect(result.channel).toBeDefined();
  });

  it("passes workspaceId, windowId and a channel to the backend", async () => {
    invokeMock.mockResolvedValue({ pane_id: "ws1__@9", window_id: "@9" });

    await terminalOpen("ws1", "@9");

    expect(invokeMock).toHaveBeenCalledWith(
      "terminal_open",
      expect.objectContaining({
        workspaceId: "ws1",
        windowId: "@9",
        channel: expect.anything(),
      })
    );
  });
});
