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
import { useCommandFreqStore } from "../store/commandFrequency";
import { useSettingsStore, type TerminalAppearance } from "../store/settings";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";
import TerminalCommandBar from "./TerminalCommandBar";
import { BranchIcon, LockIcon, LockOpenIcon, PencilIcon, RefreshIcon } from "./icons";

/** Resolve the appearance blob into xterm constructor/option values. xterm
 * measures glyphs on a canvas, so fontFamily must be a real font stack — a CSS
 * var won't resolve there; "" falls back to the app's --font-mono. */
function xtermAppearance(a: TerminalAppearance) {
  const fontFamily =
    a.fontFamily ||
    getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono")
      .trim() ||
    "monospace";
  return {
    fontFamily,
    fontSize: a.fontSize,
    cursorStyle: a.cursorStyle,
    cursorBlink: a.cursorBlink,
    theme: {
      background: a.background,
      foreground: a.foreground,
      cursor: a.foreground,
    },
  };
}

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
  // "board" renders the compact stage header from the board mockup: a status
  // dot + title + branch chip + a lone close button (minimize/maximize move into
  // the right-click menu). "default" keeps the full inline button row.
  headerVariant?: "default" | "board";
  // Branch label shown beside the title in the board header (e.g. "issue-42").
  branch?: string | null;
  // Colour of the status dot in the board header (defaults to the muted hue).
  dotColor?: string;
  // When true, the activity comet orbits just OUTSIDE the border (the tiling
  // grid gives it room); otherwise it hugs the inner edge (the inline ledger
  // accordion, where there's no surrounding gap to orbit into).
  cometOutside?: boolean;
}

