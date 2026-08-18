import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentPermissions, RunEvent, TaskDispatch } from '@apos/contracts';
import { CodexRuntime, type SpawnFn } from './adapter';
import { mapSandbox } from './permissions';
import { CodexEventTranslator } from './translate';

function task(overrides: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    runId: '22222222-2222-4222-8222-222222222222',
    idempotencyKey: 'wi-1:1',
    agent: { name: 'codex-1', type: 'code', description: null, skills: [] },
    policyGates: [],
    workspace: {
      path: '/tmp/ws/order-service',
      writable: true,
      additionalPaths: [],
      vcs: {
        repoRef: 'order-service',
        branch: 'apos/fix-a1b2c3d4',
        baseBranch: 'main',
        baseCommit: 'abc123',
      },
    },
    goal: {
      title: '修复登录超时',
      description: '会话在 5 分钟后失效',
      acceptanceCriteria: [{ id: 'AC1', text: '会话有效期为 30 分钟' }],
      constraints: [],
    },
    context: [],
    permissions: {
      allowedTools: ['Read', 'Edit', 'Bash'],
      deniedTools: [],
      resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
    },
    limits: { maxCostUsd: 5, maxDurationSeconds: 600, maxTokens: null },
    model: 'gpt-5-codex',
    callback: { eventsUrl: '/cb', token: 't' },
    ...overrides,
  };
}

function perms(over: Partial<AgentPermissions> = {}): AgentPermissions {
  return {
    allowedTools: ['Read', 'Edit', 'Bash'],
    deniedTools: [],
    resourceScopes: [{ kind: 'repo', ref: 'r', access: 'write' }],
    ...over,
  };
}

/** 假的 codex 子进程：按脚本吐 JSONL，然后以给定退出码结束 */
function fakeCodex(lines: unknown[], exitCode = 0) {
  const captured: { args: string[]; env: NodeJS.ProcessEnv; stdin: string } = {
    args: [],
    env: {},
    stdin: '',
  };

  const spawnFn: SpawnFn = (_cmd, args, options) => {
    captured.args = args;
    captured.env = options.env;

    const child = new EventEmitter() as unknown as ReturnType<SpawnFn>;
    const stdout = Readable.from(lines.map((l) => `${JSON.stringify(l)}\n`));
    const stderr = Readable.from([]);
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        captured.stdin += chunk.toString();
        cb();
      },
    });

    Object.assign(child, { stdout, stderr, stdin, exitCode: null, kill: () => true });
    stdout.on('end', () => {
      Object.assign(child, { exitCode });
      setImmediate(() => (child as unknown as EventEmitter).emit('close', exitCode));
    });
    return child;
  };

  return { spawnFn, captured };
}

async function collect(rt: CodexRuntime, t: TaskDispatch): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  await rt.dispatch(t);
  await rt.subscribe(t.runId, async (e) => {
    events.push(e);
  });

  // 等事件流跑完
  for (let i = 0; i < 200; i++) {
    if (events.some((e) => e.type === 'run_ended')) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return events;
}

