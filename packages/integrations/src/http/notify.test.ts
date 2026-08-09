import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDecisionMessage } from '@apos/domain';
import { FeishuTransport, SlackTransport, feishuBody, slackBody } from './notify';

let server: Server;
let baseUrl = '';
const recorded: { url: string; body: string }[] = [];
let reply: { status: number; body: string; contentType?: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      recorded.push({ url: req.url ?? '', body });
      res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'text/plain' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/hooks/T000`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const MSG = buildDecisionMessage({
  projectName: '订单系统重构',
  title: '生产数据库索引变更审批',
  assigneeName: '王强',
  dueInMinutes: 120,
  overdueMinutes: null,
  consequence: '不处理将阻塞 5 个下游任务',
  recommendation: '在线创建复合索引',
  url: 'https://apos.example/decisions',
  riskLevel: 'high',
});

const deps = { sleepImpl: async () => {} };

/**
 * 通知投递。
 *
 * 用真的 HTTP 服务器做契约测试：Slack 和飞书都用「200 + body 里说失败」
 * 这种反直觉的方式表达错误，只 mock fetch 是测不出来的。
 */
describe('Slack', () => {
  it('成功投递', async () => {
    recorded.length = 0;
    reply = { status: 200, body: 'ok' };

    const r = await new SlackTransport(deps).send({ webhookUrl: baseUrl }, MSG);

    expect(r.ok).toBe(true);
    expect(recorded[0]!.url).toBe('/hooks/T000');
    const sent = JSON.parse(recorded[0]!.body);
    expect(sent.text).toContain('生产数据库索引变更审批');
    expect(sent.text).toContain('阻塞 5 个下游任务');
  });

  /**
   * ★ Slack 用 200 + 文本体表达失败。只看 HTTP 状态会把
   *   「这个群没了」当成投递成功 —— 通知悄悄进黑洞，页面上一切正常。
   *   这是最坏的一种失败方式。
   */
  it('★ 200 + channel_not_found 是失败，不是成功', async () => {
    reply = { status: 200, body: 'channel_not_found' };
    const r = await new SlackTransport(deps).send({ webhookUrl: baseUrl }, MSG);

    expect(r.ok).toBe(false);
    expect(r.needsReconfigure).toBe(true);
    expect(r.message).toContain('群已解散');
  });

  it('webhook 被撤销（404）标记为需要重新配置', async () => {
    reply = { status: 404, body: 'no_service' };
    const r = await new SlackTransport(deps).send({ webhookUrl: baseUrl }, MSG);
    expect(r.ok).toBe(false);
    expect(r.needsReconfigure).toBe(true);
  });

  it('临时故障不要求重新配置 —— 那是运维问题，不是配置问题', async () => {
    reply = { status: 503, body: 'server error' };
    const r = await new SlackTransport(deps).send({ webhookUrl: baseUrl }, MSG);
    expect(r.ok).toBe(false);
    expect(r.needsReconfigure).toBe(false);
  });

  /** ★ 通知里只有跳转，没有「直接批准」——见 §12.3 的取舍 */
  it('★ 消息里只有「查看详情」跳转，没有直接批准按钮', () => {
    const body = slackBody(MSG) as { blocks: { type: string; elements?: { url?: string; text?: { text?: string } }[] }[] };
    const actions = body.blocks.find((b) => b.type === 'actions');
    expect(actions!.elements).toHaveLength(1);
    expect(actions!.elements![0]!.url).toBe('https://apos.example/decisions');
    expect(JSON.stringify(body)).not.toMatch(/批准|approve/i);
  });
});

describe('飞书', () => {
  it('code 0 是成功', async () => {
    recorded.length = 0;
    reply = { status: 200, body: '{"code":0,"msg":"success"}', contentType: 'application/json' };

    const r = await new FeishuTransport(deps).send({ webhookUrl: baseUrl }, MSG);

    expect(r.ok).toBe(true);
    expect(JSON.parse(recorded[0]!.body).msg_type).toBe('interactive');
  });

  /** ★ 飞书永远返回 200，成败全看 body 里的 code */
  it('★ 200 + 非零 code 是失败', async () => {
    reply = { status: 200, body: '{"code":9499,"msg":"invalid webhook"}', contentType: 'application/json' };
    const r = await new FeishuTransport(deps).send({ webhookUrl: baseUrl }, MSG);

    expect(r.ok).toBe(false);
    expect(r.needsReconfigure).toBe(true);
    expect(r.message).toContain('9499');
  });

  it('机器人被移出群（19024）需要重新配置', async () => {
    reply = { status: 200, body: '{"code":19024,"msg":"bot not in chat"}', contentType: 'application/json' };
    const r = await new FeishuTransport(deps).send({ webhookUrl: baseUrl }, MSG);
    expect(r.needsReconfigure).toBe(true);
  });

  it('返回了非 JSON 时如实报告，不当成成功', async () => {
    reply = { status: 200, body: '<html>gateway</html>' };
    const r = await new FeishuTransport(deps).send({ webhookUrl: baseUrl }, MSG);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('无法解析');
  });

  it('紧急消息用红色卡片头', () => {
    const urgent = buildDecisionMessage({
      projectName: 'p',
      title: 't',
      assigneeName: null,
      dueInMinutes: null,
      overdueMinutes: 100,
      consequence: null,
      recommendation: null,
      url: 'u',
      riskLevel: 'critical',
    });
    const body = feishuBody(urgent) as { card: { header: { template: string } } };
    expect(body.card.header.template).toBe('red');
  });
});
