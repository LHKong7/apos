import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { RunEvent, TaskDispatch } from '@apos/contracts';
import { GenericCliRuntime, type CliSpawnFn } from './adapter';
import {
  AIDER_PROFILE,
  CLI_PROFILES,
  GEMINI_PROFILE,
  GOOSE_PROFILE,
  OPENCODE_PROFILE,
  PI_PROFILE,
  QWEN_PROFILE,
  cliProfile,
} from './profile';
import { CliOutputTranslator } from './translate';

function task(overrides: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    runId: '33333333-3333-4333-8333-333333333333',
    idempotencyKey: 'wi-9:1',
    outputLocale: 'en',
    agent: { name: 'cli-1', type: 'code', description: null, skills: [] },
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
    model: null,
    callback: { eventsUrl: '/cb', token: 't' },
    ...overrides,
  };
}

/** 假 CLI 子进程：吐给定的 stdout 行，然后以给定退出码结束 */
function fakeCli(stdoutLines: string[], exitCode = 0, stderrLines: string[] = []) {
  const captured = { cmd: '', args: [] as string[], env: {} as NodeJS.ProcessEnv, stdin: '' };

  const spawnFn: CliSpawnFn = (cmd, args, options) => {
    captured.cmd = cmd;
    captured.args = args;
    captured.env = options.env;

    const child = new EventEmitter() as unknown as ReturnType<CliSpawnFn>;
    const stdout = Readable.from(stdoutLines.map((l) => `${l}\n`));
    const stderr = Readable.from(stderrLines.map((l) => `${l}\n`));
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

async function collect(rt: GenericCliRuntime, t: TaskDispatch): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  await rt.dispatch(t);
  await rt.subscribe(t.runId, async (e) => {
    events.push(e);
  });
  for (let i = 0; i < 200; i++) {
    if (events.some((e) => e.type === 'run_ended')) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return events;
}

const notes = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { type: 'note' }> => e.type === 'note').map((e) => e.text);

describe('六个 CLI 的调用形态', () => {
  /**
   * ★ prompt 走 stdin 而不是 argv，对这两个是刻意的：
   *   prompt 里带治理规则，动辄几千字 —— 塞进 argv 会撞长度上限，
   *   而且会完整出现在 `ps` 输出里（其他用户能看到任务内容）。
   */
  it('goose 的 prompt 走 stdin，不进 argv', async () => {
    for (const profile of [GOOSE_PROFILE]) {
      const { spawnFn, captured } = fakeCli(['done']);
      await collect(new GenericCliRuntime(profile, { apiKey: 'k', spawnFn }), task());

      expect(captured.stdin, profile.kind).toContain('修复登录超时');
      expect(captured.args.join(' '), profile.kind).not.toContain('修复登录超时');
    }
  });

  /**
   * ★ pi 也在这一组：它的 stdin 是**额外上下文**而不是指令，
   *   把 prompt 挪到 stdin、留一个空的 `-p`，`-p` 会吞掉后面那个参数，
   *   而任务描述根本没送到 —— 表现是 Agent 跑起来了但完全不知道要干嘛。
   */
  it('pi / gemini / qwen 的 prompt 跟在 -p 后面', async () => {
    for (const profile of [PI_PROFILE, GEMINI_PROFILE, QWEN_PROFILE]) {
      const { spawnFn, captured } = fakeCli(['{}']);
      await collect(new GenericCliRuntime(profile, { apiKey: 'k', spawnFn }), task());

      const i = captured.args.indexOf('-p');
      expect(i, profile.kind).toBeGreaterThanOrEqual(0);
      expect(captured.args[i + 1], profile.kind).toContain('修复登录超时');
    }
  });

  it('opencode 的 prompt 是最后一个位置参数', async () => {
    const { spawnFn, captured } = fakeCli(['done']);
    await collect(new GenericCliRuntime(OPENCODE_PROFILE, { apiKey: 'k', spawnFn }), task());

    expect(captured.args[0]).toBe('run');
    expect(captured.args.at(-1)).toContain('修复登录超时');
  });

  /**
   * ★★ Aider 自带 git 提交，而平台的工作区供给也管提交。
   *   两边都提交会让一个 Run 产出一堆零碎的 aider 风格提交，
   *   破坏「一个 Run 一次提交」这条不变量。
   */
  it('aider 必须带 --no-auto-commits 与 --yes-always', async () => {
    const { spawnFn, captured } = fakeCli(['done']);
    await collect(new GenericCliRuntime(AIDER_PROFILE, { apiKey: 'k', spawnFn }), task());

    expect(captured.args).toContain('--no-auto-commits');
    // 少了它在非交互环境下会挂住等确认
    expect(captured.args).toContain('--yes-always');
  });

  /**
   * ★ 自动批准只在可写沙箱下给。只读任务不需要放开批准 ——
   *   多给一档权限没有收益，只有风险。
   */
  it('只读沙箱下不给自动批准开关', async () => {
    const readOnly = task({
      permissions: {
        allowedTools: ['Read'],
        deniedTools: [],
        resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'read' }],
      },
    });

    const g = fakeCli(['{}']);
    await collect(new GenericCliRuntime(GEMINI_PROFILE, { apiKey: 'k', spawnFn: g.spawnFn }), readOnly);
    expect(g.captured.args).not.toContain('--yolo');

    const q = fakeCli(['{}']);
    await collect(new GenericCliRuntime(QWEN_PROFILE, { apiKey: 'k', spawnFn: q.spawnFn }), readOnly);
    expect(q.captured.args).not.toContain('yolo');
  });

  it('可写沙箱下才放开自动批准', async () => {
    const { spawnFn, captured } = fakeCli(['{}']);
    await collect(new GenericCliRuntime(GEMINI_PROFILE, { apiKey: 'k', spawnFn }), task());
    expect(captured.args).toContain('--yolo');
  });

  it('可执行文件与额外参数可以覆盖', async () => {
    const { spawnFn, captured } = fakeCli(['done']);
    await collect(
      new GenericCliRuntime(PI_PROFILE, {
        apiKey: 'k',
        binary: '/opt/bin/pi',
        extraArgs: ['--verbose'],
        spawnFn,
      }),
      task(),
    );
    expect(captured.cmd).toBe('/opt/bin/pi');
    expect(captured.args).toContain('--verbose');
  });
});