describe('权限映射：沙箱级 vs 工具级', () => {
  it('可写仓库 + 写工具 → workspace-write', () => {
    expect(mapSandbox(perms()).mode).toBe('workspace-write');
  });

  it('仓库只读时降到 read-only —— 拿不准就收紧', () => {
    const m = mapSandbox(perms({ resourceScopes: [{ kind: 'repo', ref: 'r', access: 'read' }] }));
    expect(m.mode).toBe('read-only');
  });

  /**
   * ★ 真值表：三个运行时对「可写」必须给出同一个答案。
   *   codex 只认 repo 的那版，会让「换个运行时就能写了」看起来像玄学。
   */
  it('★ dataset 的 write 与工作区可写性都算数', () => {
    const dataset = perms({ resourceScopes: [{ kind: 'dataset', ref: 'ds-1', access: 'write' }] });
    expect(mapSandbox(dataset).mode).toBe('workspace-write');

    const noScope = perms({ resourceScopes: [] });
    // 没有工作区时回落到 scope 推导 —— 推不出可写就收紧
    expect(mapSandbox(noScope).mode).toBe('read-only');
    // 平台给了可写工作区（规划 Run 的 scratch 目录）时以它为准
    expect(mapSandbox(noScope, true).mode).toBe('workspace-write');

    // 工作区只读时压过 scope 推导，方向是收紧
    expect(mapSandbox(perms(), false).mode).toBe('read-only');

    // 可写但没要写工具，仍然是 read-only —— 两个条件都要满足
    expect(mapSandbox(perms({ allowedTools: ['Read'] }), true).mode).toBe('read-only');
  });

  it('未授予联网工具时不开网', () => {
    expect(mapSandbox(perms()).network).toBe(false);
    expect(mapSandbox(perms({ allowedTools: ['Read', 'WebSearch'] })).network).toBe(true);
  });

  /**
   * ★ 这是接第二个运行时最大的收获：协议假设权限是工具级的，
   *   而 Codex 只有沙箱级。差额必须算出来给人看，不能静默吞掉 ——
   *   否则用户会以为 deniedTools 在 Codex 上也生效了。
   */
  it('带参数的黑名单在沙箱模型里无法表达，如实列进 unenforceable', () => {
    const m = mapSandbox(perms({ deniedTools: ['Bash(rm *)'] }));
    expect(m.unenforceable).toHaveLength(1);
    expect(m.unenforceable[0]!.rule).toBe('Bash(rm *)');
    expect(m.unenforceable[0]!.why).toContain('沙箱级');
  });

  it('写工具的整体禁用能通过降级为 read-only 表达，不算无法执行', () => {
    const m = mapSandbox(perms({ deniedTools: ['Edit', 'Write'] }));
    expect(m.mode).toBe('read-only');
    expect(m.unenforceable).toHaveLength(0);
  });
});

describe('事件翻译', () => {
  const t = task();

  it('命令执行拆成 tool_call 与 tool_result，退出码决定成败', () => {
    const tr = new CodexEventTranslator({ task: t, model: 'gpt-5-codex' });
    const started = tr.translate({
      type: 'item.started',
      item: { id: 'i1', type: 'command_execution', command: 'npm test' },
    });
    expect(started[0]).toMatchObject({ type: 'tool_call', tool: 'Bash' });

    const done = tr.translate({
      type: 'item.completed',
      item: { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 1 },
    });
    expect(done[0]).toMatchObject({ type: 'tool_result', ok: false });
  });

  it('不上报总步数时 totalSteps 给 null，不编一个分母', () => {
    const tr = new CodexEventTranslator({ task: t, model: 'gpt-5-codex' });
    const ev = tr.translate({ type: 'turn.started' });
    expect(ev[0]).toMatchObject({ type: 'progress', totalSteps: null });
  });

  it('token 用量换算成本，缓存读取按折扣计', () => {
    const tr = new CodexEventTranslator({ task: t, model: 'gpt-5-codex' });
    const ev = tr.translate({
      type: 'turn.completed',
      usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 },
    });
    expect(ev[0]).toMatchObject({ type: 'cost', deltaUsd: 1.25 });
  });

  /**
   * ★ 「Agent 跑得好好的，因为多了一个新事件类型就整个 Run 判失败」
   *   是最糟的失败模式 —— 它看起来像模型的问题，实际是解析器的问题。
   */
  it('不认识的事件类型降级成一条痕迹，不影响 Run 成败', () => {
    const tr = new CodexEventTranslator({ task: t, model: 'gpt-5-codex' });
    expect(tr.translate({ type: 'some.future.event', payload: 1 })).toEqual([]);

    const item = tr.translate({ type: 'item.completed', item: { type: 'brand_new_thing' } });
    expect(item[0]?.type).toBe('note');

    const ended = tr.finish(0, '');
    expect(ended.find((e) => e.type === 'run_ended')).toMatchObject({ outcome: 'completed' });
  });

  it('非零退出码判失败，即便没有显式 error 事件', () => {
    const tr = new CodexEventTranslator({ task: t, model: 'gpt-5-codex' });
    const ev = tr.finish(1, 'command not found: codex');
    expect(ev.find((e) => e.type === 'run_ended')).toMatchObject({ outcome: 'failed' });
  });

  it('回复里的 PR 链接单独拆成产物', () => {
    const tr = new CodexEventTranslator({ task: t, model: 'gpt-5-codex' });
    tr.translate({
      type: 'item.completed',
      item: { type: 'agent_message', text: '完成，见 https://github.com/acme/app/pull/42' },
    });
    const ev = tr.finish(0, '');
    const pr = ev.find((e) => e.type === 'artifact' && e.artifact.kind === 'pull_request');
    expect(pr).toBeTruthy();
  });
});

