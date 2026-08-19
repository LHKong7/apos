import { describe, expect, it } from 'vitest';
import {
  RUNTIME_KIND_SPECS,
  defaultRuntimeConfig,
  envOverridesOf,
  isSecretEnvKey,
  runtimeKindSpec,
  validateRuntimeConfig,
} from './runtime-config';

/**
 * 运行时配置 schema 的校验。
 *
 * ★ 重点在环境变量表（`env`）——它是用户能直接写 JSON 的那个口子，
 *   也是唯一一处「填错了会安静地不生效」的地方：值写成数字、键写成
 *   带横杠的名字、把整份配置写成数组，这些在保存那一刻不拒掉的话，
 *   下一次派发会以一句没人看得懂的鉴权/参数错误告终。
 */

function envOf(kind: string, env: Record<string, unknown>) {
  return validateRuntimeConfig(kind, { env });
}

describe('validateRuntimeConfig：环境变量表', () => {
  it('合法的环境变量表原样保留', () => {
    const r = envOf('claude_code', {
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.config['env']).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
    });
  });

  it('值必须是字符串 —— 数字/布尔要在保存时拒掉', () => {
    const r = envOf('claude_code', { MAX_TOKENS: 4096 });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.key).toBe('env');
    expect(!r.ok && r.issues[0]!.message).toContain('MAX_TOKENS');
  });

  it('键必须是合法的环境变量名', () => {
    const r = envOf('claude_code', { 'anthropic-base-url': 'https://x' });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.message).toContain('anthropic-base-url');
  });

  it('整份 env 写成数组或标量都要拒掉', () => {
    for (const bad of [['A=1'], 'A=1', 42]) {
      const r = validateRuntimeConfig('claude_code', { env: bad });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.issues[0]!.message).toContain('JSON 对象');
    }
  });

  it('没配 env 时补上空表，适配器侧不用到处判空', () => {
    const r = validateRuntimeConfig('claude_code', {});
    expect(r.ok && r.config['env']).toEqual({});
    expect(defaultRuntimeConfig('claude_code')['env']).toEqual({});
  });

  it('mock 运行时没有环境变量表，不传就不会凭空长出一个 env 键', () => {
    const r = validateRuntimeConfig('mock', {});
    expect(r.ok).toBe(true);
    expect(r.ok && 'env' in r.config).toBe(false);
  });

  /** mock 不认识 env，于是它就是一个普通的自定义键：收下、不校验、不下发给谁 */
  it('mock 上写了 env 也照样存下来，只是算自定义键', () => {
    const r = validateRuntimeConfig('mock', { env: { A: 'b' } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.config['env']).toEqual({ A: 'b' });
    expect(r.ok && r.unknownKeys).toEqual(['env']);
  });
});

describe('validateRuntimeConfig：不认识的键', () => {
  /**
   * ★★ 原样保留，不丢弃也不报错 —— 配置是一份自定义 JSON。
   *
   *   丢弃是「我明明填了它没了」，报错是「运行时升级了、平台还没发版，
   *   于是这个 Agent 存不下」。两条路都堵死之后配置就只能等发版。
   */
  it('未知键原样保留，并列进 unknownKeys 回给调用方', () => {
    const r = validateRuntimeConfig('claude_code', {
      model: 'claude-opus-5',
      anthropicBaseUrl: 'https://gw.example.com',
      nonsense: 1,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.config['anthropicBaseUrl']).toBe('https://gw.example.com');
    expect(r.ok && r.config['nonsense']).toBe(1);
    expect(r.ok && r.unknownKeys.sort()).toEqual(['anthropicBaseUrl', 'nonsense']);
  });

  /** 自定义键的值不受平台的类型判据管 —— 平台不知道它该长什么样 */
  it('自定义键可以是任意 JSON 值，不参与已知键那套校验', () => {
    const r = validateRuntimeConfig('claude_code', {
      customTools: [{ name: 'x' }],
      retries: 3,
      flag: true,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.config['customTools']).toEqual([{ name: 'x' }]);
    expect(r.ok && r.config['retries']).toBe(3);
    expect(r.ok && r.config['flag']).toBe(true);
  });

  /** ★ 已知键仍然照校验：自定义键放行了，不等于错值也一起放行 */
  it('自定义键不影响已知键的校验', () => {
    const r = validateRuntimeConfig('claude_code', { effort: 'ultra', myOwnKey: 'x' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.key).toBe('effort');
  });

  it('全是已知键时 unknownKeys 为空', () => {
    const r = validateRuntimeConfig('claude_code', { model: 'claude-sonnet-5' });
    expect(r.ok && r.unknownKeys).toEqual([]);
  });
});

describe('claude_code 的接入形态', () => {
  /**
   * ★ 这一项此前是 null，界面上根本不渲染接入地址输入框 ——
   *   于是 agents.endpoint 这一列对 Claude Code Agent 写了也没人消费，
   *   而中转站/自建网关恰恰是最常见的接法。
   */
  it('支持自定义接入地址', () => {
    expect(runtimeKindSpec('claude_code')!.endpoint).not.toBeNull();
  });

  it('凭证下发变量名只能是这两个之一', () => {
    expect(validateRuntimeConfig('claude_code', { credentialEnv: 'ANTHROPIC_AUTH_TOKEN' }).ok).toBe(
      true,
    );

    const bad = validateRuntimeConfig('claude_code', { credentialEnv: 'ANTHROPIC_TOKEN' });
    expect(bad.ok).toBe(false);
  });
});

describe('isSecretEnvKey', () => {
  it('认出凭证形状的变量名', () => {
    for (const key of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'SSH_KEY',
    ]) {
      expect(isSecretEnvKey(key), key).toBe(true);
    }
  });

  /**
   * ★ 误判成凭证会把一个本该看得见、改得动的值锁进密文里 ——
   *   所以按下划线切段匹配，不是子串匹配。
   */
  it('不把只是长得像的名字当成凭证', () => {
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'GIT_AUTHOR_NAME',
      'KEYCLOAK_URL',
      'HTTPS_PROXY',
      'NODE_ENV',
    ]) {
      expect(isSecretEnvKey(key), key).toBe(false);
    }
  });
});

