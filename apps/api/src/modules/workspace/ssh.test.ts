import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  inspectKnownHosts,
  inspectPrivateKey,
  probeSsh,
  sshCommand,
  SshError,
  withSshAgent,
} from './ssh';

const exec = promisify(execFile);

/**
 * SSH 认证。
 *
 * ★★ 这一层的失败都是**沉默**的：带密码的私钥会挂在那里等人输密码，
 *   `StrictHostKeyChecking=no` 会让中间人攻击完全看不出来。
 *   两者都不会有人在日志里发现，所以只能钉在测试里。
 */

// ── 私钥形态 ──────────────────────────────────────────────────────────

describe('inspectPrivateKey', () => {
  it('不是私钥的东西直接认出来', () => {
    const r = inspectPrivateKey('ghp_0123456789abcdef');
    expect(r.looksLikeKey).toBe(false);
    expect(r.problem).toContain('BEGIN');
  });

  /**
   * ★★ 带密码的私钥必须在**保存那一刻**被拒。
   *
   *   放它进库的话，失败会推迟到第一次派发 —— 而且不是报错，是
   *   ssh-add 挂在那里等密码。表现成「任务一直在执行中」，
   *   这比一个失败的派发难查得多。
   */
  it('★ 老式 PEM 的加密标记认得出来', () => {
    const legacy = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF',
      '',
      'AAAA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const r = inspectPrivateKey(legacy);
    expect(r.looksLikeKey).toBe(true);
    expect(r.encrypted).toBe(true);
    expect(r.keyType).toBe('rsa');
    expect(r.problem).toContain('密码短语');
  });

  /**
   * ★ PKCS#8 的加密形态把标记写在 BEGIN 那一行，既没有 Proc-Type
   *   也不是 openssh-key-v1 —— 前两条判据都落空，会被判成「没加密」。
   *   openssl genpkey 出来的就是这个样子，不是罕见形态。
   */
  it('★ PKCS#8 的 ENCRYPTED 头也算加密', () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: {
        format: 'pem',
        type: 'pkcs8',
        cipher: 'aes-256-cbc',
        passphrase: 'hunter2',
      },
    });

    const r = inspectPrivateKey(privateKey);
    expect(r.encrypted).toBe(true);
    expect(r.problem).toContain('密码短语');
    // ENCRYPTED 是状态不是算法，不该被当成密钥类型报出来
    expect(r.keyType).toBeNull();
  });

  it('未加密的 PKCS#8 私钥放行', () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    });

    expect(inspectPrivateKey(privateKey)).toMatchObject({
      looksLikeKey: true,
      encrypted: false,
      problem: null,
    });
  });
});

describe('inspectKnownHosts', () => {
  it('空内容不是错误 —— 那只是还没固定', () => {
    expect(inspectKnownHosts('')).toEqual({ problem: null, hosts: [] });
    expect(inspectKnownHosts('  \n\n ')).toEqual({ problem: null, hosts: [] });
  });

  it('正常的 known_hosts 解析出主机名，注释和空行跳过', () => {
    const text = [
      '# github.com:22 SSH-2.0-babeld',
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
      '',
      '[git.acme.com]:2222 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ',
    ].join('\n');

    expect(inspectKnownHosts(text)).toEqual({
      problem: null,
      hosts: ['github.com', '[git.acme.com]:2222'],
    });
  });

  /**
   * ★★ 这两条是这个函数存在的全部理由 —— 它们都是**形近**错误：
   *   贴错了但看起来对，而后果一个是连不上、一个是私钥明文进了不加密的列。
   */
  it('★ 贴成 .pub 公钥（算法名开头）要说清楚差在哪', () => {
    const r = inspectKnownHosts('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq me@laptop');
    expect(r.problem).toContain('ssh-keyscan');
    expect(r.hosts).toEqual([]);
  });

  it('★ 把私钥贴进这一栏要拦下来 —— 这一列不加密', () => {
    const r = inspectKnownHosts('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END');
    expect(r.problem).toContain('不是私钥');
  });

  it('字段不够 / 第二段不是算法名都拒', () => {
    expect(inspectKnownHosts('github.com ssh-ed25519').problem).toContain('第 1 行');
    expect(inspectKnownHosts('github.com hello AAAA').problem).toContain('不是算法名');
  });

  it('哈希过的主机名如实说明取不回原文', () => {
    const r = inspectKnownHosts('|1|abc=|def= ssh-ed25519 AAAAC3Nza');
    expect(r).toEqual({ problem: null, hosts: ['（已哈希的主机名）'] });
  });

  it('@cert-authority 这类标记行的主机名在第二段', () => {
    const r = inspectKnownHosts('@cert-authority *.acme.com ssh-rsa AAAAB3Nza');
    expect(r).toEqual({ problem: null, hosts: ['*.acme.com'] });
  });
});

// ── ssh 命令行 ────────────────────────────────────────────────────────

