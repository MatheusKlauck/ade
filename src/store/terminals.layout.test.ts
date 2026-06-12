import { describe, it, expect } from "vitest";
import {
  normalizeLayout,
  reorderLayout,
  type TerminalLayout,
} from "./terminals";

describe("normalizeLayout", () => {
  it("packs fresh windows into rows of two by default", () => {
    const out = normalizeLayout([], ["a", "b", "c"]);
    expect(out).toEqual([
      { weight: 1, tiles: [{ windowId: "a", weight: 1 }, { windowId: "b", weight: 1 }] },
      { weight: 1, tiles: [{ windowId: "c", weight: 1 }] },
    ]);
  });

  it("drops tiles whose window is gone and removes emptied rows", () => {
    const layout: TerminalLayout = [
      { weight: 1, tiles: [{ windowId: "a", weight: 2 }, { windowId: "b", weight: 1 }] },
      { weight: 1, tiles: [{ windowId: "c", weight: 1 }] },
    ];
    const out = normalizeLayout(layout, ["a"]);
    expect(out).toEqual([{ weight: 1, tiles: [{ windowId: "a", weight: 2 }] }]);
  });

  it("preserves existing tiles and appends only the new ones", () => {
    const layout: TerminalLayout = [
      { weight: 3, tiles: [{ windowId: "a", weight: 5 }] },
    ];
    const out = normalizeLayout(layout, ["a", "b"]);
    // 'a' keeps its row+weight; the existing row has room (1 < 2) so 'b' joins it.
    expect(out).toEqual([
      { weight: 3, tiles: [{ windowId: "a", weight: 5 }, { windowId: "b", weight: 1 }] },
    ]);
  });

  it("de-dupes a window that appears twice and repairs bad weights", () => {
    const layout: TerminalLayout = [
      { weight: 0, tiles: [{ windowId: "a", weight: -3 }] },
      { weight: 1, tiles: [{ windowId: "a", weight: 1 }] },
    ];
    const out = normalizeLayout(layout, ["a"]);
    expect(out).toEqual([{ weight: 1, tiles: [{ windowId: "a", weight: 1 }] }]);
  });

  it("is idempotent", () => {
    const once = normalizeLayout([], ["a", "b", "c", "d", "e"]);
    const twice = normalizeLayout(once, ["a", "b", "c", "d", "e"]);
    expect(twice).toEqual(once);
  });
});

describe("reorderLayout", () => {
  const base: TerminalLayout = [
    { weight: 1, tiles: [{ windowId: "a", weight: 1 }, { windowId: "b", weight: 1 }] },
    { weight: 1, tiles: [{ windowId: "c", weight: 1 }] },
  ];

  it("moves a tile after a target in another row, preserving its weight", () => {
    const out = reorderLayout(base, "c", "a", "after");
    expect(out).toEqual([
      {
        weight: 1,
        tiles: [
          { windowId: "a", weight: 1 },
          { windowId: "c", weight: 1 },
          { windowId: "b", weight: 1 },
        ],
      },
    ]);
  });

  it("drops a row that empties when its only tile moves out", () => {
    const out = reorderLayout(base, "c", "b", "before");
    expect(out).toHaveLength(1);
    expect(out[0].tiles.map((t) => t.windowId)).toEqual(["a", "c", "b"]);
  });

  it("reorders within the same row", () => {
    const out = reorderLayout(base, "a", "b", "after");
    expect(out[0].tiles.map((t) => t.windowId)).toEqual(["b", "a"]);
  });

  it("is a no-op when dragged and target are the same", () => {
    expect(reorderLayout(base, "a", "a", "before")).toBe(base);
  });

  it("is a no-op when an id is missing", () => {
    expect(reorderLayout(base, "z", "a", "before")).toBe(base);
    expect(reorderLayout(base, "a", "z", "before")).toBe(base);
  });
});
