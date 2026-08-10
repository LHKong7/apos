import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 凭证引用（页面文档 14 §9 的纪律，扩展到 Agent 运行时与代码仓库）。
 *
 * 三条规矩：
 * 1. 业务表里存的永远是 `secret://…` 引用，不是明文。
 * 2. 接口只回 `credentialHint`（后四位），任何响应都读不出原值。
 * 3. 引用能被解回明文的那把钥匙（APOS_SECRET_KEY）住在库外。
 *    只拿到一份数据库导出的人，解不开任何一条凭证。
 *
 * 支持两种引用形态，按运维成熟度二选一：
 *
 * | 形态 | 写法 | 明文落在哪 | 适用 |
 * | --- | --- | --- | --- |
 * | 环境变量 | `env:GITHUB_TOKEN` | 只在进程环境 | 生产首选；有 KMS/Vault 时也走这条 |
 * | 加密内联 | 直接粘贴 key | 密文进库，钥匙在环境 | 自建单机、演示环境 |
 *
 * ★ 没有第三种「明文进库」。APOS_SECRET_KEY 未配置时，
 *   接口会直接拒绝粘贴进来的凭证并告诉用户改用 env: 形态 ——
 *   而不是"先存着，回头再加密"。回头是不会来的。
 */

const ENC_PREFIX = 'secret://enc/';
const ENV_PREFIX = 'secret://env/';
const FINGERPRINT_PREFIX = 'secret://local/';

const ALGO = 'aes-256-gcm';

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigError';
  }
}

/** 主密钥。取不到时返回 null —— 调用方要据此给出可行动的报错，而不是静默降级 */
function masterKey(): Buffer | null {
  const raw = process.env['APOS_SECRET_KEY'];
  if (!raw) return null;
  // 任意长度的口令都归一到 32 字节；直接用 32 字节 hex/base64 也可以
  return createHash('sha256').update(raw).digest();
}

export function hasMasterKey(): boolean {
  return masterKey() !== null;
}

/**
 * 明文 → 引用。
 *
 * 输入以 `env:` 开头时不加密、不存储任何密文，只记住去哪个环境变量取。
 */
export function encodeSecret(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new SecretConfigError('凭证不能为空');

  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice(4).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      throw new SecretConfigError(`环境变量名不合法：${name}`);
    }
    return `${ENV_PREFIX}${name}`;
  }

  const key = masterKey();
  if (!key) {
    throw new SecretConfigError(
      '未配置 APOS_SECRET_KEY，无法安全保存凭证。' +
        '请设置该环境变量后重试，或改用 `env:变量名` 形态把凭证放在进程环境里。',
    );
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/**
 * 引用 → 明文。取不到返回 null。
 *
 * ★ 返回 null 的三种原因（钥匙没配 / 环境变量空 / 密文损坏）都不同，
 *   但对调用方是同一件事：这条凭证现在用不了。具体原因走 describeRef，
 *   因为它会被写进面向用户的报错，而解密函数的调用点常常在日志里。
 */
export function resolveSecret(ref: string | null): string | null {
  if (!ref) return null;

  if (ref.startsWith(ENV_PREFIX)) {
    return process.env[ref.slice(ENV_PREFIX.length)] ?? null;
  }

  if (ref.startsWith(ENC_PREFIX)) {
    const key = masterKey();
    if (!key) return null;

    const [ivPart, tagPart, dataPart] = ref.slice(ENC_PREFIX.length).split('.');
    if (!ivPart || !tagPart || !dataPart) return null;

    try {
      const decipher = createDecipheriv(ALGO, key, Buffer.from(ivPart, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // 换过 APOS_SECRET_KEY 之后旧密文解不开 —— 这是可能发生且必须能被诊断的
      return null;
    }
  }

  // 老的指纹式引用（integrations 早期写入的）本来就取不回明文
  return null;
}

/** 这条引用现在能不能用，以及用不了的话是为什么 */
export function describeRef(ref: string | null): {
  usable: boolean;
  kind: 'none' | 'env' | 'encrypted' | 'fingerprint';
  problem: string | null;
} {
  if (!ref) return { usable: false, kind: 'none', problem: null };

  if (ref.startsWith(ENV_PREFIX)) {
    const name = ref.slice(ENV_PREFIX.length);
    return process.env[name]
      ? { usable: true, kind: 'env', problem: null }
      : { usable: false, kind: 'env', problem: `环境变量 ${name} 未设置` };
  }

  if (ref.startsWith(ENC_PREFIX)) {
    if (!hasMasterKey()) {
      return { usable: false, kind: 'encrypted', problem: '未配置 APOS_SECRET_KEY，无法解密' };
    }
    return resolveSecret(ref) === null
      ? { usable: false, kind: 'encrypted', problem: 'APOS_SECRET_KEY 与保存时不一致，需要重新录入凭证' }
      : { usable: true, kind: 'encrypted', problem: null };
  }

  if (ref.startsWith(FINGERPRINT_PREFIX)) {
    return {
      usable: false,
      kind: 'fingerprint',
      problem: '这是仅用于识别的旧式指纹引用，取不回原值，需要重新录入凭证',
    };
  }

  return { usable: false, kind: 'fingerprint', problem: '无法识别的凭证引用格式' };
}

/**
 * 页面上显示的 ****1234。
 *
 * env: 形态显示变量名而不是值 —— 用户要认出的是「哪一把钥匙」，
 * 而这时钥匙的身份就是那个变量名。
 *
 * @param label 调用方比这里更懂这条凭证是什么时给的替代说法
 *   （比如 SSH 私钥可以给出算法名）。这里不认识 label 的内容，
 *   只负责它不为空时优先用它。
 */
export function hintOf(input: string, label?: string | null): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('env:')) return `env:${trimmed.slice(4).trim()}`;
  if (label) return label;

  /**
   * ★ 私钥的后四位是 `----`（PEM 尾巴），显示出来等于什么都没说。
   *   一个不能用来辨认的 hint 比没有更糟：管理员会以为凭证没存进去。
   */
  const pem = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/.exec(trimmed);
  if (pem) {
    const kind = (pem[1] ?? '').trim();
    return kind ? `私钥（${kind}）` : '私钥';
  }

  return `****${trimmed.slice(-4)}`;
}

/** 仅用于识别的指纹，不可逆。integrations 的历史行为保留在这里 */
export function fingerprintOf(credential: string | null): string | null {
  if (!credential) return null;
  let h = 2166136261;
  for (let i = 0; i < credential.length; i++) {
    h ^= credential.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${FINGERPRINT_PREFIX}${(h >>> 0).toString(16)}`;
}
