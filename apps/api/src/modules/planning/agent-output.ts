import { AgentCapability } from '@apos/contracts';
import { z } from 'zod';

/**
 * Agent 写回来的 JSON 的形状。
 *
 * ★★ 为什么要单独一套 schema，而不是直接复用 StructuredRequirement：
 *
 *   那个类型是**平台内部**的形状，带着 provenance、cost、model 这些只有
 *   平台自己填得出来的字段。让 Agent 去填它们，得到的要么是编造的数字
 *   （cost 它算不准），要么是它猜出来的 model 名 —— 而这些值会直接进库、
 *   进成本统计、进审计。所以这里只收 Agent 真正有资格产出的部分，
 *   其余由平台补齐。
 *
 * ★★ 校验必须是**拒绝**而不是尽力而为。
 *
 *   LLM 写 JSON 会漏字段、会把数组写成字符串、会自作主张加一层嵌套。
 *   `.catch()` 或者 partial 解析看起来更宽容，实际是把畸形数据放进库，
 *   然后在三个界面之后炸成一个和 Agent 毫无关联的报错。
 *   这里过不了就整份丢弃、回退规则占位，并把原因说出来。
 */

/** 澄清等级 —— 与 contracts 的 clarification_level 对齐 */
const Level = z.enum(['must_confirm', 'default_applicable', 'assumption_ok', 'auto_resolved']);

const RiskLevel = z.enum(['low', 'medium', 'high', 'critical']);

const WorkItemType = z.enum([
  'requirement', 'feature', 'story', 'task', 'bug', 'research',
  'review', 'test', 'incident', 'decision', 'approval', 'release', 'knowledge',
]);

const DependencyType = z.enum([
  'finish_to_start', 'start_to_start', 'artifact',
  'decision', 'permission', 'external', 'data',
]);

