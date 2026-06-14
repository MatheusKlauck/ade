import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ElementDropTargetEventBasePayload } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { boardGet, cardCreate, cardMove, terminalWrite } from "../lib/ipc";
import type { Card as CardType, BoardColumn as BoardColumnType } from "../lib/ipc";
import type { TerminalPreset } from "../store/settings";
import { useBoardStore } from "../store/board";
import { useTerminalsStore } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import {
  COL_BACKLOG,
  COL_DOING,
  COL_DONE,
  COL_PR,
  COLUMN_ORDER,
} from "../lib/columns";
import { useSettingsStore } from "../store/settings";
import { useEnterAnimation } from "../lib/useEnterAnimation";
import CardDetail from "./CardDetail";
import { useContextMenu } from "./ContextMenu";
import CardContextMenu, { useCardDeleteConfirm } from "./CardContextMenu";
import { ArrowUpRightIcon, BranchIcon } from "./icons";

interface KanbanFullProps {
  workspaceId: string | null;
}

/**
 * The always-visible board that fills the lower half of the board view (the
 * mockup's issue table). Five flat columns side by side, each a vertical card
 * list; cards stay draggable, double-click opens the detail modal, right-click
 * runs the task with a chosen preset — same behaviours as the classic Board,
 * restyled to the stage mockup.
 */
