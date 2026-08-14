import type { AgentError, RunEventBody, TaskDispatch } from '@apos/contracts';
import type { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { estimateCostUsd, hasPricing, type TokenCounts } from './cost';
import { classifyAssistantError, classifyResultError } from './errors';

type ContentBlock = SDKAssistantMessage['message']['content'][number];

const NOTE_MAX = 2000;
const REASONING_SUMMARY_MAX = 300;
const ARTIFACT_MAX = 20_000;

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

export interface TranslatorOptions {
  task: TaskDispatch;
  /** 用于 progress 的分母；Claude Code 不上报总步数，用轮次上限近似 */
  maxTurns: number;
}

/**
 * SDK 消息 → 统一 RunEvent。
 *
 * 做成有状态的类而不是纯函数，是因为三件事必须跨消息累计：
 * 轮次编号、成本估算、以及「同一次 API 调用被拆成多条 assistant 消息」的去重。
 */
export class EventTranslator {
  private turn = 0;
  private estimatedTotalUsd = 0;
  private countedMessages = new Set<string>();
  private model: string | null;
  /** 结束事件只发一次 —— result 之后若 SDK 再吐消息不能重复终结 Run */
  private ended = false;
  /** 执行中出现过的致命错误，决定最终 outcome */
  private fatalError: AgentError | null = null;

  constructor(private readonly options: TranslatorOptions) {
    this.model = options.task.model;
  }

  get endedAlready(): boolean {
    return this.ended;
  }

  /** 已估算的累计成本，用于 result 到达时校正 */
  get estimatedUsd(): number {
    return this.estimatedTotalUsd;
  }

  translate(msg: SDKMessage): RunEventBody[] {
    switch (msg.type) {
      case 'system':
        return this.system(msg);
      case 'assistant':
        return this.assistant(msg);
      case 'user':
        return this.user(msg);
      case 'tool_progress':
        return [{ type: 'heartbeat' }];
      case 'result':
        return this.result(msg);
      default:
        return [];
    }
  }

  private system(msg: Extract<SDKMessage, { type: 'system' }>): RunEventBody[] {
    switch (msg.subtype) {
      case 'init':
        this.model = msg.model;
        return [
          {
            type: 'context_loaded',
            items: this.options.task.context.map((c) => ({
              ref: c.ref,
              // SDK 不回报每项上下文的 token 数，用字符数近似（约 3 字符/token）
              tokens: Math.ceil((c.content?.length ?? 0) / 3),
              used: true,
            })),
          },
          {
            type: 'note',
            text: `会话就绪：模型 ${msg.model}，可用工具 ${msg.tools.join('、') || '（无）'}`,
          },
        ];

      case 'task_started':
        return [
          {
            type: 'delegation',
            childRunId: msg.task_id,
            agentRef: msg.subagent_type ?? 'task',
            goal: msg.description,
          },
        ];

      case 'task_progress':
        return [{ type: 'note', text: truncate(msg.summary ?? msg.description, NOTE_MAX) }];

      case 'compact_boundary':
        return [
          {
            type: 'note',
            text: `上下文已压缩（${msg.compact_metadata.trigger === 'auto' ? '自动' : '手动'}）`,
          },
        ];

      case 'permission_denied':
        // 拒绝本身由 canUseTool 记录，这里只补一条运行时视角的确认
        return [
          {
            type: 'note',
            text: truncate(
              `运行时拒绝了工具调用：${msg.tool_name}（${msg.decision_reason ?? msg.message}）`,
              NOTE_MAX,
            ),
          },
        ];

      default:
        return [];
    }
  }

  private assistant(msg: SDKAssistantMessage): RunEventBody[] {
    const events: RunEventBody[] = [];

    if (msg.error) {
      // 记下来：SDK 之后可能仍以 subtype='success' 收尾，那条 result 不能算成功
      this.fatalError = classifyAssistantError(msg.error);
      events.push({ type: 'error', error: this.fatalError });
    }

    this.turn += 1;
    const blocks = msg.message.content;

    events.push({
      type: 'progress',
      step: this.turn,
      totalSteps: this.options.maxTurns,
      description: describeTurn(blocks),
    });

    for (const block of blocks) {
      const event = this.block(block);
      if (event) events.push(event);
    }

    const cost = this.costFor(msg);
    if (cost) events.push(cost);

    return events;
  }

  private block(block: ContentBlock): RunEventBody | null {
    switch (block.type) {
      case 'text':
        return block.text.trim() ? { type: 'note', text: truncate(block.text, NOTE_MAX) } : null;

      case 'thinking':
        return {
          type: 'reasoning',
          summary: truncate(firstLine(block.thinking), REASONING_SUMMARY_MAX),
          detail: block.thinking,
        };

      case 'redacted_thinking':
        return { type: 'reasoning', summary: '（推理内容已被运行时脱敏）' };

      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use':
        return {
          type: 'tool_call',
          toolCallId: block.id,
          tool: block.name,
          params: block.input,
        };

      default:
        return null;
    }
  }

  private user(msg: Extract<SDKMessage, { type: 'user' }>): RunEventBody[] {
    const content = msg.message.content;
    if (typeof content === 'string') return [];

    const events: RunEventBody[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const ok = block.is_error !== true;
      events.push({
        type: 'tool_result',
        toolCallId: block.tool_use_id,
        ok,
        summary: truncate(stringifyToolResult(block.content), NOTE_MAX),
      });
    }
    return events;
  }

  private result(msg: Extract<SDKMessage, { type: 'result' }>): RunEventBody[] {
    if (this.ended) return [];
    this.ended = true;

    const events: RunEventBody[] = [];

    // ★ 美元校正：SDK 的 total_cost_usd 是权威值，实时估算只是过程量。
    //   tokens 全填 0 —— ingest 对 token 是累加语义，这里再报一次会重复计数。
    //   注意这条只校正美元那一侧：token 记账不需要校正，
    //   因为它一路都是实测值，从来没有估算参与。
    const delta = round(msg.total_cost_usd - this.estimatedTotalUsd, 6);
    if (delta !== 0 || !hasPricing(this.model)) {
      events.push({
        type: 'cost',
        deltaUsd: delta,
        totalUsd: round(msg.total_cost_usd, 6),
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      this.estimatedTotalUsd = msg.total_cost_usd;
    }

    const text = 'result' in msg ? (msg.result ?? '') : '';

    /**
     * ★ subtype='success' 不等于任务成功。
     *
     * 认证失败这类错误会以 subtype='success' + is_error=true 回来，
     * result 文本就是那句报错。只看 subtype 会把彻底失败的 Run 记成
     * completed —— 任务随即流转到 reviewing，还带上一条以报错为正文的产物。
     * 所以三个信号任一为真就判失败。
     */
    const failed = msg.subtype !== 'success' || msg.is_error || this.fatalError !== null;

    if (!failed) {
      events.push(...synthesizeArtifacts(text, this.options.task));
      events.push({
        type: 'run_ended',
        outcome: 'completed',
        summary: truncate(firstLine(text) || '任务完成', 500),
        selfReport: truncate(text, ARTIFACT_MAX),
      });
      return events;
    }

    const error =
      this.fatalError ??
      classifyResultError({
        // success + is_error 走通用分支，让 result 文本参与分类
        subtype: msg.subtype === 'success' ? 'error_during_execution' : msg.subtype,
        errors: 'errors' in msg ? msg.errors : text ? [text] : [],
        permissionDenials: msg.permission_denials,
        maxCostUsd: this.options.task.limits.maxCostUsd,
      });

    // 失败时不合成产物：那条「产物」的正文只会是报错本身
    if (!this.fatalError) events.push({ type: 'error', error });
    events.push({
      type: 'run_ended',
      outcome: 'failed',
      summary: error.message,
      selfReport: truncate(error.selfReport ?? (text || error.message), ARTIFACT_MAX),
    });
    return events;
  }

  /**
   * 一次 API 调用可能被拆成多条 assistant 消息（共享 message.id），
   * usage 只算一次，否则成本会翻倍。
   */
  private costFor(msg: SDKAssistantMessage): RunEventBody | null {
    const id = msg.message.id;
    if (id && this.countedMessages.has(id)) return null;
    if (id) this.countedMessages.add(id);

    const usage = msg.message.usage;
    if (!usage) return null;

    const tokens: TokenCounts = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return null;

    const deltaUsd = round(estimateCostUsd(this.model, tokens), 6);
    this.estimatedTotalUsd = round(this.estimatedTotalUsd + deltaUsd, 6);

    return {
      type: 'cost',
      deltaUsd,
      totalUsd: this.estimatedTotalUsd,
      /**
       * ★ cacheWrite 以前算进了美元估算却没往上报，于是它在库里不存在。
       *   记账单位换成 token 之后这就成了系统性少算 —— 而且偏差方向是
       *   「看起来更省」，没有人会因此来报错。
       */
      tokens: {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
      },
    };
  }
}

/**
 * 从最终回复合成产物。
 *
 * Claude Code 没有产物上传通道，但它的最终回复本身就是交付给评审的东西；
 * 回复里出现的 PR 链接是 Review 阶段最需要的入口，单独拆成一条。
 */
export function synthesizeArtifacts(text: string, task: TaskDispatch): RunEventBody[] {
  const events: RunEventBody[] = [];

  const pr = text.match(PR_URL);
  if (pr) {
    events.push({
      type: 'artifact',
      artifact: {
        kind: 'pull_request',
        title: `PR：${task.goal.title}`,
        externalUrl: pr[0],
        content: null,
        metadata: { source: 'claude_code', detectedFrom: 'run_result' },
      },
    });
  }

  if (text.trim()) {
    events.push({
      type: 'artifact',
      artifact: {
        kind: 'document',
        title: `执行摘要：${task.goal.title}`,
        externalUrl: null,
        content: truncate(text, ARTIFACT_MAX),
        metadata: { source: 'claude_code', runId: task.runId },
      },
    });
  }

  return events;
}

function describeTurn(blocks: readonly ContentBlock[]): string {
  const tools = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => b.name);
  if (tools.length > 0) return `调用 ${[...new Set(tools)].join('、')}`;

  const text = blocks.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
  if (text?.text.trim()) return truncate(firstLine(text.text), 120);

  return '思考中';
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
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
