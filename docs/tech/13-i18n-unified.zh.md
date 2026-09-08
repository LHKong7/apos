# 13 · 前后端统一的多语言方案

*[English version / 英文版本](13-i18n-unified.md)*

[12 · 多语言](12-i18n.zh.md) 讲的是已经有的东西：前端的词条目录，以及 HTTP 层吐出来的原因码。这篇讲**没做完的那一半**。

现在的设计里藏着一条没说出口的边界：**服务端能给出「码」，但给不出中文以外的任何一句话** —— 词条目录长在 `apps/web` 里，只有浏览器够得着。于是所有不落在浏览器里的路径，末端都是写死的中文：通知、策略模板表单、guard 失败、日志、导出。

这不是「有几处漏翻了」，是结构性的：码 + 参数这套纪律止步于 HTTP 响应信封，越过这条线之后，一切悄悄退回到没有 i18n 之前的样子。

**方案一句话：一份目录、一个渲染器、一种线上格式 —— 只在最后一跳出去的时候渲染，按读的人的语言。**

---

## 1. 到底哪些没做完

| 路径 | 现状 | 英文读者看到什么 |
| --- | --- | --- |
| HTTP 报错 | `fail(code, reason, 中文, {params})` | ✅ 正确 —— 界面按码取词 |
| 拒绝原因 / 决策原因 | `blocked_detail`、`reason_detail` 里存码 + 参数 | ✅ 正确 |
| **策略模板** | `/policy-templates` 直接把 `name` / `purpose` / `label` / `suffix` 作为中文送出（`domain/policy/templates.ts:137`） | 一整张配置表单是中文 |
| **策略解释** | 句子在 `domain/policy/explain.ts:177` 拼出来 | 唯一一处解释「这条治理规则到底做什么」的界面 |
| **通知** | `buildDecisionMessage` 拼中文片段（`domain/notification/decide.ts:133`） | Slack / 飞书 / 邮件只有中文 |
| **Guard 失败** | `` `${unmet.length} 个前置依赖未满足` ``（`domain/flow/guards.ts:110`） | 被列在 `REASONS_WITHOUT_CATALOG` 里豁免 |
| **角色校验** | `` `不认识这些权限：${unknown.join('、')}` ``（`domain/rbac/roles.ts:181`） | 中文，外加一个中文顿号 |
| **枚举文案** | 两张表 —— `FACT_LABELS`（中文，domain）与 `policyFactLabel()`（词条，web） | 两张表迟早对不上 |
| **「找不到」** | 两张表 —— `NOT_FOUND_PROSE`（中文）与 `error.notFound.*` | 同上 |
| **时长** | `humanMinutes()` 返回 `3 小时` | 语言被腌进了值里 |
| **日志** | 中文 | 值班的人不认识中文 |

这张表里其实藏着三种不同的故障，修法也不同：

1. **服务端没有目录。**（通知、模板、解释、日志）
2. **句子是拼出来的** —— 文档 12 已经在界面侧禁止了这件事，但服务端根本没有遵守它的手段。（guard、角色、解释）
3. **值里面带着语言** —— `3 小时`、`a、b、c`。这一类再完美的目录也救不回来：等字符串走到渲染器面前时，语言早就在里面了。

---

## 2. 四层，一个方向

```
产生               目录                 渲染                    阅读
─────────          ─────────            ─────────               ────────
domain / api  ──▶  packages/i18n   ──▶  浏览器（useT）      ──▶  界面
  吐出描述符        唯一写着语言          最后一跳出去            Slack / 邮件
  { key, params }   的地方               （通知传输层、           日志文件
                                          导出、日志）           导出文件
```

两条规则决定了整个设计：

**① 目录层以上的任何地方都不含语言。** `domain/` 里返回一句话的函数是 bug，性质和 domain 里 `import '@apos/db'` 一样。它应当返回一个描述符。

**② 渲染尽可能晚，且只发生两次。** 在浏览器里，或者在一条消息离开产品、走向一个装不下描述符的通道的那一刻。中间任何一处都不渲染。

---

## 3. 一个决定：API 不认语言

「统一」最顺手的答案是让 API 读 `Accept-Language`、返回译好的响应。这个方案**刻意不这么做**，理由才是重点 —— 正是这些理由让前后端可以共享**一份目录**，而不是共享一个翻译服务。

| 为什么不在 API 里翻 | |
| --- | --- |
| **SSE 有多个读者** | 一条 `project:{id}:board` 推送要扇出给项目里所有人。根本不存在「发起请求的那个人」，也就没有一种语言可以渲染成。就算按请求渲染，推送这条路也得再把它拆回来。 |
| **幂等重放会跨用户** | 重放的响应是从存下来的载荷里取的。一份被冻结成首个请求者语言的载荷，接下来会被送给另一个人。 |
| **切换必须是免费的** | 否则切语言就要作废整个查询缓存重新拉一遍。渲染放在客户端，它只是把内存里已有的东西重渲一次。 |
| **界面无论如何都要那个码** | `error.reason` 决定的不只是一句话：显示哪个按钮（「去授权」「一键修复」）、跳到哪一页、要不要重试。服务端翻译并不能省掉这个码，只是多了一样要同步的东西。 |

