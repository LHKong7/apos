import { t } from '../../lib/i18n';
import type { RunEventRow } from '../../lib/api/types';

export interface TimelineEntry {
  /** 同一组内第一条事件的 seq，用作 key */
  seq: number;
  ts: string;
  type: string;
  summary: string;
  payload: Record<string, unknown> | null;
  tokensDelta: number | null;
  /** 被折叠进来的事件（含首条）。长度 > 1 时显示 `xN` */
  members: RunEventRow[];
}

/**
 * 合并连续的同类工具调用（页面文档 09 §5.3 简明模式）。
 *
 * `read_file × 6` 折叠成一行，是因为 Agent 读六个文件这件事本身
 * 只有一个信息量：它在找东西。六行占满屏幕会把真正的转折点
 * （推理、写文件、失败）挤出视野。
 *
 * 只在简明模式合并；详细模式是排障视图，那里每一次调用的参数都要看得见。
 */
export function groupEvents(events: RunEventRow[], merge: boolean): TimelineEntry[] {
  const out: TimelineEntry[] = [];

  for (const event of events) {
    const last = out.at(-1);
    const tool = toolNameOf(event);

    const mergeable =
      merge &&
      last !== undefined &&
      event.type === 'tool_call' &&
      last.type === 'tool_call' &&
      tool !== null &&
      toolNameOf(last.members[0]!) === tool;

    if (mergeable) {
      last.members.push(event);
      last.ts = event.ts;
      last.summary = t('timeline.toolCalls', { tool, count: last.members.length });
      continue;
    }

    out.push({
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      summary: event.summary,
      payload: event.payload,
      tokensDelta: event.tokensDelta,
      members: [event],
    });
  }

  return out;
}

function toolNameOf(event: RunEventRow): string | null {
  const tool = event.payload?.['tool'];
  return typeof tool === 'string' ? tool : null;
}

/** 类型 → 图标（页面文档 09 §5.3 的表格） */
export const EVENT_ICONS: Record<string, string> = {
  run_started: '🚀',
  context_loaded: '🔧',
  tool_call: '🛠',
  tool_result: '↩',
  reasoning: '💭',
  delegation: '🤝',
  intervention_request: '🙋',
  note: '📝',
  progress: '▸',
  cost: '💰',
  heartbeat: '·',
  error: '❌',
  artifact: '📎',
  run_ended: '🏁',
};

export function eventIcon(type: string): string {
  return EVENT_ICONS[type] ?? '•';
}

/** 简明模式里没有独立信息量的事件类型 —— 它们的内容已经体现在别处 */
const NOISE_IN_BRIEF: readonly string[] = ['heartbeat', 'tool_result', 'cost'];

export function isNoise(type: string): boolean {
  return NOISE_IN_BRIEF.includes(type);
}
