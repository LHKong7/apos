import { agents, type Database } from '@apos/db';
import {
  defaultRuntimeConfig,
  isKnownRuntimeKind,
  RUNTIME_KIND_SPECS,
  runtimeKindSpec,
} from '@apos/contracts';
import {
  ClaudeCodeRuntime,
  CodexRuntime,
  GenericCliRuntime,
  MockRuntime,
  cliProfile,
  type AgentRuntimeAdapter,
  type RuntimeRegistry,
} from '@apos/agent-runtimes';
import { resolveSecret } from '../security/secrets';

export type AgentRow = typeof agents.$inferSelect;

export { RUNTIME_KIND_SPECS, isKnownRuntimeKind, runtimeKindSpec };

export interface FactoryOptions {
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

/**
 * Agent 行 → 适配器实例。
 *
 * ★ 注册表按 **agentId** 键控，不是按运行时。
 *
 *   这是「取消接入层」的直接后果，也是它的意义所在：两个 Agent 都用
 *   Claude Code，但一个 effort=max / maxTurns=120，另一个 effort=low /
 *   maxTurns=20 —— 它们必须是两个**不同的适配器实例**。按运行时键控的话，
 *   后注册的会覆盖先注册的，而症状是「我明明给评审 Agent 配了 low，
 *   账单却按 max 在走」，且完全无法从日志上看出来。
 *
 * ★ 凭证在这里从 credentialRef 解出来直接交给实例，不落中间变量、不进日志。
 *   解不出来时**不**回退到进程环境的默认 key —— 那会让「我明明配了 key」
 *   和「它在用别人的 key」这两种情况长得一模一样。
 */
export function createAgentAdapter(
  agent: AgentRow,
  opts: FactoryOptions = {},
): AgentRuntimeAdapter | null {
  const diagnose = opts.onDiagnostic ?? (() => {});
  const tag = `[${agent.runtimeKind}:${agent.name}]`;
  const apiKey = resolveSecret(agent.credentialRef) ?? undefined;

  // 空配置 = 全部用平台默认值。适配器侧因此永远拿到完整配置，
  // 不用到处写 `?? 默认值` —— 那种散落的默认值迟早和 schema 对不上
  const cfg = { ...defaultRuntimeConfig(agent.runtimeKind), ...agent.runtimeConfig };
  const str = (k: string) => (typeof cfg[k] === 'string' ? (cfg[k] as string) : undefined);
  const num = (k: string) => (typeof cfg[k] === 'number' ? (cfg[k] as number) : undefined);
  const list = (k: string) => (Array.isArray(cfg[k]) ? (cfg[k] as string[]) : undefined);

  switch (agent.runtimeKind) {
    case 'mock':
      return new MockRuntime(
        {},
        {
          outcome: str('outcome') === 'failed' ? 'failed' : 'completed',
          stepDelayMs: num('stepDelayMs') ?? 300,
        },
      );

    case 'claude_code':
      return new ClaudeCodeRuntime({
        apiKey,
        // 没登记凭证时才允许沿用进程环境（单机部署的常见形态）
        allowInheritedCredentials: agent.credentialRef === null,
        ...(str('model') ? { model: str('model')! } : {}),
        ...(str('effort') ? { effort: str('effort') as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
        ...(num('maxTurns') !== undefined ? { maxTurns: num('maxTurns')! } : {}),
        ...(str('onUngrantedTool')
          ? { onUngrantedTool: str('onUngrantedTool') as 'escalate' | 'deny' }
          : {}),
        ...(list('passthroughEnv') ? { passthroughEnv: list('passthroughEnv')! } : {}),
        onDiagnostic: (message, detail) => diagnose(`${tag} ${message}`, detail),
      });

    case 'codex':
      return new CodexRuntime({
        apiKey,
        allowInheritedCredentials: agent.credentialRef === null,
        ...(agent.endpoint ? { baseUrl: agent.endpoint } : {}),
        ...(str('model') ? { model: str('model')! } : {}),
        ...(str('binary') ? { binary: str('binary')! } : {}),
        ...(str('approvalPolicy') ? { approvalPolicy: str('approvalPolicy')! } : {}),
        ...(list('passthroughEnv') ? { passthroughEnv: list('passthroughEnv')! } : {}),
        onDiagnostic: (message, detail) => diagnose(`${tag} ${message}`, detail),
      });

    /**
     * ★★ 六个通用 headless CLI（pi / gemini_cli / aider / goose / opencode /
     *   qwen_code）走同一条分支：差异全在 profile 那张声明式的表里，
     *   这里只负责把 Agent 行上的配置搬过去。
     *
     *   加第七个 CLI = 加一条 profile + 加一条 spec，这个文件一个字不用改。
     */
    default: {
      const profile = cliProfile(agent.runtimeKind);
      if (!profile) return null;
      return new GenericCliRuntime(profile, {
        apiKey,
        // 没登记凭证时才允许沿用进程环境（单机部署的常见形态）
        allowInheritedCredentials: agent.credentialRef === null,
        ...(agent.endpoint ? { baseUrl: agent.endpoint } : {}),
        ...(str('model') ? { model: str('model')! } : {}),
        ...(str('binary') ? { binary: str('binary')! } : {}),
        ...(list('extraArgs') ? { extraArgs: list('extraArgs')! } : {}),
        ...(list('passthroughEnv') ? { passthroughEnv: list('passthroughEnv')! } : {}),
        onDiagnostic: (message, detail) => diagnose(`${tag} ${message}`, detail),
      });
    }
  }
}

/**
 * 把库里的 Agent 登记进注册表。只处理还没注册过的，可反复调用。
 *
 * ★ 为什么要能反复调用：注册表原本只在启动时建一次，于是任何在进程起来
 *   之后新增的 Agent 都是隐形的 —— 界面显示「适配器没有在当前进程注册」，
 *   任务派不出去，而这句话不会告诉你该去重启谁。
 *
 * ★ 只增不减：不注销已经消失的 Agent。正在跑的 Run 还握着那个适配器，
 *   把它摘掉等于中断一次执行，代价不对等。
 */
export async function syncAgents(
  db: Database,
  registry: RuntimeRegistry,
  opts: FactoryOptions = {},
): Promise<{ added: number; skipped: string[] }> {
  const rows = await db.select().from(agents);
  let added = 0;
  const skipped: string[] = [];

  for (const agent of rows) {
    if (registry.has(agent.id)) continue;

    const adapter = createAgentAdapter(agent, opts);
    if (!adapter) {
      skipped.push(`${agent.name}（未知运行时类型 ${agent.runtimeKind}）`);
      continue;
    }
    registry.register(agent.id, adapter);
    added++;
  }

  return { added, skipped };
}

/**
 * 新建 / 改配置后立刻生效，不等下一轮同步。
 *
 * ★ 改配置时必须**替换**实例而不是跳过：老实例里还捏着旧的 effort、
 *   旧的凭证。不换掉的话，界面上改完显示为已生效，实际下一次派发仍是旧值。
 */
export function registerAgentNow(
  registry: RuntimeRegistry,
  agent: AgentRow,
  opts: FactoryOptions = {},
): boolean {
  const adapter = createAgentAdapter(agent, opts);
  if (!adapter) return false;
  registry.register(agent.id, adapter);
  return true;
}
