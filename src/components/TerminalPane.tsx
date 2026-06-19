import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
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
  claudeSessions,
  terminalClose,
  terminalResize,
  terminalWrite,
  worktreeAdd,
  worktreeRemove,
  type ClaudeSession,
} from "../lib/ipc";
// Lazy so Monaco (a few MB) only loads the first time a pane opens the Repo
// view — it stays out of the initial app bundle entirely.
const RepoDiffPanel = lazy(() => import("./RepoDiffPanel"));
import { COL_DOING } from "../lib/columns";
import { useBoardStore } from "../store/board";
import type { OpenTerminal } from "../store/terminals";
import { useTerminalsStore } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import { useCommandFreqStore } from "../store/commandFrequency";
import { useSkillRecentsStore, skillNameFromLine } from "../store/skillRecents";
import { useSettingsStore, type TerminalAppearance } from "../store/settings";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";
import GitControls from "./GitControls";
import TerminalCommandBar from "./TerminalCommandBar";
import { BranchIcon, LockIcon, LockOpenIcon, PencilIcon, RefreshIcon } from "./icons";

const TermGlyph = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4l3 4-3 4" /><path d="M8 12h6" />
  </svg>
);
// Diff glyph: a "+ line" over a "− line", the unified-diff shorthand.
const DiffGlyph = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
    <path d="M3 4.5h3M4.5 3v3" />
    <path d="M8.5 4.5H14" />
    <path d="M3 11.5h3" />
    <path d="M8.5 11.5H14" />
  </svg>
);

