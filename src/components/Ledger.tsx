import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  boardGet,
  cardCreate,
  cardMove,
  terminalWrite,
  type Card as CardType,
} from "../lib/ipc";
import { useBoardStore } from "../store/board";
import { useTerminalsStore, type OpenTerminal } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import { type TerminalPreset } from "../store/settings";
import {
  useLedgerStore,
  normalizeStage,
  filterRows,
  sortRows,
  rowCounts,
  type LedgerFilter,
  type LedgerRowModel,
} from "../store/ledger";
import { COL_BACKLOG, COL_DOING, COL_DONE } from "../lib/columns";
import Stage from "./Stage";
import LedgerRow from "./LedgerRow";
import NewTerminalButton from "./NewTerminalButton";
import CardDetail from "./CardDetail";

interface LedgerProps {
  workspaceId: string | null;
  panes: OpenTerminal[]; // active-workspace panes
  onNewTerminal: (preset?: TerminalPreset) => void;
  onRemovePane: (paneId: string) => void;
  highlightedWindowId: string | null;
  onHighlightDone: () => void;
}

const MIN_ROWS_H = 80;
// Each filter pill, in display order. `input` is rendered with the accent
// treatment; the rest are neutral until selected.
const PILLS: { key: LedgerFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "input", label: "needs input" },
  { key: "doing", label: "doing" },
  { key: "pr", label: "pr" },
  { key: "paused", label: "paused" },
  { key: "backlog", label: "backlog" },
  { key: "done", label: "done" },
];

