import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isProtectedEnvKey, isSecretEnvKey } from '@apos/contracts';

/**
 * 凭证引用（页面文档 14 §9 的纪律，扩展到 Agent 运行时与代码仓库）。
 *
 * 两条不变的规矩：
 * 1. 业务表里存的永远是 `secret://…` 引用，读的一方靠前缀知道它是什么。
 * 2. 接口只回 `credentialHint`（后四位）或占位符，任何响应都读不出原值。
 *
 * 三种引用形态：
 *
 * | 形态 | 写法 | 明文落在哪 | 适用 |
 * | --- | --- | --- | --- |
 * | 环境变量 | `env:GITHUB_TOKEN` | 只在进程环境 | 生产首选；有 KMS/Vault 时也走这条 |
 * | 加密内联 | 直接粘贴 key（配了主密钥） | 密文进库，钥匙在环境 | 自建单机 |
 * | 明文内联 | 直接粘贴 key（没配主密钥） | 明文进库 | 本机开发、演示环境 |
 *
 * ★★ APOS_SECRET_KEY 决定的是**存成密文还是明文**，不再决定**能不能存**。
 *
 *   此前没配主密钥时接口直接拒绝粘贴进来的值，理由是「不做先存着回头再
 *   加密」。但它拦下的不只是凭证 —— Agent 的运行时配置是一份用户自己写的
 *   JSON，里面凡是键名带 TOKEN/KEY/AUTH 的都会被同一条规则判定为凭证，
 *   于是「配一下中转站」变成了「先去改部署的环境变量再重启」。
 *   一个把常规配置挡在门外的安全措施，最后换来的是用户绕开这一页。
 *
 *   所以改成：永远存得下，配了主密钥就是密文，没配就是明文，且这件事
 *   在界面上明说（catalog 的 `encryptsInlineSecrets`）。明文形态同样带
 *   `secret://` 前缀，因此「接口不回显」那条纪律对三种形态一视同仁。
 */

const ENC_PREFIX = 'secret://enc/';
const ENV_PREFIX = 'secret://env/';
/** 没配主密钥时的明文形态。带前缀是为了让读的一方仍然知道「这是一条凭证」 */
const PLAIN_PREFIX = 'secret://plain/';
const FINGERPRINT_PREFIX = 'secret://local/';

const ALGO = 'aes-256-gcm';

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigError';
  }
}

/** 主密钥。取不到时返回 null —— 此时内联值明文入库，界面上要如实标注 */
function masterKey(): Buffer | null {
  const raw = process.env['APOS_SECRET_KEY'];
  if (!raw) return null;
  // 任意长度的口令都归一到 32 字节；直接用 32 字节 hex/base64 也可以
  return createHash('sha256').update(raw).digest();
}

/** 内联的敏感值现在是不是密文入库。false 不是「存不下」，是「明文进库」 */
export function hasMasterKey(): boolean {
  return masterKey() !== null;
}

/**
 * 明文 → 引用。
 *
 * 输入以 `env:` 开头时不加密、不存储任何值，只记住去哪个环境变量取。
 *
 * ★ 没配主密钥时退化成明文形态而不是抛错 —— 保存永远不会因为部署少配了
 *   一个环境变量而失败。理由见文件头。
 */
