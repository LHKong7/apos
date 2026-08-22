import type { StructureInput, StructuredRequirement } from './provider';

/**
 * The file name the agent must write / Agent 要写出的文件名。
 *
 * ★ Fixed to one agreed path instead of letting the agent name the file and then
 *   guessing what it picked: the guessing step buys nothing and opens a whole class
 *   of "the run finished but the output cannot be found" failures.
 *
 * ★ 固定成一个约定路径，而不是让 Agent 自己起名再去猜：猜的那一步没有任何收益，
 *   却引入了一整类「跑完了但找不到产物」的失败。
 */
export const OUTPUT_FILE = 'apos-output.json';

/**
 * The brief. It is the only thing the agent ever sees, so how well it is written
 * decides the quality of the output outright.
 *
 * Three principles:
 * 1. **State the deliverable before the task** — these CLIs act while they read, so
 *    if "which file, which format" comes last they have already written half of
 *    something in their own shape.
 * 2. **Give a schema, not a description** — "include acceptance criteria" yields a
 *    different shape every time; only field names and value enums stand a chance of
 *    passing validation on the first try.
 * 3. **Spell out the judgment criteria, not just the work** — clarifications come in
 *    four levels, and without explaining what counts as must_confirm the agent files
 *    every single question at the highest one.
 *
 * 任务书。这是 Agent 唯一看得到的东西，写得好不好直接决定产出质量。三条原则：
 * 先说交付物再说任务；给 schema 而不是给描述；说清楚判断标准而不是只说做什么。
 */
function header(task: string): string {
  return `# ${task}

## 你要交付什么

在**当前工作目录**下写出一个文件 \`${OUTPUT_FILE}\`，内容是符合下面 schema 的
JSON。不要输出到别处，不要只在对话里打印，不要用 \`\`\` 包裹整个文件内容。

写完就结束，不需要额外解释。文件写不出来 = 这次任务失败。
`;
}

/** How clarifications are graded. Left unstated, every question comes back must_confirm */
const CLARIFICATION_RULES = `
### 澄清问题怎么分级

| level | 什么时候用 |
| --- | --- |
| \`must_confirm\` | 答案会改变方案、工期或验收标准，猜错的代价是返工。**必须由人回答** |
| \`default_applicable\` | 有一个明显合理的行业/组织默认值，用户不表态就按默认走 |
| \`assumption_ok\` | 影响很小，直接记为假设继续推进即可 |
| \`auto_resolved\` | 你已经从原文里推断出答案，列出来只是让用户有机会纠正 |

★ 不要把所有问题都标成 \`must_confirm\`。每多一个必答问题，用户就多一道
坎；把可以用默认值的问题也拦下来，是在用用户的时间换你的保险。

★ 每个问题都要给 \`agentSuggestion\`（你的倾向）和 \`suggestionBasis\`（依据）。
只提问不给建议，等于在考用户。
`;

/**
 * The output-language instruction / 输出语言指令。
 *
 * ★★ It has to be nailed down explicitly; an implicit cue — the brief itself being
 *   written in Chinese — is not enough. When the brief is Chinese and the
 *   requirement is English, both sides have a claim and the model picks one per
 *   call. In the field that meant one project carrying a Chinese PRD and an English
 *   PRD side by side (issue log: BUG-4).
 *
 * ★ It constrains only **the fields the platform asks it to produce**. The user's
 *   own wording and identifiers taken from existing code are copied verbatim —
 *   translating those renames something that belongs to the user.
 *
 * ★★ 必须显式写死，不能靠 brief 自己是中文来暗示。brief 是中文而需求是英文时，
 *   模型两边都占理，于是它每次自己选一个 —— 现场就是同一个项目里中英两份 PRD
 *   并存（问题记录：BUG-4）。
 *
 * ★ 只约束**平台要它写的字段**。用户原话、既有代码里的标识符照抄，
 *   翻译它们等于给用户的东西改名。
 */
function languageRule(locale: 'en' | 'zh' | undefined): string {
  const target = locale === 'zh' ? '简体中文' : '英文（English）';
  return `
## 输出语言

**你写进 JSON 的每一个字段都必须用${target}。** 这一条压过原始需求的语言：
需求是英文而这里要求中文时，也写中文；反之亦然。

例外只有一类：**原样引用**的内容 —— 用户的原话、代码标识符、文件路径、
第三方产品名。它们照抄，不要翻译。
`;
}

