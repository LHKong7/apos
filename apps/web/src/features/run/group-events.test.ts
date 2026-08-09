import { describe, expect, it } from 'vitest';
import { groupEvents, isNoise } from './group-events';
import type { RunEventRow } from '../../lib/api/types';

function ev(seq: number, type: string, summary: string, payload?: Record<string, unknown>): RunEventRow {
  return {
    seq,
    ts: new Date(2026, 0, 1, 12, 0, seq).toISOString(),
    type,
    level: 'detail',
    summary,
    payload: payload ?? null,
    costDelta: null,
  };
}

/**
 * 合并连续同类工具调用（页面文档 09 §5.3）。
 *
 * Agent 连读六个文件只有一个信息量：它在找东西。
 * 六行占满屏幕会把真正的转折点（推理、写文件、失败）挤出视野。
 */
describe('简明模式的事件合并', () => {
  it('连续的同名工具调用折叠成一行并计数', () => {
    const entries = groupEvents(
      [
        ev(1, 'run_started', 'Run 启动'),
        ev(2, 'tool_call', '调用 read_file', { tool: 'read_file' }),
        ev(3, 'tool_call', '调用 read_file', { tool: 'read_file' }),
        ev(4, 'tool_call', '调用 read_file', { tool: 'read_file' }),
        ev(5, 'reasoning', '决定采用复合索引'),
      ],
      true,
    );

    expect(entries).toHaveLength(3);
    expect(entries[1]!.summary).toBe('调用 read_file ×3');
    expect(entries[1]!.members).toHaveLength(3);
    // 时间戳取最后一条 —— 折叠后要能看出这组调用什么时候结束
    expect(entries[1]!.ts).toBe(new Date(2026, 0, 1, 12, 0, 4).toISOString());
  });

  it('不同工具不合并', () => {
    const entries = groupEvents(
      [
        ev(1, 'tool_call', '调用 read_file', { tool: 'read_file' }),
        ev(2, 'tool_call', '调用 write_file', { tool: 'write_file' }),
      ],
      true,
    );
    expect(entries).toHaveLength(2);
  });

  it('★ 被其他事件隔开就不算「连续」', () => {
    const entries = groupEvents(
      [
        ev(1, 'tool_call', '调用 read_file', { tool: 'read_file' }),
        ev(2, 'progress', '实现逻辑'),
        ev(3, 'tool_call', '调用 read_file', { tool: 'read_file' }),
      ],
      true,
    );
    // 中间发生了阶段变化，把它们并成一行会掩盖「分两个阶段各读了一次」
    expect(entries).toHaveLength(3);
  });

  it('详细模式不合并 —— 每次调用的参数都要看得见', () => {
    const entries = groupEvents(
      [
        ev(1, 'tool_call', '调用 read_file', { tool: 'read_file', path: 'a.ts' }),
        ev(2, 'tool_call', '调用 read_file', { tool: 'read_file', path: 'b.ts' }),
      ],
      false,
    );
    expect(entries).toHaveLength(2);
  });

  it('没有 tool 字段的事件不会被误合并', () => {
    const entries = groupEvents([ev(1, 'tool_call', '调用'), ev(2, 'tool_call', '调用')], true);
    expect(entries).toHaveLength(2);
  });

  it('空输入返回空', () => {
    expect(groupEvents([], true)).toEqual([]);
  });
});

describe('简明模式的噪声过滤', () => {
  it('心跳、工具返回、成本事件在简明模式里没有独立信息量', () => {
    expect(isNoise('heartbeat')).toBe(true);
    expect(isNoise('tool_result')).toBe(true);
    expect(isNoise('cost')).toBe(true);
  });

  it('叙事骨架不能被过滤掉', () => {
    for (const type of ['run_started', 'progress', 'tool_call', 'reasoning', 'error', 'run_ended']) {
      expect(isNoise(type)).toBe(false);
    }
  });
});
