import type { Policy } from '@apos/contracts';

/**
 * 组织级基线规则 —— 产品文档 10.4 的九类高风险操作。
 *
 * 这些规则不可删除、不可被项目规则放宽。优先级 1–20 保留给它们，
 * 项目级规则（100+）永远排在后面，因此走不到项目规则。
 * docs/tech/09-security.md §4
 */

const ORG = '00000000-0000-0000-0000-000000000000';

function baseline(
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

export const BASELINE_POLICIES: Policy[] = [
  baseline(
    'baseline-payment',
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

  baseline(
    'baseline-permission-change',
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

  baseline(
    'baseline-delete-resource',
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

  baseline(
    'baseline-security-policy',
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

  baseline(
    'baseline-prod-db',
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

  baseline(
    'baseline-sensitive-data',
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

  baseline(
    'baseline-send-external',
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

  baseline(
    'baseline-prod-deploy',
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
    '生产发布默认需要审批（产品文档 8.8.6）',
  ),

  baseline(
    'baseline-budget-exceeded',
    '预算超限需 Sponsor 批准',
    9,
    { fact: 'budgetUsedPct', op: 'gte', value: 100 },
    {
      type: 'require_human_review',
      assignee: { kind: 'project_role', role: 'sponsor' },
      dueInHours: 8,
    },
    '产品文档 8.7.5：预算超限的决策责任人是项目 Sponsor',
  ),

  baseline(
    'baseline-consecutive-failures',
    'Agent 连续失败 3 次转人工',
    10,
    { fact: 'consecutiveFailures', op: 'gte', value: 3 },
    { type: 'pause', resumeCondition: 'human_decision' },
    '产品文档 8.9.3：反复失败说明存在系统性问题，继续重试只是烧钱',
  ),
];
