import { describe, expect, it } from "vitest";
import { feedCommandBuffer, isUsableResize } from "./TerminalPane";

describe("isUsableResize", () => {
  it("rejects a hidden pane (zero box → FitAddon's degenerate 2x1)", () => {
    // display:none box measures 0; the bug was pushing 2x1 to tmux from here.
    expect(isUsableResize(0, 0, { cols: 2, rows: 1 })).toBe(false);
    expect(isUsableResize(800, 0, { cols: 120, rows: 1 })).toBe(false);
    expect(isUsableResize(0, 600, { cols: 2, rows: 40 })).toBe(false);
  });

  it("rejects missing or non-finite dims", () => {
    expect(isUsableResize(800, 600, undefined)).toBe(false);
    expect(isUsableResize(800, 600, null)).toBe(false);
    expect(isUsableResize(800, 600, { cols: NaN, rows: 40 })).toBe(false);
  });

  it("accepts a real visible size", () => {
    expect(isUsableResize(800, 600, { cols: 120, rows: 40 })).toBe(true);
  });
});

describe("feedCommandBuffer", () => {
  it("records a plain typed command on Enter", () => {
    const buf = { current: "" };
    expect(feedCommandBuffer(buf, "npm run dev\r")).toEqual(["npm run dev"]);
  });

  it("ignores OSC colour-query reports (the bogus-command bug)", () => {
    const buf = { current: "" };
    // What xterm sends back through onData when an app queries fg/bg colour.
    expect(feedCommandBuffer(buf, "\x1b]10;rgb:e6e6/e6e6/e6e6\x07")).toEqual([]);
    expect(feedCommandBuffer(buf, "\x1b]11;rgb:f8f8/f8f8/f2f2\x1b\\")).toEqual([]);
    expect(buf.current).toBe("");
  });

  it("still skips CSI/SS3 sequences and keeps the real command", () => {
    const buf = { current: "" };
    expect(feedCommandBuffer(buf, "\x1b[Aclaude\r")).toEqual(["claude"]);
  });
});