拒绝 `Accept-Language` 还有文档 12 拒绝 `navigator.language` 的那个理由：国内机器上它经常是 `zh-CN`，而使用者恰恰想要英文界面。何况**通知根本不是一个请求** —— 组装一条 Slack 消息的那一刻，没有任何 header 可读。

**所以：HTTP 表面永不本地化，只有两端渲染。**

---

## 4. `packages/i18n` —— 共享目录

```
packages/i18n/
  src/
    messages/
      buckets.ts     前缀 → 模块，外加一列「归属」（§4.1）
      en/            从 apps/web 原样搬来的十个模块
      zh/            仍按模块钉死在 en/ 上
    render.ts        render(locale, text) —— 单复数、插值、列表连接
    format.ts        数字 / 时长 / 时刻 / 百分比，按语言
    keys.ts          MessageKey、hasMessage
    locale.ts        Locale = 'en' | 'zh'、DEFAULT_LOCALE = 'en'
```

依赖方向在最底下多一环：

```
http → modules → domain → contracts → i18n
```

`@apos/i18n` 不 import 任何东西。`contracts`（为了描述符类型）以及它上面的一切都可以 import 它。

**为什么不塞进 `contracts`。** contracts 是线上契约 —— 类型与 Zod，几乎没有运行时，而且它是外部 Agent SDK 要消费的东西。让它背上 2700 条 × 2 种语言的界面文案，等于谁想知道 `WorkItem` 长什么样，谁就得连所有按钮文字一起下载。

**留在 `apps/web` 的**：`useT`、zustand 的 locale store、`<html lang>`、`useSpecText`、`format/index.ts` 里的 `xxxLabel()`。那些是 React 与浏览器的事。这次搬家只搬目录和纯函数 —— web 侧继续从 `lib/i18n` 再导出，阶段 0 里没有任何调用点需要改。

### 4.1 词条归属

`buckets.ts` 增加第三列：这条词条由谁渲染。

| 归属 | 含义 | 例子 |
| --- | --- | --- |
| `web` | 只在浏览器里渲染 | `board.column.review` |
| `server` | 只在最后一跳渲染 | `notify.decision.title` |
| `shared` | 两边都有 | `error.reason.*`、枚举文案 |

它存在是因为共享目录带来了一种前端从未有过的故障：**改一个按钮的措辞，弄坏一条 Slack 消息或一行日志**。`structure.test.ts` 扩一条断言：服务端会渲染的键不得声明为 `web` 归属 —— 至少让这条反向依赖在 diff 里看得见。

---

## 5. 线上格式：一个描述符

```ts
// packages/contracts/src/common/text.ts
export interface Text {
  key: MessageKey;
  params?: TextParams;
  /** 给码出现之前写下的存量行、以及不认识码的客户端 */
  fallback?: string;
}

export type TextParams = Record<string, TextValue>;
export type TextValue =
  | string          // 用户自己写的词 —— 原样带过去，永不翻译
  | number
  | Text            // 嵌套的一句话（§5.2）
  | TextValue[]     // 列表 —— 由渲染器连接（§5.3）
  | { kind: 'duration'; minutes: number }
  | { kind: 'instant'; iso: string }
  | { kind: 'percent' | 'money' | 'count'; value: number };
```

这就是 `ErrorReason` + `params` 已经在做的事，给它一个名字和一个类型，于是它可以去任何地方：事件载荷、`blocked_detail`、通知任务、洞察、策略模板字段。

### 5.1 只放语言中立的值

文档 12 §3.6 已经这么要求，现在它可以被强制：一个裸 `string` 参数**按定义**就是用户自己的词。凡是平台算出来的，要么进标签值，要么进嵌套的 `Text`。`params: { range: '近 7 天' }` 不再是「不建议」—— 而是**没有一种写法能让它渲染正确**，这正是目的。

### 5.2 组合，但不拼接

「永不拼句子」会撞上真实存在的复合消息：*「被挡住了：3 个前置依赖未满足，且 Review 阶段已达 WIP 上限」*。答案是嵌套，不是连接：

```ts
{ key: 'guard.blocked_multi', params: { reasons: [
    { key: 'guard.deps_unmet', params: { count: 3 } },
    { key: 'guard.wip_limit',  params: { stage: 'review', limit: 5 } },
] } }
```

每一条都是本语言里完整的一句话，外层那条决定它们怎么摆在一起。渲染器深度优先解析。嵌套限深 3 —— 再深说明这个复合句本身该是一条词条。

