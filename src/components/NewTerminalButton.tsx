import { useEffect, useRef, useState } from "react";
import { useSettingsStore, type TerminalPreset } from "../store/settings";
import { ChevronIcon } from "./icons";
import { menuItemBlockStyle as menuItemStyle } from "./ContextMenu";

// The coding agents ADE can launch directly. Each opens a plain terminal that
// runs the agent CLI via an ad-hoc preset (presets already drive the launch
// path); ADE's shell wrappers add the turn-state shims, so the comet/veil/pulse
// and session resume work the same as for a hand-typed `claude`/`pi`/`opencode`.
const AGENTS = ["claude", "pi", "opencode"] as const;

const agentPreset = (name: string): TerminalPreset => ({
  id: `agent-${name}`,
  name,
  openCommands: [name],
  closeCommands: [],
  delaySecs: 0,
  injectTask: false,
});

/** Split "New terminal" control: the main button opens a plain shell, the caret
 * opens a menu of agent quick-launches and the workspace's terminal presets.
 * Each preset opens a terminal that runs its command (and, when applicable,
 * injects the task prompt). */
export default function NewTerminalButton({
  onNewTerminal,
}: {
  onNewTerminal: (preset?: TerminalPreset) => void;
}) {
  const presets = useSettingsStore((s) => s.presets);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the menu on any outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (preset?: TerminalPreset) => {
    setOpen(false);
    onNewTerminal(preset);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => pick()}
        style={{
          padding: "4px 12px",
          background: "var(--accent)",
          color: "var(--accent-ink)",
          border: "none",
          borderRadius: "4px 0 0 4px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        New terminal
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Open with a preset"
        style={{
          padding: "4px 6px",
          background: "var(--accent)",
          color: "var(--accent-ink)",
          border: "none",
          borderLeft: "1px solid var(--accent-ink)",
          borderRadius: "0 4px 4px 0",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        <ChevronIcon size={12} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 200,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            zIndex: "var(--z-modal)",
            padding: 4,
            overflow: "hidden",
          }}
        >
          <button role="menuitem" onClick={() => pick()} style={menuItemStyle}>
            Plain shell
          </button>
          <div
            style={{ height: 1, background: "var(--border)", margin: "4px 0" }}
          />
          {AGENTS.map((a) => (
            <button
              key={a}
              role="menuitem"
              onClick={() => pick(agentPreset(a))}
              title={a}
              style={menuItemStyle}
            >
              New with {a}
            </button>
          ))}
          {presets.length > 0 && (
            <div
              style={{
                height: 1,
                background: "var(--border)",
                margin: "4px 0",
              }}
            />
          )}
          {presets.length === 0 ? (
            <div
              style={{
                padding: "6px 10px",
                fontSize: 12,
                color: "var(--muted)",
              }}
            >
              No presets — add them in Settings.
            </div>
          ) : (
            presets.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                onClick={() => pick(p)}
                title={p.openCommands.join(" && ") || undefined}
                style={menuItemStyle}
              >
                New with {p.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
