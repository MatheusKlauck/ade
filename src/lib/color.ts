// Auto-contrast text color for a given background.
//
// ADE's accent is user-configurable (Settings → Accent Color), so text sitting
// on an accent-filled button can't use a fixed white/black and stay legible.
// This picks the WCAG-higher-contrast option (near-black vs white) for whatever
// accent the user chose, keeping primary buttons readable across the gamut.

const DARK_INK = "#1a1a1a";
const LIGHT_INK = "#ffffff";

/** WCAG relative luminance of a hex color, or null if it can't be parsed. */
function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (v: number) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Returns the text color (#1a1a1a or #ffffff) with the higher contrast against
 * `bg`. Falls back to white for unparseable input.
 */
export function contrastingTextColor(bg: string): string {
  const L = relativeLuminance(bg);
  if (L === null) return LIGHT_INK;
  const darkL = relativeLuminance(DARK_INK) as number;
  const lightL = relativeLuminance(LIGHT_INK) as number;
  return contrastRatio(L, darkL) >= contrastRatio(L, lightL)
    ? DARK_INK
    : LIGHT_INK;
}
