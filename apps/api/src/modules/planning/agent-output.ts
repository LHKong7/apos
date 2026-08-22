import { AgentCapability, DataSensitivity, Environment, OperationType } from '@apos/contracts';
import { z } from 'zod';

/**
 * The shape of the JSON an agent writes back.
 *
 * ★★ Why a separate schema rather than reusing StructuredRequirement:
 *
 *   That type is the **platform's internal** shape, carrying provenance, cost,
 *   and model — fields only the platform can fill in. Asking an agent to fill
 *   them yields either invented numbers (it cannot compute cost accurately) or
 *   a model name it guessed at, and those values go straight into the database,
 *   the cost totals, and the audit trail. So this schema accepts only the part
 *   an agent is actually entitled to produce; the platform supplies the rest.
 *
 * ★★ Validation must **reject**, not do its best.
 *
 *   An LLM writing JSON drops fields, writes an array as a string, and adds a
 *   nesting level on its own initiative. `.catch()` or partial parsing looks
 *   more forgiving but really puts malformed data into the database, where it
 *   detonates three screens later as an error with no visible connection to the
 *   agent. What fails here is discarded whole: fall back to the rule-based
 *   placeholder and say why.
 *
 *   单独一套 schema 是因为 StructuredRequirement 带着只有平台填得出来的字段；
 *   校验必须是拒绝而不是尽力而为，畸形数据放进库之后会在三个界面之后炸成
 *   一个和 Agent 毫无关联的报错。
 */

/** Clarification level — aligned with clarification_level in contracts. */
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
   * ★ An acceptance criterion's `verification` accepts only auto / agent /
   *   human. Agents like to write free text such as "manual", "CI", or
   *   "code review", while downstream verification is dispatched off those
   *   three values — accepting anything else means the task is never verified
   *   by anyone.
   *
   *   只收 auto / agent / human 三种：下游核验调度按这三个值分派，
   *   收进自由文本等于任务永远没人验。
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
        /** ★ Asking without suggesting is quizzing the user (page doc 03 §5.5). */
        agentSuggestion: z.string().nullable().default(null),
        suggestionBasis: z.string().nullable().default(null),
        options: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  assumptions: z.array(z.string()).default([]),
});
export type AgentStructuredOutput = z.infer<typeof AgentStructuredOutput>;

/**
 * An explicit `null` is synonymous with omitting the key entirely.
 *
 * ★★ This does not loosen the safety floor a notch; it collapses two spellings
 *   of **the same piece of information** into one.
 *
 *   `null` here says "I don't know", and omission says "I don't know" too —
 *   the two carry identical information. Accepting one while rejecting the
 *   other polices a writing habit, not a risk. The habit is taught two fields
 *   up, where `estimatedTokens` documents "write null if you cannot estimate";
 *   the model naturally generalizes it to the neighboring optional fields, so
 *   `"operationType": null` condemned the whole plan and handed the user a
 *   generic template unrelated to their requirement — for a plan that, in
 *   governance terms, is identical to one that **simply omitted the field**.
 *
 * ★ What should be rejected still is: an **unrecognized string** such as
 *   `"delete_resrouce"` still throws the whole artifact back. That is the truly
 *   dangerous class of value — it looks like an answer while silently matching
 *   no governance rule. `null` does not disguise itself as an answer.
 *
 *   显式 null 与整个省略同义，收下一个再拒掉另一个，拒的不是风险而是模型的
 *   书写习惯；认不出来的字符串照旧整份打回 —— 它看起来像个答案，
 *   实际让所有治理规则静默地匹配不上。
 */
function nullAsAbsent<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((v) => (v === null ? undefined : v));
}

