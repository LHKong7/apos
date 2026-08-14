import type { AgentError, RunEventBody, TaskDispatch } from '@apos/contracts';
import { classifyError } from '../adapter';

/**
 * Codex CLI 的 JSONL 事件 → 统一 RunEvent。
 *
 * ★ 解析刻意写得宽容：只认识自己认识的字段，遇到不认识的事件类型
 *   降级成一条 note 而不是抛异常。理由是 CLI 的事件 schema 会随版本变，
 *   而「Agent 跑得好好的，因为多了一个新事件类型就整个 Run 判失败」
 *   是最糟的失败模式 —— 它看起来像模型的问题，实际是解析器的问题。
 */

const NOTE_MAX = 2000;
const SUMMARY_MAX = 300;
const ARTIFACT_MAX = 20_000;

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** 美元 / 百万 token。与 claude-code/cost.ts 同理：仅用于过程估算 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-5-codex': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'o4-mini': { input: 1.1, output: 4.4 },
};

const CACHE_READ_RATIO = 0.1;

export interface CodexTranslatorOptions {
  task: TaskDispatch;
  model: string;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

export class CodexEventTranslator {
  private turn = 0;
  private totalUsd = 0;
  private ended = false;
  private fatal: AgentError | null = null;
  private lastAssistantText = '';

  constructor(private readonly options: CodexTranslatorOptions) {}

  get endedAlready(): boolean {
    return this.ended;
  }

  get finalText(): string {
    return this.lastAssistantText;
  }

  /** 一行 JSONL → 0..n 条事件 */
  translate(raw: unknown): RunEventBody[] {
    if (!isRecord(raw)) return [];
    const type = typeof raw['type'] === 'string' ? raw['type'] : '';

    switch (type) {
      case 'thread.started':
        return [{ type: 'note', text: `会话已建立（thread ${str(raw['thread_id']) || '?'}）` }];

      case 'turn.started':
        this.turn += 1;
        return [
          {
            type: 'progress',
            step: this.turn,
            // ★ Codex 不上报总步数。按降级矩阵，progressReporting 报 false，
            //   这里给 null 而不是编一个分母
            totalSteps: null,
            description: `第 ${this.turn} 轮`,
          },
        ];

      case 'item.started':
      case 'item.completed':
      case 'item.updated':
        return this.item(raw['item'], type === 'item.completed');

      case 'turn.completed':
        return this.usage(raw['usage']);

      case 'turn.failed': {
        const err = isRecord(raw['error']) ? str(raw['error']['message']) : '';
        this.fatal = {
          class: classifyError(err),
          message: err || 'Codex 执行失败',
          retriable: true,
          classificationSource: 'inferred',
        };
        return [{ type: 'error', error: this.fatal }];
      }

      case 'error': {
        const message = str(raw['message']) || 'Codex 报告了一个错误';
        this.fatal = {
          class: classifyError(message),
          message,
          retriable: true,
          classificationSource: 'inferred',
        };
        return [{ type: 'error', error: this.fatal }];
      }

      default:
        return [];
    }
  }

  private item(item: unknown, completed: boolean): RunEventBody[] {
    if (!isRecord(item)) return [];
    const kind = str(item['type']);
    const id = str(item['id']) || `${kind}-${this.turn}`;

    switch (kind) {
      case 'agent_message': {
        const text = str(item['text']);
        if (!text.trim()) return [];
        this.lastAssistantText = text;
        return [{ type: 'note', text: truncate(text, NOTE_MAX) }];
      }

      case 'reasoning': {
        const text = str(item['text']);
        if (!text.trim()) return [];
        return [{ type: 'reasoning', summary: truncate(firstLine(text), SUMMARY_MAX), detail: text }];
      }

      case 'command_execution': {
        const command = str(item['command']);
        if (!completed) {
          return [{ type: 'tool_call', toolCallId: id, tool: 'Bash', params: { command } }];
        }
        const exitCode = num(item['exit_code']);
        return [
          {
            type: 'tool_result',
            toolCallId: id,
            ok: exitCode === 0,
            summary: truncate(
              `${command} → 退出码 ${exitCode ?? '?'}\n${str(item['aggregated_output'])}`,
              NOTE_MAX,
            ),
          },
        ];
      }

      case 'file_change': {
        const changes = Array.isArray(item['changes']) ? item['changes'] : [];
        const paths = changes.map((c) => (isRecord(c) ? str(c['path']) : '')).filter(Boolean);
        if (!completed) {
          return [{ type: 'tool_call', toolCallId: id, tool: 'Edit', params: { paths } }];
        }
        return [
          {
            type: 'tool_result',
            toolCallId: id,
            ok: true,
            summary: `修改 ${paths.length} 个文件：${paths.slice(0, 10).join('、')}`,
          },
        ];
      }

      case 'mcp_tool_call': {
        const tool = `${str(item['server'])}.${str(item['tool'])}`;
        return completed
          ? [
              {
                type: 'tool_result',
                toolCallId: id,
                ok: str(item['status']) !== 'failed',
                summary: truncate(tool, NOTE_MAX),
              },
            ]
          : [{ type: 'tool_call', toolCallId: id, tool, params: item['arguments'] ?? {} }];
      }

      case 'web_search':
        return [{ type: 'tool_call', toolCallId: id, tool: 'WebSearch', params: { query: str(item['query']) } }];

      case 'todo_list': {
        const items = Array.isArray(item['items']) ? item['items'] : [];
        const done = items.filter((t) => isRecord(t) && t['completed'] === true).length;
        return [{ type: 'note', text: `任务清单进度 ${done}/${items.length}` }];
      }

      case 'error': {
        const message = str(item['message']) || 'Codex 报告了一个错误';
        this.fatal = {
          class: classifyError(message),
          message,
          retriable: true,
          classificationSource: 'inferred',
        };
        return [{ type: 'error', error: this.fatal }];
      }

      default:
        // 不认识的 item 类型：留一条痕迹，但不当作失败
        return kind ? [{ type: 'note', text: `（未识别的执行项：${kind}）` }] : [];
    }
  }