export default function KanbanFull({ workspaceId }: KanbanFullProps) {
  const boards = useBoardStore((s) => s.boards);
  const optimisticMove = useBoardStore((s) => s.optimisticMove);
  const setBoard = useBoardStore((s) => s.setBoard);
  const removePane = useTerminalsStore((s) => s.removePane);

  const board = workspaceId ? boards[workspaceId] : undefined;
  const columns = board?.columns || [];
  const cardsByColumn = board?.cardsByColumn || {};

  const [newTitle, setNewTitle] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const { requestDelete, dialog: deleteDialog } = useCardDeleteConfirm();

  // DnD handlers read the latest board state via getState() (not the render-time
  // snapshot) so the closures registered once per drop target never act on a
  // stale card list — same contract as the classic Board.
  const handleDropOnColumn = useCallback(
    (columnId: string, draggedCardId: string) => {
      if (!workspaceId) return;
      const b = useBoardStore.getState().boards[workspaceId];
      const currentCards = b?.cardsByColumn[columnId] || [];
      const lastCard = currentCards[currentCards.length - 1];
      if (lastCard?.id === draggedCardId) return;
      optimisticMove(workspaceId, draggedCardId, columnId, undefined, lastCard?.id);
      cardMove(draggedCardId, columnId, undefined, lastCard?.id).catch((e) => {
        console.error("card_move (column drop) failed", e);
      });
      closeTerminalIfDone(b, columnId, draggedCardId, removePane);
    },
    [workspaceId, optimisticMove, removePane]
  );

  const handleDropBeforeCard = useCallback(
    (draggedCardId: string, beforeCardId: string) => {
      if (!workspaceId) return;
      const b = useBoardStore.getState().boards[workspaceId];
      const cards = b?.cardsByColumn || {};
      let targetColumnId = "";
      for (const colId of Object.keys(cards)) {
        if (cards[colId].some((c) => c.id === beforeCardId)) {
          targetColumnId = colId;
          break;
        }
      }
      if (!targetColumnId) return;
      const list = cards[targetColumnId];
      const idx = list.findIndex((c) => c.id === beforeCardId);
      const afterCardId = idx > 0 ? list[idx - 1].id : undefined;
      optimisticMove(workspaceId, draggedCardId, targetColumnId, beforeCardId, afterCardId);
      cardMove(draggedCardId, targetColumnId, beforeCardId, afterCardId).catch((e) => {
        console.error("card_move (reorder) failed", e);
      });
      closeTerminalIfDone(b, targetColumnId, draggedCardId, removePane);
    },
    [workspaceId, optimisticMove, removePane]
  );

  const handleCreateCard = () => {
    if (!workspaceId || !newTitle.trim()) return;
    const backlog = columns.find((c) => c.name === COL_BACKLOG);
    if (!backlog) return;
    cardCreate(workspaceId, backlog.id, newTitle.trim()).then(() => {
      setNewTitle("");
      boardGet(workspaceId).then((res) => setBoard(workspaceId, res.columns, res.cards));
    });
  };

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

  // Right-click → "Move to {column}": same path as a column drop, including the
  // Done-closes-its-terminal side effect.
  const handleMove = useCallback(
    (card: CardType, toColumnId: string) => {
      if (!workspaceId) return;
      optimisticMove(workspaceId, card.id, toColumnId);
      cardMove(card.id, toColumnId).catch((e) => {
        console.error("card_move (context menu) failed", e);
      });
      const b = useBoardStore.getState().boards[workspaceId];
      closeTerminalIfDone(b, toColumnId, card.id, removePane);
    },
    [workspaceId, optimisticMove, removePane]
  );

  const sortedColumns = useMemo(
    () =>
      [...columns].sort(
        (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name)
      ),
    [columns]
  );

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = workspaceId
    ? workspaces.find((w) => w.id === workspaceId) ?? null
    : null;

  const allCards = Object.values(cardsByColumn).flat();
  const selectedCard = selectedCardId
    ? allCards.find((c) => c.id === selectedCardId) || null
    : null;

  useEffect(() => {
    if (!selectedCardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedCardId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCardId]);

  if (!workspaceId) return null;

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {sortedColumns.map((col, i) => (
        <BoardColumn
          key={col.id}
          column={col}
          cards={cardsByColumn[col.id] || []}
          isLast={i === sortedColumns.length - 1}
          onDropCard={handleDropOnColumn}
          onDropBeforeCard={handleDropBeforeCard}
          onCardDoubleClick={setSelectedCardId}
          onRunWithPreset={handleRunWithPreset}
          onMove={handleMove}
          onDelete={requestDelete}
          columns={columns}
          showNewCardInput={col.name === COL_BACKLOG}
          newTitle={newTitle}
          setNewTitle={setNewTitle}
          onCreateCard={handleCreateCard}
        />
      ))}

      {selectedCardId && (
        <>
          <div
            onClick={() => setSelectedCardId(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "var(--scrim)",
              zIndex: 1200,
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 1300,
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

      {deleteDialog}
    </div>
  );
}

// When a card lands in Done, close its viewer pane (the tmux window is killed
// by the backend). Shared by both drop paths. Non-fatal on any miss.
function closeTerminalIfDone(
  board: { columns: { id: string; name: string }[]; cardsByColumn: Record<string, CardType[]> } | undefined,
  targetColumnId: string,
  draggedCardId: string,
  removePane: (paneId: string) => void
) {
  try {
    const targetCol = board?.columns.find((c) => c.id === targetColumnId);
    if (targetCol?.name !== COL_DONE) return;
    const allCards = Object.values(board?.cardsByColumn || {}).flat();
    const draggedCard = allCards.find((c) => c.id === draggedCardId);
    if (draggedCard?.terminal_window_id) {
      const pane = useTerminalsStore
        .getState()
        .panes.find((p) => p.windowId === draggedCard.terminal_window_id);
      if (pane) removePane(pane.paneId);
    }
  } catch {
    // Non-fatal — never break the drop.
  }
}

function BoardColumn({
  column,
  cards,
  isLast,
  onDropCard,
  onDropBeforeCard,
  onCardDoubleClick,
  onRunWithPreset,
  onMove,
  onDelete,
  columns,
  showNewCardInput,
  newTitle,
  setNewTitle,
  onCreateCard,
}: {
  column: { id: string; name: string };
  cards: CardType[];
  isLast: boolean;
  onDropCard: (columnId: string, draggedCardId: string) => void;
  onDropBeforeCard: (draggedCardId: string, beforeCardId: string) => void;
  onCardDoubleClick: (cardId: string) => void;
  onRunWithPreset: (card: CardType, preset: TerminalPreset) => void;
  onMove: (card: CardType, toColumnId: string) => void;
  onDelete: (card: CardType) => void;
  columns: BoardColumnType[];
  showNewCardInput: boolean;
  newTitle: string;
  setNewTitle: (s: string) => void;
  onCreateCard: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ columnId: column.id }),
      canDrop: (args) => args.source.data.cardId !== undefined,
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: (args: ElementDropTargetEventBasePayload) => {
        setOver(false);
        // When dropped on a card, that inner target already reordered — only act
        // as the column when WE are the innermost target.
        const innermost = args.location.current.dropTargets[0];
        if (innermost && innermost.data.cardId !== undefined) return;
        const draggedCardId = args.source.data.cardId as string;
        if (draggedCardId) onDropCard(column.id, draggedCardId);
      },
    });
  }, [column.id, onDropCard]);

  const { isEntering, onEntered } = useEnterAnimation(cards.map((c) => c.id));

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: isLast ? "none" : "1px solid var(--border)",
        background: over ? "var(--drop-target)" : "transparent",
        transition: "background var(--dur-instant) var(--ease-out-quart)",
      }}
    >
      {/* Column header — uppercase label + count, matching the mockup. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-sm)",
          padding: "10px 14px 8px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          {column.name}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {cards.length}
        </span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "0 10px 10px",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-sm)",
        }}
      >
        {cards.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            columnName={column.name}
            columns={columns}
            onDropBefore={onDropBeforeCard}
            onDoubleClick={() => onCardDoubleClick(card.id)}
            onOpenDetail={onCardDoubleClick}
            onRunWithPreset={onRunWithPreset}
            onMove={onMove}
            onDelete={onDelete}
            entering={isEntering(card.id)}
            onEntered={() => onEntered(card.id)}
          />
        ))}

        {showNewCardInput && (
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCreateCard();
            }}
            placeholder="+ New card…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              marginTop: 2,
              padding: "6px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px dashed var(--border)",
              background: "transparent",
              color: "var(--fg)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
            }}
          />
        )}
      </div>
    </div>
  );
}

function BoardCard({
  card,
  columnName,
  columns,
  onDropBefore,
  onDoubleClick,
  onOpenDetail,
  onRunWithPreset,
  onMove,
  onDelete,
  entering,
  onEntered,
}: {
  card: CardType;
  columnName: string;
  columns: BoardColumnType[];
  onDropBefore: (cardId: string, beforeCardId: string) => void;
  onDoubleClick: () => void;
  onOpenDetail: (cardId: string) => void;
  onRunWithPreset: (card: CardType, preset: TerminalPreset) => void;
  onMove: (card: CardType, toColumnId: string) => void;
  onDelete: (card: CardType) => void;
  entering: boolean;
  onEntered: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const presets = useSettingsStore((s) => s.presets);

  const onDropBeforeRef = useRef(onDropBefore);
  onDropBeforeRef.current = onDropBefore;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const d = draggable({
      element: el,
      getInitialData: () => ({
        cardId: card.id,
        columnId: card.column_id,
        cardTitle: card.title,
        cardBodyPreview: card.body_preview,
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
    const dt = dropTargetForElements({
      element: el,
      getData: () => ({ cardId: card.id, columnId: card.column_id }),
      canDrop: (args) => args.source.data.cardId !== card.id,
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: (args) => {
        setOver(false);
        const draggedCardId = args.source.data.cardId as string;
        const handler = onDropBeforeRef.current;
        if (handler && draggedCardId !== card.id) handler(draggedCardId, card.id);
      },
    });
    return () => {
      d();
      dt();
    };
  }, [card.id, card.column_id]);

  const isGithub = card.source === "github" && card.github_issue_number != null;
  const isDoing = columnName === COL_DOING;
  const isDone = columnName === COL_DONE;
  const isPr = columnName === COL_PR;

  // Dot: green while in Doing, otherwise source-coloured. Local cards (no issue
  // number) carry no dot — they read as a bare title, like the mockup.
  const dotColor = isDoing
    ? "var(--status-success)"
    : isGithub
    ? "var(--source-github)"
    : null;

  const branch = isDoing && card.github_issue_number != null
    ? `issue-${card.github_issue_number}`
    : null;

  const idChipStyle: CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--muted)",
  };

  return (
    <>
      <div
        ref={ref}
        className={entering ? "ade-card-enter" : undefined}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) onEntered();
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
        style={{
          flexShrink: 0,
          padding: "8px 10px",
          background: dragging ? "var(--surface-input)" : "var(--surface-raised)",
          border: `1px solid ${isDoing ? "var(--status-success)" : "var(--border)"}`,
          borderRadius: "var(--radius-md)",
          cursor: "grab",
          opacity: isDone ? 0.5 : dragging ? 0.5 : 1,
          transform: dragging ? "scale(0.98)" : "scale(1)",
          boxShadow: over
            ? "inset 0 0 0 1px var(--accent)"
            : isDoing
            ? "inset 0 0 0 1px color-mix(in oklab, var(--status-success) 28%, transparent)"
            : "none",
          transition:
            "background var(--dur-instant) var(--ease-out-quart)," +
            " transform var(--dur-instant) var(--ease-out-quart)," +
            " box-shadow var(--dur-instant) var(--ease-out-quart)," +
            " opacity var(--dur-instant) var(--ease-out-quart)",
        }}
      >
        {/* Top line: dot + #id (+ PR marker / doing pip on the right). */}
        {(isGithub || isPr || isDoing) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 4,
            }}
          >
            {dotColor && (
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: dotColor,
                }}
              />
            )}
            {isGithub && <span style={idChipStyle}>#{card.github_issue_number}</span>}
            <div style={{ flex: 1 }} />
            {isPr && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--source-github)",
                }}
              >
                <ArrowUpRightIcon size={11} />
                PR
              </span>
            )}
            {isDoing && (
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--status-success)",
                }}
              />
            )}
          </div>
        )}

        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.35,
            color: "var(--fg)",
            wordBreak: "break-word",
          }}
        >
          {card.title}
        </div>

        {branch && (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              marginTop: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--muted)",
            }}
          >
            <BranchIcon size={11} />
            {branch}
          </div>
        )}
      </div>

      {menu && (
        <CardContextMenu
          position={menu}
          onClose={closeMenu}
          card={card}
          columnName={columnName}
          columns={columns}
          presets={presets}
          onOpen={onOpenDetail}
          onRunWithPreset={onRunWithPreset}
          onMove={onMove}
          onDelete={onDelete}
        />
      )}
    </>
  );
}
