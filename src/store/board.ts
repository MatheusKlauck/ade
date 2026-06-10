import { create } from "zustand";
import type { Card, BoardColumn } from "../lib/ipc";

interface BoardState {
  columns: BoardColumn[];
  cardsByColumn: Record<string, Card[]>;
  setBoard: (columns: BoardColumn[], cards: Card[]) => void;
  optimisticMove: (
    cardId: string,
    toColumnId: string,
    beforeCardId?: string,
    afterCardId?: string
  ) => void;
  addCard: (card: Card) => void;
}

function sortByPosition(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.position - b.position);
}

export const useBoardStore = create<BoardState>((set) => ({
  columns: [],
  cardsByColumn: {},
  setBoard: (columns, cards) => {
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
    set({ columns, cardsByColumn });
  },
  optimisticMove: (cardId, toColumnId, beforeCardId, afterCardId) =>
    set((state) => {
      const cardsByColumn: Record<string, Card[]> = {};
      let movedCard: Card | undefined;
      for (const colId of Object.keys(state.cardsByColumn)) {
        const list = state.cardsByColumn[colId];
        const idx = list.findIndex((c) => c.id === cardId);
        if (idx !== -1) {
          movedCard = list[idx];
          cardsByColumn[colId] = list.filter((c) => c.id !== cardId);
        } else {
          cardsByColumn[colId] = list;
        }
      }
      if (!movedCard) return state;
      movedCard = { ...movedCard, column_id: toColumnId };
      const targetList = [...(cardsByColumn[toColumnId] || [])];
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
      cardsByColumn[toColumnId] = targetList;
      return { cardsByColumn };
    }),
  addCard: (card) =>
    set((state) => {
      const list = [...(state.cardsByColumn[card.column_id] || []), card];
      return {
        cardsByColumn: {
          ...state.cardsByColumn,
          [card.column_id]: sortByPosition(list),
        },
      };
    }),
}));