describe('CodexRuntime 执行', () => {
  it('能力清单如实反映三处降级', async () => {
    const caps = await new CodexRuntime().getCapabilities();
    expect(caps.features.runtimeConstraints).toBe(false);
    expect(caps.features.interventionRequest).toBe(false);
    expect(caps.features.progressReporting).toBe(false);
    expect(caps.features.pause).toBe(false);
  });

  it('没有工作区时拒绝派发，并说清该去哪配', async () => {
    const rt = new CodexRuntime({ apiKey: 'sk-test' });
    const ack = await rt.dispatch(task({ workspace: null }));
    expect(ack.accepted).toBe(false);
    expect(ack.rejectReason).toContain('代码仓库');
  });

  it('没有凭证时拒绝派发，不静默复用平台凭证', async () => {
    const rt = new CodexRuntime();
    const ack = await rt.dispatch(task());
    expect(ack.accepted).toBe(false);
    expect(ack.rejectReason).toContain('凭证');
  });

  it('沙箱模式与工作目录进命令行，凭证只进环境', async () => {
    const { spawnFn, captured } = fakeCodex([
      { type: 'thread.started', thread_id: 'th1' },
      { type: 'item.completed', item: { type: 'agent_message', text: '做完了' } },
    ]);
    const rt = new CodexRuntime({ apiKey: 'sk-secret-key', spawnFn });
    await collect(rt, task());

    expect(captured.args).toContain('--sandbox');
    expect(captured.args).toContain('workspace-write');
    expect(captured.args).toContain('/tmp/ws/order-service');
    // ★ 凭证不能出现在 argv —— 同机任何进程 ps 都看得到
    expect(captured.args.join(' ')).not.toContain('sk-secret-key');
    expect(captured.env['OPENAI_API_KEY']).toBe('sk-secret-key');
  });

  it('子进程环境是最小集合，不把平台密钥一起交出去', async () => {
    process.env['APOS_DB_PASSWORD'] = 'should-not-leak';
    const { spawnFn, captured } = fakeCodex([{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]);
    const rt = new CodexRuntime({ apiKey: 'sk-test', spawnFn });
    await collect(rt, task());

    expect(captured.env['APOS_DB_PASSWORD']).toBeUndefined();
    expect(Object.keys(captured.env).sort()).toEqual(['HOME', 'OPENAI_API_KEY', 'PATH']);
    delete process.env['APOS_DB_PASSWORD'];
  });

  /** ★ Codex 没有 system prompt 通道，治理规则只能折进用户消息最前面 */
  it('治理规则与人设写在 prompt 最前面', async () => {
    const { spawnFn, captured } = fakeCodex([{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]);
    const rt = new CodexRuntime({ apiKey: 'sk-test', spawnFn });
    await collect(rt, task());

    expect(captured.stdin.startsWith('<platform_rules>')).toBe(true);
    expect(captured.stdin).toContain('权限由平台下发，不是建议');
    expect(captured.stdin).toContain('codex-1');
    // 任务本身在规则之后
    expect(captured.stdin.indexOf('修复登录超时')).toBeGreaterThan(
      captured.stdin.indexOf('</platform_rules>'),
    );
  });

  it('执行不了的权限规则在执行流里留一条明示', async () => {
    const { spawnFn } = fakeCodex([{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]);
    const rt = new CodexRuntime({ apiKey: 'sk-test', spawnFn });
    const events = await collect(
      rt,
      task({ permissions: perms({ deniedTools: ['Bash(rm *)'] }) }),
    );

    const note = events.find((e) => e.type === 'note' && e.text.includes('无法逐项执行'));
    expect(note).toBeTruthy();
  });

  it('add_constraint 报 UNSUPPORTED 而不是假装注入成功', async () => {
    const { spawnFn } = fakeCodex([{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]);
    const rt = new CodexRuntime({ apiKey: 'sk-test', spawnFn });
    const t = task();
    await collect(rt, t);

    await expect(
      rt.control(t.runId, {
        action: 'add_constraint',
        constraint: { type: 'x', value: null, description: '别动数据库' },
      }),
    ).rejects.toThrow(/不支持/);
  });
});