export const AgentPlanOutput = z.object({
  tasks: z
    .array(
      z.object({
        /** Temporary in-plan id used to express dependencies. ★ Must be unique; checked separately below. */
        ref: z.string().min(1),
        title: z.string().min(1),
        description: z.string().default(''),
        type: WorkItemType,
        phase: z.string().default('Execution'),
        estimatedHours: z.number().nonnegative(),
        /**
         * ★★ Accept a decimal and round it; do **not** reject with `.int()`.
         *
         *   This is an **estimate**, and the neighboring estimatedHours allows
         *   decimals too. A model writing `1.5` (thinking "1.5k") is entirely
         *   normal here, whereas `.int()` would condemn the **whole plan** over
         *   this one field and fall back to the rule-based placeholder — the
         *   user gets a generic template unrelated to their requirement, with a
         *   single line of gray text to explain what happened.
         *
         *   The defense of whole-artifact rejection at the top of this file
         *   rests on **structural** errors (missing fields, an array written as
         *   a string, an extra nesting level) — those genuinely cannot be
         *   salvaged. float→int is not one of them: it rounds losslessly, so
         *   that argument does not reach this far.
         *
         *   收小数然后取整，不要用 `.int()` 拒绝：这是个估算值，
         *   为一位小数判废整份计划毫无道理。
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
         * ★★ A plan expresses **capabilities**, never tool names.
         *
         *   A tool name belongs to one runtime's vocabulary: mock says
         *   `read_file`, claude-code says `Read`, and opencode goes through the
         *   cli translator to something else again. Hard-code any one of them
         *   into a plan and the task never matches an agent on a different
         *   runtime — with the symptom being that it sits quietly in `ready`,
         *   no error, no event.
         *
         *   Capabilities are the cross-runtime layer; translating them into
         *   concrete tools is the adapter's job.
         *
         *   计划表达的是能力不是工具名：写死某个运行时的词汇表，
         *   换个运行时就永远匹配不到 Agent，而症状是任务安静地停在 ready。
         */
        requiredCapabilities: z.array(AgentCapability).default([]),
        /** @deprecated Runtime tool names from existing plans; read, never written — see requiredCapabilities. */
        requiredTools: z.array(z.string()).default([]),
        /** Mark human-only tasks already at planning time (product doc 8.8.6: production releases default to human execution). */
        requiresHuman: z.boolean().default(false),
        /**
         * ★★ Strict enums: an unrecognized **string** is rejected rather than
         *   quietly defaulted.
         *
         *   This is a hole in the safety floor. Default `operationType` to
         *   `code_change` and a model writing `"delete_resrouce"` — one letter
         *   misspelled — walks straight past the whole "deleting a resource is
         *   never auto-approved" rule, leaving no trace at the scene: the task
         *   runs to completion and not one rule matches.
         *
         *   Rejection buys a repair round instead (the retry loop in
         *   agent-provider), which costs far less.
         *
         *   认不出的字符串拒收，不静默兜底：兜底成 `code_change` 等于让一个
         *   拼错的词绕过整条安全底线，而现场毫无迹象。
         */
        operationType: nullAsAbsent(OperationType),
        environment: nullAsAbsent(Environment),
        /**
         * ★ Neither of these facts had a producer: `buildPolicyContext` reads
         *   them out of typeData, and no code wrote them into typeData. So
         *   rules like "accessing restricted data needs approval" and
         *   "external-facing content needs human confirmation" could never
         *   match — while looking perfectly configured to the user. Planning is
         *   the only stage that knows these two things, so planning is where
         *   they get marked.
         *
         *   这两项此前没有任何生产者，于是相关规则永远不会命中，
         *   而用户以为自己配好了。
         */
        dataSensitivity: nullAsAbsent(DataSensitivity),
        externalFacing: nullAsAbsent(z.boolean()),
        acceptanceCriteria: z
          .array(
            z.object({
              text: z.string().min(1),
              /** ID copied from the requirement criterion this task verifies. */
              requirementCriterionId: z.string().nullish().transform((v) => v ?? undefined),
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
 * Passing the schema does not make a plan coherent.
 *
 * ★★ Dependencies are expressed with refs rather than real ids, so "points at
 *   a ref that does not exist" is perfectly legal as far as zod is concerned.
 *   What it does once stored is this: that dependency row is silently dropped
 *   (in planning/service.ts, `refToId.get()` misses and the loop continues), so
 *   the task's precondition vanishes into thin air and the scheduler dispatches
 *   a task that should not have started yet. With no error anywhere.
 *
 * ★ Cycles behave the same way: A depends on B, B depends on A, both edges
 *   store fine, and then the two tasks wait for each other forever — which on
 *   the board looks like two cards stuck in `ready`.
 *
 *   悬空 ref 与环在 zod 那里完全合法，进库之后一个让前置条件凭空消失，
 *   另一个让两张卡永远卡在 ready，两者都没有任何报错。
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

/** Depth-first search for one cycle, returning its path — "which tasks form a cycle" beats "there is a cycle". */
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
      if (!edges.has(next)) continue; // Dangling refs are already reported above; no need to repeat
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
