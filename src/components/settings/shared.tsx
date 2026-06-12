import type { CSSProperties } from "react";

/** Per-control persistence outcome. Settings auto-saves on change/blur, so each
 * field needs to confirm the write actually landed — silence after a failed IPC
 * write is exactly the "is it saved?" ambiguity we're closing. */
export type SaveState = "saved" | "error";

/** Section label shared across tabs — the visual head of each control group. */
export const sectionLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  color: "var(--muted)",
  marginBottom: 8,
};

/** Inline, field-scoped error text. */
export const errorTextStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--status-error-text)",
};

/** A token-style text field used by the sync + token inputs. */
export const fieldStyle: CSSProperties = {
  boxSizing: "border-box",
  padding: "8px 12px",
  fontSize: 13,
  background: "var(--input-bg)",
  border: "1px solid var(--input-border)",
  borderRadius: 4,
  color: "var(--fg)",
};

/** Transient inline confirmation shown beside a control after it auto-saves.
 * `aria-live` so a screen reader announces the outcome without a focus move. */
export function FieldStatus({ state }: { state?: SaveState }) {
  if (!state) return null;
  const saved = state === "saved";
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        marginInlineStart: 8,
        fontSize: 11,
        fontWeight: 500,
        color: saved
          ? "var(--status-success-text)"
          : "var(--status-warning-text)",
      }}
    >
      {saved ? "✓ Saved" : "⚠ Not saved"}
    </span>
  );
}