describe('凭证与环境', () => {
  /**
   * ★★ 不做 { ...process.env }。那等于把平台的数据库口令、其他服务的
   *   token 一并交给 Agent 的子进程 —— 而它是要跑模型生成的代码的。
   */
  it('★ 子进程只拿到最小环境集合，平台密钥不外泄', async () => {
    process.env['APOS_SECRET_KEY'] = 'platform-master-key';
    try {
      const { spawnFn, captured } = fakeCli(['done']);
      await collect(new GenericCliRuntime(PI_PROFILE, { apiKey: 'agent-key', spawnFn }), task());

      expect(captured.env['APOS_SECRET_KEY']).toBeUndefined();
      expect(Object.keys(captured.env).sort()).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'PATH']);
      expect(captured.env['ANTHROPIC_API_KEY']).toBe('agent-key');
    } finally {
      delete process.env['APOS_SECRET_KEY'];
    }
  });

  it('透传白名单里的变量才进子进程', async () => {
    process.env['MY_TOOL_TOKEN'] = 'tok';
    try {
      const { spawnFn, captured } = fakeCli(['done']);
      await collect(
        new GenericCliRuntime(PI_PROFILE, { apiKey: 'k', passthroughEnv: ['MY_TOOL_TOKEN'], spawnFn }),
        task(),
      );
      expect(captured.env['MY_TOOL_TOKEN']).toBe('tok');
    } finally {
      delete process.env['MY_TOOL_TOKEN'];
    }
  });

  /**
   * ★ 没凭证就在派发那一刻明确拒绝。让它跑起来再失败的话，
   *   用户看到的是 CLI 自己那句鉴权错误，指不到「你没给这个 Agent 配 key」。
   */
  it('★ 缺凭证时拒绝派发，并说明该配什么', async () => {
    const rt = new GenericCliRuntime(GEMINI_PROFILE, { spawnFn: fakeCli([]).spawnFn });
    const ack = await rt.dispatch(task());

    expect(ack.accepted).toBe(false);
    expect(ack.rejectReason).toContain('Gemini CLI');
    expect(ack.rejectReason).toContain('APOS_AGENT_GEMINI_API_KEY');
  });

  it('没有工作区时拒绝派发', async () => {
    const rt = new GenericCliRuntime(PI_PROFILE, { apiKey: 'k', spawnFn: fakeCli([]).spawnFn });
    const ack = await rt.dispatch(task({ workspace: null }));

    expect(ack.accepted).toBe(false);
    expect(ack.rejectReason).toContain('工作目录');
  });

  it('同一个幂等键不会重复派发', async () => {
    const rt = new GenericCliRuntime(PI_PROFILE, { apiKey: 'k', spawnFn: fakeCli([]).spawnFn });
    const a = await rt.dispatch(task());
    const b = await rt.dispatch(task({ runId: '44444444-4444-4444-8444-444444444444' }));
    expect(b.externalRunId).toBe(a.externalRunId);
  });
});

