# 把一段自然语言需求结构化

## 你要交付什么

在**当前工作目录**下写出一个文件 `apos-output.json`，内容是符合下面 schema 的
JSON。不要输出到别处，不要只在对话里打印，不要用 ``` 包裹整个文件内容。

写完就结束，不需要额外解释。文件写不出来 = 这次任务失败。

## schema

```jsonc
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
```


### 澄清问题怎么分级

| level | 什么时候用 |
| --- | --- |
| `must_confirm` | 答案会改变方案、工期或验收标准，猜错的代价是返工。**必须由人回答** |
| `default_applicable` | 有一个明显合理的行业/组织默认值，用户不表态就按默认走 |
| `assumption_ok` | 影响很小，直接记为假设继续推进即可 |
| `auto_resolved` | 你已经从原文里推断出答案，列出来只是让用户有机会纠正 |

★ 不要把所有问题都标成 `must_confirm`。每多一个必答问题，用户就多一道
坎；把可以用默认值的问题也拦下来，是在用用户的时间换你的保险。

★ 每个问题都要给 `agentSuggestion`（你的倾向）和 `suggestionBasis`（依据）。
只提问不给建议，等于在考用户。


## 几条硬要求

- `verification` 只能是 `auto`（CI 能自动验）、`agent`（Agent 能验）、
  `human`（必须人验）三者之一。写别的值会被拒收。
- **不要把原文换个说法填进每个字段**。`businessContext` 是背景，
  `userProblem` 是问题，`businessGoal` 是目标 —— 三者填成同一句话，
  等于什么都没分析。原文里确实没有的信息，应该变成 `clarifications`
  里的一个问题，而不是编一个填进去。
- 原文含糊的地方，宁可多问一个问题，也不要编一个具体值。

## 项目类型

development

## 需求原文

```
帮我创建一个Todo 待办事项的网页应用
```
