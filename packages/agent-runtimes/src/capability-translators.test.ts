import { describe, expect, it } from 'vitest';
import type { AgentCapability } from '@apos/contracts';
import { baseToolName } from './claude-code/permissions';
import { capabilityTranslator, claudeCodeTranslator, codexTranslator } from './capability-translators';
import { CAPABILITY_TOOLS } from './capability-map';

const translate = (
  translator: ReturnType<typeof capabilityTranslator>,
  capabilities: AgentCapability[],
  denied: AgentCapability[] = [],
) =>
  translator.translate({
    capabilities,
    deniedCapabilities: denied,
    resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
    runtimeManifest: null,
  });

describe('语义能力 → 运行时工具', () => {
  it('读工作区映射到读类工具，且不含任何写工具', () => {
    const out = translate(claudeCodeTranslator, ['workspace.read']);
    expect(out.allowedTools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
    expect(out.allowedTools).not.toContain('Edit');
    expect(out.allowedTools).not.toContain('Write');
  });

  /**
   * ★★ 这条是整个能力目录存在的理由：改工作区 ≠ 推远端 ≠ 合并。
   *   三者混成一个 `repo:write` 的时候，「让 Agent 能改代码」
   *   顺手把「让 Agent 能合并代码」也授了出去。
   */
  it('改工作区不带来推送，推送不带来合并', () => {
    const write = translate(claudeCodeTranslator, ['workspace.write']);
    expect(write.allowedTools).toContain('Edit');
    expect(write.allowedTools.join(' ')).not.toContain('git push');

    const push = translate(claudeCodeTranslator, ['repository.push']);
    expect(push.allowedTools.join(' ')).toContain('git push');
    expect(push.allowedTools.join(' ')).not.toContain('pr merge');
  });

  /**
   * ★★ 跑测试给的是**带作用域**的规则，不是裸 Bash。
   *   裸 Bash 之后，「能跑测试」和「能跑 rm -rf」没有任何区别。
   */
  it('跑测试给的是受约束的命令规则，不是整个 Bash', () => {
    const out = translate(claudeCodeTranslator, ['command.test']);
    expect(out.allowedTools).not.toContain('Bash');
    expect(out.allowedTools.every((t) => baseToolName(t) !== 'Bash' || t.includes('('))).toBe(true);
    expect(out.allowedTools.join(' ')).toContain('test');
  });

  it('拒绝的能力落成黑名单规则', () => {
    const out = translate(claudeCodeTranslator, ['workspace.write'], ['repository.push']);
    expect(out.deniedTools.join(' ')).toContain('git push');
  });

  /** ★ 没有 workspace.write 时，可写仓库范围被降到只读 —— 不依赖调用顺序 */
  it('没有写能力时仓库范围降级为只读', () => {
    const out = translate(claudeCodeTranslator, ['workspace.read']);
    expect(out.resourceScopes[0]?.access).toBe('read');
  });

  it('每条能力都在映射表里有明确条目', () => {
    for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS)) {
      expect(Array.isArray(tools), `${capability} 缺少映射`).toBe(true);
    }
  });
});

describe('★ 降级必须可见', () => {
  /**
   * ★★ 「授了但落不到实处」不能静默。授权界面上 environment.deploy
   *   和 command.test 长得一模一样，而前者在这些运行时上什么都不会发生。
   */
  it('没有工具落点的能力报为不可用', () => {
    const out = translate(claudeCodeTranslator, ['environment.deploy']);
    const degraded = out.degradations.find((d) => d.capability === 'environment.deploy');
    expect(degraded?.kind).toBe('unavailable');
  });

  /**
   * ★★ Codex 的粒度是沙箱级：可写沙箱下拦不住具体命令。
   *   吞掉这句话，用户会以为那条禁止在 Codex 上也生效了。
   */
  it('沙箱级运行时报出拦不住的禁令', () => {
    const out = translate(codexTranslator, ['workspace.write'], ['pull_request.merge']);
    const degraded = out.degradations.find((d) => d.capability === 'pull_request.merge');
    expect(degraded?.kind).toBe('unenforceable');
    expect(degraded?.detail).toContain('沙箱');
  });

  /** ★ 只读沙箱下那些命令本来就跑不了，这时报警告是虚惊 —— 虚惊多了真警告没人看 */
  it('只读沙箱下不报拦不住的禁令', () => {
    const out = translate(codexTranslator, ['workspace.read'], ['pull_request.merge']);
    expect(out.degradations.some((d) => d.kind === 'unenforceable')).toBe(false);
  });

  /**
   * ★★ 认不出来的运行时回落到最粗那一档，而不是「不知道 = 都支持」。
   *   后者是这套系统里最不能接受的默认值方向。
   */
  it('未知运行时回落到最粗粒度而不是无限制', () => {
    const unknown = capabilityTranslator('some-new-cli');
    const out = translate(unknown, ['workspace.write'], ['repository.push']);
    expect(out.degradations.some((d) => d.kind === 'unenforceable')).toBe(true);
  });
});
