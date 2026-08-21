import type { StructureInput, StructuredRequirement } from './provider';

/**
 * Agent 要写出的文件名。
 *
 * ★ 固定成一个约定路径，而不是让 Agent 自己起名再去猜：
 *   猜的那一步没有任何收益，却引入了一整类「跑完了但找不到产物」的失败。
 */
export const OUTPUT_FILE = 'apos-output.json';

/**
 * 任务书。这是 Agent 唯一看得到的东西，写得好不好直接决定产出质量。
 *
 * 三条原则：
 * 1. **先说交付物再说任务** —— 这些 CLI 会边读边动手，把"写到哪个文件、
 *    什么格式"放在最后，它很可能已经按自己的想法写了一半。
 * 2. **给 schema 而不是给描述** —— "包含验收标准"会得到各种形状；
 *    给出字段名与取值枚举，才可能一次通过校验。
 * 3. **说清楚判断标准而不是只说做什么** —— 澄清问题分四级这件事，
 *    不解释「什么算 must_confirm」的话，Agent 会把所有问题都标成最高级。
 */
function header(task: string): string {
  return `# ${task}

## 你要交付什么

在**当前工作目录**下写出一个文件 \`${OUTPUT_FILE}\`，内容是符合下面 schema 的
JSON。不要输出到别处，不要只在对话里打印，不要用 \`\`\` 包裹整个文件内容。

写完就结束，不需要额外解释。文件写不出来 = 这次任务失败。
`;
}

/** 澄清分级的判据。不写清楚的话所有问题都会被标成 must_confirm */
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
 * 输出语言指令。
 *
 * ★★ 必须显式写死，不能靠 brief 自己是中文来暗示。
 *   brief 是中文而需求是英文时，模型两边都占理，于是它每次自己选一个 ——
 *   现场就是同一个项目里中英两份 PRD 并存（问题记录：BUG-4）。
 *
 * ★ 只约束**平台要它写的字段**。用户原话、既有代码里的标识符照抄，
 *   翻译它们等于给用户的东西改名。
 *
 * Stated explicitly because an implicit cue (a Chinese brief) loses to an
 * English requirement about half the time.
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
      "ref": "research",                    // 计划内唯一的临时 ID，用于表达依赖
      "title": "任务标题",
      "description": "做什么、做到什么程度",
      "type": "research",                   // requirement|feature|story|task|bug|research|
                                            // review|test|incident|decision|approval|release|knowledge
      "phase": "Research",                  // 自定义阶段名，用于分组
      "estimatedHours": 4,
      "estimatedTokens": 75000,             // 预计消耗的 token 数，估不出来填 null
      "riskLevel": "low",                   // low|medium|high|critical
      "requiredSkills": ["需求分析"],
      // 语义能力，**不是**工具名。可选值：workspace.read|workspace.write|
      // command.build|command.test|network.external|artifact.create|
      // repository.push|pull_request.create|pull_request.merge|environment.deploy|
      // database.read|database.write|secret.read
      "requiredCapabilities": ["workspace.read"],
      "requiresHuman": false,
      // 下面四项都可选，但**只能填枚举里的值**，拼错会整份计划打回重来。
      // read|code_change|db_ddl|db_dml|deploy|delete_resource|permission_change|
      // access_sensitive_data|send_external|payment|security_policy_change|high_cost_resource
      "operationType": "deploy",
      "environment": "production",          // dev|test|staging|production
      "dataSensitivity": "internal",        // public|internal|confidential|restricted
      "externalFacing": false,              // 产出会发给外部客户或公开渠道吗
      "acceptanceCriteria": [{ "text": "…", "verification": "auto" }],
      "dependsOn": [{ "ref": "design", "type": "finish_to_start" }]
    }
  ],
  "milestones": [{ "name": "里程碑名", "taskRefs": ["research"], "dueOffsetDays": 3 }],
  "risks": [{ "description": "风险", "level": "medium", "mitigation": "缓解措施" }]
}
\`\`\`

## 几条硬要求

- \`dependsOn\` 里的 \`ref\` **必须指向本计划内真实存在的任务**。指向不存在的
  ref 会让那条依赖被静默丢弃，于是一个还不该开始的任务被派出去执行。
- **依赖不能成环**。A 依赖 B、B 依赖 A 的话，两个任务会永远互相等待，
  界面上表现为两张卡永久卡住。
- 生产环境的发布与数据库结构变更必须 \`"requiresHuman": true\`，
  并标上 \`operationType\` 与 \`environment\`。
- \`operationType\` / \`environment\` / \`dataSensitivity\` **只能取上面列出的值**。
  拼错或自造一个值会让整份计划被拒收 —— 不确定就别填这一项，
  填一个近似的值比留空危险得多：治理规则会因此静默地匹配不上。
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
     * ★★ 已回答的澄清是**最硬的输入**：它是人明确表过态的地方。
     *   不带进来的话，Agent 会把已经问清楚的东西重新假设一遍，
     *   而用户上一步逐条回答的工作等于白做。
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