// Reconstruct the command lines a user types from the raw keystroke stream
// xterm hands us in onData. We only see local input here (the shell echo comes
// back as PTY output, not onData), so we replay basic line editing —
// printables append, backspace pops, ESC sequences (arrows/history) and other
// control keys are skipped — and emit a line each time Enter is pressed. It's a
// heuristic, not a shell: history-recalled or tab-completed text the shell
// redraws on its own never reaches us, so those runs are simply missed (never
// mis-recorded). The buffer is mutated in place via the ref and completed lines
// are returned.
function feedCommandBuffer(
  bufRef: { current: string },
  data: string
): string[] {
  const completed: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === "\r" || ch === "\n") {
      const line = bufRef.current.trim();
      bufRef.current = "";
      if (line) completed.push(line);
    } else if (code === 0x7f || code === 0x08) {
      // Backspace / delete.
      bufRef.current = bufRef.current.slice(0, -1);
    } else if (code === 0x1b) {
      // Escape sequence (arrow keys, Home/End, history nav, Alt-combos). Skip
      // its bytes so they don't land in the buffer: a CSI (\x1b[) or SS3
      // (\x1bO) intro runs until a letter/`~` terminator; a lone ESC or
      // Alt-<key> is just the next single byte.
      i++;
      if (data[i] === "[" || data[i] === "O") {
        i++;
        while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++;
      }
    } else if (code === 0x03 || code === 0x15) {
      // Ctrl-C (interrupt) / Ctrl-U (kill line) — abandon the current line.
      bufRef.current = "";
    } else if (code === 0x17) {
      // Ctrl-W — delete the previous word.
      bufRef.current = bufRef.current.replace(/\s*\S+\s*$/, "");
    } else if (code >= 0x20) {
      bufRef.current += ch;
    }
    // Other control bytes (Tab, etc.) are ignored.
  }
  // Guard against a runaway buffer if some unusual input never submits.
  if (bufRef.current.length > 1000) bufRef.current = "";
  return completed;
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
  headerVariant = "default",
  branch,
  dotColor,
  cometOutside,
}: TerminalPaneProps) {
  const isBoard = headerVariant === "board";
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

  // Output-activity tracking → the "agent working" affordances, kept in the
  // shared store (keyed by windowId) so a minimized terminal's tray chip mirrors
  // them while this pane is display:none. `working` drives the orbiting comet
  // while output is actively arriving; `veil` is a counter bumped when a burst
  // ends, replaying the attention sweep. workingRef is the local transition guard
  // so the channel handler (registered once) only writes the store on an actual
  // edge, not on every chunk.
  const activity = useTerminalsStore((s) => s.activityByWindow[pane.windowId]);
  const working = activity?.working ?? false;
  const veilKey = activity?.veil ?? 0;
  const workingRef = useRef(false);
  const burstActiveRef = useRef(false);
  const burstStartRef = useRef(0);
  // Stops the comet once output has gone quiet. Refreshed on every chunk; when it
  // fires the terminal is idle (agent done / sitting at a prompt), so the orbit
  // halts even though the user hasn't typed yet. See markActivity below.
  const idleTimerRef = useRef<number | null>(null);
  // Timestamp of the user's last keystroke. Output arriving right after a key is
  // just the shell echoing what was typed, not the agent producing — so it must
  // not drive the comet/veil. See markActivity below.
  const lastInputRef = useRef(0);
  // Accumulates the command line the user is currently typing, so a full line
  // can be recorded into the quick-command frequency store when Enter is hit.
  const cmdLineRef = useRef("");
  // Only the FIRST command submitted after the terminal opens is captured into
  // the quick-command store — that's the command that starts work in this
  // workspace (e.g. `claude`, `npm run dev`). One-way latch per pane: once the
  // first command is recorded, later commands in the same session are ignored.
  const firstCommandCapturedRef = useRef(false);
  // Dismisses the quick-command bar for good the moment a command is run (Enter
  // or a chip click). It's a one-way latch — once a command runs in this pane,
  // the bar stays gone for the rest of the pane's life (it comes back only on a
  // fresh pane / app restart).
  const [barDismissed, setBarDismissed] = useState(false);
  const dismissCommandBar = () => setBarDismissed(true);
  // The onData handler is registered once, so it reads the latest dismiss
  // function through a ref to avoid capturing a stale closure.
  const dismissCommandBarRef = useRef(dismissCommandBar);
  dismissCommandBarRef.current = dismissCommandBar;

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

    const term = new Terminal(
      xtermAppearance(useSettingsStore.getState().terminalAppearance)
    );
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

    const windowId = pane.windowId;
    const workspaceId = pane.workspaceId;
    const acts = useTerminalsStore.getState;

    // Data from user typing
    term.onData((data) => {
      lastInputRef.current = Date.now();
      // Reconstruct typed command lines. Only the first command submitted after
      // the terminal opens is recorded into the quick-command store — it's the
      // one that starts work in this workspace. The first submission also
      // dismisses the bar for good.
      const submitted = feedCommandBuffer(cmdLineRef, data);
      if (submitted.length > 0 && !firstCommandCapturedRef.current) {
        firstCommandCapturedRef.current = true;
        useCommandFreqStore.getState().record(workspaceId, submitted[0]);
      }
      if (submitted.length > 0) dismissCommandBarRef.current();
      // The user is typing again, so the terminal is back to awaiting input.
      // Stop the comet now (no veil — the burst was interrupted, not finished).
      burstActiveRef.current = false;
      if (idleTimerRef.current != null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (workingRef.current) {
        workingRef.current = false;
        acts().setTerminalWorking(windowId, false);
      }
      terminalWrite(pane.paneId, data).catch(() => {});
    });

    // Activity heuristic: sustained output = read mode (the agent is producing).
    // A short ramp keeps trivial blips from flashing the border. The comet spins
    // only while output keeps arriving: every chunk refreshes an idle timer, and
    // once output stays quiet for IDLE_OFF_MS the comet stops — so an agent that
    // has finished (sitting idle at a prompt) no longer orbits. Typing also stops
    // it immediately via the read→write handoff in term.onData.
    const RAMP_MS = 150;
    // Output landing within this window of a keystroke is treated as the echo of
    // the user's own typing and never starts a burst. Each keystroke refreshes
    // the window, so continuous typing stays animation-free.
    const INPUT_ECHO_MS = 250;
    // How long output must stay quiet before the comet halts. Generous enough to
    // ride out natural pauses within a single response (tool calls, thinking)
    // without flickering off, short enough that a stopped terminal settles fast.
    const IDLE_OFF_MS = 1200;
    const markActivity = () => {
      const now = Date.now();
      // Ignore keystroke echo: while the user is typing, neither the comet nor
      // the veil should fire — they mark agent output only.
      if (now - lastInputRef.current < INPUT_ECHO_MS) return;
      if (!burstActiveRef.current) {
        burstActiveRef.current = true;
        burstStartRef.current = now;
      }
      if (!workingRef.current && now - burstStartRef.current >= RAMP_MS) {
        workingRef.current = true;
        acts().setTerminalWorking(windowId, true);
      }
      // Refresh the idle-off timer: the comet keeps spinning while chunks flow
      // and stops once they stop. A fresh burst re-ramps from scratch.
      if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        burstActiveRef.current = false;
        if (workingRef.current) {
          workingRef.current = false;
          acts().setTerminalWorking(windowId, false);
          // Burst finished — sweep the attention veil once to mark "done".
          acts().bumpTerminalVeil(windowId);
        }
      }, IDLE_OFF_MS);
    };

    // Wire channel
    pane.channel.onmessage = (msg: unknown) => {
      const buf = msg as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      chunkBufRef.current.push(bytes);
      markActivity();

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
      if (idleTimerRef.current != null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      workingRef.current = false;
      burstActiveRef.current = false;
      // Drop this window's activity so a closed terminal leaves no stale comet.
      useTerminalsStore.getState().clearTerminalActivity(pane.windowId);
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

  // Apply live appearance changes (font, colors, cursor) without tearing down
  // the PTY-linked terminal. A font-size change reflows the grid even though the
  // container size is unchanged — the ResizeObserver won't fire — so refit and
  // tell the backend the new cols/rows explicitly.
  const appearance = useSettingsStore((s) => s.terminalAppearance);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const o = xtermAppearance(appearance);
    term.options.fontFamily = o.fontFamily;
    term.options.fontSize = o.fontSize;
    term.options.cursorStyle = o.cursorStyle;
    term.options.cursorBlink = o.cursorBlink;
    term.options.theme = o.theme;
    fitRef.current?.fit();
    terminalResize(pane.paneId, term.cols, term.rows).catch(() => {});
  }, [appearance, pane.paneId]);

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
      data-testid={`terminal-pane-${pane.windowId}`}
      className={[
        "ade-term-pane",
        "ade-comet",
        cometOutside && "ade-comet--outside",
        working && "ade-term-visible",
        working && "ade-term-working",
        highlighted && "terminal-pane-highlight",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        opacity: reordering ? 0.5 : 1,
        transition: "opacity var(--dur-instant) var(--ease-out-quart)",
      }}
    >
      {/* Inner clip: rounds + clips the terminal content and the veil so they
          stay inside the border, while the comet (a pseudo-element on the host
          above) is free to orbit OUTSIDE it. Without this, a grid wrapper set to
          overflow:visible (so the comet can escape) would let the square content
          corners poke past the rounded border. */}
      <div
        className="ade-term-clip"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          borderRadius: cometOutside ? 4 : 0,
        }}
      >
      {/* Attention veil — remounted per burst-end (keyed) so the sweep replays. */}
      {veilKey > 0 && (
        <div key={veilKey} className="ade-term-done-veil" aria-hidden />
      )}
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
          gap: isBoard ? 8 : 6,
          padding: isBoard ? "5px 8px 5px 10px" : "4px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          // The header doubles as the drag handle for rearranging panes.
          cursor: renameDraft != null ? "default" : "grab",
        }}
      >
        {/* Leading marker: lock takes precedence; otherwise the board variant
            shows a coloured status dot. */}
        {locked ? (
          <LockIcon size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
        ) : isBoard ? (
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: dotColor ?? "var(--muted)",
            }}
          />
        ) : null}
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
            onDoubleClick={() => onToggleMaximize?.()}
            style={{
              flexShrink: isBoard ? 1 : undefined,
              flex: isBoard ? undefined : 1,
              minWidth: 0,
              fontSize: isBoard ? 12.5 : 12,
              fontWeight: isBoard ? 600 : 400,
              color: "var(--fg)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </span>
        )}
        {isBoard && branch && renameDraft == null && (
          <span
            title={branch}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--muted)",
            }}
          >
            <BranchIcon size={11} />
            {branch}
          </span>
        )}
        {/* Spacer pushes the close button to the far right in the board header,
            where minimize/maximize live in the right-click menu instead. */}
        {isBoard && <div style={{ flex: 1, minWidth: 8 }} />}
        {!isBoard && (
          <>
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
          </>
        )}
        <button
          style={{
            ...iconBtnStyle,
            ...(isBoard ? { border: "none", width: 20, height: 20 } : null),
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
            {/* Board header hides the inline min/max buttons — surface them here. */}
            {isBoard && (
              <>
                <button
                  style={menuItemStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--panel)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    onToggleMinimize?.();
                    closeMenu();
                  }}
                >
                  <span style={{ width: 14, textAlign: "center" }}>—</span>
                  <span>Minimize</span>
                </button>
                <button
                  style={menuItemStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--panel)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    onToggleMaximize?.();
                    closeMenu();
                  }}
                >
                  <span style={{ width: 14, textAlign: "center" }}>
                    {maximized ? "❐" : "▢"}
                  </span>
                  <span>{maximized ? "Restore" : "Maximize"}</span>
                </button>
              </>
            )}
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
          background: appearance.background,
          outline: dragOver ? "2px solid var(--accent)" : "none",
          outlineOffset: "-2px",
        }}
      />
      </div>
      {/* Quick-command bar: the workspace's most-used commands, one click to
          re-run. Lives outside the clip so it sits flush at the pane's bottom
          edge, and only on chromed grid panes (the inline ledger terminal has
          its own footer). */}
      {!chromeless && !barDismissed && (
        <TerminalCommandBar
          paneId={pane.paneId}
          workspaceId={pane.workspaceId}
          onInject={() => {
            termRef.current?.focus();
            dismissCommandBar();
          }}
        />
      )}
    </div>
  );
}

// Memoized so divider drags (which re-render TerminalArea per pointermove)
// don't re-render every pane; TerminalArea passes stable callbacks.
export default memo(TerminalPane);