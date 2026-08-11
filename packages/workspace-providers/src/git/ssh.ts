import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * SSH 认证。
 *
 * ★★ 私钥**不落盘**，走 ssh-agent。
 *
 *   OpenSSH 的 `ssh -i` 只接受文件路径，所以「把 key 写到临时文件」是
 *   最容易想到的做法。但这个平台上它不成立：
 *
 *   - 容器里同时跑着别的 Run 的 Agent，它们是同一个 OS 用户的进程。
 *     只要 key 在磁盘上，任何一个 Agent 的 Bash 工具都能 `cat` 到它。
 *     「Agent 跑之前写、跑完删」挡不住这一点 —— 并发的 Run 里，
 *     总有别人的 Agent 正在跑。
 *   - 这和 git.ts 里已经立下的两条规矩是同一条：token 不拼进 remote URL
 *     （`.git/config` 就在 Agent 的工作目录里），不用 credential helper
 *     （要落盘，清理时机难保证）。私钥比 token 更值钱，标准不该更低。
 *
 *   ssh-agent 这条路，key 只活在 agent 进程的内存里（`ssh-add -` 从 stdin 喂），
 *   我们只把 `SSH_AUTH_SOCK` 放进 **git 子进程**的环境 —— Agent 的运行时
 *   环境是另外构造的，拿不到这个变量。socket 本身在 0700 的临时目录里。
 *
 * ★ 代价是多一个进程要管。所以 agent 的生命周期严格包在 withSshAgent 里，
 *   `finally` 里 kill + 删目录；进程意外退出时 agent 是我们的子进程，
 *   会跟着一起走。
 */

export class SshError extends Error {
  constructor(
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'SshError';
  }
}

export interface SshSession {
  /** 只进 git 子进程的环境，绝不进 Agent 的 */
  authSock: string;
  knownHostsFile: string;
  /**
   * 本次连接结束后 known_hosts 的内容。
   * 首次连接（TOFU）后会多出这台主机的公钥，调用方据此固定下来。
   */
  readKnownHosts(): Promise<string>;
}

export interface SshAuthOptions {
  /** 私钥明文，只在内存里活到本次调用结束 */
  privateKey: string;
  /**
   * 已固定的主机公钥。为空表示还没学到 ——
   * 这时用 accept-new（TOFU），并把学到的内容回传给调用方固定。
   */
  knownHosts: string | null;
}

