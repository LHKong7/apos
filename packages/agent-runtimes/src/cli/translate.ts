import type { RunEventBody } from '@apos/contracts';
import type { OutputFormat } from './profile';

/**
 * 把各家 CLI 的输出翻译成协议事件。
 *
 * ★★ 核心原则：**不假装认识没验证过的 schema。**
 *
 *   这六个 CLI 的输出格式来自各自的文档，不是实测（见 profile.ts 顶部）。
 *   照着文档写一个逐字段映射的解析器，它会在两种情况下坏掉，而且都很难查：
 *   文档过期了，或者版本升级改了字段名。坏掉的表现是**事件流突然变空** ——
 *   Run 在跑，界面上什么都没有，没有任何报错。
 *
 *   所以这里反过来做：只认那些**结构上认得出**的东西（用量数字、错误、
 *   一段文本），其余原样透出成 note。代价是事件流不如 claude-code 那边精细，
 *   收益是**永远不会静默丢东西** —— 认不出来的内容会原样出现在 Run 详情里，
 *   下一个人能照着它把映射补上。
 *
 * ★ 另一条：不编造成本。几个 CLI 会打印 token 数，但没有权威结算值。
 *   估算出来的数字会被读成账单，那比不显示更糟（codex 那边也是这么处理的）。
 */

/** 一行文本超过这个长度就截断 —— 有些 CLI 会把整个文件内容打出来 */
const MAX_TEXT = 2000;
/** 单个 Run 最多产生这么多条 note，防止刷屏把事件表撑爆 */
const MAX_NOTES = 400;

export interface CliTranslatorOptions {
  format: OutputFormat;
  kind: string;
  /** 认不出来的行是否也透出。默认 true —— 静默丢弃是这里最不想要的行为 */
  passthroughUnknown?: boolean;
}

export class CliOutputTranslator {
  private notes = 0;
  private truncatedNotice = false;
  /** json 形态下要攒完整个 stdout 才能解析 */
  private buffer: string[] = [];
  private tokens: { input: number; output: number } | null = null;
  private texts: string[] = [];

  constructor(private readonly opts: CliTranslatorOptions) {}

  /** 处理一行 stdout。返回要发出的事件（可能为空） */
  line(raw: string): RunEventBody[] {
    const text = raw.trimEnd();
    if (!text.trim()) return [];

    if (this.opts.format === 'json') {
      // 整个 stdout 是一个对象，逐行攒着，收尾时一次性解析
      this.buffer.push(raw);
      return [];
    }

    if (this.opts.format === 'stream-json') {
      const parsed = tryParse(text);
      if (parsed === undefined) {
        // 非 JSON 行（横幅、进度条）在 stream-json 模式下不是事件，但也不能当没看见
        return this.note(`非 JSON 输出：${clip(text)}`);
      }
      return this.fromJson(parsed);
    }

    // 纯文本：整行透出
    this.texts.push(text);
    return this.note(clip(text));
  }

  /** 进程结束。json 形态在这里才真正解析 */
  finish(exitCode: number | null, stderrTail: string): RunEventBody[] {
    const out: RunEventBody[] = [];

    if (this.opts.format === 'json' && this.buffer.length > 0) {
      const parsed = tryParse(this.buffer.join('\n'));
      if (parsed === undefined) {
        out.push(...this.note(`stdout 不是合法 JSON，原样保留：${clip(this.buffer.join('\n'))}`));
      } else {
        out.push(...this.fromJson(parsed));
      }
    }

    if (this.tokens) {
      /**
       * ★ deltaUsd / totalUsd 一律 0。
       *   有 token 数不等于有价钱 —— 单价取决于模型、档位、缓存命中，
       *   这里任何一个乘出来的数字都会被当成账单读。
       */
      out.push({
        type: 'cost',
        tokens: {
          input: this.tokens.input,
          output: this.tokens.output,
          cacheRead: 0,
          cacheWrite: 0,
        },
        deltaUsd: 0,
        totalUsd: 0,
      });
    }

    const ok = exitCode === 0;
    if (!ok) {
      out.push({
        type: 'error',
        error: {
          class: 'runtime_error',
          message:
            exitCode === null
              ? `${this.opts.kind} 进程异常结束`
              : `${this.opts.kind} 退出码 ${exitCode}`,
          retriable: true,
          ...(stderrTail.trim() ? { selfReport: clip(stderrTail, 4000) } : {}),
          classificationSource: 'inferred' as const,
        },
      });
    }

    out.push({
      type: 'run_ended',
      outcome: ok ? 'completed' : 'failed',
      summary: ok ? this.summary() : `执行失败（退出码 ${exitCode ?? '无'}）`,
    });
    return out;
  }

