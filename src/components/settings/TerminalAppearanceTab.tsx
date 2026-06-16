import { useCallback, useMemo } from "react";
import { useSettingsStore } from "../../store/settings";
import type { TerminalAppearance } from "../../store/settings";
import { contrastRatioHex } from "../../lib/color";
import { FieldStatus, fieldStyle, sectionLabelStyle, type SaveState } from "./shared";

// Quoted where the family name has spaces so it survives as a CSS font-family.
const FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "System default" },
  { value: "Menlo", label: "Menlo" },
  { value: "Monaco", label: "Monaco" },
  { value: "'SF Mono'", label: "SF Mono" },
  { value: "Consolas", label: "Consolas" },
  { value: "'JetBrains Mono'", label: "JetBrains Mono" },
  { value: "'Fira Code'", label: "Fira Code" },
  { value: "'Cascadia Code'", label: "Cascadia Code" },
  { value: "'Courier New'", label: "Courier New" },
];

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24] as const;

// background/foreground pairs — one click to a coherent look.
const THEME_PRESETS: ReadonlyArray<{
  name: string;
  background: string;
  foreground: string;
}> = [
  { name: "Midnight", background: "#0b0e14", foreground: "#e6e6e6" },
  { name: "Dracula", background: "#282a36", foreground: "#f8f8f2" },
  { name: "Nord", background: "#2e3440", foreground: "#d8dee9" },
  { name: "Solarized Dark", background: "#002b36", foreground: "#839496" },
  { name: "Solarized Light", background: "#fdf6e3", foreground: "#586e75" },
  { name: "Paper", background: "#f5f5f5", foreground: "#1a1a1a" },
];

const CURSOR_OPTIONS: ReadonlyArray<{
  value: TerminalAppearance["cursorStyle"];
  label: string;
}> = [
  { value: "bar", label: "Bar" },
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
];

const selectStyle = { ...fieldStyle, cursor: "pointer" } as const;

interface Props {
  status?: SaveState;
  onSaveResult: (state: SaveState) => void;
}

/** Terminal tab — look & feel: theme presets, font, colors, cursor, with a live
 * preview and a contrast guard so a custom palette can't go invisible. */
export default function TerminalAppearanceTab({ status, onSaveResult }: Props) {
  const appearance = useSettingsStore((s) => s.terminalAppearance);
  const setAppearance = useSettingsStore((s) => s.setTerminalAppearance);

  const update = useCallback(
    async (patch: Partial<TerminalAppearance>) => {
      try {
        await setAppearance({ ...appearance, ...patch });
        onSaveResult("saved");
      } catch {
        onSaveResult("error");
      }
    },
    [appearance, setAppearance, onSaveResult]
  );

  // Warn when text on the chosen background drops below the WCAG AA 4.5:1 line —
  // a near-invisible terminal is the footgun a color picker invites.
  const lowContrast = useMemo(() => {
    const r = contrastRatioHex(appearance.foreground, appearance.background);
    return r !== null && r < 4.5 ? r : null;
  }, [appearance.foreground, appearance.background]);

  return (
    <div style={{ maxWidth: 560, marginBottom: 24 }}>
      <label style={sectionLabelStyle}>
        Terminal Appearance
        <FieldStatus state={status} />
      </label>

      {/* Theme presets — the quick path to a coherent look. */}
      <div
        role="radiogroup"
        aria-label="Terminal theme preset"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}
      >
        {THEME_PRESETS.map((p) => {
          const selected =
            appearance.background.toLowerCase() === p.background.toLowerCase() &&
            appearance.foreground.toLowerCase() === p.foreground.toLowerCase();
          return (
            <button
              key={p.name}
              role="radio"
              aria-checked={selected}
              title={p.name}
              onClick={() =>
                update({ background: p.background, foreground: p.foreground })
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                fontSize: 12,
                background: p.background,
                color: p.foreground,
                border: selected
                  ? "2px solid var(--accent)"
                  : "1px solid var(--border)",
                borderRadius: 6,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              Aa <span style={{ opacity: 0.8 }}>{p.name}</span>
            </button>
          );
        })}
      </div>

      {/* Font family + size. */}
      <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
        <label style={{ flex: 1 }}>
          <span style={sectionLabelStyle}>Font</span>
          <select
            aria-label="Terminal font family"
            value={appearance.fontFamily}
            onChange={(e) => update({ fontFamily: e.target.value })}
            style={{ ...selectStyle, width: "100%" }}
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span style={sectionLabelStyle}>Size</span>
          <select
            aria-label="Terminal font size"
            value={appearance.fontSize}
            onChange={(e) => update({ fontSize: parseInt(e.target.value, 10) })}
            style={{ ...selectStyle, width: 80 }}
          >
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Background + text colors. */}
      <div style={{ display: "flex", gap: 24, marginBottom: 14 }}>
        <ColorField
          label="Background"
          value={appearance.background}
          onChange={(v) => update({ background: v })}
        />
        <ColorField
          label="Text"
          value={appearance.foreground}
          onChange={(v) => update({ foreground: v })}
        />
      </div>

      {/* Cursor style + blink. */}
      <div
        style={{ display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 14 }}
      >
        <label>
          <span style={sectionLabelStyle}>Cursor</span>
          <select
            aria-label="Cursor style"
            value={appearance.cursorStyle}
            onChange={(e) =>
              update({
                cursorStyle: e.target.value as TerminalAppearance["cursorStyle"],
              })
            }
            style={{ ...selectStyle, width: 140 }}
          >
            {CURSOR_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--fg)",
            cursor: "pointer",
            paddingBottom: 8,
          }}
        >
          <input
            type="checkbox"
            checked={appearance.cursorBlink}
            onChange={(e) => update({ cursorBlink: e.target.checked })}
          />
          Blink
        </label>
      </div>

      {/* Live preview — the chosen colors and font on a sample shell line. */}
      <div
        aria-hidden
        style={{
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: appearance.background,
          color: appearance.foreground,
          fontFamily: appearance.fontFamily || "var(--font-mono)",
          fontSize: appearance.fontSize,
          lineHeight: 1.5,
          padding: "10px 12px",
          overflow: "hidden",
        }}
      >
        <div>$ git status</div>
        <div style={{ opacity: 0.85 }}>On branch main</div>
        <div>
          nothing to commit, working tree clean
          <CursorGlyph appearance={appearance} />
        </div>
      </div>

      {lowContrast !== null && (
        <p
          role="status"
          aria-live="polite"
          style={{
            margin: "10px 0 0",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--status-warning-text)",
          }}
        >
          ⚠ Text on this background is only {lowContrast.toFixed(1)}:1 — below the
          4.5:1 needed to stay comfortably readable.
        </p>
      )}
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label>
      <span style={sectionLabelStyle}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} color`}
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
          style={{ fontSize: 13, color: "var(--fg)", fontFamily: "var(--font-mono)" }}
        >
          {value}
        </span>
      </div>
    </label>
  );
}

/** Non-blinking cursor sample shaped to the chosen style (the real terminal
 * handles blink itself). */
function CursorGlyph({ appearance }: { appearance: TerminalAppearance }) {
  const { cursorStyle, foreground, fontSize } = appearance;
  return (
    <span
      style={{
        display: "inline-block",
        marginLeft: 3,
        background: foreground,
        verticalAlign: cursorStyle === "underline" ? "bottom" : "middle",
        width: cursorStyle === "bar" ? 2 : Math.round(fontSize * 0.6),
        height: cursorStyle === "underline" ? 2 : fontSize,
      }}
    />
  );
}