export function buildStructureBrief(input: StructureInput): string {
  const context = input.context.length
    ? `\n## 可参考的上下文\n\n${input.context.map((c) => `### ${c.title}\n${c.content}`).join('\n\n')}\n`
    : '';

  return `${header('把一段自然语言需求结构化')}
${languageRule(input.scope?.locale)}
## schema

\`\`\`jsonc
{
  "title": "一句话标题，不超过 200 字",
  "businessContext": "这件事的背景：现在是什么状况、为什么现在要做",
  "userProblem": "用户实际遇到的问题（不是解决方案）",
  "businessGoal": "做成之后业务上得到什么",
  "userStories": ["作为…，我希望…，以便…"],
  "scope": { "inScope": ["这次要做的"], "outOfScope": ["这次明确不做的"] },
  "nonFunctional": ["性能/安全/可用性等非功能要求"],
  "successMetrics": ["可度量的成功指标"],
  "constraints": ["硬约束：期限、技术栈、合规…"],
  "risks": ["风险描述"],
  "acceptanceCriteria": [
    { "text": "可验证的验收条件", "verification": "auto" }  // auto | agent | human
  ],
  "clarifications": [
    {
      "question": "要问用户的问题",
      "level": "must_confirm",           // 见下表
      "impact": "不回答会怎样，尽量量化到工期或范围",
      "agentSuggestion": "你倾向哪个答案",
      "suggestionBasis": "为什么这么倾向",
      "options": ["候选答案A", "候选答案B"]
    }
  ],
  "assumptions": ["你没问、直接假设掉的东西"]
}
\`\`\`

${CLARIFICATION_RULES}

## 几条硬要求

- \`verification\` 只能是 \`auto\`（CI 能自动验）、\`agent\`（Agent 能验）、
  \`human\`（必须人验）三者之一。写别的值会被拒收。
- **不要把原文换个说法填进每个字段**。\`businessContext\` 是背景，
  \`userProblem\` 是问题，\`businessGoal\` 是目标 —— 三者填成同一句话，
  等于什么都没分析。原文里确实没有的信息，应该变成 \`clarifications\`
  里的一个问题，而不是编一个填进去。
- 原文含糊的地方，宁可多问一个问题，也不要编一个具体值。

## 项目类型

${input.projectType}
${context}
## 需求原文

\`\`\`
${input.rawInput}
\`\`\`
`;
}

/**
 * How many characters of the previous output the repair brief may carry.
 *
 * ★ The temptation is to include all of it — but a rejected plan can run to tens of
 *   KB, and pasting the whole thing back pushes the one line that actually matters
 *   ("here is what was wrong") thousands of lines down. What the agent needs is
 *   **orientation**, and the problem list already names the exact field paths; the
 *   output is only there to compare against.
 *
 * ★ 带全的诱惑很大 —— 但一份被判废的计划可能有几十 KB，整个塞回去会把真正要读的
 *   那句「哪里错了」挤到几千行之后。Agent 需要的是定位，而问题清单已经把字段路径
 *   说清楚了；产物只是用来对照。
 */
const PREVIOUS_OUTPUT_LIMIT = 8_000;

/**
 * The brief for the repair round / 修正轮的任务书。
 *
 * ★★ Why this round exists: `agent-output.ts` says in its comments that "rejection
 *   buys a retry or a clarification", yet before this there **was no retry** — one
 *   misspelled enum value threw away the most expensive call in the product and
 *   dropped the user into a rule-based template that had nothing to do with their
 *   requirement. And what the model gets wrong is almost always formatting rather
 *   than comprehension: hand back the zod complaint verbatim and it usually fixes
 *   it in a single round.
 *
 * ★★ Both the **complaint** and the **previous output** must be carried; drop either
 *   and the round is wasted. The complaint alone leaves the agent with no idea what
 *   it wrote last time, so it rewrites from scratch (and often repeats the same
 *   mistake); the output alone does not say what failed.
 *
 * ★ The original brief is appended in full, uncut. This round is a freshly opened
 *   session with no memory of the last one — the schema and the hard requirements
 *   have to be handed over again.
 *
 * ★★ 为什么要有这一轮：拒收本该换来一次重试，但在此之前根本没有重试 —— 一个枚举值
 *   拼错，产品里最贵的那次调用整场作废，用户直接掉进一份与需求无关的规则模板。
 *   模型犯的多半是格式错误，不是理解错误：把 zod 报的那几句原样递回去，它通常一次
 *   就改对了。
 *
 * ★★ 必须带上报错与上一版产物两样，缺一样这一轮就白跑：只给报错，Agent 不知道
 *   自己当时写了什么，只能从头重写一遍（于是很可能重犯同一个错）；只给产物，
 *   它不知道哪里不合格。
 *
 * ★ 原任务书整份附在后面，不做删减。Agent 这一轮是新开的一次会话，它没有上一轮的
 *   记忆 —— schema 与那几条硬要求必须再给一遍。
 */