describe('输出翻译：不假装认识没验证过的 schema', () => {
  /**
   * ★★ 这一条是整个翻译层存在的理由。
   *
   *   照着文档写逐字段映射的话，字段名一变，事件流就**静默变空** ——
   *   Run 在跑、界面上什么都没有、没有任何报错。这里反过来：
   *   认不出来的原样透出，下一个人能照着它把映射补上。
   */
  it('★ 认不出来的 JSON 原样透出，绝不静默丢弃', () => {
    const t = new CliOutputTranslator({ format: 'stream-json', kind: 'X' });
    const out = t.line(JSON.stringify({ someFutureField: 'v', nested: { a: 1 } }));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'note' });
    expect((out[0] as { text: string }).text).toContain('未识别的事件');
    expect((out[0] as { text: string }).text).toContain('someFutureField');
  });

  it('stream-json 里的非 JSON 行也留痕', () => {
    const t = new CliOutputTranslator({ format: 'stream-json', kind: 'X' });
    const out = t.line('=== 横幅 ===');
    expect((out[0] as { text: string }).text).toContain('非 JSON 输出');
  });

  it('按结构抽取文本，认得块数组形态', () => {
    const t = new CliOutputTranslator({ format: 'stream-json', kind: 'X' });
    const out = t.line(JSON.stringify({ content: [{ type: 'text', text: '正在读取文件' }] }));
    expect((out[0] as { text: string }).text).toBe('正在读取文件');
  });

  it('按结构抽取工具调用，参数原样带上', () => {
    const t = new CliOutputTranslator({ format: 'stream-json', kind: 'X' });
    const out = t.line(JSON.stringify({ type: 'tool_use', tool: 'Bash', args: { cmd: 'ls' } }));
    const call = out.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ tool: 'Bash', params: { cmd: 'ls' } });
  });

  /**
   * ★★ 有 token 数不等于有价钱。单价取决于模型、档位、缓存命中 ——
   *   任何一个乘出来的数字都会被当成账单读，那比不显示更糟。
   */
  it('★ 上报 token 但成本一律为 0 —— 不编造账单', () => {
    const t = new CliOutputTranslator({ format: 'stream-json', kind: 'X' });
    t.line(JSON.stringify({ usage: { input_tokens: 120, output_tokens: 45 } }));
    const cost = t.finish(0, '').find((e) => e.type === 'cost');

    expect(cost).toMatchObject({
      tokens: { input: 120, output: 45 },
      deltaUsd: 0,
      totalUsd: 0,
    });
  });

  it('json 形态攒到收尾才解析', () => {
    const t = new CliOutputTranslator({ format: 'json', kind: 'X' });
    expect(t.line('{ "response": "改完了",')).toHaveLength(0);
    expect(t.line('  "stats": { "tokens": { "input": 10, "output": 2 } } }')).toHaveLength(0);

    const out = t.finish(0, '');
    expect(out.some((e) => e.type === 'note' && e.text === '改完了')).toBe(true);
    expect(out.find((e) => e.type === 'cost')).toMatchObject({ tokens: { input: 10, output: 2 } });
  });

  it('json 形态下 stdout 不是合法 JSON 时保留原文，而不是当成没输出', () => {
    const t = new CliOutputTranslator({ format: 'json', kind: 'X' });
    t.line('Traceback (most recent call last):');
    const out = t.finish(1, '');
    expect(out.some((e) => e.type === 'note' && e.text.includes('Traceback'))).toBe(true);
  });

  it('非零退出码翻成 error + failed', () => {
    const t = new CliOutputTranslator({ format: 'text', kind: 'X' });
    const out = t.finish(2, 'command not found');
    expect(out.find((e) => e.type === 'error')).toMatchObject({
      error: { retriable: true, selfReport: 'command not found' },
    });
    expect(out.find((e) => e.type === 'run_ended')).toMatchObject({ outcome: 'failed' });
  });

  /**
   * ★ 有些 CLI 会把整个文件内容打到 stdout。不设上限的话，一次 Run
   *   能往事件表里塞进几万行 —— 而 run_events 是要长期留存的审计数据。
   *   但截断必须**说出来**，否则读日志的人会以为 Agent 只做了这么多。
   */
  it('输出刷屏时截断，但要说自己截断了', () => {
    const t = new CliOutputTranslator({ format: 'text', kind: 'X' });

    const emitted: string[] = [];
    for (let i = 0; i < 500; i++) {
      for (const e of t.line(`行 ${i}`)) if (e.type === 'note') emitted.push(e.text);
    }

    // 400 条真内容 + 1 条截断说明
    expect(emitted).toHaveLength(401);
    expect(emitted.at(-1)).toContain('不再逐条记录');
    // 说过一次就不再重复刷
    expect(t.line('还有更多')).toHaveLength(0);
  });

  /** 单行也要有上限 —— 一行几 MB 的文件内容同样能把事件表撑爆 */
  it('超长单行被截断且标明截了多少', () => {
    const t = new CliOutputTranslator({ format: 'text', kind: 'X' });
    const out = t.line('x'.repeat(5000));
    const text = (out[0] as { text: string }).text;

    expect(text.length).toBeLessThan(5000);
    expect(text).toContain('已截断');
  });
});