describe('sshCommand', () => {
  const session = {
    authSock: '/tmp/x/agent.sock',
    knownHostsFile: '/tmp/x/known_hosts',
    readKnownHosts: async () => '',
  };

  /**
   * ★★ `StrictHostKeyChecking=no` 会连主机公钥换了都照连 —— 那正是
   *   中间人攻击的样子，而且事后无从发现。这一条钉死：任何时候都不能出现。
   */
  it('★ 绝不使用 StrictHostKeyChecking=no', () => {
    expect(sshCommand(session, true)).not.toContain('StrictHostKeyChecking=no');
    expect(sshCommand(session, false)).not.toContain('StrictHostKeyChecking=no');
  });

  it('固定过的主机严格校验，没固定过才 accept-new', () => {
    expect(sshCommand(session, true)).toContain('StrictHostKeyChecking=yes');
    expect(sshCommand(session, false)).toContain('StrictHostKeyChecking=accept-new');
  });

  it('BatchMode 与 known_hosts 都在', () => {
    const cmd = sshCommand(session, true);
    expect(cmd).toContain('BatchMode=yes');
    expect(cmd).toContain(`UserKnownHostsFile="${session.knownHostsFile}"`);
  });

  /**
   * ★★ 用 IdentityAgent + IdentityFile=none 来做到「只用我们那把 key」，
   *   **不能**用 IdentitiesOnly=yes。
   *
   *   IdentitiesOnly 只认身份**文件**，会把 agent 提供的身份排除掉；
   *   而我们的 key 只在 agent 里。它的失败长成
   *   `Permission denied (publickey)` —— 看起来像仓库没授权，
   *   实际上 key 根本没被拿出来试过。这条 bug 上线过一次，钉死。
   */
  it('★ 不能出现 IdentitiesOnly —— 它会把 agent 里的 key 排除掉', () => {
    expect(sshCommand(session, true)).not.toContain('IdentitiesOnly');
  });

  it('钉死用哪个 agent，并去掉宿主机的默认身份文件', () => {
    const cmd = sshCommand(session, true);
    expect(cmd).toContain(`IdentityAgent="${session.authSock}"`);
    expect(cmd).toContain('IdentityFile=none');
  });
});

// ── ssh-agent 生命周期（需要 openssh-client） ─────────────────────────

const sshEnv = await probeSsh();
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** 现生成一把 key —— 仓库里放一把真私钥是绝对不行的，哪怕是测试用的 */
async function generateKey(passphrase: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'apos-sshtest-'));
  dirs.push(dir);
  const path = join(dir, 'id_ed25519');
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'apos-test', '-f', path]);
  return readFile(path, 'utf8');
}

describe.skipIf(!sshEnv.ok)('withSshAgent', () => {
  it('★ 私钥不落盘：临时目录里只有 socket 和 known_hosts', async () => {
    const key = await generateKey('');
    const { readdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');

    const entries = await withSshAgent({ privateKey: key, knownHosts: null }, (s) =>
      readdir(dirname(s.authSock)),
    );

    expect(entries.sort()).toEqual(['agent.sock', 'known_hosts']);
  });

  it('传进去的 known_hosts 原样落在会话文件里', async () => {
    const key = await generateKey('');
    const pinned = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq';

    const content = await withSshAgent({ privateKey: key, knownHosts: pinned }, (s) =>
      s.readKnownHosts(),
    );

    expect(content.trim()).toBe(pinned);
  });

  it('★ 带密码的私钥当场失败，而不是挂在那里等输入', async () => {
    const key = await generateKey('hunter2');

    const err = await withSshAgent({ privateKey: key, knownHosts: null }, async () => 'ok').catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).hint).toContain('密码短语');
  }, 15_000);

  it('真实生成的 ed25519 私钥认得出算法，且不是加密的', async () => {
    expect(inspectPrivateKey(await generateKey(''))).toEqual({
      looksLikeKey: true,
      keyType: 'ed25519',
      encrypted: false,
      problem: null,
    });
  });

  it('★ ssh-keygen 加了密码的 key 也认得出来（新格式的标记藏在 base64 里）', async () => {
    const r = inspectPrivateKey(await generateKey('hunter2'));
    expect(r.looksLikeKey).toBe(true);
    expect(r.encrypted).toBe(true);
    expect(r.problem).toContain('密码短语');
  });

  /**
   * ★★ agent 握着私钥，漏掉一次 kill 的表现是「一个握着私钥的进程
   *   永远留在那里」—— 没有任何报错，只有内存里多一份私钥。
   *   所以回调抛异常这条路径也必须收干净。
   */
  it('★ 回调抛异常时 agent 一样被收掉，临时目录也删掉', async () => {
    const key = await generateKey('');
    let sock = '';

    const err = await withSshAgent({ privateKey: key, knownHosts: null }, async (s) => {
      sock = s.authSock;
      throw new Error('boom');
    }).catch((e: unknown) => e);

    /**
     * ★ 回调的异常必须**原样**传上去。包成 SshError 的话，
     *   调用方就没法把「这把 key 有问题」和「连上了但远端拒了」分开 ——
     *   而配置页要据此指向不同的输入框。
     */
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SshError);
    expect((err as Error).message).toBe('boom');

    const { stat } = await import('node:fs/promises');
    await expect(stat(sock)).rejects.toThrow();
  });

  it('key 确实进了 agent —— ssh-add -l 能列出来', async () => {
    const key = await generateKey('');

    const listed = await withSshAgent({ privateKey: key, knownHosts: null }, async (s) => {
      const { stdout } = await exec('ssh-add', ['-l'], {
        env: { PATH: process.env['PATH'], SSH_AUTH_SOCK: s.authSock },
      });
      return stdout;
    });

    expect(listed).toContain('apos-test');
  });
});
