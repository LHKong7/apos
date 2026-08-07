import type { NotifyMessage } from '@apos/domain';
import { HttpClient, HttpError } from './client';

/**
 * 通知投递（页面文档 14 §5.5）。
 *
 * ★ 投递端和判定端严格分开：判定（发不发、找谁、要不要穿透免打扰）
 *   在 @apos/domain，这里只负责「把已经决定要发的东西发出去」。
 *   两者揉在一起的话，「凌晨两点高风险决策该不该穿透免打扰」
 *   这种规则就只能靠起一个真的 Slack 才测得到。
 *
 * ★ 只放跳转链接，不放「直接批准」按钮（§12.3）。
 *   在第三方平台内确认「点按钮的人真的是决策责任人」，各平台机制都不同 ——
 *   做不到这一点的直接批准，会把不可代行的决策变成谁点谁算。
 */

export interface NotifyTarget {
  /** Incoming Webhook / 机器人 URL。凭证即 URL 本身，所以它按凭证对待 */
  webhookUrl: string;
}

export interface DeliveryResult {
  ok: boolean;
  /** 失败时给人能看懂的原因，页面直接展示 */
  message: string;
  /** 群被解散 / webhook 被撤销 —— 需要用户重新配置，重试没用（§11）*/
  needsReconfigure: boolean;
  latencyMs: number;
}

export interface NotifyTransport {
  readonly provider: string;
  send(target: NotifyTarget, message: NotifyMessage): Promise<DeliveryResult>;
}

interface TransportDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Slack Incoming Webhook。返回体是纯文本 "ok"，不是 JSON。 */
export class SlackTransport implements NotifyTransport {
  readonly provider = 'slack';
  constructor(private readonly deps: TransportDeps = {}) {}

  async send(target: NotifyTarget, message: NotifyMessage): Promise<DeliveryResult> {
    return post(target.webhookUrl, slackBody(message), this.deps, (status, body) => {
      /**
       * ★ Slack 用 200 + 文本体表达失败（"no_service" / "channel_not_found"）。
       *   只看 HTTP 状态会把「这个群没了」当成投递成功，
       *   于是通知悄悄进了黑洞，而页面上一切正常 —— 这是最坏的失败方式。
       */
      const text = body.trim();
      if (status === 200 && text === 'ok') return null;
      if (/no_service|channel_not_found|no_team/i.test(text)) {
        return { message: `Slack 拒绝：${text}（webhook 可能已被撤销或群已解散）`, needsReconfigure: true };
      }
      return { message: `Slack 拒绝：${text || status}`, needsReconfigure: false };
    });
  }
}

/** 飞书自定义机器人。永远返回 200，成败看 body 里的 code。 */
export class FeishuTransport implements NotifyTransport {
  readonly provider = 'feishu';
  constructor(private readonly deps: TransportDeps = {}) {}

  async send(target: NotifyTarget, message: NotifyMessage): Promise<DeliveryResult> {
    return post(target.webhookUrl, feishuBody(message), this.deps, (_status, body) => {
      let parsed: { code?: number; msg?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        return { message: `飞书返回了无法解析的内容：${body.slice(0, 80)}`, needsReconfigure: false };
      }
      if (parsed.code === 0 || parsed.code === undefined) return null;
      // 19024 = 机器人被移出群；9499 = webhook 失效
      const gone = parsed.code === 19024 || parsed.code === 9499;
      return {
        message: `飞书拒绝（${parsed.code}）：${parsed.msg ?? ''}`,
        needsReconfigure: gone,
      };
    });
  }
}

async function post(
  url: string,
  body: unknown,
  deps: TransportDeps,
  interpret: (status: number, text: string) => { message: string; needsReconfigure: boolean } | null,
): Promise<DeliveryResult> {
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const client = new HttpClient({
    // webhook 的完整 URL 就是 baseUrl，path 留空
    baseUrl: url,
    fetchImpl,
    sleepImpl: deps.sleepImpl,
    maxRetries: 2,
    timeoutMs: 10_000,
  });

  try {
    /**
     * ★ raw：这两家都用「200 + body 里说失败」表达错误，
     *   所以响应体必须原样拿到，不能在 JSON 解析处先炸掉。
     */
    const text = await client.request<string>({
      method: 'POST',
      path: '',
      json: body,
      raw: true,
      headers: { accept: 'text/plain, application/json' },
    });

    const problem = interpret(200, text ?? '');
    if (problem) {
      return { ok: false, ...problem, latencyMs: Date.now() - started };
    }
    return { ok: true, message: '已发送', needsReconfigure: false, latencyMs: Date.now() - started };
  } catch (e) {
    if (e instanceof HttpError) {
      return {
        ok: false,
        message: e.message,
        /** 404 / 403 的 webhook 是被撤销了，重试没用 */
        needsReconfigure: e.kind === 'not_found' || e.kind === 'forbidden',
        latencyMs: Date.now() - started,
      };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : '投递失败',
      needsReconfigure: false,
      latencyMs: Date.now() - started,
    };
  }
}

export function slackBody(m: NotifyMessage): unknown {
  return {
    text: `${m.title}\n${m.lines.join('\n')}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${m.title}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: m.lines.join('\n') } },
      {
        type: 'actions',
        elements: [
          // ★ 只有跳转，没有「直接批准」—— 见文件头注释
          { type: 'button', text: { type: 'plain_text', text: '查看详情' }, url: m.url },
        ],
      },
    ],
  };
}

export function feishuBody(m: NotifyMessage): unknown {
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: m.title },
        template: m.urgent ? 'red' : 'orange',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: m.lines.join('\n') } },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '查看详情' }, url: m.url, type: 'primary' },
          ],
        },
      ],
    },
  };
}