export function buildRepairBrief(
  originalBrief: string,
  problems: string,
  previousOutput: string | null,
): string {
  const truncated =
    previousOutput === null
      ? null
      : previousOutput.length > PREVIOUS_OUTPUT_LIMIT
        ? `${previousOutput.slice(0, PREVIOUS_OUTPUT_LIMIT)}\n…（太长，只截取前 ${PREVIOUS_OUTPUT_LIMIT} 个字符）`
        : previousOutput;

  const previous =
    truncated === null
      ? '（上一版没有写出产物文件）'
      : `\`\`\`json\n${truncated}\n\`\`\``;

  return `# 上一版产物没通过校验，请修正后重新交付

## 哪里不合格

\`\`\`
${problems}
\`\`\`

## 上一版你写出来的内容

${previous}

## 这一轮怎么做

1. 对照上面的报错，**只改错的地方**。已经写对的部分（任务拆分、依赖关系、
   工期估算）原样保留 —— 重写一份新的计划意味着上一轮的分析白做了，
   而且很可能重新犯一个别的错。
2. 报错指着某个**枚举字段**时（\`type\`、\`riskLevel\`、\`verification\`、
   \`level\`、\`operationType\`、\`environment\`、\`dataSensitivity\` 这一类），
   回到下面的 schema 照着允许的取值改。**不确定的可选字段整行删掉**，
   不要写 \`null\`，也不要猜一个看起来差不多的值 —— 猜出来的值会让
   治理规则静默地匹配不上，比留空危险得多。
3. 改完把完整的 JSON 重新写进 \`${OUTPUT_FILE}\` —— 是整份文件，
   不是补丁、不是差异。

下面是原始任务书，schema 与要求与上一轮完全相同。

---

${originalBrief}
`;
}

