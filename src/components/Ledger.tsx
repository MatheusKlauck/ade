import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
  normalizeExpanded,
  filterRows,
  sortRows,
  rowCounts,
  DEFAULT_ACCORDION_HEIGHT,
  type LedgerFilter,
  type LedgerRowModel,
} from "../store/ledger";
import { COL_BACKLOG, COL_DOING, COL_DONE } from "../lib/columns";
import LedgerRow from "./LedgerRow";
import ExpandedTerminal from "./ExpandedTerminal";
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

const MIN_ACCORDION_H = 140;
const MAX_ACCORDION_H = 900;

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

  const expandedByWorkspace = useLedgerStore((s) => s.expandedByWorkspace);
  const accordionHeightByWorkspace = useLedgerStore(
    (s) => s.accordionHeightByWorkspace
  );
  const attentionByWindow = useLedgerStore((s) => s.attentionByWindow);
  const filter = useLedgerStore((s) => s.filter);
  const fullscreenWindowId = useLedgerStore((s) => s.fullscreenWindowId);
  const setFilter = useLedgerStore((s) => s.setFilter);
  const setExpanded = useLedgerStore((s) => s.setExpanded);
  const loadExpanded = useLedgerStore((s) => s.loadExpanded);
  const toggleExpandedWindow = useLedgerStore((s) => s.toggleExpandedWindow);
  const setAccordionHeight = useLedgerStore((s) => s.setAccordionHeight);
  const setFullscreen = useLedgerStore((s) => s.setFullscreen);
  const clearAttention = useLedgerStore((s) => s.clearAttention);

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const syncStatus = useWorkspacesStore((s) => s.syncStatus);
  const activeWorkspace = workspaceId
    ? workspaces.find((w) => w.id === workspaceId) ?? null
    : null;

  const [newTitle, setNewTitle] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);
  const [cursorIdx, setCursorIdx] = useState(-1); // keyboard cursor row

  const board = workspaceId ? boards[workspaceId] : undefined;
  const columns = useMemo(() => board?.columns ?? [], [board]);
  const cardsByColumn = board?.cardsByColumn;

  // Load persisted expansion + height on workspace change.
  useEffect(() => {
    if (workspaceId) loadExpanded(workspaceId);
  }, [workspaceId, loadExpanded]);

  // Escape closes the card-detail modal.
  useEffect(() => {
    if (!selectedCardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedCardId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCardId]);

  // Clear the attention flag for whichever terminal you're actively watching.
  useEffect(() => {
    if (focusedWindowId) clearAttention(focusedWindowId);
  }, [focusedWindowId, clearAttention]);

  // ---- expansion ----
  const paneWins = panes.map((p) => p.windowId);
  const winKey = paneWins.join("|");
  // paneSig also tracks paneId so a reattached window (same windowId, fresh
  // paneId/channel) rebuilds the map instead of serving the dead pane.
  const paneSig = panes.map((p) => `${p.windowId}:${p.paneId}`).join("|");
  const paneByWin = useMemo(
    () => new Map(panes.map((p) => [p.windowId, p])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneSig]
  );
  const rawExpanded = workspaceId ? expandedByWorkspace[workspaceId] : undefined;
  const expandedSet = useMemo(
    () => normalizeExpanded(rawExpanded ?? new Set<string>(), paneWins),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawExpanded, winKey]
  );

  // Prune expanded entries for closed windows (gate on loaded so we never
  // clobber persisted state before loadExpanded ran).
  useEffect(() => {
    if (!workspaceId || rawExpanded === undefined) return;
    const norm = normalizeExpanded(rawExpanded, paneWins);
    if (norm.size !== rawExpanded.size) {
      setExpanded(workspaceId, norm, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, rawExpanded, winKey]);

  const accordionH =
    dragH ??
    (workspaceId ? accordionHeightByWorkspace[workspaceId] : undefined) ??
    DEFAULT_ACCORDION_HEIGHT;

  // ---- terminal helpers ----
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
      const st = useTerminalsStore.getState();
      if ((st.lockedByWorkspace[pane.workspaceId] ?? []).includes(pane.windowId)) {
        return; // locked — can't close
      }
      onRemovePane(pane.paneId);
    },
    [onRemovePane]
  );

  // ---- card moves (single helper; Done closes the terminal) ----
  const moveCard = useCallback(
    (card: CardType, toColumnId: string) => {
      if (!workspaceId) return;
      const b = useBoardStore.getState().boards[workspaceId];
      if (!b) return;
      const toCol = b.columns.find((c) => c.id === toColumnId);
      optimisticMove(workspaceId, card.id, toColumnId);
      cardMove(card.id, toColumnId).catch((e) => {
        console.error("card_move failed", e);
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

  const handleRunWithPreset = useCallback(
    (card: CardType, preset: TerminalPreset) => {
      if (!workspaceId) return;
      const b = useBoardStore.getState().boards[workspaceId];
      if (!b) return;
      const doingCol = b.columns.find((c) => c.name === COL_DOING);
      if (!doingCol) return;

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

  // Drop a card onto another row's terminal: inject the dropped card's task and
  // start it (move to Doing). Works whether the target terminal is expanded or
  // collapsed — the row, not the hidden pane, is the drop target.
  const handleCardDrop = useCallback(
    (
      dragged: {
        cardId: string;
        columnId: string;
        cardTitle: string;
        cardBodyPreview: string | null;
      },
      targetWindowId: string
    ) => {
      if (!workspaceId) return;
      const pane = useTerminalsStore
        .getState()
        .panes.find((p) => p.windowId === targetWindowId);
      if (!pane) return;
      const lines = [`# ${dragged.cardTitle}`];
      if (dragged.cardBodyPreview) {
        for (const l of dragged.cardBodyPreview.split("\n")) {
          if (l.trim()) lines.push(`# ${l.trim()}`);
        }
      }
      terminalWrite(pane.paneId, lines.join("\r") + "\r").catch(() => {});
      useLedgerStore.getState().expandWindow(workspaceId, targetWindowId);
      const b = useBoardStore.getState().boards[workspaceId];
      const doingCol = b?.columns.find((c) => c.name === COL_DOING);
      const draggedCard = b
        ? Object.values(b.cardsByColumn)
            .flat()
            .find((c) => c.id === dragged.cardId)
        : undefined;
      if (doingCol && draggedCard && draggedCard.column_id !== doingCol.id) {
        moveCard(draggedCard, doingCol.id);
      }
    },
    [workspaceId, moveCard]
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

  const cardRows: LedgerRowModel[] = useMemo(() => {
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

  // Ad-hoc shells: panes whose window backs no card become synthetic rows so a
  // plain "New terminal" is visible and expandable like everything else.
  const cardWins = useMemo(() => {
    const s = new Set<string>();
    for (const r of cardRows)
      if (r.card.terminal_window_id) s.add(r.card.terminal_window_id);
    return s;
  }, [cardRows]);

  const shellRows: LedgerRowModel[] = useMemo(() => {
    const out: LedgerRowModel[] = [];
    for (const p of panes) {
      if (cardWins.has(p.windowId)) continue;
      const shellCard: CardType = {
        id: `shell:${p.windowId}`,
        workspace_id: p.workspaceId,
        column_id: "",
        title: titleFor(p),
        body_preview: null,
        position: -1, // sort shells ahead of issues within "doing"
        source: "local",
        github_issue_number: null,
        github_state: null,
        assignee: null,
        labels_json: null,
        remote_updated_at: null,
        terminal_window_id: p.windowId,
        created_at: "",
        updated_at: "",
      };
      out.push({
        card: shellCard,
        columnName: COL_DOING,
        attention: attentionByWindow[p.windowId],
        isAdHocShell: true,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winKey, cardWins, attentionByWindow, namesByWorkspace]);

  const counts = useMemo(() => rowCounts(cardRows), [cardRows]);
  const visibleRows = useMemo(
    () => sortRows(filterRows([...shellRows, ...cardRows], filter)),
    [shellRows, cardRows, filter]
  );

  const selectedCard = selectedCardId
    ? cardRows.find((r) => r.card.id === selectedCardId)?.card ?? null
    : null;

  // ---- keyboard nav (↑/↓ move cursor, ↩ expand) ----
  const visibleRef = useRef<LedgerRowModel[]>(visibleRows);
  visibleRef.current = visibleRows;
  const cursorRef = useRef(cursorIdx);
  cursorRef.current = cursorIdx;
  // Keep the cursor in range as the list changes.
  useEffect(() => {
    if (cursorIdx >= visibleRows.length) setCursorIdx(visibleRows.length - 1);
  }, [visibleRows.length, cursorIdx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.isContentEditable)
      )
        return; // typing somewhere (incl. a terminal's hidden textarea)
      if (useTerminalsStore.getState().focusedWindowId) return; // terminal owns keys
      if (selectedCardId) return; // modal open
      const rows = visibleRef.current;
      if (rows.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursorIdx((i) => Math.min(rows.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursorIdx((i) => (i < 0 ? 0 : Math.max(0, i - 1)));
      } else if (e.key === "Enter") {
        const i = cursorRef.current;
        const row = i >= 0 ? rows[i] : undefined;
        const wid = row?.card.terminal_window_id;
        if (wid && workspaceId && paneByWin.has(wid)) {
          e.preventDefault();
          toggleExpandedWindow(workspaceId, wid);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCardId, workspaceId, toggleExpandedWindow, paneByWin]);

  // ---- accordion height resize ----
  const beginResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    const startY = e.clientY;
    const startH = accordionH;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(
        MIN_ACCORDION_H,
        Math.min(MAX_ACCORDION_H, startH + (ev.clientY - startY))
      );
      setDragH(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragH((h) => {
        if (h != null && workspaceId) setAccordionHeight(workspaceId, h);
        return null;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- status bar figures ----
  const agentsRunning = panes.length;
  const prOpen = counts.pr;
  const sync = workspaceId ? syncStatus[workspaceId] : undefined;

  const pill = (key: LedgerFilter, label: string) => {
    const n = counts[key];
    if (key !== "all" && n === 0) return null;
    const on = filter === key;
    const isInput = key === "input";
    const accent = on || (isInput && n > 0);
    const style: CSSProperties = {
      border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
      borderRadius: "var(--radius-pill)",
      padding: "1px 10px",
      fontSize: 11,
      cursor: "pointer",
      background:
        isInput && n > 0
          ? "color-mix(in srgb, var(--accent) 10%, transparent)"
          : on
          ? "var(--surface-input)"
          : "transparent",
      color: accent ? "var(--accent)" : "var(--muted)",
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
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Toolbar */}
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
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--muted)",
            whiteSpace: "nowrap",
          }}
        >
          sort: attention · ↕ move · ↩ expand
        </span>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreateCard();
          }}
          placeholder="New card…"
          style={{
            width: 140,
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

      {/* Rows list — the single PTY container. Every TerminalPane lives here,
          keyed by stable id; collapse only toggles its wrapper height. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          background: "var(--bg)",
        }}
      >
        {visibleRows.length === 0 ? (
          <div
            style={{
              padding: 16,
              fontSize: 12,
              color: "var(--muted)",
              textAlign: "center",
            }}
          >
            {cardRows.length === 0 && shellRows.length === 0
              ? "No issues yet — add one above, or open a terminal"
              : "Nothing matches this filter"}
          </div>
        ) : (
          visibleRows.map((r, idx) => {
            const wid = r.card.terminal_window_id;
            const pane = wid ? paneByWin.get(wid) : undefined;
            const isExpanded = !!wid && expandedSet.has(wid);
            const isFs = !!wid && fullscreenWindowId === wid;
            // Key by windowId whenever one exists: it's stable even if a window
            // ever transitions shell→card-backed (the card.id would differ and
            // remount the pane → PTY death). Terminal-less cards fall back to id.
            const key = wid ?? r.card.id;
            // Collapsed → display:none (NOT height:0). A 0-height-but-laid-out
            // xterm container makes the FitAddon/ResizeObserver propose ~1 row
            // and thrash the PTY size; display:none gives the observer a clean
            // 0×0 so no resize fires — the same proven pattern the old grid used
            // for hidden panes. The pane stays MOUNTED either way (PTY intact).
            const wrapperStyle: CSSProperties = isFs
              ? {
                  position: "fixed",
                  inset: 0,
                  zIndex: "var(--z-modal)" as unknown as number,
                  background: "var(--bg)",
                }
              : isExpanded
              ? { height: accordionH, overflow: "hidden" }
              : { display: "none" };
            return (
              <Fragment key={key}>
                <LedgerRow
                  card={r.card}
                  columnName={r.columnName}
                  attention={r.attention}
                  hasPane={!!pane}
                  isExpanded={isExpanded}
                  isAdHocShell={r.isAdHocShell}
                  selected={idx === cursorIdx}
                  columns={columns}
                  onToggleExpand={() => {
                    if (wid && workspaceId) toggleExpandedWindow(workspaceId, wid);
                  }}
                  onOpenDetail={setSelectedCardId}
                  onMove={moveCard}
                  onRunWithPreset={handleRunWithPreset}
                  onCardDrop={handleCardDrop}
                />
                {pane && (
                  <div style={wrapperStyle}>
                    <ExpandedTerminal
                      pane={pane}
                      title={titleFor(pane)}
                      locked={lockedFor(pane)}
                      hasCustomName={customNameFor(pane) != null}
                      attention={attentionByWindow[pane.windowId]}
                      fullscreen={isFs}
                      onToggleLock={() => toggleLock(pane.workspaceId, pane.windowId)}
                      onRename={(name) =>
                        setTerminalName(pane.workspaceId, pane.windowId, name)
                      }
                      onRemove={() => handleRemovePane(pane)}
                      onToggleFullscreen={() =>
                        setFullscreen(isFs ? null : wid!)
                      }
                      onCollapse={() => {
                        if (isFs) setFullscreen(null);
                        if (wid && workspaceId)
                          toggleExpandedWindow(workspaceId, wid);
                      }}
                      highlighted={highlightedWindowId === wid}
                      onHighlightDone={onHighlightDone}
                    />
                  </div>
                )}
                {/* Drag grip to resize the expanded terminals (shared height). */}
                {pane && isExpanded && !isFs && (
                  <div
                    onPointerDown={beginResize}
                    title="Drag to resize terminals"
                    style={{
                      height: 6,
                      margin: "-8px 12px 6px",
                      cursor: "row-resize",
                      borderRadius: 3,
                    }}
                  />
                )}
              </Fragment>
            );
          })
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
        {sync?.lastSync && (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background:
                  sync.status === "error"
                    ? "var(--status-error)"
                    : "var(--status-success)",
              }}
            />
            {sync.status === "syncing" ? "syncing…" : "synced"}
          </span>
        )}
        {activeWorkspace?.github_repo && (
          <span style={{ fontFamily: "var(--font-mono)" }}>
            ⎇ {activeWorkspace.github_repo}
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
