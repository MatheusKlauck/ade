import { memo, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  boardGet,
  cardMove,
  terminalClose,
  terminalResize,
  terminalWrite,
} from "../lib/ipc";
import { COL_DOING } from "../lib/columns";
import { useBoardStore } from "../store/board";
import type { OpenTerminal } from "../store/terminals";
import { useTerminalsStore } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";
import { LockIcon, LockOpenIcon, PencilIcon, RefreshIcon } from "./icons";

interface TerminalPaneProps {
  pane: OpenTerminal;
  title: string;
  maximized?: boolean;
  locked?: boolean;
  hasCustomName?: boolean;
  onToggleLock?: () => void;
  onRename?: (name: string) => void;
  onRemove: () => void;
  onToggleMinimize?: () => void;
  onToggleMaximize?: () => void;
  highlighted?: boolean;
  onHighlightDone?: () => void;
  // Render only the terminal body (no built-in header/controls). The inline
  // accordion supplies its own minimal panel header instead, but the xterm host,
  // its PTY wiring, the card-drop target and focus tracking are unchanged — so
  // the pane is the same mounted instance either way (PTY invariant intact).
  chromeless?: boolean;
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

function TerminalPane({
  pane,
  title,
  maximized,
  locked,
  hasCustomName,
  onToggleLock,
  onRename,
  onRemove,
  onToggleMinimize,
  onToggleMaximize,
  highlighted,
  onHighlightDone,
  chromeless,
}: TerminalPaneProps) {
  // Header context menu (right-click); Escape-to-dismiss is built in.
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  // Draft custom name while the header title is being edited, or null when not.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // True while this pane's header is being dragged to a new position, used to
  // dim the pane so the drop target stands out.
  const [reordering, setReordering] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  // Mirrors `renameDraft != null` so the drag adapter's canDrag (registered
  // once) can read the latest editing state without re-registering on keystroke.
  const editingRef = useRef(false);
  editingRef.current = renameDraft != null;
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

    // Resize observer. Divider drags fire this per animation frame for every
    // affected pane; fit() reflows the whole xterm buffer and terminalResize
    // is an IPC round-trip, so debounce to the trailing edge and skip the IPC
    // call when the grid size didn't actually change.
    let resizeTimer: number | null = null;
    let lastDims: { cols: number; rows: number } | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer != null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        const dims = fit.proposeDimensions();
        if (!dims) return;
        fit.fit();
        const cols = Math.floor(dims.cols);
        const rows = Math.floor(dims.rows);
        if (lastDims && lastDims.cols === cols && lastDims.rows === rows) {
          return;
        }
        lastDims = { cols, rows };
        terminalResize(pane.paneId, cols, rows).catch(() => {});
      }, 80);
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
      if (resizeTimer != null) window.clearTimeout(resizeTimer);
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

  // Drop target: accept card drags and inject title + description as shell comments.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => typeof source.data.cardTitle === "string",
      onDragEnter: () => setDragOver(true),
      onDragLeave: () => setDragOver(false),
      onDrop: ({ source }) => {
        setDragOver(false);
        const title = source.data.cardTitle as string;
        const body = source.data.cardBodyPreview as string | null;
        const cardId = source.data.cardId as string;
        const currentColumnId = source.data.columnId as string;

        // Inject title + description as shell comments (no-op lines).
        const lines = [`# ${title}`];
        if (body) {
          for (const line of body.split("\n")) {
            if (line.trim()) lines.push(`# ${line.trim()}`);
          }
        }
        terminalWrite(pane.paneId, lines.join("\r") + "\r").catch(() => {});

        // Move card to "Doing" if not already there.
        const board = useBoardStore.getState().boards[pane.workspaceId];
        const doingCol = board?.columns.find((c) => c.name === COL_DOING);
        if (doingCol && doingCol.id !== currentColumnId) {
          useBoardStore.getState().optimisticMove(pane.workspaceId, cardId, doingCol.id);
          cardMove(cardId, doingCol.id).catch(() => {
            // Backend rejected the move: re-fetch so the optimistic update
            // doesn't leave the card stranded in Doing.
            boardGet(pane.workspaceId)
              .then((b) =>
                useBoardStore
                  .getState()
                  .setBoard(pane.workspaceId, b.columns, b.cards)
              )
              .catch(() => {});
          });
        }
      },
    });
  }, [pane.paneId]);

  // Header is the drag handle for rearranging panes: it carries the stable
  // windowId so the terminal area can move this tile next to a drop target.
  // Disabled while renaming so text selection in the input isn't hijacked.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    return draggable({
      element: el,
      canDrag: () => !editingRef.current,
      getInitialData: () => ({ termWindowId: pane.windowId }),
      onDragStart: () => setReordering(true),
      onDrop: () => setReordering(false),
    });
  }, [pane.windowId]);

  // Focus and select the rename input when editing begins.
  useEffect(() => {
    if (renameDraft != null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renameDraft != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRename = () => {
    // Seed the draft with the current title so it can be edited in place.
    setRenameDraft(title);
    closeMenu();
  };
  const commitRename = () => {
    if (renameDraft != null) onRename?.(renameDraft);
    setRenameDraft(null);
  };

  return (
    <div
      className={highlighted ? "terminal-pane-highlight" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        opacity: reordering ? 0.5 : 1,
        transition: "opacity var(--dur-instant) var(--ease-out-quart)",
      }}
    >
      {!chromeless && (
      <div
        ref={headerRef}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          // The header doubles as the drag handle for rearranging panes.
          cursor: renameDraft != null ? "default" : "grab",
        }}
      >
        {locked && (
          <LockIcon size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
        )}
        {renameDraft != null ? (
          <input
            ref={renameInputRef}
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
            // Stop the right-click handler / drag adapter on the header from
            // hijacking interaction with the input.
            onContextMenu={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: "var(--fg)",
              background: "var(--input-bg)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              padding: "1px 4px",
            }}
          />
        ) : (
          <span
            title={title}
            onDoubleClick={() => onRename && startRename()}
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
        )}
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
      )}

      {!chromeless && menu && (
        <ContextMenu position={menu} onClose={closeMenu} minWidth={150}>
            <button
              style={menuItemStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--panel)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
              onClick={startRename}
            >
              <PencilIcon size={14} />
              <span>Rename</span>
            </button>
            {hasCustomName && (
              <button
                style={menuItemStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--panel)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                onClick={() => {
                  // An empty name clears the override; title reverts to the card.
                  onRename?.("");
                  closeMenu();
                }}
              >
                <RefreshIcon size={14} />
                <span>Reset name</span>
              </button>
            )}
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
                closeMenu();
              }}
            >
              {locked ? <LockOpenIcon size={14} /> : <LockIcon size={14} />}
              <span>{locked ? "Unlock" : "Lock"}</span>
            </button>
        </ContextMenu>
      )}
      <div
        ref={containerRef}
        onMouseDown={() => termRef.current?.focus()}
        style={{
          flex: 1,
          minHeight: 0,
          background: "#000",
          outline: dragOver ? "2px solid var(--accent)" : "none",
          outlineOffset: "-2px",
        }}
      />
    </div>
  );
}

// Memoized so divider drags (which re-render TerminalArea per pointermove)
// don't re-render every pane; TerminalArea passes stable callbacks.
export default memo(TerminalPane);