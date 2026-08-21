/**
 * 哪个前缀住在哪个文件 / Which key prefix lives in which module.
 *
 * ★★ 这张表存在的理由是**让分组成为被检查的事实，而不是一条约定**。
 *
 *   词条表此前是一个 2900 行的单文件，它的分节名已经漂成「补遗二」
 *   「最后一批」—— 按加入时间命名，而不是按内容。那不是谁偷懒：
 *   当「新键放哪儿」的唯一答案是「文件末尾」时，结果必然如此。
 *
 *   拆成十个文件本身挡不住这件事重演 —— 一年后同样会有人把
 *   `analytics.*` 的新键顺手写进 `common.ts`，因为那个文件正好开着。
 *   所以前缀归属写在这里，由 `structure.test.ts` 逐条核对：放错文件是**测试失败**，
 *   而不是一条没人执行的规矩。
 *
 *   Splitting into ten files does not by itself prevent the drift that
 *   produced "addendum two": a year from now someone will put a new
 *   `analytics.*` key into `common.ts` because that file happened to be open.
 *   The mapping is declared here and checked, so a misplaced key fails a test
 *   rather than quietly settling in.
 *
 * ★ 加一个新前缀时，把它加进下面某一组。**不允许**有不属于任何一组的前缀 ——
 *   测试同时从两头查：文件里的键必须属于本组，本组的前缀必须真的有键。
 *   前者防「放错地方」，后者防「这张表本身过期」。
 */
export const BUCKETS = {
  /** 全局外壳、通用动作、格式化、登录、账号 —— 不属于任何单一页面的那些 */
  common: [
    'common', 'nav', 'shell', 'ui', 'states', 'toast', 'theme', 'locale', 'identity',
    'format', 'notFound', 'login', 'accounts', 'conn', 'chip', 'badge', 'list',
    'whatIs', 'project', 'org', 'source', 'api',
  ],
  /** 服务端报错。与 `ErrorReason` / `NotFoundEntity` 一一对应，见 docs/tech/12-i18n.md */
  errors: ['error'],
  /** 看板与工作项 */
  board: [
    'board', 'kanban', 'card', 'planCard', 'itemDrawer', 'createItem', 'move', 'deps',
    'workItemStatus', 'workItemType', 'risk', 'priority', 'executor', 'blocked', 'gated',
  ],
  /** 需求与澄清 */
  requirement: ['requirement', 'clarify', 'editor', 'sot', 'completeness'],
  /** 计划与版本对比 */
  plan: ['plan', 'planDiff'],
  /** Agent：配置、详情、能力、授权、Run */
  agent: [
    'agentCfg', 'agents', 'agent', 'agentDetail', 'agentTab', 'agentView', 'agentState',
    'cap', 'capability', 'access', 'scopes', 'binding', 'credential', 'perm',
    'runTab', 'runDetail', 'runSum', 'runCtl', 'artifact', 'errClass',
  ],
  /** 分析页与总览 */
  analytics: [
    'analytics', 'overview', 'flow', 'hitl', 'cost', 'quality', 'benefit', 'insights',
    'chart', 'timeline', 'highlight',
  ],
  /** Policy 与决策 */
  policy: [
    'policy', 'rule', 'ruleList', 'scenario', 'hits', 'opType', 'env',
    'decision', 'decisions', 'decDrawer', 'decisionView',
  ],
  /** 设置：角色、成员、存储、仓库、集成、通知 */
  settings: ['roles', 'role', 'members', 'storage', 'ws', 'integ', 'notify', 'conflict'],
  /** 执行图、诊断与领域事件 */
  graph: ['graph', 'diag', 'shape', 'edge', 'event', 'eventPrefix'],
} as const;

export type Bucket = keyof typeof BUCKETS;

/** 前缀 → 该去哪个文件。放错地方时测试报的就是这张表算出来的答案 */
export const BUCKET_OF: Record<string, Bucket> = Object.fromEntries(
  Object.entries(BUCKETS).flatMap(([bucket, prefixes]) =>
    prefixes.map((p) => [p, bucket as Bucket]),
  ),
);