describe('envOverridesOf', () => {
  it('读不出环境变量表时一律给空对象，不抛异常', () => {
    expect(envOverridesOf(null)).toEqual({});
    expect(envOverridesOf({})).toEqual({});
    expect(envOverridesOf({ env: 'not-an-object' })).toEqual({});
    expect(envOverridesOf({ env: ['A'] })).toEqual({});
  });

  it('过滤掉非字符串的值', () => {
    expect(envOverridesOf({ env: { A: 'a', B: 42 } })).toEqual({ A: 'a' });
  });
});


/**
 * 英文覆盖 —— 阻断性。
 *
 * ★★ 为什么这条要是**测试**而不是靠自觉：
 *
 *   这张表上的 `*En` 字段是可选的，界面取不到就回落中文（见 useSpecText，
 *   那个回落本身是对的：一段中文说明总比空白强）。但可选 + 回落意味着
 *   漏写**没有任何现场迹象** —— 英文界面照常渲染，只是渲染的是中文。
 *   实测曾经一次欠下 48 处，正好落在新用户配置 Agent 的必经路径上。
 *
 *   而这张表存在的理由是「加一个 CLI 只用加一条 profile」——
 *   那也意味着加一个 CLI 就会顺手多欠一批文案。所以由测试来数。
 *
 * ★ 判据是「中文的那一份含 CJK」而不是「有没有填」：像 `binary`、
 *   `ANTHROPIC_API_KEY` 这种本来就是英文/标识符的值不需要再来一份。
 *
 * Every reader-facing string that is written in Chinese must ship an English
 * counterpart. The optional fields fall back to Chinese, which renders fine
 * and therefore hides the omission — so it is counted here instead.
 */
describe('运行时规格的英文覆盖', () => {
  const hasCJK = (s: string | null | undefined) => /[\u4e00-\u9fff]/.test(s ?? '');

  it('每一条面向用户的中文文案都配了英文', () => {
    const missing: string[] = [];
    for (const spec of RUNTIME_KIND_SPECS) {
      const need = (zh: string | null | undefined, en: string | null | undefined, at: string) => {
        if (hasCJK(zh) && !en) missing.push(`${spec.kind}.${at}`);
      };
      need(spec.description, spec.descriptionEn, 'description');
      need(spec.prerequisite, spec.prerequisiteEn, 'prerequisite');
      for (const key of ['credential', 'endpoint'] as const) {
        const slot = spec[key];
        if (!slot) continue;
        need(slot.label, slot.labelEn, `${key}.label`);
        need(slot.help, slot.helpEn, `${key}.help`);
      }
      for (const f of spec.fields) {
        need(f.label, f.labelEn, `${f.key}.label`);
        need(f.help, f.helpEn, `${f.key}.help`);
        for (const o of f.options ?? []) {
          need(o.label, o.labelEn, `${f.key}/${o.value}.label`);
          need(o.help, o.helpEn, `${f.key}/${o.value}.help`);
        }
      }
    }
    expect(missing, `以下文案缺英文，英文界面会显示中文：\n${missing.join('\n')}`).toEqual([]);
  });
});
