import { agentRuntimes, type Database } from '@apos/db';
import {
  ClaudeCodeRuntime,
  MockRuntime,
  type AgentRuntimeAdapter,
  type RuntimeRegistry,
} from '@apos/agent-runtimes';
import { CodexRuntime } from '@apos/agent-runtimes';
import { resolveSecret } from '../security/secrets';

export type RuntimeRow = typeof agentRuntimes.$inferSelect;

/** 支持的运行时类型 —— 页面上的下拉选项与这份清单同源 */
export const RUNTIME_KINDS = [
  {
    kind: 'claude_code',
    label: 'Claude Code',
    description: '基于 Claude Agent SDK，工具级权限、实时事件流、执行中可注入约束',
    needsCredential: true,
    credentialLabel: 'Anthropic API Key',
    needsEndpoint: false,
  },
  {
    kind: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex CLI，沙箱级权限（非工具级），事件粒度较粗',
    needsCredential: true,
    credentialLabel: 'OpenAI API Key',
    needsEndpoint: false,
  },
  {
    kind: 'mock',
    label: '内存运行时（演示 / 测试）',
    description: '不调用任何外部模型，按脚本产生事件。用于演练流程与验证降级路径',
    needsCredential: false,
    credentialLabel: null,
    needsEndpoint: false,
  },
] as const;

export type RuntimeKind = (typeof RUNTIME_KINDS)[number]['kind'];

export function isKnownKind(kind: string): kind is RuntimeKind {
  return RUNTIME_KINDS.some((k) => k.kind === kind);
}

export interface FactoryOptions {
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

/**
 * 数据库行 → 适配器实例。
 *
 * ★ 凭证在这里从 credentialRef 解出来，直接交给适配器实例持有，
 *   不落任何中间变量、不进日志。解不出来时**不**回退到进程环境的
 *   ANTHROPIC_API_KEY —— 那会让「我明明配了 key」和「它在用别人的 key」
 *   这两种情况长得一模一样。
 */
export function createRuntimeAdapter(
  row: RuntimeRow,
  opts: FactoryOptions = {},
): AgentRuntimeAdapter | null {
  const diagnose = opts.onDiagnostic ?? (() => {});
  const apiKey = resolveSecret(row.credentialRef) ?? undefined;

  switch (row.kind) {
    case 'mock':
      return new MockRuntime();

    case 'claude_code':
      return new ClaudeCodeRuntime({
        apiKey,
        // 没登记凭证时才允许沿用进程环境（单机部署的常见形态）
        allowInheritedCredentials: row.credentialRef === null,
        onDiagnostic: (message, detail) => diagnose(`[claude-code:${row.name}] ${message}`, detail),
      });

    case 'codex':
      return new CodexRuntime({
        apiKey,
        allowInheritedCredentials: row.credentialRef === null,
        ...(row.endpoint ? { baseUrl: row.endpoint } : {}),
        onDiagnostic: (message, detail) => diagnose(`[codex:${row.name}] ${message}`, detail),
      });

    default:
      return null;
  }
}

/**
 * 把库里的运行时登记进注册表。只处理还没注册过的行，可反复调用。
 *
 * ★ 为什么要能反复调用：注册表原本只在启动时建一次，于是任何在进程起来
 *   之后新增的运行时都是隐形的 —— 界面显示「适配器没有在当前进程注册」，
 *   任务派不出去，而这句话不会告诉你该去重启谁。
 *
 * ★ 只增不减：这里不注销已经消失的运行时行。正在跑的 Run 还握着那个适配器，
 *   把它摘掉等于中断一次执行，代价不对等。
 */
export async function syncRuntimes(
  db: Database,
  registry: RuntimeRegistry,
  opts: FactoryOptions = {},
): Promise<{ added: number; skipped: string[] }> {
  const rows = await db.select().from(agentRuntimes);
  let added = 0;
  const skipped: string[] = [];

  for (const row of rows) {
    if (registry.has(row.id)) continue;

    const adapter = createRuntimeAdapter(row, opts);
    if (!adapter) {
      skipped.push(`${row.name}（未知类型 ${row.kind}）`);
      continue;
    }
    registry.register(row.id, adapter);
    added++;
  }

  return { added, skipped };
}

/** 新建 / 改配置后立刻生效，不等下一轮同步 */
export function registerNow(
  registry: RuntimeRegistry,
  row: RuntimeRow,
  opts: FactoryOptions = {},
): boolean {
  const adapter = createRuntimeAdapter(row, opts);
  if (!adapter) return false;
  registry.register(row.id, adapter);
  return true;
}
