import { describe, it, expect } from "vitest";
import { parseJsonLines, linesToJson } from "./GestorSettings";

describe("gestor settings JSON-array <-> lines", () => {
  it("roundtrips a command list", () => {
    const json = linesToJson("cargo test\nbun run test");
    expect(JSON.parse(json)).toEqual(["cargo test", "bun run test"]);
    expect(parseJsonLines(json)).toBe("cargo test\nbun run test");
  });

  it("drops blank/whitespace lines", () => {
    expect(linesToJson("  a  \n\n   \nb")).toBe('["a","b"]');
  });

  it("tolerates null / non-array / junk", () => {
    expect(parseJsonLines(null)).toBe("");
    expect(parseJsonLines("not json")).toBe("");
    expect(parseJsonLines('{"a":1}')).toBe("");
    expect(linesToJson("")).toBe("[]");
  });
});