### 5.3 列表由渲染器连接

`joinList()` 搬进 `packages/i18n`，对任何数组参数生效：中文用 `、`，英文用 `, ` 且最后一项前加 `and`。`domain/rbac/roles.ts:181` 与 `domain/policy/explain.ts:91` 不再 `.join()`，直接把数组送出去。

### 5.4 时长、数字、时刻

返回 `3 小时` 的 `humanMinutes()` 删掉；`{ kind: 'duration', minutes }` 在渲染时交给 `Intl.RelativeTimeFormat` / `Intl.NumberFormat`。这一类 bug 是光有目录修不掉的，也正是描述符要携带标签值、而不是预先格式化好的字符串的原因。

---

## 6. 用哪种语言，在哪里决定

渲染需要一个 locale，而每个边缘从不同的地方拿。**永远不从 header 拿。**

| 场景 | locale 来自 | 回落链 |
| --- | --- | --- |
| 浏览器界面 | 显式选择的 store（文档 12 §2①） | `en` |
| 发给某个人的通知 | `users.locale` | 项目 → 组织 → `en` |
| 发到群里的通知（Slack 群不是一个人） | `projects.locale` | 组织 → `en` |
| 邮件 | 收件人的 `users.locale` | `en` |
| 导出（CSV/PDF） | 发起导出的用户，显式作为查询参数带上 | `en` |
| 日志行、审计文本、`fallback` 字段 | `APOS_LOG_LOCALE`，全部署一个值，启动时定死 | `en` |
| Run 里给 Agent 看的文本 | `projects.locale` —— 读这次 run 的人在那个项目里 | `en` |

新增三个可空列：`users.locale`、`projects.locale`、`organizations.locale`。**可空是有含义的** —— `NULL` 表示「继承」，和显式写 `en` 不是一回事，等到组织设了默认语言那天，两者的差别就会显出来。

`APOS_LOG_LOCALE` 是每部署一个值而不是每请求一个：一个相邻两行不同语言的日志文件，比整个用错语言更糟 —— 它让 grep 失效。

---

## 7. 渲染完的东西一律不落库

`blocked_detail` 已经存的是码和参数而不是句子，其余一切照此办理：通知任务、决策原因、洞察、事件。**去年写下的一行，按今天读它的人的语言渲染** —— 如果当初存的是句子，这件事不可能做到。

存量行只有句子、没有码。它们靠 `Text.fallback` 继续工作，这正是 `REASONS_WITHOUT_CATALOG` 和现在的 `message` 字段已经在做的事。不回填、不迁移历史数据 —— 渲染器优先用键，取不到就落回存着的那句话。

---

## 8. `fail()` 交出它的句子

目录一旦对服务端可见，第三个参数就是多余的：

```ts
throw fail('VALIDATION_FAILED', 'storage.delivery_target_readonly', { ref });   // ← 三个参数
```

响应信封里的 `message` 改为按 `APOS_LOG_LOCALE` 从目录渲染。这么做除了整洁还有两个理由：

- **消掉了漂移。** 抛出点的那句话和词条是同一件事的两种说法，各改各的。现在已经有几处对不上了。
- **消掉了造成这个缺口的那条路。** 文档 12 说过 `code, reason, message` 这个顺序的存在意义是堵住「先写句子、码以后补」。把句子拿掉，这个选项就不存在了。

`NOT_FOUND_PROSE` 同理消失 —— `error.notFound.<entity>` 成为唯一一张表。

---

## 9. 两处「刻意留白」变成码

文档 12 §5 刻意让 `guard.failed` 与 `policy.denied` 保留服务端原句，因为笼统的「有前置条件不满足」把具体信息全扔了。那个判断是对的，本方案不推翻它 —— 而是让它不再必要。

```ts
export type GuardReason =
  | { code: 'guard.deps_unmet'; params: { count: number; items: string[] } }
  | { code: 'guard.wip_limit'; params: { stage: StageKey; limit: number } }
  | { code: 'guard.no_executor' }
  | { code: 'guard.no_artifact' }
  | { code: 'guard.acceptance_unmet'; params: { count: number } }
  | { code: 'guard.quality_gate'; params: { checks: string[] } };
```

`guards.ts` 里六个分支，六个码。策略拒绝变成 `{ ruleId, ruleName, factCode, expected, actual }` —— 规则名是用户自己起的，原样带过去；其余都是界面早就有文案的枚举。

`REASONS_WITHOUT_CATALOG` 最终应当为空。**但机制留着**：它是「刻意不翻」与「忘了翻」之间唯一的分界，下一次刻意留白不该再发明一遍。

---

## 10. 守住新防线的测试

文档 12 的四个测试保留。再加四个，它们盯的是同一件事：**写代码的人看不见的沉默失效**。

