import type { ResourceScope } from '@apos/contracts';

/**
 * 生效的资源范围 = Agent 上显式配的 + 项目级仓库的默认只读。
 *
 * ★★ 为什么要有默认这一档：一个项目通常只有一个代码仓库，而「这个项目的
 *   Agent 能不能读这个项目的代码」在 99% 的情况下答案是「当然能」。
 *   逐个 Agent 授权一遍换不到任何安全性 —— 忘了配的表现是 Agent 在空目录里
 *   开工然后报告「未找到相关代码，已创建新实现」，而管理员看不出哪里配漏了。
 *
 * ★★ 这一层给出的默认档位是 `read`，而**最终档位由能力那一侧定**
 *   （见 capabilities/evaluate.ts 末尾的对齐段）：有 workspace.write 的
 *   升到 write，没有的留在 read。
 *
 *   「review Agent 该只读、code Agent 才写」这个区别一点没丢，只是它现在
 *   由能力表达，而不是要求管理员在资源范围里再说一遍。让它在两个地方各配
 *   一次的代价是两处迟早对不上 —— 而对不上的那一侧（能力说能改、范围说只读）
 *   的表现是 Agent 在一个改不动的目录里开工，报告「未找到相关代码」。
 *
 * ★ 管理员**显式**写的那些不受这条影响：写着 read 就是 read。
 *
 * ★ 只有**项目级**登记参与默认。org 级仓库对全组织可见，默认给出去就是
 *   「A 项目的 Agent 自动能读 B 项目的代码」—— 跨项目的授权必须是个决定。
 *
 * Effective scopes = what the admin configured, plus a default tier covering
 * every project-scoped repository. This layer sets that tier to `read`; the
 * evaluator then raises it to `write` for agents that hold `workspace.write`
 * and lowers explicit writes for agents that do not. "Who may write" is still
 * the one distinction this model exists to express — it is just expressed once,
 * as a capability, instead of twice. Org-scoped repositories are excluded:
 * cross-project access stays a decision.
 */
export interface EffectiveScopeInput {
  /** Agent 上显式配置的资源范围 / What the admin configured on the agent */
  explicit: readonly ResourceScope[];
  /**
   * 本项目**项目级**登记且启用的仓库 ref。
   * org 级（projectId 为空）的不要放进来 —— 它们不参与默认。
   */
  projectRepoRefs: readonly string[];
}

export function effectiveResourceScopes(input: EffectiveScopeInput): ResourceScope[] {
  /**
   * ★ 显式配置一律胜出，**包括显式写成 `none` 的**。
   *   不这样的话「把某个 Agent 的仓库权限收回」就没有任何写法可以表达 ——
   *   删掉那条等于回落到默认只读，配成 none 又被默认盖掉。
   *   一条撤销不掉的权限比一开始就没有这条默认糟得多。
   */
  const explicitRepoRefs = new Set(
    input.explicit.filter((s) => s.kind === 'repo').map((s) => s.ref),
  );

  const stamped: ResourceScope[] = input.explicit.map((s) => ({ ...s, origin: 'explicit' }));

  /**
   * ★ 去重并排序。permissionSnapshot 会落库、会被拿来比对两次 Run 的授权差异，
   *   顺序不稳定的话每次派发都长得像「权限变了」。
   */
  const defaulted = [...new Set(input.projectRepoRefs)]
    .filter((ref) => !explicitRepoRefs.has(ref))
    .sort()
    .map(
      (ref): ResourceScope => ({
        kind: 'repo',
        ref,
        access: 'read',
        origin: 'project_default',
      }),
    );

  return [...stamped, ...defaulted];
}
