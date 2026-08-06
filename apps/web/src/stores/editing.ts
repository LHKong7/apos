import { create } from 'zustand';

interface EditingState {
  /** entityId → 正在编辑的字段 */
  editing: Map<string, Set<string>>;
  /** entityId → 被拦下的远端更新字段，用于提示而不是静默丢弃 */
  conflicts: Map<string, Set<string>>;

  startEdit: (entityId: string, field: string) => void;
  endEdit: (entityId: string, field: string) => void;
  isEditing: (entityId: string, field: string) => boolean;
  noteConflict: (entityId: string, fields: string[]) => void;
  conflictOf: (entityId: string, field: string) => boolean;
  clearConflicts: (entityId: string) => void;
}

/**
 * 编辑保护（docs/tech/08-frontend-architecture.md §4.3）。
 *
 * 页面文档 README §5.10 的硬性要求：用户正在编辑的区域不被远端更新覆盖。
 * 这是最不可接受的一类 bug —— 用户敲了半天字，Agent 推来一条更新，
 * 输入框就被清空了。
 *
 * ★ 但也不能静默丢弃远端更新：用户需要知道自己看到的已经过时，
 *   否则保存时收到 409 会完全不明白发生了什么。所以冲突要留痕并提示。
 */
export const useEditingStore = create<EditingState>((set, get) => ({
  editing: new Map(),
  conflicts: new Map(),

  startEdit: (entityId, field) => {
    const editing = new Map(get().editing);
    const fields = new Set(editing.get(entityId) ?? []);
    fields.add(field);
    editing.set(entityId, fields);
    set({ editing });
  },

  endEdit: (entityId, field) => {
    const editing = new Map(get().editing);
    const fields = new Set(editing.get(entityId) ?? []);
    fields.delete(field);
    if (fields.size === 0) editing.delete(entityId);
    else editing.set(entityId, fields);
    set({ editing });
  },

  isEditing: (entityId, field) => get().editing.get(entityId)?.has(field) ?? false,

  noteConflict: (entityId, fields) => {
    if (fields.length === 0) return;
    const conflicts = new Map(get().conflicts);
    const set_ = new Set(conflicts.get(entityId) ?? []);
    for (const f of fields) set_.add(f);
    conflicts.set(entityId, set_);
    set({ conflicts });
  },

  conflictOf: (entityId, field) => get().conflicts.get(entityId)?.has(field) ?? false,

  clearConflicts: (entityId) => {
    const conflicts = new Map(get().conflicts);
    conflicts.delete(entityId);
    set({ conflicts });
  },
}));

/**
 * 打补丁时跳过用户正在编辑的字段，并把被跳过的字段记为冲突。
 * 返回值可直接用作新的缓存值。
 */
export function patchProtected<T extends object>(
  entityId: string,
  old: T,
  incoming: Partial<T>,
): T {
  const store = useEditingStore.getState();
  const safe: Record<string, unknown> = {};
  const conflicted: string[] = [];

  for (const [field, value] of Object.entries(incoming)) {
    if (store.isEditing(entityId, field)) conflicted.push(field);
    else safe[field] = value;
  }

  store.noteConflict(entityId, conflicted);
  return { ...old, ...(safe as Partial<T>) };
}
