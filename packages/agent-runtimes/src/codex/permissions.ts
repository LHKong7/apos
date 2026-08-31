import type { AgentPermissions } from '@apos/contracts';
import { baseToolName, WRITE_TOOLS } from '../claude-code/permissions';

/**
 * Codex 的沙箱等级。这是它权限模型的**全部粒度** ——
 * 没有「允许 Read 但禁止 Bash」这种说法。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface MappedSandbox {
  mode: SandboxMode;
  /** 是否允许联网 */
  network: boolean;
  /**
   * 平台授予了、但沙箱级别无法逐项表达的限制。
   *
   * ★ 这份清单是本适配器存在的最大价值：它把「我们以为限制住了」
   *   和「运行时真的限制住了」之间的差额算出来，交给页面显示。
   *   静默吞掉它，用户会以为 `deniedTools` 在 Codex 上也生效了。
   */
  unenforceable: { rule: string; why: string }[];
}

/**
 * APOS 权限 → Codex 沙箱。
 *
 * 映射方向刻意是**收紧**的：拿不准就降一级。
 * 沙箱模式选错的后果不对称 —— 选严了任务失败（看得见、可修），
 * 选松了 Agent 拿到了不该有的能力（看不见、修不回来）。
 *
 * `workspaceWritable` 是平台已备好的工作区给出的答案（`RunWorkspace.writable`），
 * 给了就以它为准 —— 规划 Run 的 scratch 目录没有任何资源范围对应它，
 * 光靠 scope 推导永远推不出「可写」。没给（没有工作区）才回落到 scope 推导。
 *
 * When the platform has already prepared a workspace it decides writability:
 * planning scratch dirs have no matching scope, so scope inference alone can
 * never call them writable. Scope inference remains the fallback.
 */
export function mapSandbox(
  permissions: AgentPermissions,
  workspaceWritable?: boolean,
): MappedSandbox {
  const allowed = new Set(permissions.allowedTools.map(baseToolName));
  const deniedBare = new Set(
    permissions.deniedTools.filter((r) => !r.includes('(')).map(baseToolName),
  );
  const scopedDenies = permissions.deniedTools.filter((r) => r.includes('('));

  // ★ 与 claude-code 的 mapPermissions 同一条规则：repo 与 dataset 的 write 都算。
  //   两个运行时给出不同答案的话，「换个运行时就能写了」会被当成玄学。
  // Same rule as claude-code's mapPermissions — a write scope on a repo or a
  // dataset counts. Divergence here reads as "it works on the other runtime".
  const scopeWritable = permissions.resourceScopes.some(
    (s) => s.access === 'write' && (s.kind === 'repo' || s.kind === 'dataset'),
  );
  const effectiveWritable = workspaceWritable ?? scopeWritable;
  const wantsWrite = WRITE_TOOLS.some((t) => allowed.has(t) && !deniedBare.has(t));

  const mode: SandboxMode = effectiveWritable && wantsWrite ? 'workspace-write' : 'read-only';

  // 只有显式授予了联网类工具才开网；默认关闭
  const network = ['WebFetch', 'WebSearch'].some((t) => allowed.has(t) && !deniedBare.has(t));

  const unenforceable: MappedSandbox['unenforceable'] = [];

  /**
   * ★ 关键差异点。
   *
   *   Claude Code 能做到「Bash 可用但 rm 不可用」，因为它按工具调用逐次问。
   *   Codex 在 workspace-write 下，命令执行是沙箱内自由的 —— 带参数的黑名单
   *   （`Bash(rm *)`）根本没有落点。
   */
  /**
   * ★ The reason must not name a runtime. This mapper is shared: cli/adapter.ts
   *   reuses it for all six headless CLIs, so a hardcoded "Codex" made an
   *   OpenCode run's audit note read `⚠ OpenCode … / - Bash(git push:*)：Codex
   *   的权限粒度是沙箱级 …` — two different runtimes named two lines apart, in
   *   the one record an auditor uses to reconstruct what actually ran. Both
   *   callers already name the runtime on the heading line above this list.
   *
   *   这句话里不能出现运行时名字。mapSandbox 是共用的 —— cli/adapter.ts 把它
   *   用在全部六个 headless CLI 上，写死「Codex」的结果是 OpenCode 的审计
   *   记录里，相隔两行出现了两个运行时的名字。而两个调用方都已经在上面那行
   *   标题里写明了是谁。
   */
  for (const rule of scopedDenies) {
    unenforceable.push({
      rule,
      why: '沙箱级权限无法按命令参数拦截；该规则在此运行时不生效',
    });
  }

  for (const tool of deniedBare) {
    // 写类工具的禁止能通过降到 read-only 表达，其余表达不了
    if ((WRITE_TOOLS as readonly string[]).includes(tool)) continue;
    if (tool === 'WebFetch' || tool === 'WebSearch') continue; // 由 network 开关表达
    if (mode === 'read-only') continue; // 只读模式下本来就做不了什么
    unenforceable.push({
      rule: tool,
      why: `沙箱模式无法单独禁用 ${tool}，该工具在 workspace-write 下仍可能被使用`,
    });
  }

  return { mode, network, unenforceable };
}