  private usage(raw: unknown): RunEventBody[] {
    if (!isRecord(raw)) return [];
    const usage = raw as Usage;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cached_input_tokens ?? 0;
    if (input + output + cacheRead === 0) return [];

    const price = lookupPrice(this.options.model);
    const deltaUsd = price
      ? round(
          (input * price.input + output * price.output + cacheRead * price.input * CACHE_READ_RATIO) /
            1_000_000,
          6,
        )
      : 0;

    this.totalUsd = round(this.totalUsd + deltaUsd, 6);
    return [
      /**
       * ★ cacheWrite 填 0 而不是省略：Codex 的 usage 里没有这一项。
       *   0 在这里的含义是「这个运行时不区分缓存写入」，
       *   与 Claude 那边报上来的真实 0 不可区分 —— 但两者的账都不会因此错，
       *   因为 Codex 的输入 token 本来就把缓存写入算在里面了。
       */
      {
        type: 'cost',
        deltaUsd,
        totalUsd: this.totalUsd,
        tokens: { input, output, cacheRead, cacheWrite: 0 },
      },
    ];
  }

  /**
   * 进程退出时收尾。
   *
   * ★ Codex 没有等价于 Claude 那条 `result` 的权威结算消息，
   *   所以成败以「进程退出码 + 是否出现过致命错误」判定，
   *   成本以过程估算为准（costReporting 因此标注为估算值）。
   */
  finish(exitCode: number | null, stderrTail: string): RunEventBody[] {
    if (this.ended) return [];
    this.ended = true;

    const events: RunEventBody[] = [];
    const failed = this.fatal !== null || (exitCode !== null && exitCode !== 0);

    if (!failed) {
      events.push(...this.artifacts());
      events.push({
        type: 'run_ended',
        outcome: 'completed',
        summary: truncate(firstLine(this.lastAssistantText) || '任务完成', 500),
        selfReport: truncate(this.lastAssistantText, ARTIFACT_MAX),
      });
      return events;
    }

    const error: AgentError =
      this.fatal ??
      {
        class: classifyError(stderrTail),
        message: stderrTail.trim() || `Codex 进程以退出码 ${exitCode} 结束`,
        retriable: true,
        classificationSource: 'inferred',
      };

    if (!this.fatal) events.push({ type: 'error', error });
    events.push({
      type: 'run_ended',
      outcome: 'failed',
      summary: error.message,
      selfReport: truncate(this.lastAssistantText || error.message, ARTIFACT_MAX),
    });
    return events;
  }

  private artifacts(): RunEventBody[] {
    const text = this.lastAssistantText;
    const out: RunEventBody[] = [];

    const pr = text.match(PR_URL);
    if (pr) {
      out.push({
        type: 'artifact',
        artifact: {
          kind: 'pull_request',
          title: `PR：${this.options.task.goal.title}`,
          externalUrl: pr[0],
          content: null,
          metadata: { source: 'codex', detectedFrom: 'run_result' },
        },
      });
    }

    if (text.trim()) {
      out.push({
        type: 'artifact',
        artifact: {
          kind: 'document',
          title: `执行摘要：${this.options.task.goal.title}`,
          externalUrl: null,
          content: truncate(text, ARTIFACT_MAX),
          metadata: { source: 'codex', runId: this.options.task.runId },
        },
      });
    }

    return out;
  }
}

function lookupPrice(model: string) {
  if (PRICE_PER_MTOK[model]) return PRICE_PER_MTOK[model];
  for (const [key, price] of Object.entries(PRICE_PER_MTOK)) {
    if (model.startsWith(key)) return price;
  }
  return null;
}

export function hasCodexPricing(model: string): boolean {
  return lookupPrice(model) !== null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…（已截断，共 ${t.length} 字）`;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