describe('执行与降级', () => {
  it('纯文本 CLI 的每行输出都变成事件', async () => {
    const { spawnFn } = fakeCli(['正在分析', '已修改 auth.ts', '完成']);
    const events = await collect(new GenericCliRuntime(PI_PROFILE, { apiKey: 'k', spawnFn }), task());

    expect(notes(events)).toEqual(expect.arrayContaining(['正在分析', '已修改 auth.ts', '完成']));
    expect(events.at(-1)).toMatchObject({ type: 'run_ended', outcome: 'completed' });
  });

  /**
   * ★ 不支持流式的运行时要提前说。否则用户盯着一个一直不动的执行流，
   *   只会以为卡死了 —— 而它其实在正常跑，只是要跑完才有输出。
   */
  it('★ 只能收尾出结果的运行时，开头就说清楚', async () => {
    const { spawnFn } = fakeCli(['{"response":"ok"}']);
    const events = await collect(
      new GenericCliRuntime(GEMINI_PROFILE, { apiKey: 'k', spawnFn }),
      task(),
    );
    expect(notes(events).some((t) => t.includes('一次性输出'))).toBe(true);
  });

  /**
   * ★ 权限表达不了的部分要写进执行流 —— 它是审计链的一部分。
   *   静默吞掉的话，用户会以为 deniedTools 在这些 CLI 上也生效了。
   */
  it('★ 沙箱级权限表达不了的规则要列出来', async () => {
    const { spawnFn } = fakeCli(['done']);
    const events = await collect(
      new GenericCliRuntime(PI_PROFILE, { apiKey: 'k', spawnFn }),
      task({
        permissions: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          // 带参数的黑名单在沙箱级权限里根本没有落点
          deniedTools: ['Bash(rm *)'],
          resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
        },
      }),
    );

    const warning = notes(events).find((t) => t.includes('沙箱级'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Bash(rm *)');
  });

  /**
   * ★ 没装 CLI 是最常见的部署问题。把安装命令直接给出来，
   *   而不是让运维自己去搜「这个 CLI 怎么装」。
   */
  it('★ 可执行文件不存在时，报错里带安装命令', async () => {
    const spawnFn: CliSpawnFn = () => {
      throw new Error('spawn aider ENOENT');
    };
    const events = await collect(new GenericCliRuntime(AIDER_PROFILE, { apiKey: 'k', spawnFn }), task());

    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ error: { class: 'capability_mismatch', retriable: false } });
    expect((err as { error: { selfReport?: string } }).error.selfReport).toContain('aider-install');
  });

  it('CLI 非零退出时如实标记失败并带上 stderr', async () => {
    const { spawnFn } = fakeCli(['部分输出'], 1, ['ERROR: rate limit exceeded']);
    const events = await collect(new GenericCliRuntime(PI_PROFILE, { apiKey: 'k', spawnFn }), task());

    expect(events.at(-1)).toMatchObject({ type: 'run_ended', outcome: 'failed' });
    const err = events.find((e) => e.type === 'error');
    expect((err as { error: { selfReport?: string } }).error.selfReport).toContain('rate limit');
  });

  it('终止指令让 Run 以 terminated 收尾', async () => {
    const { spawnFn } = fakeCli(['慢慢跑']);
    const rt = new GenericCliRuntime(PI_PROFILE, { apiKey: 'k', spawnFn });
    const t = task();
    const events: RunEvent[] = [];
    await rt.dispatch(t);
    await rt.subscribe(t.runId, async (e) => {
      events.push(e);
    });
    await rt.control(t.runId, { action: 'terminate', reason: '人工中止' });

    expect(await rt.queryStatus(t.runId)).toMatchObject({ status: 'terminated' });
  });

  it('起跑后无法注入约束 —— 如实抛不支持而不是假装接受', async () => {
    const { spawnFn } = fakeCli(['x']);
    const rt = new GenericCliRuntime(GOOSE_PROFILE, { apiKey: 'k', spawnFn });
    const t = task();
    await rt.dispatch(t);
    await rt.subscribe(t.runId, async () => {});

    await expect(
      rt.control(t.runId, { action: 'add_constraint', constraint: { type: 'x', value: 1, description: 'd' } }),
    ).rejects.toThrow(/runtimeConstraints/);
  });
});

