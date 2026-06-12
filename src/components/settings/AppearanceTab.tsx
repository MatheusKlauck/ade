import { useCallback, useMemo } from "react";
import { useSettingsStore } from "../../store/settings";
import { bestInkContrast, contrastRatioHex } from "../../lib/color";
import { FieldStatus, sectionLabelStyle, type SaveState } from "./shared";

/** On-brand accent presets. Each is a mid-luminance, saturated hue chosen to
 * clear WCAG against BOTH the near-black and near-white surfaces, so it carries
 * legible button text and stays visible as a selection/focus indicator in
 * either theme. The native color well stays as a "custom" escape hatch, gated
 * by the live contrast check below. */
const ACCENT_SWATCHES: ReadonlyArray<{ value: string; name: string }> = [
  { value: "#f02fc2", name: "Magenta" },
  { value: "#7c3aed", name: "Violet" },
  { value: "#0d9488", name: "Teal" },
  { value: "#16a34a", name: "Green" },
  { value: "#ea580c", name: "Orange" },
  { value: "#e11d48", name: "Rose" },
];

interface AppearanceTabProps {
  themeStatus?: SaveState;
  accentStatus?: SaveState;
  /** Report the auto-save outcome for a field so the modal-level status
   * flasher can show (and later clear) the inline confirmation. */
  onSaveResult: (field: "theme" | "accent", state: SaveState) => void;
}

/** Appearance tab: theme toggle + accent picker with a live contrast guard. */
export default function AppearanceTab({
  themeStatus,
  accentStatus,
  onSaveResult,
}: AppearanceTabProps) {
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setAccent = useSettingsStore((s) => s.setAccent);

  const handleThemeChange = useCallback(
    async (newTheme: string) => {
      try {
        await setTheme(newTheme);
        onSaveResult("theme", "saved");
      } catch {
        // The store already applied the theme to the DOM; surface that the
        // persist didn't land so the change isn't silently transient.
        onSaveResult("theme", "error");
      }
    },
    [setTheme, onSaveResult]
  );

  const handleAccentChange = useCallback(
    async (color: string) => {
      try {
        await setAccent(color);
        onSaveResult("accent", "saved");
      } catch {
        onSaveResult("accent", "error");
      }
    },
    [setAccent, onSaveResult]
  );

  // Live contrast guard for a custom accent. Evaluated against the SAME ink math
  // App.tsx uses for `--accent-ink`, and against the active theme's actual panel
  // surface — so the warnings reflect what the user will really see now. `theme`
  // is a dep so flipping themes re-checks against the new surfaces.
  const accentWarnings = useMemo(() => {
    const warnings: string[] = [];
    const ink = bestInkContrast(accent);
    if (ink && ink.ratio < 4.5) {
      warnings.push(
        `Button text on this accent is only ${ink.ratio.toFixed(
          1
        )}:1 — below the 4.5:1 needed to stay readable.`
      );
    }
    const panel = getComputedStyle(document.documentElement)
      .getPropertyValue("--panel")
      .trim();
    const vsPanel = panel ? contrastRatioHex(accent, panel) : null;
    if (vsPanel !== null && vsPanel < 3) {
      warnings.push(
        `This accent barely separates from the panel (${vsPanel.toFixed(
          1
        )}:1, needs 3:1), so selection, tabs, and focus rings will be hard to see.`
      );
    }
    return warnings;
  }, [accent, theme]);

  return (
    <div
      role="tabpanel"
      id="settings-panel-appearance"
      aria-labelledby="settings-tab-appearance"
      style={{ maxWidth: 560 }}
    >
      <div style={{ marginBottom: 20 }}>
        <label style={sectionLabelStyle}>
          Theme
          <FieldStatus state={themeStatus} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => handleThemeChange("dark")}
            aria-pressed={theme === "dark"}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background:
                theme === "dark" ? "var(--accent)" : "var(--input-bg)",
              color: theme === "dark" ? "var(--accent-ink)" : "var(--fg)",
              border:
                theme === "dark"
                  ? "1px solid var(--accent)"
                  : "1px solid var(--input-border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Dark
          </button>
          <button
            onClick={() => handleThemeChange("light")}
            aria-pressed={theme === "light"}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background:
                theme === "light" ? "var(--accent)" : "var(--input-bg)",
              color: theme === "light" ? "var(--accent-ink)" : "var(--fg)",
              border:
                theme === "light"
                  ? "1px solid var(--accent)"
                  : "1px solid var(--input-border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Light
          </button>
        </div>
      </div>

      <div>
        <label style={sectionLabelStyle}>
          Accent Color
          <FieldStatus state={accentStatus} />
        </label>

        {/* On-brand presets — the default, safe path. */}
        <div
          role="radiogroup"
          aria-label="Accent color preset"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {ACCENT_SWATCHES.map((swatch) => {
            const selected =
              accent.toLowerCase() === swatch.value.toLowerCase();
            const ink = bestInkContrast(swatch.value)?.ink ?? "var(--on-accent)";
            return (
              <button
                key={swatch.value}
                role="radio"
                aria-checked={selected}
                aria-label={swatch.name}
                title={swatch.name}
                onClick={() => handleAccentChange(swatch.value)}
                style={{
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  fontSize: 13,
                  lineHeight: 1,
                  color: ink,
                  background: swatch.value,
                  border: selected
                    ? "2px solid var(--fg)"
                    : "1px solid var(--border)",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                {selected ? "✓" : ""}
              </button>
            );
          })}
        </div>

        {/* Custom escape hatch + the resolved hex. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
          }}
        >
          <input
            type="color"
            value={accent}
            onChange={(e) => handleAccentChange(e.target.value)}
            aria-label="Custom accent color"
            style={{
              width: 40,
              height: 32,
              padding: 0,
              border: "1px solid var(--input-border)",
              borderRadius: 4,
              background: "var(--input-bg)",
              cursor: "pointer",
            }}
          />
          <span
            style={{
              fontSize: 13,
              color: "var(--fg)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {accent}
          </span>
        </div>

        {/* Live preview: the accent on the two surfaces that actually
            carry it — a filled button and a selected-tab underline. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 12,
          }}
        >
          <span
            aria-hidden
            style={{
              padding: "4px 12px",
              fontSize: 12,
              borderRadius: 4,
              background: "var(--accent)",
              color: "var(--accent-ink)",
            }}
          >
            Action
          </span>
          <span
            aria-hidden
            style={{
              fontSize: 12,
              paddingBottom: 3,
              color: "var(--fg)",
              borderBottom: "2px solid var(--accent)",
            }}
          >
            Selected
          </span>
        </div>

        {accentWarnings.length > 0 && (
          <div role="status" aria-live="polite" style={{ marginTop: 10 }}>
            {accentWarnings.map((w) => (
              <p
                key={w}
                style={{
                  margin: "0 0 4px",
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: "var(--status-warning-text)",
                }}
              >
                ⚠ {w}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
