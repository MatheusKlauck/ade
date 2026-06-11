import { describe, it, expect } from "vitest";
import { contrastingTextColor } from "./color";

describe("contrastingTextColor", () => {
  it("picks dark ink on the light default accent (#4a9eff)", () => {
    expect(contrastingTextColor("#4a9eff")).toBe("#1a1a1a");
  });

  it("picks white on a deep/navy accent", () => {
    expect(contrastingTextColor("#0b3d91")).toBe("#ffffff");
  });

  it("picks dark ink on a near-white background", () => {
    expect(contrastingTextColor("#fafafa")).toBe("#1a1a1a");
  });

  it("picks white on a near-black background", () => {
    expect(contrastingTextColor("#111111")).toBe("#ffffff");
  });

  it("handles 3-digit hex", () => {
    expect(contrastingTextColor("#fff")).toBe("#1a1a1a");
  });

  it("falls back to white on invalid input", () => {
    expect(contrastingTextColor("not-a-color")).toBe("#ffffff");
  });
});