/** Compact "2h ago" / "3d ago" label from a Claude session's epoch-seconds mtime. */
function relativeSessionTime(epochSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSecs));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

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
  // "board" renders the compact stage header from the board mockup: macOS-style
  // traffic lights (close/minimize/maximize) + title + branch chip. "default"
  // keeps the full inline button row.
  headerVariant?: "default" | "board";
  // Branch label shown beside the title in the board header (e.g. "issue-42").
  branch?: string | null;
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
export function feedCommandBuffer(
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
      } else if (data[i] === "]") {
        // OSC (e.g. the terminal's colour-query reports, \x1b]10;rgb:…) —
        // runs until BEL or ST (ESC \). Without this its payload leaks into
        // the buffer and gets recorded as a bogus quick-command.
        i++;
        while (
          i < data.length &&
          data.charCodeAt(i) !== 0x07 &&
          !(data[i] === "\x1b" && data[i + 1] === "\\")
        )
          i++;
        if (data[i] === "\x1b") i++;
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

// Whether a pane's measured size is safe to push to the backend. A pane hidden
// via display:none (maximize/minimize/board relayout) reports a 0-size box, and
// xterm's FitAddon turns that into a degenerate 2x1 grid (Math.max(2,…)/Math.max(1,…))
// instead of bailing — sending that to tmux shrinks the window to 2x1 and mangles
// any running TUI, which only repaints on the next real resize. Skip while hidden
// (zero box) or when the proposed grid isn't a finite real size.
export function isUsableResize(
  clientWidth: number,
  clientHeight: number,
  dims: { cols: number; rows: number } | undefined | null
): dims is { cols: number; rows: number } {
  if (clientWidth === 0 || clientHeight === 0) return false;
  if (!dims) return false;
  return (
    Number.isFinite(dims.cols) &&
    Number.isFinite(dims.rows) &&
    dims.cols >= 2 &&
    dims.rows >= 1
  );
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

// One segment of the per-pane Terminal/Repo switcher. Active uses a 16% accent
// tint + accent ink (DESIGN.md reserves the solid accent, so the view chrome
// stays a tint, not a fill).
const segBtnStyle = (active: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  border: "none",
  borderRight: "1px solid var(--border)",
  background: active ? "rgba(240,47,194,0.16)" : "transparent",
  color: active ? "var(--accent)" : "var(--muted)",
  fontSize: 10,
  fontWeight: active ? 600 : 400,
  lineHeight: 1.6,
  cursor: "pointer",
});

// macOS-style traffic-light control (board header). The colour identifies the
// action — red close, yellow minimize, green maximize — and a disabled control
// (e.g. close on a locked pane) dims out.
const trafficStyle = (color: string, disabled: boolean): React.CSSProperties => ({
  width: 12,
  height: 12,
  flexShrink: 0,
  padding: 0,
  borderRadius: "50%",
  border: "none",
  background: color,
  opacity: disabled ? 0.4 : 1,
  cursor: disabled ? "not-allowed" : "pointer",
});

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
  cometOutside,
}: TerminalPaneProps) {
  const isBoard = headerVariant === "board";
  // Header context menu (right-click); Escape-to-dismiss is built in.
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  // Git controls popover, anchored to the branch chip. Separate menu instance so
  // it doesn't collide with the header right-click menu.
  const gitMenu = useContextMenu();
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const openGitMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    gitMenu.open(r.left, r.bottom + 4);
  };
  // Live branch (after a switch) wins over the prop the parent passed in.
  const displayBranch = gitBranch ?? branch;
  // Claude session picker: null = menu shows normal items; an array = menu shows
  // the resumable sessions ("Open session" was picked). Reset whenever the menu
  // closes so the next right-click starts on the normal items.
  const [sessionList, setSessionList] = useState<ClaudeSession[] | null>(null);
  const dismissMenu = () => {
    setSessionList(null);
    closeMenu();
  };
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
  // "Claude finished its turn and is waiting for you" — pulses the pane bg.
  const waiting = activity?.waiting ?? false;
  const workingRef = useRef(false);
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
  // Per-pane view switcher (Terminal | Repo-diffs) and worktree toggle. View
  // defaults to terminal so existing panes are unchanged. The Repo view and the
  // worktree action are wired as the next step — here this is the chrome only.
  const [view, setView] = useState<"terminal" | "repo">("terminal");
  const [worktree, setWorktree] = useState(false);
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [worktreeRoot, setWorktreeRoot] = useState<string | null>(null);
  const [worktreeBranch, setWorktreeBranch] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtError, setWtError] = useState<string | null>(null);

  // Single-quote a path for the shell. Paths come from our own worktree_add, so
  // the only metacharacter that can appear is a quote; escape it the POSIX way.
  const shq = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;

  const toggleWorktree = async (on: boolean) => {
    setWtError(null);
    setWtBusy(true);
    try {
      if (on) {
        const wt = await worktreeAdd(pane.workspaceId, pane.paneId);
        setWorktreePath(wt.path);
        setWorktreeRoot(wt.root);
        setWorktreeBranch(wt.branch);
        setWorktree(true);
        // Move the live shell into the isolated worktree.
        terminalWrite(pane.paneId, `cd ${shq(wt.path)}\n`);
      } else {
        const path = worktreePath;
        const root = worktreeRoot;
        setWorktree(false);
        setWorktreePath(null);
        setWorktreeBranch(null);
        // cd the shell out first, then drop the worktree. Non-force remove: if
        // it has uncommitted work git refuses and we keep it (no data loss).
        if (root) terminalWrite(pane.paneId, `cd ${shq(root)}\n`);
        if (path) {
          try {
            await worktreeRemove(pane.workspaceId, path);
          } catch (e) {
            setWtError(`Worktree mantido (tem mudanças): ${e}`);
          }
        }
      }
    } catch (e) {
      setWtError(String(e));
      setWorktree(false);
    } finally {
      setWtBusy(false);
    }
  };
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
      // Reconstruct typed command lines. Only the first command submitted after
      // the terminal opens is recorded into the quick-command store — it's the
      // one that starts work in this workspace. The first submission also
      // dismisses the bar for good.
      const submitted = feedCommandBuffer(cmdLineRef, data);
      // Quick-command capture is only for bare-shell panes. App panes (claude via
      // preset/card/resume) feed app input here, not shell commands — recording
      // it would surface `/compact` & co. as bogus quick-commands.
      if (
        pane.captureCommands &&
        submitted.length > 0 &&
        !firstCommandCapturedRef.current
      ) {
        firstCommandCapturedRef.current = true;
        useCommandFreqStore.getState().record(workspaceId, submitted[0]);
      }
      // Count every `/skill` typed into the terminal (e.g. into a Claude Code
      // session), not just skills dragged from the sidebar. record() ignores
      // names that aren't actual scanned skills.
      for (const line of submitted) {
        const skill = skillNameFromLine(line);
        if (skill) useSkillRecentsStore.getState().record(skill);
      }
      if (submitted.length > 0) dismissCommandBarRef.current();
      terminalWrite(pane.paneId, data).catch(() => {});
    });

    // The comet means "Claude is mid-turn", not merely "bytes are arriving". The
    // only authoritative signal for that is Claude Code's own footer, which shows
    // an "esc to interrupt" hint while — and only while — a turn is in flight. We
    // scan the live screen for it after each flush instead of inferring from output
    // cadence, so `npm run dev`, build logs, `tail -f` &c. never light the ring.
    // ponytail: single-string marker; widen the regex if the footer copy changes.
    const WORKING_MARKER = /esc to interrupt/i;
    const updateWorking = () => {
      const t = termRef.current;
      if (!t) return;
      // Once ADE's Claude hooks have spoken for this window (claude_hooks.rs),
      // they authoritatively own working/veil/waiting — back the screen-scrape
      // fallback off so the two don't fight. It stays active until the first
      // hook fires (or forever if hooks aren't installed).
      if (acts().activityByWindow[windowId]?.claude) return;
      const buf = t.buffer.active;
      let hit = false;
      for (let i = buf.baseY; i < buf.baseY + t.rows; i++) {
        const line = buf.getLine(i);
        if (line && WORKING_MARKER.test(line.translateToString(true))) {
          hit = true;
          break;
        }
      }
      if (hit === workingRef.current) return;
      workingRef.current = hit;
      acts().setTerminalWorking(windowId, hit);
      // Turn just ended — sweep the attention veil once to pull the eye back.
      if (!hit) acts().bumpTerminalVeil(windowId);
    };

    // Wire channel
    pane.channel.onmessage = (msg: unknown) => {
      const buf = msg as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      chunkBufRef.current.push(bytes);

      if (flushRef.current == null) {
        flushRef.current = requestAnimationFrame(() => {
          const t = termRef.current;
          const chunks = chunkBufRef.current;
          chunkBufRef.current = [];
          flushRef.current = null;
          if (t && chunks.length) {
            // updateWorking reads the parsed buffer, so it must run AFTER xterm
            // applies these writes — xterm.write is async, hence the last-chunk
            // callback rather than calling it inline after the loop.
            for (let i = 0; i < chunks.length; i++) {
              if (i === chunks.length - 1) t.write(chunks[i], updateWorking);
              else t.write(chunks[i]);
            }
          }
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
        const el = containerRef.current;
        const dims = fit.proposeDimensions();
        // A hidden pane (display:none) yields a degenerate 2x1 grid; pushing it
        // to tmux corrupts the view. Only fit + resize at a real size.
        if (!el || !isUsableResize(el.clientWidth, el.clientHeight, dims)) return;
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
      const ts = useTerminalsStore.getState();
      ts.setFocusedWindow(pane.windowId);
      // You're here now — stop the "waiting for input" pulse without waiting for
      // the next prompt submission to clear it.
      ts.setTerminalWaiting(pane.windowId, false);
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
      workingRef.current = false;
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
    // Skip the refit while hidden — fit() on a 0-size box gives a 2x1 grid that
    // would corrupt the tmux view. The ResizeObserver refits when it reappears.
    const el = containerRef.current;
    const dims = fitRef.current?.proposeDimensions();
    if (!el || !isUsableResize(el.clientWidth, el.clientHeight, dims)) return;
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

  // Per-pane header controls: the Terminal/Repo pill and the Worktree checkbox.
  // Rendered between the title and the branch in both header variants.
  const viewControls = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
      <span
        style={{
          display: "inline-flex",
          border: "1px solid var(--border)",
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--input-bg)",
        }}
      >
        <button
          style={segBtnStyle(view === "terminal")}
          title="Terminal"
          aria-pressed={view === "terminal"}
          onClick={() => setView("terminal")}
        >
          <TermGlyph />
          Term
        </button>
        <button
          style={{ ...segBtnStyle(view === "repo"), borderRight: "none" }}
          title="Diff — mudanças deste terminal"
          aria-pressed={view === "repo"}
          onClick={() => setView("repo")}
        >
          <DiffGlyph />
          Diff
        </button>
      </span>
      <label
        title={
          wtError ??
          (worktreeBranch
            ? `Worktree isolado: ${worktreeBranch}`
            : "Criar um git worktree isolado para as modificações deste terminal")
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 10,
          color: wtError
            ? "var(--status-error, #e74c3c)"
            : worktree
              ? "var(--accent-cyan)"
              : "var(--muted)",
          cursor: wtBusy ? "wait" : "pointer",
          userSelect: "none",
          opacity: wtBusy ? 0.6 : 1,
        }}
      >
        <input
          type="checkbox"
          checked={worktree}
          disabled={wtBusy}
          onChange={(e) => toggleWorktree(e.target.checked)}
          style={{ width: 13, height: 13, margin: 0, accentColor: "var(--accent-cyan)" }}
        />
        Worktree
        {worktree && worktreeBranch && (
          <span style={{ color: "var(--accent-cyan)", opacity: 0.85 }}>
            · {worktreeBranch}
          </span>
        )}
      </label>
    </span>
  );

  return (
    <div
      data-testid={`terminal-pane-${pane.windowId}`}
      className={[
        "ade-term-pane",
        "ade-comet",
        cometOutside && "ade-comet--outside",
        working && "ade-term-visible",
        working && "ade-term-working",
        waiting && "ade-term-waiting",
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
        {/* Leading marker: the board variant carries the macOS-style traffic
            lights (close / minimize / maximize); a locked pane keeps its lock
            badge and disables close. The classic variant shows the lock badge —
            its min/max/close buttons live on the right of the header. */}
        {isBoard ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
            }}
          >
            <button
              onClick={locked ? undefined : onRemove}
              disabled={locked}
              title={locked ? "Locked — unlock to close" : "Close"}
              aria-label="Close terminal"
              style={trafficStyle("#ff5f57", !!locked)}
            />
            <button
              onClick={onToggleMinimize}
              title="Minimize"
              aria-label="Minimize terminal"
              style={trafficStyle("#febc2e", false)}
            />
            <button
              onClick={onToggleMaximize}
              title={maximized ? "Restore" : "Maximize"}
              aria-label={maximized ? "Restore terminal" : "Maximize terminal"}
              style={trafficStyle("#28c840", false)}
            />
            {locked && (
              <LockIcon
                size={12}
                style={{ color: "var(--accent)", flexShrink: 0 }}
              />
            )}
          </span>
        ) : locked ? (
          <LockIcon size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
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
        {/* Board header: title sits next to the traffic lights, the spacer
            pushes the branch chip to the far right. The window controls live in
            the leading traffic-light cluster, so nothing trails on the right. */}
        {isBoard && <div style={{ flex: 1, minWidth: 8 }} />}
        {renameDraft == null && viewControls}
        {isBoard && displayBranch && renameDraft == null && (
          <button
            title={`Git: ${displayBranch} — trocar branch, commit, stash`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={openGitMenu}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--muted)",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            <BranchIcon size={11} />
            {displayBranch}
          </button>
        )}
        {!isBoard && displayBranch && renameDraft == null && (
          <button
            title={`Git: ${displayBranch} — trocar branch, commit, stash`}
            aria-label={`git branch ${displayBranch}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={openGitMenu}
            style={{
              display: "inline-flex",
              alignItems: "center",
              flexShrink: 0,
              color: "var(--muted)",
              background: "transparent",
              border: "none",
              padding: 0,
              marginRight: 2,
              cursor: "pointer",
            }}
          >
            <BranchIcon size={12} />
          </button>
        )}
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
        {!isBoard && (
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
        )}
      </div>
      )}

      {gitMenu.menu && (
        <ContextMenu position={gitMenu.menu} onClose={gitMenu.close} minWidth={240}>
          <GitControls
            workspaceId={pane.workspaceId}
            worktree={worktreePath}
            onCurrentBranch={setGitBranch}
          />
        </ContextMenu>
      )}

      {!chromeless && menu && (
        <ContextMenu
          position={menu}
          onClose={dismissMenu}
          minWidth={sessionList ? 240 : 150}
        >
          {!sessionList && (
            <>
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
            <button
              style={menuItemStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--panel)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
              onClick={() => {
                // Swap the menu into the session picker (loaded async). Stays open.
                claudeSessions(pane.workspaceId)
                  .then(setSessionList)
                  .catch(() => setSessionList([]));
              }}
            >
              <RefreshIcon size={14} />
              <span>Open session</span>
            </button>
            </>
          )}
          {sessionList && (
            <>
              <div
                style={{
                  padding: "4px 10px 3px",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                }}
              >
                Resume Claude session
              </div>
              {sessionList.length === 0 ? (
                <div
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    color: "var(--muted)",
                  }}
                >
                  No sessions for this workspace yet.
                </div>
              ) : (
                sessionList.map((s) => (
                  <button
                    key={s.id}
                    title={`claude --resume ${s.id}`}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--panel)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                    onClick={() => {
                      terminalWrite(
                        pane.paneId,
                        `claude --resume ${s.id}\r`,
                      ).catch(() => {});
                      dismissMenu();
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: "var(--fg)",
                      cursor: "pointer",
                      padding: "6px 10px",
                      borderRadius: 4,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.title}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 11,
                        color: "var(--muted)",
                      }}
                    >
                      {relativeSessionTime(s.lastActive)}
                      {s.gitBranch ? ` · ${s.gitBranch}` : ""}
                    </div>
                  </button>
                ))
              )}
            </>
          )}
        </ContextMenu>
      )}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
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
        {/* Repo view: an overlay over the live terminal (never unmounts the
            xterm host — PTY invariant). Shows the diffs of this terminal's
            changes; clicking a file opens its diff. Targets the worktree path
            when isolation is on, else the workspace repo. */}
        {view === "repo" && (
          <Suspense
            fallback={
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 50,
                  display: "grid",
                  placeItems: "center",
                  background: "var(--panel)",
                  color: "var(--muted)",
                  fontSize: 12,
                }}
              >
                Carregando editor…
              </div>
            }
          >
            <RepoDiffPanel workspaceId={pane.workspaceId} worktree={worktreePath} />
          </Suspense>
        )}
      </div>
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