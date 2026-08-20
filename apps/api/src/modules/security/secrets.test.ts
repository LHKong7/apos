import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeRef,
  encodeEnvOverrides,
  encodeSecret,
  hasMasterKey,
  hintOf,
  resolveSecret,
  SecretConfigError,
} from './secrets';

const KEY = 'APOS_SECRET_KEY';
const original = process.env[KEY];

beforeEach(() => {
  process.env[KEY] = 'test-master-key';
});

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  delete process.env['MY_TOKEN'];
});

describe('凭证引用', () => {
  it('明文加密后进引用，引用里读不出原值', () => {
    const ref = encodeSecret('sk-ant-super-secret-12345');
    expect(ref.startsWith('secret://enc/')).toBe(true);
    expect(ref).not.toContain('sk-ant-super-secret');
    expect(resolveSecret(ref)).toBe('sk-ant-super-secret-12345');
  });

  it('env: 形态不存任何密文，只记变量名', () => {
    const ref = encodeSecret('env:MY_TOKEN');
    expect(ref).toBe('secret://env/MY_TOKEN');

    process.env['MY_TOKEN'] = 'from-environment';
    expect(resolveSecret(ref)).toBe('from-environment');
  });

  /**
   * ★★ 没有主密钥时**照样存得下**，只是明文。
   *
   *   此前这里是「直接拒绝」。但被它拦下的不只是凭证 —— Agent 的运行时
   *   配置是一份用户自己写的 JSON，键名带 TOKEN/KEY/AUTH 的值都会走这条
   *   路径，于是「配一下中转站」变成了「先去改部署的环境变量再重启」。
   *   一个把常规配置挡在门外的安全措施，换来的是用户绕开这一页。
   *
   *   密钥现在决定的是**存成什么样**，不是**能不能存**。
   */
  it('没有主密钥时明文入库而不是拒绝保存', () => {
    delete process.env[KEY];
    expect(hasMasterKey()).toBe(false);

    const ref = encodeSecret('sk-ant-plain');
    expect(ref.startsWith('secret://plain/')).toBe(true);
    // 明文形态取得回原值，且自称可用 —— 它不依赖任何环境
    expect(resolveSecret(ref)).toBe('sk-ant-plain');
    expect(describeRef(ref)).toEqual({
      usable: true,
      kind: 'plain',
      problem: null,
      problemCode: null,
    });

    // env: 形态不受影响，仍是推荐写法
    expect(encodeSecret('env:MY_TOKEN')).toBe('secret://env/MY_TOKEN');
  });

  /**
   * ★ 明文形态带 `secret://` 前缀，不是裸值。
   *   前缀是「接口不回显」那条纪律的抓手：脱敏靠认前缀，
   *   裸值一旦混进库里，同一条 JSON 里的 token 就会随响应发回浏览器。
   */
  it('明文形态仍带 secret:// 前缀，且引用里不出现原值本身', () => {
    delete process.env[KEY];
    const ref = encodeSecret('sk-ant-plain-12345');

    expect(ref.startsWith('secret://')).toBe(true);
    expect(ref).not.toContain('sk-ant-plain-12345');
  });

  /** 空值任何形态下都不接受 —— 存一条空凭证等于把故障推迟到派发那一刻 */
  it('空值仍然拒绝，不因为少了主密钥就放行', () => {
    delete process.env[KEY];
    expect(() => encodeSecret('   ')).toThrowError(SecretConfigError);
  });

  it('换过主密钥之后旧密文解不开，且能说清原因', () => {
    const ref = encodeSecret('sk-old');
    process.env[KEY] = 'a-different-key';

    expect(resolveSecret(ref)).toBeNull();
    const d = describeRef(ref);
    expect(d.usable).toBe(false);
    expect(d.problem).toContain('重新录入');
  });

  it('env: 指向的变量没设时判为不可用，而不是静默返回空', () => {
    const ref = encodeSecret('env:MY_TOKEN');
    const d = describeRef(ref);
    expect(d.usable).toBe(false);
    expect(d.problem).toContain('MY_TOKEN');
  });

  it('旧式指纹引用如实标注为取不回原值', () => {
    const d = describeRef('secret://local/abc123');
    expect(d.kind).toBe('fingerprint');
    expect(d.usable).toBe(false);
    expect(d.problem).toContain('重新录入');
  });

  it('hint 只露后四位；env 形态露变量名而不是值', () => {
    expect(hintOf('sk-ant-1234abcd')).toBe('****abcd');
    expect(hintOf('env:MY_TOKEN')).toBe('env:MY_TOKEN');
  });

  it('相同明文两次编码得到不同密文（IV 随机），但都能解回原值', () => {
    const a = encodeSecret('same-secret');
    const b = encodeSecret('same-secret');
    expect(a).not.toBe(b);
    expect(resolveSecret(a)).toBe('same-secret');
    expect(resolveSecret(b)).toBe('same-secret');
  });

  it('密文被篡改时解不开，而不是返回一段垃圾', () => {
    const ref = encodeSecret('sk-ant-real');
    const tampered = `${ref.slice(0, -4)}AAAA`;
    expect(resolveSecret(tampered)).toBeNull();
  });
});

/**
 * ★★ APOS 自己的密钥不能下发给 Agent。
 *
 *   两条路都能把进程环境里的值交给子进程：环境变量表里的 `env:变量名`，
 *   和 passthroughEnv 那份名字列表。两条的门槛都只是 `agent.update`，
 *   而那个权限任何项目的 pm / tech_lead 都有 —— 也就是说，
 *   不拦的话一个项目负责人就能把签名密钥交给一个自己写 prompt 的子进程，
 *   拿它签出任意用户的令牌。这是一条从项目角色直达整个实例的提权路径。
 */
describe('★ APOS 自己的密钥禁止外发', () => {
  it('env: 引用签名密钥被拒，报错说清为什么', () => {
    expect(() => encodeSecret('env:APOS_JWT_SECRET')).toThrow(/APOS 自己的密钥/);
  });

  it('凭证主密钥、数据库连接串同样被拒', () => {
    expect(() => encodeSecret('env:APOS_SECRET_KEY')).toThrow(SecretConfigError);
    expect(() => encodeSecret('env:DATABASE_URL')).toThrow(SecretConfigError);
    expect(() => encodeSecret('env:DATABASE_DIRECT_URL')).toThrow(SecretConfigError);
    expect(() => encodeSecret('env:APOS_SUPERADMIN_PASSWORD')).toThrow(SecretConfigError);
  });

  it('★ 大小写与空格绕不过去', () => {
    expect(() => encodeSecret('env: apos_jwt_secret ')).toThrow(SecretConfigError);
  });

  it('★ 环境变量表这条路也走同一道判定', () => {
    expect(() => encodeEnvOverrides({ ANTHROPIC_AUTH_TOKEN: 'env:APOS_JWT_SECRET' })).toThrow(
      SecretConfigError,
    );
  });

  it('Agent 自己的那些环境变量照常可以引用 —— 拦的是点名的那几个', () => {
    expect(encodeSecret('env:ANTHROPIC_AUTH_TOKEN')).toBe('secret://env/ANTHROPIC_AUTH_TOKEN');
    // 名字里带 APOS_ 但不在清单里的不受影响
    expect(encodeSecret('env:APOS_WORKSPACE_ROOT')).toBe('secret://env/APOS_WORKSPACE_ROOT');
  });
});