describe('profile 表本身', () => {
  it('六个 CLI 都在表里，kind 唯一', () => {
    const kinds = CLI_PROFILES.map((p) => p.kind);
    expect(kinds.sort()).toEqual(['aider', 'gemini_cli', 'goose', 'opencode', 'pi', 'qwen_code']);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  /**
   * ★ 每个 profile 都要能回答「没装怎么办」和「文档在哪」。
   *   缺了它们，第一次部署失败时现场没有任何可行动的信息。
   */
  it('每个 profile 都有安装提示与文档出处', () => {
    for (const p of CLI_PROFILES) {
      expect(p.installHint, p.kind).toBeTruthy();
      expect(p.docs, p.kind).toMatch(/^https?:\/\//);
    }
  });

  it('单次执行的能力上限对所有 CLI 都成立', () => {
    for (const p of CLI_PROFILES) {
      expect(p.features.runtimeConstraints, p.kind).toBe(false);
      expect(p.features.interventionRequest, p.kind).toBe(false);
      expect(p.features.pause, p.kind).toBe(false);
    }
  });

  /**
   * ★★ 能力清单不能夸大。json 形态是「跑完才有输出」，
   *   声明成 streamingEvents 会让界面画一个永远不动的执行流。
   */
  it('★ 非流式输出的运行时不能声称支持流式事件', () => {
    for (const p of CLI_PROFILES) {
      if (p.output === 'json') expect(p.features.streamingEvents, p.kind).toBe(false);
    }
  });

  it('cliProfile 按 kind 查得到，未知 kind 返回 null', () => {
    expect(cliProfile('goose')?.label).toBe('Goose');
    expect(cliProfile('nope')).toBeNull();
  });
});
