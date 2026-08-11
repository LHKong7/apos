import { spawn } from 'node:child_process';
import type { WorkspaceCheckResult } from '@apos/contracts';

/**
 * 在工作区里跑质量核验命令。
 *
 * ★★ 这一步与铺料/交货后端**完全正交** —— 它只是「在一个本地目录里跑一条命令」。
 *   Git 工作树、空目录、将来从对象存储同步下来的目录，跑法一模一样。
 *   所以它属于流水线，不属于任何一个 Provider：放进 Provider 就意味着
 *   每加一个后端抄一遍，而抄错的那一份不会有人发现（核验失败与核验没跑
 *   在结果里长得很像）。
 *
 * ★ 命令来自仓库登记（管理员配置），与 CI 的信任模型一致。
 *   环境同样是最小集合 —— 核验脚本没有理由需要平台的数据库口令。
 */
export async function runCheck(
  cwd: string,
  command: string,
  timeoutSeconds: number,
): Promise<WorkspaceCheckResult> {
  const started = Date.now();

  return new Promise<WorkspaceCheckResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      /**
       * ★★ detached 让子进程自成一个进程组，这样超时才**杀得干净**。
       *
       *   `shell: true` 起的是一个 shell，测试框架（vitest/jest/pytest）
       *   还会在它下面再起一批 worker。不 detached 的话，超时时
       *   `child.kill()` 只杀得掉那个 shell —— worker 变成孤儿，
       *   继续跑到它们自己的上限。表现是「任务超时了，但机器负载居高不下」，
       *   而没有任何地方看得到那些进程属于哪次执行。
       */
      detached: true,
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], CI: 'true' },
    });

    const chunks: string[] = [];
    const collect = (b: Buffer) => {
      chunks.push(b.toString());
      // 只留尾部，测试输出可能有几十兆
      if (chunks.length > 200) chunks.splice(0, chunks.length - 200);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    /** 负 pid = 整个进程组。组不在了（已自然退出）会抛 ESRCH，忽略即可 */
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    let hardTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      // ★ 先 TERM 给测试框架一个写覆盖率/关连接的机会，5s 后再 KILL
      killTree('SIGTERM');
      hardTimer = setTimeout(() => killTree('SIGKILL'), 5_000);
      hardTimer.unref?.();
    }, timeoutSeconds * 1000);

    const done = (passed: boolean, extra = '') => {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({
        ran: true,
        passed,
        command,
        output: (chunks.join('') + extra).slice(-8000),
        durationMs: Date.now() - started,
      });
    };

    child.on('close', (code) => done(code === 0));
    child.on('error', (err) => done(false, `\n无法执行核验命令：${err.message}`));
  });
}