export const AgentStructuredOutput = z.object({
  title: z.string().min(1).max(200),
  businessContext: z.string(),
  userProblem: z.string(),
  businessGoal: z.string(),
  userStories: z.array(z.string()).default([]),
  scope: z
    .object({
      inScope: z.array(z.string()).default([]),
      outOfScope: z.array(z.string()).default([]),
    })
    .default({ inScope: [], outOfScope: [] }),
  nonFunctional: z.array(z.string()).default([]),
  successMetrics: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  /**
   * ★ 验收标准的 verification 只收 auto / agent / human 三种。
   *   Agent 爱写 "manual"、"CI"、"code review" 这类自由文本，
   *   而下游的核验调度是按这三个值分派的 —— 收进来等于任务永远没人验。
   */
  acceptanceCriteria: z
    .array(
      z.object({
        text: z.string().min(1),
        verification: z.enum(['auto', 'agent', 'human']).default('agent'),
      }),
    )
    .default([]),
  clarifications: z
    .array(
      z.object({
        question: z.string().min(1),
        level: Level,
        impact: z.string(),
        /** ★ 只提问不给建议，就是在考用户（页面文档 03 §5.5） */
        agentSuggestion: z.string().nullable().default(null),
        suggestionBasis: z.string().nullable().default(null),
        options: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  assumptions: z.array(z.string()).default([]),
});
export type AgentStructuredOutput = z.infer<typeof AgentStructuredOutput>;

export const AgentPlanOutput = z.object({
  tasks: z
    .array(
      z.object({
        /** 计划内的临时 ID，用来表达依赖。★ 必须唯一，下面单独查 */
        ref: z.string().min(1),
        title: z.string().min(1),
        description: z.string().default(''),
        type: WorkItemType,
        phase: z.string().default('Execution'),
        estimatedHours: z.number().nonnegative(),
        /**
         * ★★ 收小数然后取整，**不要**用 `.int()` 拒绝。
         *
         *   这是个**估算值**，紧挨着的 estimatedHours 也允许小数。模型写
         *   `1.5`（它心里是「1.5k」）在这里完全正常，而 `.int()` 会因为这一个
         *   字段判废**整份计划**，退回规则占位 —— 用户拿到的是一份与需求
         *   无关的通用模板，界面上只有一行灰字说明发生过什么。
         *
         *   文件顶部为「整份拒绝」辩护时举的是**结构性**错误（漏字段、
         *   数组写成字符串、多一层嵌套）—— 那些确实没法救。float→int 不是，
         *   它能无损取整，那条理由覆盖不到这里。
         *
         *   Round instead of rejecting: this is an estimate, and one decimal
         *   place must not discard an otherwise valid plan.
         */
        estimatedTokens: z
          .number()
          .nonnegative()
          .nullable()
          .default(null)
          .transform((v) => (v === null ? null : Math.round(v))),
        riskLevel: RiskLevel,
        requiredSkills: z.array(z.string()).default([]),
        /**
         * ★★ 计划表达的是**能力**，不是工具名。
         *
         *   工具名属于某一个运行时的词汇表（mock 说 `read_file`，
         *   claude-code 说 `Read`，opencode 走 cli 翻译器又是另一套）。
         *   计划里写死任何一套，换个运行时就永远匹配不到 Agent，
         *   而症状是任务安静地停在 ready —— 没有报错、没有事件。
         *
         *   能力是跨运行时的那一层，翻译成具体工具是适配器的事。
         *
         *   Plans speak capabilities, never tool names: a tool name belongs to
         *   one runtime's vocabulary, and hard-coding one strands every task
         *   on any other runtime.
         */
        requiredCapabilities: z.array(AgentCapability).default([]),
        /** @deprecated 存量计划里的运行时工具名，只读不写 —— 见 requiredCapabilities */
        requiredTools: z.array(z.string()).default([]),
        /** 计划阶段就要标出必须由人做的任务（产品文档 8.8.6：生产发布默认由人执行） */
        requiresHuman: z.boolean().default(false),
        operationType: z.string().optional(),
        environment: z.string().optional(),
        acceptanceCriteria: z
          .array(
            z.object({
              text: z.string().min(1),
              verification: z.enum(['auto', 'agent', 'human']).default('agent'),
            }),
          )
          .default([]),
        dependsOn: z
          .array(z.object({ ref: z.string().min(1), type: DependencyType.default('finish_to_start') }))
          .default([]),
      }),
    )
    .min(1, '计划里一个任务都没有'),
  milestones: z
    .array(
      z.object({
        name: z.string().min(1),
        taskRefs: z.array(z.string()).default([]),
        dueOffsetDays: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
  risks: z
    .array(
      z.object({
        description: z.string().min(1),
        level: z.string().default('medium'),
        mitigation: z.string().default(''),
      }),
    )
    .default([]),
});
export type AgentPlanOutput = z.infer<typeof AgentPlanOutput>;

/**
 * schema 过了不代表这份计划是自洽的。
 *
 * ★★ 依赖用的是 ref 而不是真 ID，所以「指向一个不存在的 ref」在 zod 那里
 *   完全合法。而它进库之后的表现是：依赖那一行被静默丢弃（planning/service.ts
 *   里 `refToId.get()` 拿不到就 continue），于是任务的前置条件凭空消失，
 *   调度器会把一个还不该开始的任务派出去。没有任何报错。
 *
 * ★ 环也一样：A 依赖 B、B 依赖 A，两条边都写得进库，然后这两个任务
 *   永远等不到对方，看板上表现为「两张卡一直卡在 ready」。
 */
export function validatePlanGraph(plan: AgentPlanOutput): string[] {
  const problems: string[] = [];
  const refs = plan.tasks.map((t) => t.ref);
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) problems.push(`任务 ref 重复：${ref}`);
    seen.add(ref);
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!seen.has(dep.ref)) problems.push(`任务「${task.ref}」依赖了不存在的 ref：${dep.ref}`);
      if (dep.ref === task.ref) problems.push(`任务「${task.ref}」依赖了自己`);
    }
  }

  for (const m of plan.milestones) {
    for (const ref of m.taskRefs) {
      if (!seen.has(ref)) problems.push(`里程碑「${m.name}」指向了不存在的 ref：${ref}`);
    }
  }

  const cycle = findCycle(plan);
  if (cycle) problems.push(`依赖成环：${cycle.join(' → ')}`);

  return problems;
}

/** 深度优先找一条环，找到就返回路径 —— 报「有环」不如报「哪几个任务成环」 */
function findCycle(plan: AgentPlanOutput): string[] | null {
  const edges = new Map(plan.tasks.map((t) => [t.ref, t.dependsOn.map((d) => d.ref)]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (ref: string): string[] | null => {
    if (state.get(ref) === 'done') return null;
    if (state.get(ref) === 'visiting') return [...stack.slice(stack.indexOf(ref)), ref];

    state.set(ref, 'visiting');
    stack.push(ref);
    for (const next of edges.get(ref) ?? []) {
      if (!edges.has(next)) continue; // 悬空 ref 上面已经报过，这里不重复
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(ref, 'done');
    return null;
  };

  for (const ref of edges.keys()) {
    const found = walk(ref);
    if (found) return found;
  }
  return null;
}
