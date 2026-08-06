import { beforeEach, describe, expect, it } from 'vitest';
import { patchProtected, useEditingStore } from './editing';

beforeEach(() => {
  useEditingStore.setState({ editing: new Map(), conflicts: new Map() });
});

/**
 * 编辑保护（页面文档 README §5.10）。
 *
 * 用户敲了半天字、Agent 推来一条更新把输入框清空 ——
 * 这是最不可接受的一类 bug，因为用户的劳动直接消失且无从恢复。
 */
describe('远端更新不覆盖用户正在编辑的字段', () => {
  it('正在编辑的字段被跳过，其余照常应用', () => {
    const store = useEditingStore.getState();
    store.startEdit('wi-1', 'description');

    const next = patchProtected('wi-1', { description: '我写了一半', title: '旧标题' }, {
      description: 'Agent 改写的描述',
      title: '新标题',
    });

    expect(next.description).toBe('我写了一半');
    expect(next.title).toBe('新标题');
  });

  it('★ 冲突不静默丢弃，要留痕以便提示用户', () => {
    useEditingStore.getState().startEdit('wi-1', 'description');
    patchProtected('wi-1', { description: '我写了一半' }, { description: '远端版本' });

    expect(useEditingStore.getState().conflictOf('wi-1', 'description')).toBe(true);
    // 没冲突的字段不该被误报
    expect(useEditingStore.getState().conflictOf('wi-1', 'title')).toBe(false);
  });

  it('结束编辑后远端更新恢复正常应用', () => {
    const store = useEditingStore.getState();
    store.startEdit('wi-1', 'description');
    store.endEdit('wi-1', 'description');

    const next = patchProtected('wi-1', { description: '旧' }, { description: '新' });
    expect(next.description).toBe('新');
  });

  it('编辑状态按实体隔离，不同任务互不影响', () => {
    useEditingStore.getState().startEdit('wi-1', 'description');

    const other = patchProtected('wi-2', { description: '旧' }, { description: '新' });
    expect(other.description).toBe('新');
  });

  it('同一实体的多个字段各自独立', () => {
    const store = useEditingStore.getState();
    store.startEdit('wi-1', 'a');
    store.startEdit('wi-1', 'b');
    store.endEdit('wi-1', 'a');

    expect(useEditingStore.getState().isEditing('wi-1', 'a')).toBe(false);
    expect(useEditingStore.getState().isEditing('wi-1', 'b')).toBe(true);
  });
});
