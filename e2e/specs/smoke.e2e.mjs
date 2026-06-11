import { $, expect } from "@wdio/globals";

// Pipeline smoke test: proves tauri-driver attaches to the real ADE binary and
// the webview renders the React tree. It deliberately asserts nothing about
// specific screens — the functional suite (Kanban, terminals, sync) builds on
// the stable data-testid hooks + ADE_QA_SEED deterministic data (see docs/QA.md).

describe("ADE shell boots", () => {
  it("mounts the React root", async () => {
    const root = await $("#root");
    await expect(root).toExist();
  });

  it("renders UI into the root", async () => {
    const root = await $("#root");
    const children = await root.$$("*");
    expect(children.length).toBeGreaterThan(0);
  });
});
