import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * 口令散列 —— scrypt，参数与盐一起写进字符串。
 *
 * ★★ 自描述格式（`scrypt$N$r$p$salt$hash`）不是为了好看：散列参数
 *   迟早要调（机器变快、被攻破的成本下降）。参数写死在代码里的话，
 *   调参那天全库的口令一次性作废 —— 因为没人知道旧的那批是用什么
 *   参数算的。把参数存在每条记录里，新旧可以共存，改参数只影响新口令。
 *
 * ★ 用 scrypt 而不是引一个 bcrypt/argon2 依赖：它在 node:crypto 里，
 *   是内存硬的，且这个仓库的加密（modules/security/secrets.ts 的 AES-GCM）
 *   本来就直接用 node:crypto。多一个原生依赖要多一份编译产物。
 */

/**
 * ★ 自己包一层而不是 `promisify(scrypt)`：promisify 的类型定义挑中的是
 *   不带 options 的那个重载，于是传参数（N/r/p/maxmem）就编译不过。
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** OWASP 2024 对 scrypt 的最低建议是 N=2^17 / r=8 / p=1 */
const N = 1 << 17;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/**
 * ★ scrypt 的内存用量是 128·N·r 字节 ≈ 128MB（N=2^17, r=8）。
 *   Node 默认的 maxmem 是 32MB，超了直接抛 `Invalid scrypt params` ——
 *   而那个错会出现在登录路径上，表现为「所有人都登不进去」。
 */
const MAXMEM = 256 * 1024 * 1024;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/** 口令下限。只挡最离谱的那一档，不做「必须含大写和符号」那种规则 —— 那类规则挡不住字典攻击，只会逼出 Passw0rd! */
const MIN_LENGTH = 8;

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_LENGTH) {
    throw new WeakPasswordError(`口令至少 ${MIN_LENGTH} 位`);
  }
  if (password.length > 200) {
    throw new WeakPasswordError('口令过长（上限 200 位）');
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/**
 * 校验。任何一种「不对」都返回 false，不抛异常也不区分原因。
 *
 * ★★ 调用方**必须**把「这个账号没有口令」「邮箱不存在」「口令错」
 *   三件事回成同一句话。区分开来的每一种，都是一个「哪些邮箱是真账号」
 *   的枚举探针。
 *
 * ★ 比对走 timingSafeEqual。字符串 `===` 会在第一个不同的字节短路，
 *   逐字节的耗时差异足以把散列一位一位试出来。
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    // 参数在库里被改坏时 scrypt 会抛。这是「这条口令用不了」，不是服务故障
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
