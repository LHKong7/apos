import { describe, expect, it } from 'vitest';
import {
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

  it('mock 运行时没有环境变量表，传了也不会凭空长出一个 env 键', () => {
    const r = validateRuntimeConfig('mock', { env: { A: 'b' } });
    expect(r.ok).toBe(true);
    expect(r.ok && 'env' in r.config).toBe(false);
  });
});

describe('validateRuntimeConfig：不认识的键', () => {
  /**
   * ★ 仍然丢弃（schema 删字段时老 Agent 才改得动），但要**说出来**。
   *   配置可以直接粘 JSON 之后，静默丢弃就成了「我明明填了它没了」。
   */
  it('未知键被丢弃，并列进 dropped 回给调用方', () => {
    const r = validateRuntimeConfig('claude_code', {
      model: 'claude-opus-5',
      anthropicBaseUrl: 'https://gw.example.com',
      nonsense: 1,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.config['anthropicBaseUrl']).toBeUndefined();
    expect(r.ok && r.dropped.sort()).toEqual(['anthropicBaseUrl', 'nonsense']);
  });

  it('全是已知键时 dropped 为空', () => {
    const r = validateRuntimeConfig('claude_code', { model: 'claude-sonnet-5' });
    expect(r.ok && r.dropped).toEqual([]);
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