  /** 收尾摘要：取最后几行有内容的输出，比一句「已完成」有用 */
  private summary(): string {
    const tail = this.texts.filter((t) => t.trim()).slice(-3).join(' / ');
    return tail ? clip(tail, 400) : '已完成';
  }

  /**
   * 从一个 JSON 值里抽取认得出的东西。
   *
   * ★ 这里的判断全部基于**结构**而不是某个 CLI 的字段名约定：
   *   带 usage/token 数字的当用量，带 error 的当错误，带文本的当文本。
   *   六家的字段名不一样，但这三类东西的形状是共通的。
   */
  private fromJson(value: unknown): RunEventBody[] {
    if (value === null || typeof value !== 'object') return this.note(clip(String(value)));
    const obj = value as Record<string, unknown>;
    const out: RunEventBody[] = [];

    const usage = pickUsage(obj);
    if (usage) {
      this.tokens = {
        input: (this.tokens?.input ?? 0) + usage.input,
        output: (this.tokens?.output ?? 0) + usage.output,
      };
    }

    const err = pickString(obj, ['error', 'errorMessage', 'error_message']);
    if (err) {
      out.push({
        type: 'error',
        error: {
          class: 'runtime_error',
          message: clip(err, 1000),
          retriable: true,
          classificationSource: 'reported' as const,
        },
      });
    }

    const tool = pickString(obj, ['tool', 'toolName', 'tool_name', 'name']);
    const kind = pickString(obj, ['type', 'kind', 'event']);
    if (tool && kind && /tool/i.test(kind)) {
      out.push({
        type: 'tool_call',
        /**
         * ★ 这些 CLI 大多不给工具调用 ID。用 kind+序号合成一个 ——
         *   协议要求它非空，而下游只用它把 tool_call 与 tool_result 配对；
         *   配不上的后果只是详情页少一条关联，不影响执行。
         */
        toolCallId: pickString(obj, ['toolCallId', 'tool_call_id', 'id']) ?? `${this.opts.kind}-${this.notes}`,
        tool,
        // 参数原样带上：Run 详情里「它到底调了什么」是排查的第一现场
        params: pickRecord(obj, ['input', 'args', 'arguments', 'parameters']) ?? {},
      });
    }

    const text = pickText(obj);
    if (text) {
      this.texts.push(text);
      out.push(...this.note(clip(text)));
    }

    // 什么都没抽出来 —— 原样透出，绝不静默丢弃
    if (out.length === 0 && !usage) {
      out.push(...this.note(`未识别的事件：${clip(JSON.stringify(obj))}`));
    }
    return out;
  }

  private note(text: string): RunEventBody[] {
    if (this.notes >= MAX_NOTES) {
      if (this.truncatedNotice) return [];
      this.truncatedNotice = true;
      return [
        {
          type: 'note',
          text: `⚠ 输出超过 ${MAX_NOTES} 条，后续内容不再逐条记录（完整输出见运行日志）`,
        },
      ];
    }
    this.notes++;
    return [{ type: 'note', text }];
  }
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断 ${text.length - max} 字）` : text;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function pickRecord(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return null;
}

/**
 * 文本可能藏在好几层里：`content` 直接是字符串，或者是
 * `[{type:'text', text:'…'}]` 这种块数组（几家都用这个形状）。
 */
function pickText(obj: Record<string, unknown>): string | null {
  const direct = pickString(obj, ['text', 'message', 'response', 'content', 'delta', 'summary']);
  if (direct) return direct;

  const content = obj['content'] ?? obj['message'];
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => (c && typeof c === 'object' ? pickString(c as Record<string, unknown>, ['text', 'content']) : null))
      .filter((s): s is string => Boolean(s));
    if (parts.length) return parts.join('');
  }
  if (content && typeof content === 'object') {
    return pickString(content as Record<string, unknown>, ['text', 'content', 'response']);
  }
  return null;
}

/**
 * 用量。各家嵌套层级不同（有的在 `usage`，有的在 `stats.tokens`），
 * 但字段名都在 input/output/prompt/completion 这几个词附近。
 */
function pickUsage(obj: Record<string, unknown>): { input: number; output: number } | null {
  const containers = [obj, obj['usage'], obj['stats'], obj['tokens'], obj['metrics']];
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    const nested = rec['tokens'];
    const src = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : rec;
    const input = pickNumber(src, ['input', 'inputTokens', 'input_tokens', 'prompt', 'promptTokens', 'prompt_tokens']);
    const output = pickNumber(src, ['output', 'outputTokens', 'output_tokens', 'completion', 'completionTokens', 'completion_tokens']);
    if (input !== null || output !== null) return { input: input ?? 0, output: output ?? 0 };
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
