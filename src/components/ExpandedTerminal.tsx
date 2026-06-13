import { useEffect, useRef, useState, type CSSProperties } from "react";
import TerminalPane from "./TerminalPane";
import { terminalWrite } from "../lib/ipc";
import { useTerminalsStore, type OpenTerminal } from "../store/terminals";
import type { Attention } from "../store/ledger";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";
import { LockIcon, LockOpenIcon, PencilIcon, RefreshIcon } from "./icons";

/*
 * ExpandedTerminal: one terminal rendered inline beneath its ledger row — the
 * mockup's "● terminal — live" panel. It owns the minimal panel header (live
 * dot + label, full-screen + collapse + ⋯ menu) and a bottom hint bar; the
 * terminal body itself is a `chromeless` TerminalPane (its own header is
 * suppressed). The pane is the SAME mounted instance the rows list owns — this
 * component only frames it, so the PTY invariant is untouched.
 */

const QUICK_KEYS: { label: string; data: string; title: string }[] = [
  { label: "1", data: "1", title: "Send 1 to the agent" },
  { label: "2", data: "2", title: "Send 2 to the agent" },
  { label: "3", data: "3", title: "Send 3 to the agent" },
  { label: "↩", data: "\r", title: "Send Enter" },
  { label: "esc", data: "\x1b", title: "Send Escape (interrupt)" },
];

export function attentionDotColor(attention: Attention | undefined): string {
  if (attention?.kind === "input") return "var(--accent)";
  if (attention?.kind === "failed") return "var(--status-error)";
  return "var(--status-success)";
}

export interface ExpandedTerminalProps {
  pane: OpenTerminal;
  title: string;
  locked: boolean;
  hasCustomName: boolean;
  attention?: Attention;
  fullscreen: boolean;
  onToggleLock: () => void;
  onRename: (name: string) => void;
  onRemove: () => void; // already lock-guarded by the caller
  onToggleFullscreen: () => void;
  onCollapse: () => void;
  highlighted: boolean;
  onHighlightDone: () => void;
}

const headerBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  fontSize: 10,
  fontFamily: "var(--font-sans)",
  color: "var(--muted)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const quickBtn: CSSProperties = {
  padding: "2px 9px",
  fontSize: 10,
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
  color: "var(--fg)",
  background: "var(--surface-raised)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export default function ExpandedTerminal({
  pane,
  title,
  locked,
  hasCustomName,
  attention,
  fullscreen,
  onToggleLock,
  onRename,
  onRemove,
  onToggleFullscreen,
  onCollapse,
  highlighted,
  onHighlightDone,
}: ExpandedTerminalProps) {
  const needsInput = attention?.kind === "input";
  // When several terminals are expanded at once, only one owns the keyboard.
  // Highlight it with a glow ring so it's obvious where keys are going. A
  // border-colour change alone wouldn't read (--accent and --focus-ring are the
  // same pink, so it'd clash with the needsInput border).
  const isFocused = useTerminalsStore(
    (s) => s.focusedWindowId === pane.windowId
  );
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renameDraft != null) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renameDraft != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitRename = () => {
    if (renameDraft != null) onRename(renameDraft);
    setRenameDraft(null);
  };

  // The live/status label: "live" while running, or the attention word.
  const stateWord = needsInput
    ? "input needed"
    : attention?.kind === "failed"
    ? "failed"
    : attention?.kind === "done"
    ? "done"
    : "live";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        margin: "0 12px 10px",
        border: `1px solid ${
          isFocused || needsInput ? "var(--focus-ring)" : "var(--border)"
        }`,
        borderRadius: "0 var(--radius-lg) var(--radius-lg) var(--radius-lg)",
        overflow: "hidden",
        background: "var(--bg)",
        boxShadow: isFocused
          ? "0 0 0 1px var(--focus-ring), 0 0 16px -2px rgba(240, 47, 194, 0.45)"
          : "none",
        transition:
          "box-shadow var(--dur-state) var(--ease-out-quart), border-color var(--dur-state) var(--ease-out-quart)",
      }}
    >
      {/* Panel header bar: ● terminal — live  ····  ↗ full screen  collapse ▴ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 26,
          flexShrink: 0,
          padding: "0 8px",
          background: "var(--surface-raised)",
          borderBottom: "1px solid var(--border)",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--muted)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flexShrink: 0,
            background: attentionDotColor(attention),
          }}
        />
        {renameDraft != null ? (
          <input
            ref={renameRef}
            value={renameDraft}
            placeholder={title}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenameDraft(null);
              }
            }}
            style={{
              width: 200,
              fontSize: 11,
              color: "var(--fg)",
              background: "var(--input-bg)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              padding: "1px 4px",
            }}
          />
        ) : (
          <span style={{ color: "var(--fg)" }}>
            {title} — {stateWord}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {needsInput && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {QUICK_KEYS.map((k) => (
              <button
                key={k.label}
                title={k.title}
                style={{
                  ...quickBtn,
                  borderColor:
                    k.label === "1" ? "var(--accent)" : "var(--border)",
                  color: k.label === "1" ? "var(--accent)" : "var(--fg)",
                }}
                onClick={() => {
                  terminalWrite(pane.paneId, k.data).catch(() => {});
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}

        <button style={headerBtn} onClick={onToggleFullscreen}>
          {fullscreen ? "❐ exit full screen" : "⤢ full screen"}
        </button>
        <button style={headerBtn} onClick={onCollapse} title="Collapse">
          collapse ▴
        </button>
        <button
          style={headerBtn}
          aria-haspopup="menu"
          title="More"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.right - 150, r.bottom + 2);
          }}
        >
          ⋯
        </button>
      </div>

      {/* Terminal body — the same mounted pane, chrome supplied above. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <TerminalPane
          pane={pane}
          title={title}
          chromeless
          maximized={fullscreen}
          locked={locked}
          hasCustomName={hasCustomName}
          onToggleLock={onToggleLock}
          onRename={onRename}
          onRemove={onRemove}
          onToggleMaximize={onToggleFullscreen}
          highlighted={highlighted}
          onHighlightDone={onHighlightDone}
        />
      </div>

      {/* Hint bar */}
      <div
        style={{
          flexShrink: 0,
          height: 22,
          display: "flex",
          alignItems: "center",
          padding: "0 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--surface-raised)",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--muted)",
        }}
      >
        <span style={{ color: needsInput ? "var(--accent)" : "var(--muted)" }}>
          ❯
        </span>
        <span style={{ flex: 1 }} />
        <span>live — keys go to the agent · ↩ confirm · esc interrupt</span>
      </div>

      {menu && (
        <ContextMenu position={menu} onClose={closeMenu} minWidth={150}>
          <button
            style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            onClick={() => {
              setRenameDraft(title);
              closeMenu();
            }}
          >
            <PencilIcon size={14} />
            <span>Rename</span>
          </button>
          {hasCustomName && (
            <button
              style={menuItemStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              onClick={() => {
                onRename("");
                closeMenu();
              }}
            >
              <RefreshIcon size={14} />
              <span>Reset name</span>
            </button>
          )}
          <button
            style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            onClick={() => {
              onToggleLock();
              closeMenu();
            }}
          >
            {locked ? <LockOpenIcon size={14} /> : <LockIcon size={14} />}
            <span>{locked ? "Unlock" : "Lock"}</span>
          </button>
          <button
            style={{
              ...menuItemStyle,
              opacity: locked ? 0.4 : 1,
              cursor: locked ? "not-allowed" : "pointer",
            }}
            disabled={locked}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            onClick={() => {
              onRemove();
              closeMenu();
            }}
          >
            <span style={{ width: 14, textAlign: "center" }}>×</span>
            <span>{locked ? "Locked — unlock to close" : "Close terminal"}</span>
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
