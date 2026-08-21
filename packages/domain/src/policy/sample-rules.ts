import type { Policy } from '@apos/contracts';

/**
 * 一套真实形状的治理规则，**只在测试里用** —— 不从 `index.ts` 导出。
 *
 * ★★ 这份数据以前叫 `BASELINE_POLICIES`，是硬编码进产品的十条组织基线：
 *   不可删、不可放宽、永远参与求值。它被删掉了 —— 生效的规则只能是
 *   用户自己录进库里的那些，一条都没有就是零条。
 *
 *   但它作为**测试夹具**仍然值钱：求值顺序、优先级遮蔽、派发前的规则预警、
 *   体检的冲突与覆盖检测，全都需要一套条件互相交叠、动作严格程度不一的
 *   真实规则才测得出来。现编几条 `riskLevel == 'low'` 测不出这些。
 *
 *   所以搬到这里，身份从「产品行为」变成「测试数据」。它不再影响任何
 *   运行时路径，改它只会改测试。
 *
 * A realistic set of governance rules used **only by tests**; deliberately not
 * exported from the package index. This data used to be `BASELINE_POLICIES` —
 * ten organisation-level rules hard-coded into the product. Those are gone: the
 * rules in force are exactly the ones a user has entered, and none means none.
 * As a fixture it is still worth keeping, because priority shadowing, conflict
 * detection and gate selection only show up against rules whose conditions
 * overlap and whose actions differ in strictness.
 */

const ORG = '00000000-0000-0000-0000-000000000000';

function rule(
  id: string,
  name: string,
  priority: number,
  condition: Policy['condition'],
  action: Policy['action'],
  description: string,
): Policy {
  return {
    id,
    orgId: ORG,
    projectId: null,
    name,
    description,
    priority,
    enabled: true,
    condition,
    action,
  };
}

export const SAMPLE_RULES: Policy[] = [
  rule(
    'sample-payment',
    '执行付款需多人会签',
    1,
    { fact: 'operationType', op: 'eq', value: 'payment' },
    {
      type: 'require_multiple_approvals',
      approvers: [
        { kind: 'project_role', role: 'sponsor' },
        { kind: 'role', role: 'finance' },
      ],
      mode: 'all',
      dueInHours: 24,
    },
    '涉及资金流出的操作必须由业务负责人与财务共同批准',
  ),

  rule(
    'sample-permission-change',
    '修改权限需组织管理员批准',
    2,
    { fact: 'operationType', op: 'eq', value: 'permission_change' },
    {
      type: 'require_human_review',
      assignee: { kind: 'role', role: 'org_admin' },
      dueInHours: 8,
    },
    '权限变更会改变治理边界本身，必须由组织管理员确认',
  ),

  rule(
    'sample-delete-resource',
    '删除资源需多人会签',
    3,
    { fact: 'operationType', op: 'eq', value: 'delete_resource' },
    {
      type: 'require_multiple_approvals',
      approvers: [
        { kind: 'project_role', role: 'tech_lead' },
        { kind: 'owner_of', subject: 'work_item' },
      ],
      mode: 'all',
      dueInHours: 8,
    },
    '删除操作通常不可逆，需要两人确认',
  ),

  rule(
    'sample-security-policy',
    '修改安全策略需组织管理员批准',
    4,
    { fact: 'operationType', op: 'eq', value: 'security_policy_change' },
    {
      type: 'require_human_review',
      assignee: { kind: 'role', role: 'security_lead' },
      dueInHours: 8,
    },
    '安全策略变更需安全负责人确认',
  ),

  rule(
    'sample-prod-db',
    '生产数据库变更必须由 DBA 审批',
    5,
    {
      all: [
        { fact: 'environment', op: 'eq', value: 'production' },
        { fact: 'operationType', op: 'in', value: ['db_ddl', 'db_dml'] },
      ],
    },
    { type: 'require_human_review', assignee: { kind: 'role', role: 'dba' }, dueInHours: 4 },
    '生产库的结构或数据变更风险高且难以回滚',
  ),

  rule(
    'sample-sensitive-data',
    '访问受限数据需数据负责人批准',
    6,
    { fact: 'dataSensitivity', op: 'eq', value: 'restricted' },
    {
      type: 'require_human_review',
      assignee: { kind: 'role', role: 'data_owner' },
      dueInHours: 8,
    },
    '受限级数据默认不进入 Agent 上下文，如需访问必须单独批准',
  ),

  rule(
    'sample-send-external',
    '对外发送信息需人工确认',
    7,
    { fact: 'operationType', op: 'eq', value: 'send_external' },
    {
      type: 'require_human_review',
      assignee: { kind: 'project_role', role: 'pm' },
      dueInHours: 4,
    },
    '发给外部客户或公开渠道的内容不可撤回',
  ),

  rule(
    'sample-prod-deploy',
    '生产环境发布需发布负责人审批',
    8,
    {
      all: [
        { fact: 'environment', op: 'eq', value: 'production' },
        { fact: 'operationType', op: 'eq', value: 'deploy' },
      ],
    },
    {
      type: 'require_human_review',
      assignee: { kind: 'role', role: 'release_manager' },
      dueInHours: 4,
    },
    '生产发布默认需要审批',
  ),

  rule(
    'sample-budget-exceeded',
    '预算超限需 Sponsor 批准',
    9,
    { fact: 'budgetUsedPct', op: 'gte', value: 100 },
    {
      type: 'require_human_review',
      assignee: { kind: 'project_role', role: 'sponsor' },
      dueInHours: 8,
    },
    '预算超限的决策责任人是项目 Sponsor',
  ),

  rule(
    'sample-consecutive-failures',
    'Agent 连续失败 3 次转人工',
    10,
    { fact: 'consecutiveFailures', op: 'gte', value: 3 },
    { type: 'pause', resumeCondition: 'human_decision' },
    '反复失败说明存在系统性问题，继续重试只是烧钱',
  ),
];