export async function withSshAgent<T>(
  opts: SshAuthOptions,
  fn: (session: SshSession) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'apos-ssh-'));
  const sock = join(dir, 'agent.sock');
  const knownHostsFile = join(dir, 'known_hosts');

  // 主机公钥不是秘密，落盘没问题 —— 它本来就是要公开比对的那一份
  await writeFile(knownHostsFile, opts.knownHosts ?? '', { mode: 0o600 });

  const agent = spawn('ssh-agent', ['-D', '-a', sock], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env['PATH'] },
  });

  let agentStderr = '';
  agent.stderr?.on('data', (b: Buffer) => {
    agentStderr += b.toString();
  });

  try {
    /**
     * ★ 只有**准备阶段**的失败才包成 SshError。
     *
     *   回调里抛出来的（多半是 GitError）原样往上传：调用方靠
     *   `instanceof SshError` 区分「这把 key 有问题」和「连上了但远端拒了」，
     *   一律包起来的话这个区分就没了 —— 而这两者的下一步动作完全不同。
     */
    try {
      await waitForSocket(agent, sock, agentStderr);
      await addKey(sock, opts.privateKey);
    } catch (err) {
      if (err instanceof SshError) throw err;
      throw new SshError(`SSH 认证准备失败：${(err as Error).message}`, agentStderr.trim() || null);
    }

    return await fn({
      authSock: sock,
      knownHostsFile,
      readKnownHosts: () => readFile(knownHostsFile, 'utf8').catch(() => ''),
    });
  } finally {
    agent.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** agent 起来之前 ssh-add 会连不上 socket，得等它 bind 好 */
async function waitForSocket(
  agent: ReturnType<typeof spawn>,
  sock: string,
  stderrSoFar: string,
): Promise<void> {
  const { stat } = await import('node:fs/promises');
  const deadline = Date.now() + 5000;

  for (;;) {
    if (agent.exitCode !== null) {
      throw new SshError(
        `ssh-agent 启动失败（退出码 ${agent.exitCode}）`,
        stderrSoFar.trim() || '部署环境可能没有安装 openssh-client',
      );
    }
    if (await stat(sock).then(() => true, () => false)) return;
    if (Date.now() > deadline) throw new SshError('ssh-agent 启动超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * 把私钥喂给 agent。
 *
 * ★ 从 stdin 喂（`ssh-add -`），不经过文件。
 *
 * ★ `SSH_ASKPASS_REQUIRE=never` + 不给 DISPLAY：带密码的私钥会**当场失败**
 *   而不是挂在那里等人输密码。一个卡住的派发比一个失败的派发难查得多 ——
 *   前者表现为「任务一直在执行中」，没有任何错误可看。
 */
async function addKey(sock: string, privateKey: string): Promise<void> {
  const child = spawn('ssh-add', ['-'], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: {
      PATH: process.env['PATH'],
      SSH_AUTH_SOCK: sock,
      SSH_ASKPASS_REQUIRE: 'never',
    },
  });

  let stderr = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderr += b.toString();
  });

  // 私钥文件通常以换行结尾，缺了的话 ssh-add 会报 invalid format
  child.stdin.end(privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`);

  const code = await new Promise<number>((resolve) => {
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });

  if (code !== 0) {
    const text = stderr.trim();
    throw new SshError(
      '私钥无法加载',
      /passphrase|Enter passphrase/i.test(text)
        ? '这把私钥带密码短语。平台不支持带密码的私钥（无人值守场景没法输入），请换一把不带密码的部署密钥'
        : text || '私钥格式不正确',
    );
  }
}

/** git 走 ssh 时的命令行。known_hosts 的严格程度取决于有没有固定过主机公钥 */
export function sshCommand(session: SshSession, pinned: boolean): string {
  const opts = [
    // 任何需要交互的分支（输密码、确认主机）都当场失败，不挂住
    '-o BatchMode=yes',
    /**
     * ★★ 「只用我们喂进去的那把 key」是这两条一起做到的，
     *   **不能**用 `IdentitiesOnly=yes`。
     *
     *   IdentitiesOnly 的语义是「只用配置/命令行里指定的身份**文件**」，
     *   它会把 agent 提供的身份一并排除掉 —— 而我们的 key 只存在于
     *   agent 里，没有对应文件。加上它的表现是
     *   `Permission denied (publickey)`：看起来像是仓库没授权，
     *   实际上 key 根本没被拿出来试。
     *
     *   正确的组合是：IdentityAgent 钉死用哪个 agent（宿主机继承来的
     *   SSH_AUTH_SOCK 因此不会插队），IdentityFile=none 去掉默认的
     *   ~/.ssh/id_* —— 不存在的身份文件会被静默跳过，所以老版本 ssh
     *   不认 none 时也只是退化成「多试一把宿主机的 key」，不会报错。
     */
    `-o IdentityAgent="${session.authSock}"`,
    '-o IdentityFile=none',
    `-o UserKnownHostsFile="${session.knownHostsFile}"`,
    /**
     * ★ 学到的主机名要**明文**记下来。
     *
     *   宿主机的 ssh_config 常常开着 HashKnownHosts（Ubuntu 的默认），
     *   那样固定进库的就是 `|1|…` —— 配置页上只能显示成
     *   「已哈希的主机名」，管理员没法拿它和 ssh-keyscan 的输出核对。
     *   哈希的意义是防止读到 known_hosts 的人枚举你连过哪些主机，
     *   而这份文件只服务一个仓库，主机名就在它的 remoteUrl 里写着。
     */
    '-o HashKnownHosts=no',
    /**
     * ★★ 固定过就必须严格校验；没固定过用 accept-new（TOFU），
     *   **绝不用 `no`**。
     *
     *   `StrictHostKeyChecking=no` 会连主机公钥变了都照连 —— 那正是
     *   中间人攻击的样子，而且事后无从发现。accept-new 只在第一次
     *   放行未知主机，之后变了就拒。第一次的风险由调用方消解：
     *   连上之后立刻把学到的公钥固定下来（见 credentials.ts）。
     */
    pinned ? '-o StrictHostKeyChecking=yes' : '-o StrictHostKeyChecking=accept-new',
  ];
  return `ssh ${opts.join(' ')}`;
}

/**
 * ssh 工具链可用性。
 *
 * ★ 和 probeGit 同一个理由：部署环境没装 openssh-client 要在**配置页上**
 *   说清楚，而不是等第一次派发才炸 —— 那时错误表现为「某个任务失败了」，
 *   没人会想到是镜像里少装了一个包。
 */
let sshProbe: Promise<{ ok: boolean; problem: string | null }> | null = null;

export async function probeSsh(): Promise<{ ok: boolean; problem: string | null }> {
  // ★ 只探一次。装没装 openssh-client 在进程存活期内不会变，
  //   而仓库列表每次打开都要用它 —— 一次三个进程，不该重复付
  sshProbe ??= runSshProbe();
  return sshProbe;
}

async function runSshProbe(): Promise<{ ok: boolean; problem: string | null }> {
  for (const bin of ['ssh', 'ssh-agent', 'ssh-add']) {
    try {
      // -V / -h 各家返回码不一，能起来不报 ENOENT 就算有
      await exec(bin, bin === 'ssh' ? ['-V'] : ['-h'], { timeout: 5000 }).catch((e: unknown) => {
        if ((e as { code?: string }).code === 'ENOENT') throw e;
      });
    } catch {
      return {
        ok: false,
        problem: `未找到 ${bin}：SSH 形态的 git 地址无法使用。部署镜像需要 openssh-client`,
      };
    }
  }
  return { ok: true, problem: null };
}

// ── 私钥的形态检查 ────────────────────────────────────────────────────

export interface KeyInspection {
  looksLikeKey: boolean;
  /** ed25519 / rsa / ecdsa…；认不出为 null */
  keyType: string | null;
  encrypted: boolean;
  problem: string | null;
}

const PEM_RE = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----([\s\S]*?)-----END /;

/**
 * 登记时就看一眼这把 key。
 *
 * ★★ 带密码的私钥要在**保存那一刻**拒掉，不能等派发。
 *
 *   无人值守场景没法输入密码短语，所以它注定用不了。而如果放它进库，
 *   失败会发生在第一次派发时，表现是一条「准备工作区失败」——
 *   而管理员会以为是权限或网络问题，因为他保存的时候什么都没说。
 */
export function inspectPrivateKey(text: string): KeyInspection {
  const trimmed = text.trim();
  const m = PEM_RE.exec(trimmed);

  if (!m) {
    return {
      looksLikeKey: false,
      keyType: null,
      encrypted: false,
      problem: '这不像一把私钥（应以 -----BEGIN … PRIVATE KEY----- 开头）',
    };
  }

  /**
   * 加密标记在头部的两种老形态：
   *   老式 PEM  → `Proc-Type: 4,ENCRYPTED` 这一行
   *   PKCS#8    → BEGIN 那一行就写着 ENCRYPTED（openssl genpkey 的产物）
   */
  if (/Proc-Type:\s*4,ENCRYPTED/i.test(trimmed) || /ENCRYPTED/.test(m[1] ?? '')) {
    return {
      looksLikeKey: true,
      keyType: legacyType(m[1] ?? ''),
      encrypted: true,
      problem: ENCRYPTED_HINT,
    };
  }

  const body = Buffer.from((m[2] ?? '').replace(/\s+/g, ''), 'base64');

  /**
   * OpenSSH 新格式：`openssh-key-v1\0` 之后紧跟长度前缀的 ciphername。
   * 不是 "none" 就是加密过的 —— 这在头部看不出来，只能解出来看。
   */
  if (body.subarray(0, 14).toString('latin1') === 'openssh-key-v1') {
    const cipherLen = body.readUInt32BE(15);
    const cipher = body.subarray(19, 19 + cipherLen).toString('latin1');
    const encrypted = cipher !== 'none';
    return {
      looksLikeKey: true,
      keyType: opensshKeyType(body),
      encrypted,
      problem: encrypted ? ENCRYPTED_HINT : null,
    };
  }

  return { looksLikeKey: true, keyType: legacyType(m[1] ?? ''), encrypted: false, problem: null };
}

const ENCRYPTED_HINT =
  '这把私钥带密码短语。平台不支持带密码的私钥（无人值守场景没法输入），请换一把不带密码的部署密钥';

// ── 主机公钥的形态检查 ────────────────────────────────────────────────

export interface KnownHostsInspection {
  problem: string | null;
  /** 固定了哪几台主机 —— 配置页要显示出来，否则没人知道这段文本管的是谁 */
  hosts: string[];
}

const KEY_ALGO_RE = /^(ssh-[a-z0-9]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/i;

/**
 * 检查手填的 known_hosts。
 *
 * ★ 这里挡的是两个几乎人人都会踩的形近错误：
 *   把 `id_ed25519.pub`（`算法 公钥 注释`）当成 known_hosts（`主机 算法 公钥`），
 *   以及把**私钥**填进这个框。前者的表现是连接时「主机公钥不匹配」，
 *   后者是把私钥明文存进了一个不加密的列 —— 后果严重且完全无声。
 */
export function inspectKnownHosts(text: string): KnownHostsInspection {
  const trimmed = text.trim();
  if (trimmed === '') return { problem: null, hosts: [] };

  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(trimmed)) {
    return {
      problem:
        '这里要填的是**主机公钥**（公开信息，可用 ssh-keyscan 生成），不是私钥。' +
        '私钥请填在凭证一栏 —— 那一栏会加密保存，这一栏不会',
      hosts: [],
    };
  }

  const hosts: string[] = [];

  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;

    const fields = line.split(/\s+/);
    const at = `第 ${i + 1} 行`;

    if (KEY_ALGO_RE.test(fields[0] ?? '')) {
      return {
        problem:
          `${at}以算法名开头，这是 .pub 公钥的格式。known_hosts 每行是「主机 算法 公钥」，` +
          '可以用 `ssh-keyscan github.com` 之类的命令生成',
        hosts: [],
      };
    }

    // @cert-authority / @revoked 这类标记开头的行，主机名在第二段
    const marked = (fields[0] ?? '').startsWith('@');
    const [host, algo] = marked ? [fields[1], fields[2]] : [fields[0], fields[1]];

    if (fields.length < (marked ? 4 : 3) || !host || !algo) {
      return { problem: `${at}不是 known_hosts 格式（应为「主机 算法 公钥」）`, hosts: [] };
    }
    if (!KEY_ALGO_RE.test(algo)) {
      return { problem: `${at}的第二段「${algo}」不是算法名（如 ssh-ed25519）`, hosts: [] };
    }

    // |1|… 是哈希过的主机名，原文取不回来，如实说明
    hosts.push(host.startsWith('|1|') ? '（已哈希的主机名）' : host);
  }

  return { problem: null, hosts: [...new Set(hosts)] };
}

function legacyType(prefix: string): string | null {
  // ENCRYPTED 是状态不是算法（PKCS#8 的头部就长这样），别把它当成密钥类型报出去
  const p = prefix.trim().toLowerCase().replace(/\bencrypted\b/g, '').trim();
  return p === '' ? null : p;
}

/** 公钥 blob 里的算法名，如 ssh-ed25519 */
function opensshKeyType(body: Buffer): string | null {
  const m = /(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com)/.exec(
    body.toString('latin1'),
  );
  return m ? m[1]!.replace(/^ssh-/, '') : null;
}
