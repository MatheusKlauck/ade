import { describe, it, expect } from "vitest";
import { skillNameFromLine, rankedSkills } from "./skillRecents";

describe("skillNameFromLine", () => {
  it("extracts the skill name from a slash command line", () => {
    expect(skillNameFromLine("/plan add auth")).toBe("plan");
    expect(skillNameFromLine("  /ponytail:ponytail ")).toBe("ponytail:ponytail");
    expect(skillNameFromLine("/review")).toBe("review");
  });
  it("rejects lines that aren't slash commands", () => {
    expect(skillNameFromLine("npm run dev")).toBe(null);
    expect(skillNameFromLine("/")).toBe(null);
    expect(skillNameFromLine("")).toBe(null);
  });
});

describe("rankedSkills", () => {
  it("orders by count, highest first, capped at n", () => {
    const counts = { plan: 2, review: 5, ship: 1 };
    expect(rankedSkills(counts, 8)).toEqual(["review", "plan", "ship"]);
    expect(rankedSkills(counts, 2)).toEqual(["review", "plan"]);
  });
});