export default function Ledger({
  workspaceId,
  panes,
  onNewTerminal,
  onRemovePane,
  highlightedWindowId,
  onHighlightDone,
}: LedgerProps) {
  const boards = useBoardStore((s) => s.boards);
  const setBoard = useBoardStore((s) => s.setBoard);
  const optimisticMove = useBoardStore((s) => s.optimisticMove);

  const lockedByWorkspace = useTerminalsStore((s) => s.lockedByWorkspace);
  const namesByWorkspace = useTerminalsStore((s) => s.namesByWorkspace);
  const toggleLock = useTerminalsStore((s) => s.toggleLock);
  const setTerminalName = useTerminalsStore((s) => s.setTerminalName);
  const focusedWindowId = useTerminalsStore((s) => s.focusedWindowId);

  const stageByWorkspace = useLedgerStore((s) => s.stageByWorkspace);
  const rowsHeightByWorkspace = useLedgerStore((s) => s.rowsHeightByWorkspace);
  const attentionByWindow = useLedgerStore((s) => s.attentionByWindow);
  const filter = useLedgerStore((s) => s.filter);
  const setFilter = useLedgerStore((s) => s.setFilter);
  const setStage = useLedgerStore((s) => s.setStage);
  const loadStage = useLedgerStore((s) => s.loadStage);
  const setRowsHeight = useLedgerStore((s) => s.setRowsHeight);
  const clearAttention = useLedgerStore((s) => s.clearAttention);

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = workspaceId
    ? workspaces.find((w) => w.id === workspaceId) ?? null
    : null;

  const [newTitle, setNewTitle] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  // Live divider height while dragging (committed to the store on pointer-up so
  // a drag is one persisted write, not hundreds).
  const [dragRowsH, setDragRowsH] = useState<number | null>(null);

  const board = workspaceId ? boards[workspaceId] : undefined;
  const columns = useMemo(() => board?.columns ?? [], [board]);
  const cardsByColumn = board?.cardsByColumn;

  // Load the persisted stage + rows height when the workspace changes.
  useEffect(() => {
    if (workspaceId) loadStage(workspaceId);
  }, [workspaceId, loadStage]);

  // Escape closes the card-detail modal.
  useEffect(() => {
    if (!selectedCardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedCardId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCardId]);

  // ---- stage (terminal panels) ----
  const paneWins = panes.map((p) => p.windowId);
  const winKey = paneWins.join("|");
  const rawStage = workspaceId ? stageByWorkspace[workspaceId] : undefined;
  // Always render from a normalised stage so a freshly-opened terminal shows up
  // immediately, even before the persistence effect below writes it back.
  const stage = normalizeStage(rawStage ?? { panels: [] }, paneWins);

  // Persist the normalised stage whenever it diverges from what's stored — a
  // terminal opened (placed) or closed (dropped). Gated on rawStage being
  // defined so we never clobber persisted state with the default before
  // loadStage has run.
  useEffect(() => {
    if (!workspaceId || rawStage === undefined) return;
    const norm = normalizeStage(rawStage, paneWins);
    if (JSON.stringify(norm) !== JSON.stringify(rawStage)) {
      setStage(workspaceId, norm, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, rawStage, winKey]);

  // Clear the attention flag for whichever terminal you're actively watching —
  // you've seen it, so it shouldn't keep pulling at the row order.
  useEffect(() => {
    if (focusedWindowId) clearAttention(focusedWindowId);
  }, [focusedWindowId, clearAttention]);

  const onStageChange = useCallback(
    (next: typeof stage) => {
      if (workspaceId) setStage(workspaceId, next, true);
    },
    [workspaceId, setStage]
  );

  // ---- terminal title / lock / name helpers (mirrors the old TerminalArea) ----
  const customNameFor = (pane: OpenTerminal): string | undefined =>
    namesByWorkspace[pane.workspaceId]?.[pane.windowId];

  const titleFor = (pane: OpenTerminal): string => {
    const custom = customNameFor(pane);
    if (custom) return custom;
    const b = boards[pane.workspaceId];
    if (b) {
      for (const colId of Object.keys(b.cardsByColumn)) {
        const card = b.cardsByColumn[colId].find(
          (c) => c.terminal_window_id === pane.windowId
        );
        if (card) {
          return card.github_issue_number != null
            ? `#${card.github_issue_number} | ${card.title}`
            : card.title;
        }
      }
    }
    return "Terminal";
  };

  const lockedFor = (pane: OpenTerminal): boolean =>
    (lockedByWorkspace[pane.workspaceId] ?? []).includes(pane.windowId);

  const handleRemovePane = useCallback(
    (pane: OpenTerminal) => {
      // Locked terminals can't be closed — guard every path into removal.
      const st = useTerminalsStore.getState();
      if ((st.lockedByWorkspace[pane.workspaceId] ?? []).includes(pane.windowId)) {
        return;
      }
      onRemovePane(pane.paneId);
    },
    [onRemovePane]
  );

  // ---- card moves (single helper; consolidates the old duplicated logic) ----
  // Move a card to a column, optimistically; closing its terminal when the
  // target is Done (the backend kills the tmux window; drop the pane too).
  const moveCard = useCallback(
    (card: CardType, toColumnId: string) => {
      if (!workspaceId) return;
      const b = useBoardStore.getState().boards[workspaceId];
      if (!b) return;
      const toCol = b.columns.find((c) => c.id === toColumnId);
      optimisticMove(workspaceId, card.id, toColumnId);
      cardMove(card.id, toColumnId).catch((e) => {
        console.error("card_move failed", e);
        // Re-fetch so a rejected move doesn't strand the optimistic state.
        boardGet(workspaceId)
          .then((res) => setBoard(workspaceId, res.columns, res.cards))
          .catch(() => {});
      });
      if (toCol?.name === COL_DONE && card.terminal_window_id) {
        const pane = useTerminalsStore
          .getState()
          .panes.find((p) => p.windowId === card.terminal_window_id);
        if (pane) onRemovePane(pane.paneId);
      }
    },
    [workspaceId, optimisticMove, setBoard, onRemovePane]
  );

  // Right-click → "Run with {preset}": same path as the old Board.
  const handleRunWithPreset = useCallback(
    (card: CardType, preset: TerminalPreset) => {
      if (!workspaceId) return;
      const b = useBoardStore.getState().boards[workspaceId];
      if (!b) return;
      const doingCol = b.columns.find((c) => c.name === COL_DOING);
      if (!doingCol) return;

      // Already-running session: run the preset's open commands straight into it
      // (a re-move to Doing only re-focuses; it won't re-emit a launch event).
      const pane = card.terminal_window_id
        ? useTerminalsStore
            .getState()
            .panes.find((p) => p.windowId === card.terminal_window_id)
        : undefined;
      if (pane) {
        const payload = preset.openCommands
          .map((c) => c.trim())
          .filter(Boolean)
          .join("\n");
        if (payload) terminalWrite(pane.paneId, payload + "\n").catch(() => {});
        return;
      }

      useTerminalsStore.getState().setPendingPreset(card.id, preset);
      const doingCards = b.cardsByColumn[doingCol.id] || [];
      const lastCard = doingCards[doingCards.length - 1];
      optimisticMove(workspaceId, card.id, doingCol.id, undefined, lastCard?.id);
      cardMove(card.id, doingCol.id, undefined, lastCard?.id).catch((e) => {
        console.error("card_move (run with preset) failed", e);
      });
    },
    [workspaceId, optimisticMove]
  );

  const handleCreateCard = () => {
    if (!workspaceId || !newTitle.trim()) return;
    const backlog = columns.find((c) => c.name === COL_BACKLOG);
    if (!backlog) return;
    cardCreate(workspaceId, backlog.id, newTitle.trim()).then(() => {
      setNewTitle("");
      boardGet(workspaceId)
        .then((res) => setBoard(workspaceId, res.columns, res.cards))
        .catch(() => {});
    });
  };

  // ---- rows model ----
  const colNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of columns) m.set(c.id, c.name);
    return m;
  }, [columns]);

  const allRows: LedgerRowModel[] = useMemo(() => {
    if (!cardsByColumn) return [];
    const out: LedgerRowModel[] = [];
    for (const colId of Object.keys(cardsByColumn)) {
      const columnName = colNameById.get(colId) ?? "";
      for (const card of cardsByColumn[colId]) {
        const att = card.terminal_window_id
          ? attentionByWindow[card.terminal_window_id]
          : undefined;
        out.push({ card, columnName, attention: att });
      }
    }
    return out;
  }, [cardsByColumn, colNameById, attentionByWindow]);

  const counts = useMemo(() => rowCounts(allRows), [allRows]);
  const visibleRows = useMemo(
    () => sortRows(filterRows(allRows, filter)),
    [allRows, filter]
  );

  // Window IDs currently shown as the active tab somewhere on the stage — their
  // rows get the accent rail so the table and the terminals read as connected.
  const activeWins = useMemo(() => {
    const s = new Set<string>();
    for (const panel of stage.panels) if (panel.active) s.add(panel.active);
    return s;
  }, [stage]);

  const liveWins = useMemo(() => new Set(paneWins), [winKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCard = selectedCardId
    ? allRows.find((r) => r.card.id === selectedCardId)?.card ?? null
    : null;

  // ---- divider drag (resizes the rows region) ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  const storedRowsH = workspaceId ? rowsHeightByWorkspace[workspaceId] : undefined;
  const rowsH = dragRowsH ?? storedRowsH ?? 240;

  const beginDividerDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    const cont = rootRef.current;
    const maxH = cont
      ? cont.getBoundingClientRect().height - 200
      : window.innerHeight - 300;
    const startY = e.clientY;
    const startH = rowsH;
    const onMove = (ev: PointerEvent) => {
      // Drag up (smaller clientY) grows the rows region.
      const next = Math.max(
        MIN_ROWS_H,
        Math.min(Math.max(MIN_ROWS_H, maxH), startH + (startY - ev.clientY))
      );
      setDragRowsH(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragRowsH((h) => {
        if (h != null && workspaceId) setRowsHeight(workspaceId, h);
        return null;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- empty-stage dropzone: dropping a backlog/paused card here starts it ----
  const dropRef = useRef<HTMLDivElement | null>(null);
  const [dropOver, setDropOver] = useState(false);
  useEffect(() => {
    const el = dropRef.current;
    if (!el || panes.length > 0) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => typeof source.data.cardId === "string",
      onDragEnter: () => setDropOver(true),
      onDragLeave: () => setDropOver(false),
      onDrop: ({ source }) => {
        setDropOver(false);
        if (!workspaceId) return;
        const cardId = source.data.cardId as string;
        const b = useBoardStore.getState().boards[workspaceId];
        const doingCol = b?.columns.find((c) => c.name === COL_DOING);
        const card = b
          ? Object.values(b.cardsByColumn).flat().find((c) => c.id === cardId)
          : undefined;
        if (doingCol && card && card.column_id !== doingCol.id) {
          moveCard(card, doingCol.id);
        }
      },
    });
  }, [panes.length, workspaceId, moveCard]);

  // ---- status bar figures ----
  const agentsRunning = panes.length;
  const prOpen = counts.pr;

  const pill = (key: LedgerFilter, label: string) => {
    const n = counts[key];
    if (key !== "all" && n === 0) return null;
    const on = filter === key;
    const isInput = key === "input";
    const style: CSSProperties = {
      border: `1px solid ${on || (isInput && n > 0) ? "var(--accent)" : "var(--border)"}`,
      borderRadius: 10,
      padding: "1px 10px",
      fontSize: 11,
      cursor: "pointer",
      background: isInput && n > 0 ? "color-mix(in srgb, var(--accent) 10%, transparent)" : on ? "var(--surface-input)" : "transparent",
      color: on || (isInput && n > 0) ? "var(--accent)" : "var(--muted)",
      whiteSpace: "nowrap",
    };
    return (
      <button key={key} style={style} onClick={() => setFilter(key)}>
        {label} {n}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Toolbar: filter pills + new card + new terminal */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {PILLS.map((p) => pill(p.key, p.label))}
        </div>
        <div style={{ flex: 1 }} />
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreateCard();
          }}
          placeholder="New card…"
          style={{
            width: 150,
            boxSizing: "border-box",
            padding: "4px 10px",
            borderRadius: 4,
            border: "1px solid var(--input-border)",
            background: "var(--input-bg)",
            color: "var(--fg)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
          }}
        />
        <NewTerminalButton onNewTerminal={onNewTerminal} />
      </div>

      {/* Stage (terminals) */}
      {panes.length > 0 ? (
        <Stage
          panes={panes}
          stage={stage}
          onStageChange={onStageChange}
          titleFor={titleFor}
          lockedFor={lockedFor}
          hasCustomName={(p) => customNameFor(p) != null}
          attentionByWindow={attentionByWindow}
          onToggleLock={(p) => toggleLock(p.workspaceId, p.windowId)}
          onRename={(p, name) => setTerminalName(p.workspaceId, p.windowId, name)}
          onRemove={handleRemovePane}
          highlightedWindowId={highlightedWindowId}
          onHighlightDone={onHighlightDone}
        />
      ) : (
        <div
          ref={dropRef}
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "var(--muted)",
            background: dropOver ? "var(--drop-target)" : "var(--panel)",
            boxShadow: dropOver ? "inset 0 0 0 2px var(--accent)" : "none",
            transition: "background var(--dur-instant) var(--ease-out-quart)",
          }}
        >
          <span style={{ fontSize: 13 }}>No terminals open</span>
          <span style={{ fontSize: 12 }}>
            Drag an issue here to start it, or
          </span>
          <button
            onClick={() => onNewTerminal()}
            style={{
              padding: "8px 20px",
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Open terminal
          </button>
        </div>
      )}

      {/* Divider between the stage and the issue rows */}
      <div
        onPointerDown={beginDividerDrag}
        title="Drag to resize"
        style={{
          height: 7,
          flexShrink: 0,
          cursor: "row-resize",
          borderTop: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      />

      {/* Rows: the dense issue table */}
      <div
        style={{
          height: rowsH,
          flexShrink: 0,
          overflowY: "auto",
          background: "var(--bg)",
        }}
      >
        {visibleRows.length === 0 ? (
          <div
            style={{
              padding: "16px",
              fontSize: 12,
              color: "var(--muted)",
              textAlign: "center",
            }}
          >
            {allRows.length === 0 ? "No issues yet" : "Nothing matches this filter"}
          </div>
        ) : (
          visibleRows.map((r) => (
            <LedgerRow
              key={r.card.id}
              card={r.card}
              columnName={r.columnName}
              attention={r.attention}
              hasPane={
                r.card.terminal_window_id
                  ? liveWins.has(r.card.terminal_window_id)
                  : false
              }
              active={
                r.card.terminal_window_id
                  ? activeWins.has(r.card.terminal_window_id)
                  : false
              }
              columns={columns}
              onOpenDetail={setSelectedCardId}
              onMove={moveCard}
              onRunWithPreset={handleRunWithPreset}
            />
          ))
        )}
      </div>

      {/* Status bar */}
      <div
        style={{
          height: 24,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "0 14px",
          borderTop: "1px solid var(--border)",
          background: "var(--panel)",
          fontSize: 10,
          color: "var(--muted)",
        }}
      >
        {counts.input > 0 && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "var(--accent)",
              fontWeight: 600,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--accent)",
              }}
            />
            {counts.input} needs input
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span>
          {agentsRunning} agent{agentsRunning === 1 ? "" : "s"} running
          {prOpen > 0 ? ` · ${prOpen} PR open` : ""}
        </span>
      </div>

      {/* Card detail modal */}
      {selectedCardId && (
        <>
          <div
            onClick={() => setSelectedCardId(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 200,
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 201,
              width: 560,
              maxWidth: "90vw",
              maxHeight: "85vh",
              overflowY: "auto",
              borderRadius: "var(--radius-md)",
              boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
            }}
          >
            <CardDetail
              card={selectedCard}
              workspace={activeWorkspace}
              onClose={() => setSelectedCardId(null)}
              onDeleted={() => setSelectedCardId(null)}
              modal
            />
          </div>
        </>
      )}
    </div>
  );
}
