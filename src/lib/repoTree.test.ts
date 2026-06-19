import { describe, expect, it } from "vitest";
import { treeRows } from "./repoTree";
import type { ChangedFile } from "./ipc";

const f = (path: string, status = "M"): ChangedFile => ({ path, status });

describe("treeRows", () => {
  it("compacts single-child dir chains into one row", () => {
    const rows = treeRows([f("src-tauri/src/ipc/mod.rs")], new Set());
    expect(rows.map((r) => (r.type === "dir" ? r.label : `>${r.name}`))).toEqual([
      "src-tauri/src/ipc",
      ">mod.rs",
    ]);
    // file row carries the full path, dir row the compacted path key
    const fileRow = rows.find((r) => r.type === "file");
    expect(fileRow && fileRow.type === "file" && fileRow.file.path).toBe(
      "src-tauri/src/ipc/mod.rs"
    );
  });

  it("groups siblings and keeps dirs before files", () => {
    const rows = treeRows(
      [f("src/App.tsx"), f("src/lib/ipc.ts"), f("package.json", "?")],
      new Set()
    );
    // src (dir, has children so not compacted) → lib → ipc.ts, then App.tsx; then package.json
    expect(rows.map((r) => (r.type === "dir" ? `[${r.label}]` : r.name))).toEqual([
      "[src]",
      "[lib]",
      "ipc.ts",
      "App.tsx",
      "package.json",
    ]);
  });

  it("hides children of a collapsed dir", () => {
    const rows = treeRows([f("src/lib/ipc.ts")], new Set(["src/lib"]));
    expect(rows.map((r) => (r.type === "dir" ? r.label : r.name))).toEqual([
      "src/lib",
    ]);
  });
});
