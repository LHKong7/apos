import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeRef,
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
   * ★ 这条是整个模块存在的理由：没有主密钥时**拒绝**保存，
   *   而不是「先明文存着，回头再加密」。回头是不会来的。
   */
  it('没有主密钥时拒绝保存粘贴进来的凭证，并给出可行动的替代方案', () => {
    delete process.env[KEY];
    expect(hasMasterKey()).toBe(false);

    expect(() => encodeSecret('sk-ant-plain')).toThrowError(SecretConfigError);
    try {
      encodeSecret('sk-ant-plain');
    } catch (e) {
      expect((e as Error).message).toContain('env:');
    }

    // env: 形态不需要主密钥
    expect(encodeSecret('env:MY_TOKEN')).toBe('secret://env/MY_TOKEN');
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
