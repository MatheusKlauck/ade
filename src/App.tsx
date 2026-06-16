import { useState, useEffect, useRef, useCallback } from "react";
import {
  subscribeNotify,
  subscribeTerminalFocus,
  subscribeTerminalClose,
  boardGet,
  subscribeBoard,
  subscribeSync,
  subscribeTerminalAlert,
  type TerminalAlertPayload,
  terminalOpen,
  terminalWrite,
  cardDetail,
  uiStateGet,
  uiStateSet,
} from "./lib/ipc";
import AppBar, { type ViewMode } from "./components/AppBar";
import Settings from "./components/Settings";
import GestorPanel from "./components/GestorPanel";
import NewFeatureComposer from "./components/NewFeatureComposer";
import { useAgentStatusSync } from "./store/agentStatus";
import Ledger from "./components/Ledger";
import BoardView from "./components/BoardView";
import StatusBar from "./components/StatusBar";
import SkillsSidebar from "./components/SkillsSidebar";
import { ToastStack, type ToastData, type ToastItem } from "./components/Toast";
import { useTerminalsStore, type OpenTerminal } from "./store/terminals";
import { useLedgerStore } from "./store/ledger";
import { useWorkspacesStore } from "./store/workspaces";
import { useBoardStore } from "./store/board";
import {
  useNotificationsStore,
  type NotifyCode,
  type NotifyLevel,
} from "./store/notifications";
import {
  useSettingsStore,
  getDefaultPreset,
  type TerminalPreset,
} from "./store/settings";
import Onboarding from "./components/Onboarding";
import { contrastingTextColor } from "./lib/color";

/** Extra settle time (seconds) between the startup command and the task-prompt
 * injection, to give the program the startup command launches (e.g. an agent
 * CLI) a moment to be ready to receive input. */
const TASK_INJECT_SETTLE_SECS = 1;

const paneIsOpen = (paneId: string) =>
  useTerminalsStore.getState().panes.some((p) => p.paneId === paneId);

/**
 * Inject the task's title + full description into the pane as a submitted prompt.
 * Best-effort: a failed lookup or a closed pane simply skips injection.
 *
 * The text is wrapped in a bracketed-paste sequence so multi-line descriptions
 * are inserted as a single block — agent CLIs that honor bracketed paste (Claude
 * Code, readline, …) won't treat the internal newlines as Enter — and a trailing
 * CR then submits it, exactly like pasting a prompt and pressing Enter.
 */
async function injectTaskPrompt(paneId: string, cardId: string) {
  let detail;
  try {
    detail = await cardDetail(cardId);
  } catch {
    return;
  }
  if (!paneIsOpen(paneId)) return; // cardDetail may have awaited a network fetch

  const title = (detail.card.title ?? "").trim();
  const body = (detail.body ?? "").trim();
  // Strip ESC so a description can't break out of the paste / inject control seqs.
  const text = (body ? `${title}\n\n${body}` : title).replace(/\x1b/g, "");
  if (!text) return;

  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  terminalWrite(paneId, `${PASTE_START}${text}${PASTE_END}\r`).catch(() => {});
}

/** Turn a command list into a single payload to write to the PTY: trimmed,
 * non-empty lines joined by newlines (each newline acts as Enter, so the shell
 * runs them sequentially), with a trailing newline to submit the last one.
 * Returns "" when there's nothing to run. */