export function encodeSecret(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new SecretConfigError('凭证不能为空');

  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice(4).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      throw new SecretConfigError(`环境变量名不合法：${name}`);
    }
    /**
     * ★★ APOS 自己的密钥一律不许被引用。
     *
     *   `env:APOS_JWT_SECRET` 在语法上完全合法，落库之后派发时会被
     *   如实解开、交给子进程 —— 而那个子进程的 prompt 由填这一栏的人写。
     *   拿到签名密钥就能签出任意用户的令牌，整个身份体系当场作废。
     *   门槛只是 `agent.update`（任何项目的 pm / tech_lead 都有），
     *   所以这条必须是拒绝而不是提醒。
     */
    if (isProtectedEnvKey(name)) {
      throw new SecretConfigError(
        `${name} 是 APOS 自己的密钥，不能下发给 Agent。` +
          `Agent 要用的凭证请填它自己的值，或引用另一个专门为它设的环境变量。`,
      );
    }
    return `${ENV_PREFIX}${name}`;
  }

  const key = masterKey();
  if (!key) {
    /**
     * ★ base64url 编码只是为了让引用里不出现换行与 `/`（PEM 私钥两样都有），
     *   不是加密 —— 谁拿到这一行都能解回原值，界面上必须这么说。
     */
    return `${PLAIN_PREFIX}${Buffer.from(trimmed, 'utf8').toString('base64url')}`;
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

  if (ref.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(ref.slice(PLAIN_PREFIX.length), 'base64url').toString('utf8');
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
  kind: 'none' | 'env' | 'encrypted' | 'plain' | 'fingerprint';
  problem: string | null;
} {
  if (!ref) return { usable: false, kind: 'none', problem: null };

  /**
   * ★ 明文形态永远可用 —— 它不依赖任何环境。「明文入库」这件事本身
   *   不在这里报，它是部署的选择而不是这条凭证的故障：混进 problem
   *   会让每个 Agent 都挂着一条红字，真正的故障反而被淹没。
   *   界面上由 catalog 的 encryptsInlineSecrets 统一说一次。
   */
  if (ref.startsWith(PLAIN_PREFIX)) return { usable: true, kind: 'plain', problem: null };

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

/**
 * ── Agent 运行时配置里的环境变量表 ────────────────────────────────────
 *
 * 用户在界面上直接写一份 JSON 下发给子进程（`{"ANTHROPIC_BASE_URL": …,
 * "ANTHROPIC_AUTH_TOKEN": …}`）。这里负责让敏感值不被接口回显。
 *
 * 库里的值有四种形态：
 * | 形态 | 怎么来的 | 回显成 |
 * | --- | --- | --- |
 * | `secret://enc/…` | 敏感键填了字面量，且配了主密钥 | `secret://saved` |
 * | `secret://plain/…` | 敏感键填了字面量，没配主密钥 | `secret://saved` |
 * | `secret://env/NAME` | 值写成 `env:NAME` | `env:NAME` |
 * | 明文 | 非敏感键的字面量（如网关地址） | 原样 |
 *
 * ★ 前两种回显成同一个占位符，因此界面与调用方不必分辨部署有没有配主密钥 ——
 *   「保存了、不回显、原样存回表示不改」这套语义对两者完全一致。
 */

/**
 * 加密值回显时的占位符。
 *
 * ★ 必须能原样存回来表示「这一项不改」—— 界面上那是一个 JSON 文本框，
 *   用户改网关地址时会把整份 JSON 一起提交。没有这个约定的话，
 *   改一个字段就会把同一份 JSON 里的 token 冲成字面量 "****1234"，
 *   而这件事直到下一次派发报 401 才会被发现。
 */
export const KEPT_SECRET = 'secret://saved';

/** 保存时：明文 → 引用。previous 是库里已有的那份，用于兑现 KEPT_SECRET */
export function encodeEnvOverrides(
  next: Record<string, string>,
  previous: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(next)) {
    if (value === KEPT_SECRET) {
      const kept = previous[key];
      if (!kept) {
        throw new SecretConfigError(
          `环境变量 ${key} 没有已保存的值可以沿用。${KEPT_SECRET} 是「保持不变」的占位符，` +
            '新增这一项时请填入实际值。',
        );
      }
      out[key] = kept;
      continue;
    }

    /**
     * ★ 不接受手工填写的 secret:// 引用 —— 那是**存储形态**，由这个函数
     *   自己生成，不是用户该写的输入。放行它等于让人跳过这里的全部校验
     *   直接往库里塞一条引用。
     *
     * ★★ 注意：真正挡住「把 APOS 自己的密钥读给 Agent」的不是这一条。
     *
     *   这里以前写着「放行的话任何人都能粘 secret://env/DATABASE_URL 进来，
     *   那正是 passthroughEnv 那份白名单要挡住的事」—— 两句都不成立：
     *   下面那条 `env:变量名` 分支做的是同一件事而且是允许的，
     *   而 passthroughEnv 根本不是白名单，它就是用户给什么就透传什么。
     *   也就是说，那份「白名单」从来不存在，注释描述的是一层想象中的防线。
     *
     *   现在拦住它的是 isProtectedEnvKey（contracts 里那份点名清单），
     *   两条路径都过它：上面的 `env:` 分支，以及运行时工厂里的
     *   passthroughEnv 过滤。安全措施要么在代码里，要么就别写在注释里。
     */
    if (value.startsWith('secret://')) {
      throw new SecretConfigError(
        `环境变量 ${key} 的值不能是 secret:// 引用。要从进程环境取值请写成 \`env:变量名\`。`,
      );
    }

    if (value.startsWith('env:') || isSecretEnvKey(key)) {
      out[key] = encodeSecret(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

/**
 * 回显时：引用 → 占位符。已保存的敏感值永不回显原文。
 *
 * ★ 明文形态也照样遮住。它进库时是不是密文取决于部署有没有配主密钥，
 *   而「接口不把 token 吐回浏览器」这条与那个无关 —— 两者绑在一起的话，
 *   少配一个环境变量就等于顺手打开了回显。
 */
export function maskEnvOverrides(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (value.startsWith(ENC_PREFIX) || value.startsWith(PLAIN_PREFIX)) return [key, KEPT_SECRET];
      if (value.startsWith(ENV_PREFIX)) return [key, `env:${value.slice(ENV_PREFIX.length)}`];
      return [key, value];
    }),
  );
}

/**
 * 派发前：引用 → 明文。
 *
 * ★ 解不开的键**不下发**，并单独列出来。
 *   悄悄下发一个空串的表现是 Agent 报一句 401，而现场没有任何东西
 *   指向「那把 key 所在的环境变量没设置」——「配置没生效而现场毫无迹象」
 *   是这个仓库反复吃过的亏。
 */
export function resolveEnvOverrides(env: Record<string, string>): {
  env: Record<string, string>;
  unresolved: string[];
} {
  const out: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (!value.startsWith('secret://')) {
      out[key] = value;
      continue;
    }
    const plain = resolveSecret(value);
    if (plain === null) unresolved.push(key);
    else out[key] = plain;
  }

  return { env: out, unresolved };
}

/** 这份环境变量表里有哪些引用现在取不到值，以及为什么 */
export function describeEnvOverrides(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, value]) => value.startsWith('secret://'))
    .map(([key, value]) => ({ key, ...describeRef(value) }))
    .filter((d) => !d.usable)
    .map((d) => `环境变量 ${d.key}：${d.problem ?? '凭证不可用'}`);
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
