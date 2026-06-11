import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  terminalClose,
  terminalResize,
  terminalWrite,
} from "../lib/ipc";
import type { OpenTerminal } from "../store/terminals";
import { useTerminalsStore } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import { LockIcon, LockOpenIcon } from "./icons";

interface TerminalPaneProps {
  pane: OpenTerminal;
  title: string;
  maximized?: boolean;
  locked?: boolean;
  onToggleLock?: () => void;
  onRemove: () => void;
  onToggleMinimize?: () => void;
  onToggleMaximize?: () => void;
  highlighted?: boolean;
  onHighlightDone?: () => void;
}

const iconBtnStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--muted)",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
};

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  borderRadius: "var(--radius-sm)",
  color: "var(--fg)",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

export default function TerminalPane({
  pane,
  title,
  maximized,
  locked,
  onToggleLock,
  onRemove,
  onToggleMinimize,
  onToggleMaximize,
  highlighted,
  onHighlightDone,
}: TerminalPaneProps) {
  // Position of the header context menu (right-click), or null when closed.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<{ dispose: () => void } | null>(null);
  const flushRef = useRef<number | null>(null);
  const chunkBufRef = useRef<Uint8Array[]>([]);
  // Pending backend-close timer. See the cleanup below for the StrictMode rationale.
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // React.StrictMode (dev only) double-invokes effects on mount:
    // setup → cleanup → setup. The cleanup tears down the BACKEND PTY pane
    // (terminalClose → kills the tmux viewer + drops it from the registry).
    // If that fired synchronously, the second setup would re-wire onData to a
    // dead pane and typing would silently no-op. Refs persist across the
    // double-invoke, so if a previous cleanup scheduled a deferred close, the
    // immediate re-setup cancels it here — keeping the live backend pane.
    // A real unmount has no re-setup, so the deferred close still fires.
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    const term = new Terminal({ cursorBlink: true });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    // Try WebGL renderer; fallback to canvas is automatic.
    import("@xterm/addon-webgl")
      .then((mod) => {
        const webgl = new mod.WebglAddon();
        webglRef.current = webgl;
        term.loadAddon(webgl);
      })
      .catch(() => {
        // canvas fallback is built-in
      });

    if (containerRef.current) {
      term.open(containerRef.current);
      fit.fit();
      // Focus immediately so keystrokes reach the shell without a click.
      term.focus();
    }

    // Data from user typing
    term.onData((data) => {
      terminalWrite(pane.paneId, data).catch(() => {});
    });

    // Wire channel
    pane.channel.onmessage = (msg: unknown) => {
      const buf = msg as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      chunkBufRef.current.push(bytes);

      if (flushRef.current == null) {
        flushRef.current = requestAnimationFrame(() => {
          const t = termRef.current;
          if (t) {
            for (const chunk of chunkBufRef.current) {
              t.write(chunk);
            }
          }
          chunkBufRef.current = [];
          flushRef.current = null;
        });
      }
    };

    // Resize observer
    const ro = new ResizeObserver(() => {
      fit.fit();
      const dims = fit.proposeDimensions();
      if (dims) {
        terminalResize(
          pane.paneId,
          Math.floor(dims.cols),
          Math.floor(dims.rows)
        ).catch(() => {});
      }
    });
    if (containerRef.current) {
      ro.observe(containerRef.current);
    }

    // Track keyboard focus for this terminal. focusin/focusout bubble up from
    // xterm's hidden textarea. The focused terminal is the one you're watching,
    // so the alert monitor suppresses its completions, and focusing it clears
    // any badge already accumulated for its workspace.
    const focusEl = containerRef.current;
    const onFocusIn = () => {
      useTerminalsStore.getState().setFocusedWindow(pane.windowId);
      useWorkspacesStore.getState().clearTerminalAlerts(pane.workspaceId);
    };
    const onFocusOut = () => {
      const st = useTerminalsStore.getState();
      if (st.focusedWindowId === pane.windowId) st.setFocusedWindow(null);
    };
    focusEl?.addEventListener("focusin", onFocusIn);
    focusEl?.addEventListener("focusout", onFocusOut);

    return () => {
      ro.disconnect();
      focusEl?.removeEventListener("focusin", onFocusIn);
      focusEl?.removeEventListener("focusout", onFocusOut);
      const ts = useTerminalsStore.getState();
      if (ts.focusedWindowId === pane.windowId) ts.setFocusedWindow(null);
      if (flushRef.current != null) {
        cancelAnimationFrame(flushRef.current);
        flushRef.current = null;
      }
      if (webglRef.current) {
        try {
          webglRef.current.dispose();
        } catch {}
        webglRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      // Defer the backend close so a StrictMode synthetic remount can cancel it
      // (see the setup above). On a real unmount nothing re-runs the setup, so
      // this fires ~100ms later and closes the PTY viewer (kills viewer process,
      // tmux window survives). The deterministic pane_id means the cancelled
      // case keeps using the same live backend pane.
      const paneId = pane.paneId;
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        terminalClose(paneId).catch(() => {});
      }, 100);
    };
  }, [pane.paneId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight effect: scroll into view and add brief glow
  useEffect(() => {
    if (!highlighted) return;
    // Scroll the pane into view
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Clear highlight after 1 second
    const timer = setTimeout(() => {
      onHighlightDone?.();
    }, 1000);
    return () => clearTimeout(timer);
  }, [highlighted, onHighlightDone]);

  // Dismiss the header context menu on Escape.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  return (
    <div
      className={highlighted ? "terminal-pane-highlight" : undefined}
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
        }}
      >
        {locked && (
          <LockIcon size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
        )}
        <span
          title={title}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            color: "var(--fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        <button
          style={iconBtnStyle}
          title="Minimize"
          aria-label="Minimize terminal"
          onClick={onToggleMinimize}
        >
          —
        </button>
        <button
          style={iconBtnStyle}
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore terminal" : "Maximize terminal"}
          onClick={onToggleMaximize}
        >
          {maximized ? "❐" : "▢"}
        </button>
        <button
          style={{
            ...iconBtnStyle,
            opacity: locked ? 0.4 : 1,
            cursor: locked ? "not-allowed" : "pointer",
          }}
          title={locked ? "Locked — unlock to close" : "Close"}
          aria-label="Close terminal"
          disabled={locked}
          onClick={onRemove}
        >
          ×
        </button>
      </div>

      {menu && (
        <>
          {/* Full-screen backdrop swallows the next click/right-click so the
              menu closes when you act anywhere outside it. */}
          <div
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 1000 }}
          />
          <div
            style={{
              position: "fixed",
              top: menu.y,
              left: menu.x,
              zIndex: 1001,
              minWidth: 150,
              padding: 4,
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
            }}
          >
            <button
              style={menuItemStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--panel)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
              onClick={() => {
                onToggleLock?.();
                setMenu(null);
              }}
            >
              {locked ? <LockOpenIcon size={14} /> : <LockIcon size={14} />}
              <span>{locked ? "Unlock" : "Lock"}</span>
            </button>
          </div>
        </>
      )}
      <div
        ref={containerRef}
        onMouseDown={() => termRef.current?.focus()}
        style={{ flex: 1, minHeight: 0, background: "#000" }}
      />
    </div>
  );
}