| 测试 | 守什么 | 什么时候红 |
| --- | --- | --- |
| `i18n/coverage.test.ts` | **所有**枚举里的每一个码 —— `ErrorReason`、`GuardReason`、`RejectionCode`、`DecisionReason`、`Insight.code`、`PolicyIssue.type`、通知键、策略模板字段 —— 在两种语言里都取得到词 | 新码上线却没有句子 |
| `i18n/no-prose.test.ts` | 服务端「面向用户」的构造点里没有 CJK 字面量（`domain/notification/`、`flow/guards.ts`、`policy/explain.ts`、`policy/templates.ts`、`rbac/roles.ts`） | 该给描述符的地方有人写了句子 |
| `i18n/params.test.ts` | 参数值里不含 CJK、`、`、单位后缀；数组参数没有被预先连接 | 语言漏进了值里（§5.4） |
| `i18n/pseudo.test.ts` | 生成一份伪本地化的第三语言 `xx`（每条包成 `⟦…⟧`），渲染全部词条与全部枚举码，输出中不得出现没被包住的文本 | `packages/i18n` 之外还残留着语言 |

最后一个是整个方案的验收标准：**加一种语言如果只需要动 `packages/i18n/messages/`，方案就是成立的；只要还得改别处，就是不成立。**

---

## 11. 迁移 —— 五个阶段，每个都能单独上线

| # | 改动 | 影响面 | 结束时是绿的吗 |
| --- | --- | --- | --- |
| 0 | 建 `packages/i18n`；搬目录与纯函数；`apps/web/src/lib/i18n` 改为再导出 | 约 30 个文件移动，0 个调用点改动 | 是 —— 纯搬家 |
| 1 | contracts 里的 `Text`；服务端 `render()`；`APOS_LOG_LOCALE`；`fail()` 去掉句子参数；删 `NOT_FOUND_PROSE` | 所有 `fail()` 调用点（机械改动） | 是 |
| 2 | `users.locale` / `projects.locale` / `organizations.locale`；通知改为描述符并按收件人渲染；删 `humanMinutes` | `notification/`、传输层、一个迁移 | 是 |
| 3 | `GuardReason` 与策略拒绝码；清空 `REASONS_WITHOUT_CATALOG`；策略模板与 `explain.ts` 改吐描述符 | `flow/guards.ts`、`policy/`、策略相关页面 | 是 |
| 4 | 删掉 domain 里的 `XXX_LABELS` 中文表；日志行走渲染器 | `analytics/`、`policy/`、`graph/` | 是 |

顺序只有一处是硬的：阶段 1 必须在 2–4 之前，因为它们都要服务端渲染器。2、3、4 彼此独立，顺序任意，也可以并行。

阶段 0 刻意做成空操作。**一次既搬家又改行为的提交是没法评审的** —— diff 是 30 个文件重命名，那一处真正的改动就藏在里面看不见了。

---

## 12. 明确不做的事

写下来是为了让它们是决定，而不是遗漏：

- **RTL。** 阿拉伯语 / 希伯来语要的是布局镜像，不是一份目录。这里的东西不挡它，但也不做它。
- **CLDR 的完整单复数。** `_one` / `_other` 够 `en` 和 `zh` 用。真出现更多形态的语言（俄、阿、波兰），换掉 `render.ts` 里的挑选函数改用 `Intl.PluralRules` 即可 —— 一个函数，描述符格式不变。
- **翻译用户内容。** 需求正文、策略名、Agent 名、提交信息。永不。文档 12 §1。
- **机器翻译目录。** 目录小到写得完，又重要到不能猜 —— `error.reason.*` 那些词条是在告诉人「怎么把自己解开」。
- **时区。** 与语言是两条正交的轴（一个住柏林的中文用户），描述符里时刻本来就是 ISO 串，两者可以各自决定。
- **按语言懒加载目录。** 现在两种语言都是急切打包的，而一个要等分片下载的语言切换会闪。`buckets.ts` 里已经有按区域切分所需的映射 —— 等真量过包体积再做，不要提前做。

---

## 13. 落地之后，怎么加一句话

| 它是…… | 怎么做 |
| --- | --- |
| 界面文案 | 与文档 12 §7 一致 —— 在 `messages/{en,zh}/<area>.ts` 加一条键 |
| 服务端报错 | `fail(code, reason, { params })`，两侧目录各加 `error.reason.<code>`。不写句子。 |
| 通知 / 导出 / 日志行 | 返回一个 `Text`。只在传输层按收件人的语言渲染。 |
| Guard 或策略结论 | 在对应联合类型里加一个码，参数用语言中立的值 |
| 枚举文案 | 词条 + `xxxLabel()`。永不在 domain 里放中文表。 |
| 数字、时长、列表 | 标签值或数组。永不是一个格式化好的字符串。 |