function joinCommands(cmds: string[]): string {
  const lines = cmds.map((c) => c.trim()).filter(Boolean);
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Schedule the open commands for a newly-opened pane and, when `injectCardId`
 * is given (a card just moved to Doing), the task-prompt injection right after.
 *
 * When `preset` is supplied (the user picked a named preset, or a card chose one
 * via "Run with…") its open commands/delay/inject flag take over. For a plain
 * card-driven open with no preset, the workspace's default preset applies.
 */
function scheduleStartupSequence(
  paneId: string,
  opts: { preset?: TerminalPreset; injectCardId?: string } = {},
) {
  const { preset, injectCardId } = opts;
  // For card opens with no explicit preset, fall back to the workspace default.
  const effective =
    preset ??
    (injectCardId ? getDefaultPreset(useSettingsStore.getState()) : null);

  const openCommands = effective?.openCommands ?? [];
  const delaySecs = Math.max(0, effective?.delaySecs ?? 0);
  const payload = joinCommands(openCommands);
  const hasStartup = payload.length > 0;
  // A card-driven open with no resolved preset still injects (preserves the
  // original behavior); a preset injects only when it opts in. Injection always
  // requires an actual card to pull the prompt from.
  const wantsInject =
    !!injectCardId && (effective ? effective.injectTask : true);

  if (hasStartup) {
    setTimeout(() => {
      if (!paneIsOpen(paneId)) return;
      terminalWrite(paneId, payload).catch(() => {});
    }, delaySecs * 1000);
  }

  if (wantsInject) {
    // Inject after the startup command has been sent (+ settle), or after a
    // short settle when there's no startup command.
    const injectAt = hasStartup
      ? delaySecs + TASK_INJECT_SETTLE_SECS
      : TASK_INJECT_SETTLE_SECS;
    setTimeout(() => {
      if (!paneIsOpen(paneId)) return;
      injectTaskPrompt(paneId, injectCardId);
    }, injectAt * 1000);
  }
}

/** Best-effort label for the terminal window from its linked card, else null. */
function titleForWindow(workspaceId: string, windowId: string): string | null {
  const board = useBoardStore.getState().boards[workspaceId];
  if (!board) return null;
  for (const colId of Object.keys(board.cardsByColumn)) {
    const card = board.cardsByColumn[colId].find(
      (c) => c.terminal_window_id === windowId,
    );
    if (card) {
      return card.github_issue_number != null
        ? `#${card.github_issue_number} | ${card.title}`
        : card.title;
    }
  }
  return null;
}

/** Human-readable text for a terminal completion/bell/app alert. */
function formatTerminalAlert(p: TerminalAlertPayload): string {
  const title = titleForWindow(p.workspace_id, p.window_id);
  const who = title ? `${title}: ` : "";
  if (p.kind === "completed") {
    const failed = p.detail && p.detail !== "0";
    return failed
      ? `${who}command failed (exit ${p.detail})`
      : `${who}command finished`;
  }
  if (p.kind === "bell") return `${who}bell`;
  return `${who}${p.detail || "notification"}`;
}

/** Most toasts visible at once. A burst beyond this drops the oldest, but never
 * an error — errors must not vanish silently (they also persist in the
 * NotificationCenter), so they're kept even past the cap. */
const MAX_TOASTS = 3;

/** ui_state key for the persisted main-view choice (app-global, not per-workspace). */
const VIEW_MODE_KEY = "view-mode";

function capToasts(list: ToastItem[]): ToastItem[] {
  if (list.length <= MAX_TOASTS) return list;
  let toDrop = list.length - MAX_TOASTS;
  return list.filter((t) => {
    if (toDrop > 0 && t.level !== "error") {
      toDrop--;
      return false;
    }
    return true;
  });
}

export default function App() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showGestor, setShowGestor] = useState(false);
  const [showNewFeature, setShowNewFeature] = useState(false);
  // Which main GUI is shown: "ledger" (dense issue table, default) or "classic"
  // (terminal grid + bottom Kanban dock). Persisted globally to ui_state.
  const [viewMode, setViewMode] = useState<ViewMode>("ledger");
  // Whether the board view's lower Kanban panel is expanded. Collapsing it hands
  // the whole area to the terminal stage; toggled from the status bar.
  const [boardOpen, setBoardOpen] = useState(true);
  const toastIdRef = useRef(0);

  // Append a toast to the stack (capped; errors never silently dropped).
  const pushToast = useCallback((data: ToastData) => {
    setToasts((cur) =>
      capToasts([...cur, { ...data, id: ++toastIdRef.current }]),
    );
  }, []);
  // Stable so each Toast's auto-dismiss timer isn't reset on every re-render.
  const dismissToast = useCallback(
    (id: number) => setToasts((cur) => cur.filter((t) => t.id !== id)),
    [],
  );

  // Apply theme at startup using settings store
  const settingsLoad = useSettingsStore((s) => s.load);
  const settingsTheme = useSettingsStore((s) => s.theme);
  const settingsAccent = useSettingsStore((s) => s.accent);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  // Apply theme/accent from store whenever they change (and on initial load),
  // then cache them so the pre-paint script in index.html can restore the same
  // values on the next cold start — no flash of the wrong theme.
  useEffect(() => {
    if (settingsLoaded) {
      const ink = contrastingTextColor(settingsAccent);
      document.documentElement.setAttribute("data-theme", settingsTheme);
      document.documentElement.style.setProperty("--accent", settingsAccent);
      document.documentElement.style.setProperty("--accent-ink", ink);
      try {
        localStorage.setItem("ade-theme", settingsTheme);
        localStorage.setItem("ade-accent", settingsAccent);
        localStorage.setItem("ade-accent-ink", ink);
      } catch {
        /* best-effort cache; quota/availability errors are non-fatal */
      }
    }
  }, [settingsTheme, settingsAccent, settingsLoaded]);

  const panes = useTerminalsStore((s) => s.panes);
  const addPane = useTerminalsStore((s) => s.addPane);
  const removePane = useTerminalsStore((s) => s.removePane);
  const removePanesForWorkspace = useTerminalsStore(
    (s) => s.removePanesForWorkspace,
  );
  const getPanesForWorkspace = useTerminalsStore((s) => s.getPanesForWorkspace);
  const highlightedWindowId = useTerminalsStore((s) => s.highlightedWindowId);
  const focusWindow = useTerminalsStore((s) => s.focusWindow);
  const clearHighlight = useTerminalsStore((s) => s.clearHighlight);
  const loadLocked = useTerminalsStore((s) => s.loadLocked);
  const loadNames = useTerminalsStore((s) => s.loadNames);
  const loadPresetWindows = useTerminalsStore((s) => s.loadPresetWindows);
  const loadLayout = useTerminalsStore((s) => s.loadLayout);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspacesLoaded = useWorkspacesStore((s) => s.loaded);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const updateSyncStatus = useWorkspacesStore((s) => s.updateSyncStatus);
  useAgentStatusSync(activeWorkspaceId);
  const setBoard = useBoardStore((s) => s.setBoard);

  // Track previous workspace to detect tab switches
  const prevWorkspaceRef = useRef<string | null>(null);
  // Guards the view-toggle rebuild so a double-click mid-rebuild can't fire a
  // second teardown/reattach over the first.
  const toggleViewBusy = useRef(false);

  // Persist window IDs to ui_state for a workspace
  const persistWindowIds = useCallback(
    async (workspaceId: string) => {
      const workspacePanes = getPanesForWorkspace(workspaceId);
      const windowIds = workspacePanes.map((p) => p.windowId);
      await uiStateSet(`terminals:${workspaceId}`, JSON.stringify(windowIds));
    },
    [getPanesForWorkspace],
  );

  const notifyPush = useNotificationsStore((s) => s.push);

  useEffect(() => {
    const unsub = subscribeNotify((payload) => {
      pushToast(payload);
      notifyPush(
        payload.level as NotifyLevel,
        payload.code as NotifyCode,
        payload.message,
      );
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [notifyPush, pushToast]);

  // Load workspaces on mount
  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Restore the persisted main-view choice once on mount (defaults to ledger).
  useEffect(() => {
    uiStateGet(VIEW_MODE_KEY)
      .then((stored) => {
        if (stored === "classic" || stored === "ledger") setViewMode(stored);
      })
      .catch(() => {});
  }, []);

  // Subscribe to board events (keyed by workspace_id)
  useEffect(() => {
    const unsub = subscribeBoard((payload) => {
      setBoard(payload.workspace_id, payload.columns, payload.cards);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [setBoard]);

  // Subscribe to sync events
  useEffect(() => {
    const unsub = subscribeSync((payload) => {
      updateSyncStatus(payload.workspace_id, payload.status, payload.last_sync);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [updateSyncStatus]);

  // Subscribe to terminal completion alerts (from the backend monitor). Notify
  // only for terminals you're NOT watching: skip the focused window while the
  // app window itself has focus. A short throttle collapses bursts (e.g. a
  // program ringing the bell repeatedly). Surviving alerts accumulate on the
  // originating workspace's pill.
  const alertThrottle = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const unsub = subscribeTerminalAlert((p) => {
      // Viewer-independent busy/veil tracking runs FIRST, before the focus guard
      // and throttle below (which are about notification semantics). A workspace
      // in the background is never the focused window, but routing here also
      // keeps the active workspace's state accurate for when you switch away.
      if (p.kind === "started") {
        // "started" has no badge/ledger meaning and must not be throttled.
        useWorkspacesStore
          .getState()
          .markTerminalStarted(p.workspace_id, p.window_id);
        return;
      }
      if (p.kind === "gone") {
        // The pane reached EOF (e.g. the shell `exit`ed) without a completion —
        // reconcile the busy flag so the tab's comet doesn't linger. No badge.
        useWorkspacesStore
          .getState()
          .clearTerminalBusy(p.workspace_id, p.window_id);
        return;
      }
      if (p.kind === "completed") {
        // Bump the veil only for BACKGROUND completions — on the active tab the
        // pane shows its own sweep, and bumping would replay it on switch-away.
        const activeId = useWorkspacesStore.getState().activeWorkspaceId;
        useWorkspacesStore
          .getState()
          .markTerminalDone(
            p.workspace_id,
            p.window_id,
            p.workspace_id !== activeId,
          );
        // fall through to the existing badge + ledger logic
      }

      const { focusedWindowId } = useTerminalsStore.getState();
      if (p.window_id === focusedWindowId && document.hasFocus()) return;

      const key = `${p.window_id}:${p.kind}`;
      const now = Date.now();
      const last = alertThrottle.current.get(key) ?? 0;
      if (now - last < 700) return;
      alertThrottle.current.set(key, now);
      // Bounded: past ~200 entries, evict everything older than the throttle
      // window so a long session of many windows can't grow the map forever.
      if (alertThrottle.current.size > 200) {
        for (const [k, t] of alertThrottle.current) {
          if (now - t >= 700) alertThrottle.current.delete(k);
        }
      }

      useWorkspacesStore
        .getState()
        .pushTerminalAlert(p.workspace_id, formatTerminalAlert(p));

      // Flag the originating terminal so its ledger row surfaces. Heuristic
      // mapping (no OSC 133 yet): a finished command is done/failed by its exit
      // code; a bell or app notification most often means the agent is waiting
      // on the user, so treat it as "input needed".
      const attentionKind =
        p.kind === "completed"
          ? p.detail && p.detail !== "0"
            ? "failed"
            : "done"
          : "input";
      useLedgerStore
        .getState()
        .setAttention(p.window_id, attentionKind, p.detail);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, []);

  // When the active workspace changes, load its persisted terminal lock state,
  // custom names, window→preset associations, and split layout.
  useEffect(() => {
    if (activeWorkspaceId) {
      loadLocked(activeWorkspaceId);
      loadNames(activeWorkspaceId);
      loadPresetWindows(activeWorkspaceId);
      loadLayout(activeWorkspaceId);
    }
  }, [activeWorkspaceId, loadLocked, loadNames, loadPresetWindows, loadLayout]);

  // When active workspace changes, fetch its board (if not cached)
  useEffect(() => {
    if (!activeWorkspaceId) return;
    boardGet(activeWorkspaceId)
      .then((res) => {
        setBoard(activeWorkspaceId, res.columns, res.cards);
      })
      .catch(() => {});
  }, [activeWorkspaceId, setBoard]);

  // Settings are per-workspace: (re)load them whenever the active workspace
  // changes so theme/accent/startup command/token reflect the current one.
  useEffect(() => {
    if (activeWorkspaceId) settingsLoad(activeWorkspaceId);
  }, [activeWorkspaceId, settingsLoad]);

  // Subscribe to terminal focus events
  useEffect(() => {
    const unsub = subscribeTerminalFocus(async (payload) => {
      const { workspace_id, window_id } = payload;

      // Check if a pane for this window_id already exists. Read panes via
      // getState() so this subscription mounts once — depending on `panes`
      // would tear down/re-create the Tauri listener on every pane change and
      // could drop a terminal_focus event in the gap.
      const existing = useTerminalsStore
        .getState()
        .panes.find((p) => p.windowId === window_id);
      if (existing) {
        // Pane exists — highlight it, expand its terminal inline, and clear any
        // pending attention now that the user is looking at it.
        const ls = useLedgerStore.getState();
        ls.expandWindow(workspace_id, window_id);
        ls.clearAttention(window_id);
        focusWindow(window_id);
      } else {
        // No pane — reattach/create a new one
        try {
          const result = await terminalOpen(workspace_id, window_id);
          const pane: OpenTerminal = {
            paneId: result.paneId,
            windowId: result.windowId,
            workspaceId: workspace_id,
            channel: result.channel,
          };
          addPane(pane);
          // A preset is present only when this card was launched via its
          // "Run with…" menu; otherwise fall back to the workspace defaults.
          const preset = payload.card_id
            ? useTerminalsStore.getState().takePendingPreset(payload.card_id)
            : undefined;
          // Remember which preset opened this window (the chosen one, else the
          // workspace default) so manual close can run its closeCommands.
          const effective =
            preset ?? getDefaultPreset(useSettingsStore.getState());
          if (effective) {
            useTerminalsStore
              .getState()
              .setPresetForWindow(workspace_id, result.windowId, effective.id);
          }
          scheduleStartupSequence(pane.paneId, {
            preset,
            injectCardId: payload.card_id,
          });
          // Expand the freshly-opened terminal inline so it's immediately visible.
          useLedgerStore.getState().expandWindow(workspace_id, result.windowId);
          focusWindow(window_id);
        } catch {
          // The tmux window is gone (died/killed since the focus event was
          // queued). Surface it rather than swallow — same rule the reattach
          // path follows: nothing fails silently.
          const title = titleForWindow(workspace_id, window_id);
          pushToast({
            level: "warn",
            code: "TERMINAL_GONE",
            message: title
              ? `Couldn't open "${title}" — its tmux window is gone.`
              : "Couldn't open that terminal — its tmux window is gone.",
          });
        }
      }
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [focusWindow, addPane, pushToast]);

  // Subscribe to terminal close events (a card moved to Done). The backend has
  // already killed the tmux window; drop the matching pane from the UI.
  useEffect(() => {
    const unsub = subscribeTerminalClose(({ workspace_id, window_id }) => {
      const pane = useTerminalsStore
        .getState()
        .panes.find((p) => p.windowId === window_id);
      if (pane) removePane(pane.paneId);
      // The tmux window is gone for good — drop any attention flag for it.
      useLedgerStore.getState().clearAttention(window_id);
      // Reconcile background busy state: a window killed mid-command emitted a
      // "started" but never its "completed", so clear it to avoid a stale comet.
      useWorkspacesStore.getState().clearTerminalBusy(workspace_id, window_id);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [removePane]);

  // Handle workspace switch: persist old workspace's window IDs,
  // remove old panes from store (triggers unmount + terminalClose),
  // then reattach new workspace's terminals.
  useEffect(() => {
    const prevId = prevWorkspaceRef.current;

    if (!activeWorkspaceId) {
      prevWorkspaceRef.current = null;
      return;
    }

    // Persist old workspace's window IDs before switching
    if (prevId && prevId !== activeWorkspaceId) {
      const oldPanes = getPanesForWorkspace(prevId);
      const windowIds = oldPanes.map((p) => p.windowId);
      uiStateSet(`terminals:${prevId}`, JSON.stringify(windowIds)).catch(
        () => {},
      );
      // Remove panes from store — this triggers TerminalPane unmount
      // which calls terminalClose (kills viewer, tmux window survives)
      removePanesForWorkspace(prevId);
    }

    prevWorkspaceRef.current = activeWorkspaceId;

    // Reattach terminals for the new workspace
    async function reattach() {
      if (!activeWorkspaceId) return;
      // Check if we already have panes for this workspace (initial load)
      const existing = getPanesForWorkspace(activeWorkspaceId);
      if (existing.length > 0) return;

      try {
        const stored = await uiStateGet(`terminals:${activeWorkspaceId}`);
        if (!stored) return;
        const windowIds: string[] = JSON.parse(stored);
        // Reattach in parallel — each window is independent, and a serial loop
        // would make restore latency scale with the number of terminals.
        const results = await Promise.allSettled(
          windowIds.map((wid) => terminalOpen(activeWorkspaceId, wid)),
        );
        // Add panes in windowIds order, not Promise-resolution order, so
        // terminals reappear in their saved layout instead of a race.
        results.forEach((r) => {
          if (r.status !== "fulfilled") return;
          addPane({
            paneId: r.value.paneId,
            windowId: r.value.windowId,
            workspaceId: activeWorkspaceId,
            channel: r.value.channel,
          });
        });
        // A rejection means the tmux window is gone (died/killed since we last
        // saw it). That's silent data loss for the user, so surface it rather
        // than swallow.
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          // Toast (not the history store): there's no CONTRACTS §7 code for
          // reattach loss, and that enum is exhaustive — so don't invent one.
          pushToast({
            level: "warn",
            code: "TERMINALS_NOT_RESTORED",
            message: `${failed} terminal${failed > 1 ? "s" : ""} couldn't be restored — the tmux window${failed > 1 ? "s are" : " is"} gone.`,
          });
        }
        // Clear stored IDs after successful reattach (they'll be re-persisted on next switch)
        await uiStateSet(`terminals:${activeWorkspaceId}`, "[]").catch(
          () => {},
        );
      } catch {
        // No stored terminals, that's fine
      }
    }
    reattach();
  }, [
    activeWorkspaceId,
    addPane,
    getPanesForWorkspace,
    removePanesForWorkspace,
    pushToast,
  ]);

  // Persist window IDs when panes change (for current workspace)
  useEffect(() => {
    if (activeWorkspaceId) {
      persistWindowIds(activeWorkspaceId);
    }
  }, [panes, activeWorkspaceId, persistWindowIds]);

  const handleNewTerminal = async (preset?: TerminalPreset) => {
    if (!activeWorkspaceId) return;
    try {
      const result = await terminalOpen(activeWorkspaceId);
      const pane: OpenTerminal = {
        paneId: result.paneId,
        windowId: result.windowId,
        workspaceId: activeWorkspaceId,
        channel: result.channel,
      };
      addPane(pane);
      // Associate the explicitly chosen preset so manual close runs its
      // closeCommands. A plain shell (no preset) gets no close commands.
      if (preset) {
        useTerminalsStore
          .getState()
          .setPresetForWindow(activeWorkspaceId, result.windowId, preset.id);
      }
      // Expand the new terminal inline so it shows up right away.
      useLedgerStore
        .getState()
        .expandWindow(activeWorkspaceId, result.windowId);
      scheduleStartupSequence(pane.paneId, { preset });
    } catch (e) {
      console.error(e);
    }
  };

  // Switch between the ledger and classic GUIs. Both GUIs mount their own
  // TerminalPane instances, so a plain React swap would unmount every pane —
  // each schedules a deferred terminalClose that kills its viewer ~100ms later
  // — while the new GUI mounts fresh panes against the SAME (deterministic)
  // paneIds, so the terminals would die moments after the switch. We instead do
  // it deliberately, exactly like a workspace switch: flip the GUI, tear the
  // viewers down, then reattach fresh viewers once the deferred closes settle.
  // The tmux windows (and their agents) survive throughout; only the on-screen
  // viewers rebuild — the "terminais reanexam" behaviour.
  const handleToggleView = () => {
    if (toggleViewBusy.current) return;
    const ws = activeWorkspaceId;
    const next: ViewMode = viewMode === "ledger" ? "classic" : "ledger";

    // Flip + persist immediately so the chrome responds even with no terminals.
    setViewMode(next);
    uiStateSet(VIEW_MODE_KEY, next).catch(() => {});
    if (!ws) return;

    const windowIds = getPanesForWorkspace(ws).map((p) => p.windowId);
    if (windowIds.length === 0) return; // no viewers to rebuild

    toggleViewBusy.current = true;
    // Tear down the current viewers (unmount → deferred terminalClose). The
    // lock/name/preset associations are keyed by windowId and left intact.
    removePanesForWorkspace(ws);

    // Reattach after the ~100ms deferred closes have fired, so a reopened
    // (deterministic) paneId can't be killed by a still-pending close.
    window.setTimeout(async () => {
      try {
        const results = await Promise.allSettled(
          windowIds.map(async (wid) => {
            const result = await terminalOpen(ws, wid);
            addPane({
              paneId: result.paneId,
              windowId: result.windowId,
              workspaceId: ws,
              channel: result.channel,
            });
          }),
        );
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          // Same surfacing as the workspace-switch reattach: no CONTRACTS code
          // for reattach loss, so toast rather than the history store.
          pushToast({
            level: "warn",
            code: "TERMINALS_NOT_RESTORED",
            message: `${failed} terminal${failed > 1 ? "s" : ""} couldn't be restored — the tmux window${failed > 1 ? "s are" : " is"} gone.`,
          });
        }
      } finally {
        toggleViewBusy.current = false;
      }
    }, 260);
  };

  // Manual close (× button): run the window's preset closeCommands into the
  // surviving tmux window before dropping the pane, then clear the association.
  const handleRemove = (paneId: string) => {
    const ts = useTerminalsStore.getState();
    const pane = ts.panes.find((p) => p.paneId === paneId);
    if (pane) {
      const presetId = ts.getPresetForWindow(pane.workspaceId, pane.windowId);
      if (presetId) {
        const preset = useSettingsStore
          .getState()
          .presets.find((p) => p.id === presetId);
        const close = preset ? joinCommands(preset.closeCommands) : "";
        if (close) terminalWrite(pane.paneId, close).catch(() => {});
      }
      ts.clearPresetForWindow(pane.workspaceId, pane.windowId);
      // Manual close is permanent — drop any attention flag for this window.
      useLedgerStore.getState().clearAttention(pane.windowId);
    }
    removePane(paneId);
  };

  const handleSettingsSaved = (login: string) => {
    pushToast({
      level: "info",
      code: "TOKEN_SAVED",
      message: `GitHub connected as ${login}`,
    });
  };

  // Until the first workspace load settles, hold a calm themed shell — never the
  // onboarding screen — so a returning user doesn't flash "no workspaces" for a
  // frame on every cold start. (Load is local/fast; this is just the seam.)
  if (!workspacesLoaded) {
    return (
      <div
        style={{
          position: "relative",
          minHeight: "100vh",
          background: "var(--bg)",
        }}
      >
        {/* titleBarStyle: Overlay removes the native title bar, so keep a drag
            handle even while hydrating. */}
        <div
          data-tauri-drag-region
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: 40,
            zIndex: 1,
          }}
        />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  // Loaded and genuinely empty → the onboarding screen.
  if (workspaces.length === 0) {
    return (
      <div
        style={{
          position: "relative",
          minHeight: "100vh",
          background: "var(--bg)",
          color: "var(--fg)",
        }}
      >
        {/* titleBarStyle: Overlay removes the native title bar, so the window
            needs a drag handle even on the onboarding screen. */}
        <div
          data-tauri-drag-region
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: 40,
            zIndex: 1,
          }}
        />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
        <Onboarding />
      </div>
    );
  }

  // Only show panes for the active workspace
  const activePanes = panes.filter((p) => p.workspaceId === activeWorkspaceId);

  return (
    <div
      style={{
        position: "relative",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <AppBar
        onOpenSettings={() => setShowSettings(true)}
        onOpenGestor={() => setShowGestor(true)}
        onNewFeature={() => setShowNewFeature(true)}
        viewMode={viewMode}
        onToggleView={handleToggleView}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <SkillsSidebar workspaceId={activeWorkspaceId} />
        {viewMode === "ledger" ? (
          <div data-testid="view-ledger" style={{ display: "contents" }}>
            <Ledger
              workspaceId={activeWorkspaceId}
              panes={activePanes}
              onNewTerminal={handleNewTerminal}
              onRemovePane={handleRemove}
              highlightedWindowId={highlightedWindowId}
              onHighlightDone={clearHighlight}
            />
          </div>
        ) : (
          <div data-testid="view-board" style={{ display: "contents" }}>
            <BoardView
              workspaceId={activeWorkspaceId}
              panes={activePanes}
              onNewTerminal={handleNewTerminal}
              onRemovePane={handleRemove}
              highlightedWindowId={highlightedWindowId}
              onHighlightDone={clearHighlight}
              open={boardOpen}
            />
          </div>
        )}
      </div>
      {/* The board view's footer spans the full width (under the skills rail). */}
      {viewMode === "classic" && (
        <StatusBar
          workspaceId={activeWorkspaceId}
          boardOpen={boardOpen}
          onToggleBoard={() => setBoardOpen((o) => !o)}
        />
      )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onSaved={handleSettingsSaved}
        />
      )}
      {showGestor && activeWorkspaceId && (
        <GestorPanel
          workspaceId={activeWorkspaceId}
          onClose={() => setShowGestor(false)}
        />
      )}
      {showNewFeature && activeWorkspaceId && (
        <NewFeatureComposer
          workspaceId={activeWorkspaceId}
          onClose={() => setShowNewFeature(false)}
        />
      )}
    </div>
  );
}
