import { create } from "zustand";
import type { Card, BoardColumn } from "../lib/ipc";

interface BoardState {
  // Cards keyed by workspace_id, then column_id
  boards: Record<string, { columns: BoardColumn[]; cardsByColumn: Record<string, Card[]> }>;
  activeWorkspaceId: string | null;

  setBoard: (workspaceId: string, columns: BoardColumn[], cards: Card[]) => void;
  setActiveWorkspace: (workspaceId: string | null) => void;
  optimisticMove: (
    workspaceId: string,
    cardId: string,
    toColumnId: string,
    beforeCardId?: string,
    afterCardId?: string
  ) => void;
  addCard: (workspaceId: string, card: Card) => void;
}

function sortByPosition(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.position - b.position);
}

function organizeCards(columns: BoardColumn[], cards: Card[]): Record<string, Card[]> {
  const cardsByColumn: Record<string, Card[]> = {};
  for (const col of columns) {
    cardsByColumn[col.id] = [];
  }
  for (const card of cards) {
    if (!cardsByColumn[card.column_id]) {
      cardsByColumn[card.column_id] = [];
    }
    cardsByColumn[card.column_id].push(card);
  }
  for (const colId of Object.keys(cardsByColumn)) {
    cardsByColumn[colId] = sortByPosition(cardsByColumn[colId]);
  }
  return cardsByColumn;
}

export const useBoardStore = create<BoardState>((set) => ({
  boards: {},
  activeWorkspaceId: null,

  setBoard: (workspaceId, columns, cards) =>
    set((state) => ({
      boards: {
        ...state.boards,
        [workspaceId]: {
          columns,
          cardsByColumn: organizeCards(columns, cards),
        },
      },
    })),

  setActiveWorkspace: (workspaceId) =>
    set({ activeWorkspaceId: workspaceId }),

  optimisticMove: (workspaceId, cardId, toColumnId, beforeCardId, afterCardId) =>
    set((state) => {
      const board = state.boards[workspaceId];
      if (!board) return state;
      const { cardsByColumn } = board;
      const newCardsByColumn: Record<string, Card[]> = {};
      let movedCard: Card | undefined;
      for (const colId of Object.keys(cardsByColumn)) {
        const list = cardsByColumn[colId];
        const idx = list.findIndex((c) => c.id === cardId);
        if (idx !== -1) {
          movedCard = list[idx];
          newCardsByColumn[colId] = list.filter((c) => c.id !== cardId);
        } else {
          newCardsByColumn[colId] = list;
        }
      }
      if (!movedCard) return state;
      movedCard = { ...movedCard, column_id: toColumnId };
      const targetList = [...(newCardsByColumn[toColumnId] || [])];
      let inserted = false;
      if (beforeCardId) {
        const idx = targetList.findIndex((c) => c.id === beforeCardId);
        if (idx !== -1) {
          targetList.splice(idx, 0, movedCard);
          inserted = true;
        }
      }
      if (!inserted && afterCardId) {
        const idx = targetList.findIndex((c) => c.id === afterCardId);
        if (idx !== -1) {
          targetList.splice(idx + 1, 0, movedCard);
          inserted = true;
        }
      }
      if (!inserted) {
        targetList.push(movedCard);
      }
      newCardsByColumn[toColumnId] = targetList;
      return {
        boards: {
          ...state.boards,
          [workspaceId]: {
            ...board,
            cardsByColumn: newCardsByColumn,
          },
        },
      };
    }),

  addCard: (workspaceId, card) =>
    set((state) => {
      const board = state.boards[workspaceId];
      if (!board) return state;
      const list = [...(board.cardsByColumn[card.column_id] || []), card];
      return {
        boards: {
          ...state.boards,
          [workspaceId]: {
            ...board,
            cardsByColumn: {
              ...board.cardsByColumn,
              [card.column_id]: sortByPosition(list),
            },
          },
        },
      };
    }),
}));