export function buildPlanBrief(
  req: StructuredRequirement,
  projectType: string,
  feedback?: string,
  locale?: 'en' | 'zh',
): string {
  const revision = feedback
    ? `
## ★ 这是重新规划，用户对上一版的意见如下

\`\`\`
${feedback}
\`\`\`

必须**针对这些意见调整**。原样交回一份内容相同的计划，等于告诉用户
"要求修改"是个假按钮。
`
    : '';

  return `${header('把结构化需求拆成可执行的任务计划')}
${languageRule(locale)}
## schema

\`\`\`jsonc
{
  "tasks": [
    {
      // ref 是你自己起的临时 ID，只用来表达依赖。它和 "type" 没有关系，
      // 不要把 ref 的字面量拿去当 type 用。
      "ref": "step-1",
      "title": "任务标题",
      "description": "做什么、做到什么程度",
      "type": "research",                   // 见下面「type 只有这 13 个值」
      "phase": "Research",                  // 自定义阶段名，用于分组
      "estimatedHours": 4,
      "estimatedTokens": 75000,             // 预计消耗的 token 数；只有这一项估不出来时可以写 null
      "riskLevel": "low",                   // low|medium|high|critical
      "requiredSkills": ["需求分析"],
      // 语义能力，**不是**工具名。可选值：workspace.read|workspace.write|
      // command.build|command.test|network.external|artifact.create|
      // repository.push|pull_request.create|pull_request.merge|environment.deploy|
      // database.read|database.write|secret.read
      "requiredCapabilities": ["workspace.read"],
      "requiresHuman": false,
      "acceptanceCriteria": [{ "text": "…", "verification": "auto" }],
      "dependsOn": []                       // 没有前置任务就是空数组
    },
    {
      "ref": "step-2",
      "title": "上线到生产",
      "description": "…",
      "type": "release",
      "phase": "Release",
      "estimatedHours": 2,
      "estimatedTokens": 20000,
      "riskLevel": "high",
      "requiredSkills": [],
      "requiredCapabilities": ["environment.deploy"],
      "requiresHuman": true,
      // 下面四项都是可选的，只能填枚举里的值。
      // read|code_change|db_ddl|db_dml|deploy|delete_resource|permission_change|
      // access_sensitive_data|send_external|payment|security_policy_change|high_cost_resource
      "operationType": "deploy",
      "environment": "production",          // dev|test|staging|production
      // dataSensitivity 与 externalFacing 这个任务用不上，就整个不写这两行 ——
      // 不确定的可选字段**省略**，不要写 "dataSensitivity": null
      "acceptanceCriteria": [{ "text": "…", "verification": "human" }],
      "dependsOn": [{ "ref": "step-1", "type": "finish_to_start" }]
    }
  ],
  "milestones": [{ "name": "里程碑名", "taskRefs": ["step-1", "step-2"], "dueOffsetDays": 3 }],
  "risks": [{ "description": "风险", "level": "medium", "mitigation": "缓解措施" }]
}
\`\`\`

## \`type\` 只有这 13 个值

\`requirement\` \`feature\` \`story\` \`task\` \`bug\` \`research\` \`review\`
\`test\` \`incident\` \`decision\` \`approval\` \`release\` \`knowledge\`

写别的值（\`design\`、\`implementation\`、\`deploy\`…）会让**整份计划被拒收**。
常见的几类工作对应到哪个值：

| 你想表达 | 用哪个 type |
| --- | --- |
| 方案设计、技术选型、写设计文档 | \`task\` |
| 调研、可行性分析、看现有代码 | \`research\` |
| 写代码、改配置 | \`task\`（或 \`feature\` / \`bug\`，看它属于什么） |
| 上线、发版 | \`release\` |
| 评审、Code Review | \`review\` |

## 几条硬要求

- \`dependsOn\` 里的 \`ref\` **必须指向本计划内真实存在的任务**。指向不存在的
  ref 会让那条依赖被静默丢弃，于是一个还不该开始的任务被派出去执行。
- **\`ref\` 与 \`type\` 是两回事**。ref 是你自己起的 ID（\`step-1\`、\`api-contract\`
  都行），type 只能取上面那 13 个值里的一个。别把 ref 的字面量填进 type。
- **依赖不能成环**。A 依赖 B、B 依赖 A 的话，两个任务会永远互相等待，
  界面上表现为两张卡永久卡住。
- 生产环境的发布与数据库结构变更必须 \`"requiresHuman": true\`，
  并标上 \`operationType\` 与 \`environment\`。
- \`operationType\` / \`environment\` / \`dataSensitivity\` **只能取上面列出的值**。
  拼错或自造一个值会让整份计划被拒收 —— 填一个近似的值比不填危险得多：
  治理规则会因此静默地匹配不上。
- **不确定的可选字段整个省略，不要写 \`null\`。** 只有 \`estimatedTokens\`
  这一项允许 \`null\`；其余可选字段不知道就别写那一行。
- 会读到用户数据、密钥或线上库的任务标 \`dataSensitivity\`；
  产出会发给外部客户或公开渠道的任务标 \`"externalFacing": true\`。
  这两项决定了「访问敏感数据要不要人批」「对外内容要不要人确认」
  这类规则拦不拦得住它，不标就等于这些规则对这个任务不存在。
- 任务粒度控制在 2–16 小时。太粗无法并行也无法追踪进度，
  太细会让依赖图膨胀到没人看得懂。
- **按这个需求真正需要什么来拆**，不要套「调研→设计→开发→测试→发布」
  的固定模板。一个纯文档需求不需要发布任务，一个纯配置变更不需要设计任务。
${revision}
## 项目类型

${projectType}

## 结构化需求

\`\`\`json
${JSON.stringify(
  {
    title: req.title,
    businessContext: req.businessContext,
    userProblem: req.userProblem,
    businessGoal: req.businessGoal,
    userStories: req.userStories,
    scope: req.scope,
    nonFunctional: req.nonFunctional,
    constraints: req.constraints,
    risks: req.risks,
    acceptanceCriteria: req.acceptanceCriteria.map((c) => ({
      text: c.text,
      verification: c.verification,
    })),
    assumptions: req.assumptions,
    /**
     * ★★ Answered clarifications are the **hardest input there is**: they are the
     *   points a human took an explicit position on. Leave them out and the agent
     *   re-assumes things that were already settled, which throws away the work the
     *   user just did answering them one by one.
     *
     * ★★ 已回答的澄清是最硬的输入：它是人明确表过态的地方。不带进来的话，Agent 会把
     *   已经问清楚的东西重新假设一遍，而用户上一步逐条回答的工作等于白做。
     */
    answeredClarifications: req.clarifications
      .filter((c) => c.answer)
      .map((c) => ({ question: c.question, answer: c.answer })),
  },
  null,
  2,
)}
\`\`\`
`;
}
