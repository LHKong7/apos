import { agents, type Database } from '@apos/db';
import {
  defaultRuntimeConfig,
  envOverridesOf,
  isKnownRuntimeKind,
  isProtectedEnvKey,
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
import { resolveEnvOverrides, resolveSecret } from '../security/secrets';

export type AgentRow = typeof agents.$inferSelect;

export { RUNTIME_KIND_SPECS, isKnownRuntimeKind, runtimeKindSpec };

export interface FactoryOptions {
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

/**
 * Agent row → adapter instance / Agent 行 → 适配器实例。
 *
 * ★ The registry is keyed by **agentId**, not by runtime kind.
 *
 *   That is the direct consequence of removing the shared access layer, and
 *   also the point of it: two Agents can both run Claude Code while one is
 *   effort=max / maxTurns=120 and the other effort=low / maxTurns=20 — they
 *   have to be two **different adapter instances**. Keyed by runtime, the
 *   second registration overwrites the first, and the symptom is "I configured
 *   the review Agent as low but the bill is running at max", with nothing in
 *   the logs to show it.
 *
 * ★ The credential is resolved from credentialRef here and handed straight to
 *   the instance: no intermediate variable, never logged. When it cannot be
 *   resolved we do **not** fall back to the process environment's default key —
 *   that would make "I did configure a key" and "it is using somebody else's
 *   key" look exactly alike.
 */
export function createAgentAdapter(
  agent: AgentRow,
  opts: FactoryOptions = {},
): AgentRuntimeAdapter | null {
  const diagnose = opts.onDiagnostic ?? (() => {});
  const tag = `[${agent.runtimeKind}:${agent.name}]`;
  const apiKey = resolveSecret(agent.credentialRef) ?? undefined;

  // An empty config means every platform default applies. The adapter side
  // therefore always receives a complete config and never needs a scattered
  // `?? someDefault`, which drifts out of sync with the schema sooner or later
  const cfg = { ...defaultRuntimeConfig(agent.runtimeKind), ...agent.runtimeConfig };
  const str = (k: string) => (typeof cfg[k] === 'string' ? (cfg[k] as string) : undefined);
  const num = (k: string) => (typeof cfg[k] === 'number' ? (cfg[k] as number) : undefined);
  const rawList = (k: string) => (Array.isArray(cfg[k]) ? (cfg[k] as string[]) : undefined);

  /**
   * ★★ Any of APOS's own secrets named in passthroughEnv is stripped.
   *
   *   The meaning of this field is "pass a variable the APOS process already
   *   has through to the child process", and the bar for editing it is only
   *   `agent.update` — which every project's pm / tech_lead holds. Without the
   *   filter, adding one line `APOS_JWT_SECRET` to this list puts the signing
   *   secret inside a child process whose prompt the same person writes, and
   *   with it they can mint a token for any user.
   *
   *   This is the same prohibition as `env:VAR_NAME` in the environment
   *   variable map (see security/secrets.ts); both paths have to enforce it —
   *   closing one door only is the same as closing none.
   *
   * ★ Stripping has to be announced. Silently dropping a variable presents as
   *   "I configured it and it did not take effect", a failure mode this repo
   *   has been bitten by repeatedly.
   */
  const list = (k: string) => {
    const raw = rawList(k);
    if (k !== 'passthroughEnv' || !raw) return raw;
    const blocked = raw.filter(isProtectedEnvKey);
    if (blocked.length > 0) {
      diagnose(
        `${tag} 这些是 APOS 自己的密钥，不会透传给 Agent：${blocked.join('、')}`,
      );
    }
    return raw.filter((name) => !isProtectedEnvKey(name));
  };

  /**
   * Environment variable map: the database stores references, but the adapter
   * has to be handed plaintext / 库里存的是引用，交给适配器的必须是明文。
   *
   * ★ Keys that cannot be resolved must be **announced**. They are not sent
   *   down, and the symptom is the Agent reporting a bare 401 — nothing in that
   *   error points at "the env var that ANTHROPIC_AUTH_TOKEN refers to is not
   *   set".
   */
  const overrides = resolveEnvOverrides(envOverridesOf(cfg));
  if (overrides.unresolved.length > 0) {
    diagnose(`${tag} 这些环境变量的引用解不开，不会下发：${overrides.unresolved.join('、')}`);
  }
  const env = Object.keys(overrides.env).length > 0 ? { env: overrides.env } : {};

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
        // Inheriting the process environment is allowed only when no credential
        // is registered (the common shape of a single-machine deployment)
        allowInheritedCredentials: agent.credentialRef === null,
        // Endpoint → ANTHROPIC_BASE_URL. Relays and self-hosted gateways use this
        ...(agent.endpoint ? { baseUrl: agent.endpoint } : {}),
        ...(str('credentialEnv')
          ? { credentialEnv: str('credentialEnv') as 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' }
          : {}),
        ...(str('model') ? { model: str('model')! } : {}),
        ...(str('effort') ? { effort: str('effort') as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
        ...(num('maxTurns') !== undefined ? { maxTurns: num('maxTurns')! } : {}),
        ...(str('onUngrantedTool')
          ? { onUngrantedTool: str('onUngrantedTool') as 'escalate' | 'deny' }
          : {}),
        ...(list('passthroughEnv') ? { passthroughEnv: list('passthroughEnv')! } : {}),
        ...env,
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
        ...env,
        onDiagnostic: (message, detail) => diagnose(`${tag} ${message}`, detail),
      });

    /**
     * ★★ Six generic headless CLIs (pi / gemini_cli / aider / goose / opencode
     *   / qwen_code) share this one branch: every difference between them lives
     *   in the declarative profile table, and all this code does is carry the
     *   Agent row's config across.
     *
     *   Adding a seventh CLI = one more profile plus one more spec, with not a
     *   single word changed in this file.
     */
    default: {
      const profile = cliProfile(agent.runtimeKind);
      if (!profile) return null;
      return new GenericCliRuntime(profile, {
        apiKey,
        // Inheriting the process environment is allowed only when no credential
        // is registered (the common shape of a single-machine deployment)
        allowInheritedCredentials: agent.credentialRef === null,
        ...(agent.endpoint ? { baseUrl: agent.endpoint } : {}),
        ...(str('model') ? { model: str('model')! } : {}),
        ...(str('binary') ? { binary: str('binary')! } : {}),
        ...(list('extraArgs') ? { extraArgs: list('extraArgs')! } : {}),
        ...(list('passthroughEnv') ? { passthroughEnv: list('passthroughEnv')! } : {}),
        ...env,
        onDiagnostic: (message, detail) => diagnose(`${tag} ${message}`, detail),
      });
    }
  }
}

/**
 * Registers the database's Agents into the registry. Only touches ones not yet
 * registered, so it is safe to call repeatedly / 只处理还没注册过的，可反复调用。
 *
 * ★ Why it has to be repeatable: the registry used to be built once at startup,
 *   which made every Agent created after the process came up invisible — the UI
 *   said "the adapter is not registered in the current process", work could not
 *   be dispatched, and that sentence does not tell you which process to restart.
 *
 * ★ Add-only: Agents that have disappeared are never unregistered. A Run still
 *   in flight is holding that adapter, and pulling it out means aborting an
 *   execution — a trade that does not pay.
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
 * Takes effect immediately after a create or a config change, without waiting
 * for the next sync round / 新建 / 改配置后立刻生效，不等下一轮同步。
 *
 * ★ On a config change the instance must be **replaced**, not skipped: the old
 *   instance still holds the old effort and the old credential. Skip it and the
 *   UI reports the change as applied while the next dispatch still runs the old
 *   values.
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
