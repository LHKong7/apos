import { create } from 'zustand';
import type { Stage } from '@apos/contracts';

export type BoardView = 'kanban' | 'list' | 'agent' | 'decision';

export interface MoveRecord {
  workItemId: string;
  from: Stage | null;
  to: Stage;
  /** 谁推动的：system / agent / human / integration */
  source: string;
  at: number;
}

interface BoardState {
  /** 用户正在查看详情的卡片 —— 它的自动移动动画要延后（页面文档 05 §5.5） */
  openedCardId: string | null;
  draggingCardId: string | null;
  /** 安静模式：只更新数据不做动画（页面文档 05 §12 的待确认项，默认关） */
  quiet: boolean;

  /** 最近发生的移动，驱动落位动画与来源角标 */
  moves: Map<string, MoveRecord>;
  /** 未被用户「看见」的移动数量，用于顶部汇总提示 */
  unseenMoves: MoveRecord[];

  setOpenedCard: (id: string | null) => void;
  setDragging: (id: string | null) => void;
  toggleQuiet: () => void;
  recordMove: (move: MoveRecord) => void;
  clearMove: (workItemId: string) => void;
  acknowledgeMoves: () => void;
}

/** 落位动画时长；超过就不再算「刚移动过」 */
export const MOVE_HIGHLIGHT_MS = 1500;
/** 多张卡同时移动时的错峰间隔（页面文档 05 §5.5） */
export const MOVE_STAGGER_MS = 80;

export const useBoardStore = create<BoardState>((set, get) => ({
  openedCardId: null,
  draggingCardId: null,
  quiet: false,
  moves: new Map(),
  unseenMoves: [],

  setOpenedCard: (id) => set({ openedCardId: id }),
  setDragging: (id) => set({ draggingCardId: id }),
  toggleQuiet: () => set((s) => ({ quiet: !s.quiet })),

  recordMove: (move) => {
    const moves = new Map(get().moves);
    moves.set(move.workItemId, move);
    set({ moves, unseenMoves: [...get().unseenMoves, move] });
  },

  clearMove: (workItemId) => {
    const moves = new Map(get().moves);
    moves.delete(workItemId);
    set({ moves });
  },

  acknowledgeMoves: () => set({ unseenMoves: [] }),
}));
