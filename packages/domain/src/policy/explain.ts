import type { Action, Condition, FactKey, Operator, Recipient } from '@apos/contracts';
import { formatTokens } from '../format/tokens';

/**
 * 自然语言解释 —— 页面文档 13 §5.6
 *
 * ★ 必须用模板拼接，不能用 LLM。解释与实际执行逻辑必须严格一致；
 *   LLM 生成的偏差会直接导致用户误配规则，而治理功能上的偏差不可接受。
 *   docs/tech/05-policy-engine.md §6
 */

export const FACT_LABELS: Record<FactKey, string> = {
  projectType: '项目类型',
  workItemType: '任务类型',
  riskLevel: '风险等级',
  reversible: '操作可逆性',
  externalFacing: '是否涉及外部客户',
  environment: '操作环境',
  dataSensitivity: '数据敏感度',
  impactTaskCount: '影响的任务数',
  impactServices: '涉及的服务',
  operationType: '操作类型',
  agentType: 'Agent 类型',
  agentConfidence: 'Agent 置信度',
  agentSuccessRate: 'Agent 历史成功率',
  consecutiveFailures: '连续失败次数',
  runTokens: '本次执行 token 用量',
  projectTokensSpent: '项目累计 token 用量',
  projectTokenBudget: '项目 token 预算',
  budgetUsedPct: '预算使用比例',
  testsResult: '自动测试结果',
  testCoverage: '测试覆盖率',
  securityScan: '安全扫描结果',
  agentReview: 'Review Agent 结论',
  autonomyLevel: '项目自治等级',
};

const VALUE_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '极高',
  passed: '通过',
  failed: '未通过',
  not_run: '未执行',
  concerns: '有意见',
  dev: '开发',
  test: '测试',
  staging: '预生产',
  production: '生产',
  public: '公开',
  internal: '内部',
  confidential: '机密',
  restricted: '受限',
  db_ddl: '数据库结构变更',
  db_dml: '数据库数据变更',
  deploy: '部署',
  delete_resource: '删除资源',
  permission_change: '权限变更',
  access_sensitive_data: '访问敏感数据',
  send_external: '对外发送信息',
  payment: '执行付款',
  security_policy_change: '安全策略变更',
  high_cost_resource: '使用高成本资源',
  code_change: '代码变更',
  read: '读取',
  human_led: '人类主导',
  agent_led_approval: 'Agent 主导 + 关键批准',
  agent_autonomous: 'Agent 自治',
  true: '是',
  false: '否',
};

const ROLE_LABELS: Record<string, string> = {
  pm: '项目负责人',
  tech_lead: '技术负责人',
  sponsor: '业务负责人',
  dba: 'DBA',
  security_lead: '安全负责人',
  release_manager: '发布负责人',
  data_owner: '数据负责人',
  finance: '财务',
  org_admin: '组织管理员',
};

/** 用量类 fact 用 token 缩写格式（1.2M），不用货币 */
const TOKEN_FACTS: readonly FactKey[] = ['runTokens', 'projectTokensSpent', 'projectTokenBudget'];
const PERCENT_FACTS: readonly FactKey[] = ['budgetUsedPct', 'testCoverage'];

function formatValue(fact: FactKey, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => formatValue(fact, v)).join('、');
  if (TOKEN_FACTS.includes(fact) && typeof value === 'number') {
    return `${formatTokens(value)} token`;
  }
  if (PERCENT_FACTS.includes(fact) && typeof value === 'number') return `${value}%`;
  if (fact === 'agentConfidence' || fact === 'agentSuccessRate') {
    if (typeof value === 'number') return `${Math.round(value * 100)}%`;
  }
  const key = String(value);
  return VALUE_LABELS[key] ?? key;
}

/** 操作符短语。数值类与枚举类的措辞不同，否则会出现「风险等级低于 高」这种别扭句子 */
function operatorPhrase(fact: FactKey, op: Operator, value: unknown): string {
  const numeric =
    typeof value === 'number' &&
    fact !== 'riskLevel';

  switch (op) {
    case 'eq':
      return `是${formatValue(fact, value)}`;
    case 'ne':
      return `不是${formatValue(fact, value)}`;
    case 'lt':
      return numeric ? `低于${formatValue(fact, value)}` : `低于${formatValue(fact, value)}`;
    case 'lte':
      return `不高于${formatValue(fact, value)}`;
    case 'gt':
      return `高于${formatValue(fact, value)}`;
    case 'gte':
      return `不低于${formatValue(fact, value)}`;
    case 'in':
      return `属于${formatValue(fact, value)}之一`;
    case 'not_in':
      return `不属于${formatValue(fact, value)}`;
    case 'contains':
      return `包含${formatValue(fact, value)}`;
  }
}

const CJK = '\\u4e00-\\u9fff\\u3000-\\u303f';
const LATIN = 'A-Za-z0-9$@#%&';

/**
 * 中英文之间补空格。解释文本是给人读的，「请DBA审批」这种挤在一起的
 * 排版会明显降低可读性。
 */
export function spaceCJK(text: string): string {
  return text
    .replace(new RegExp(`([${CJK}])([${LATIN}])`, 'g'), '$1 $2')
    .replace(new RegExp(`([${LATIN}])([${CJK}])`, 'g'), '$1 $2');
}

export function explainCondition(cond: Condition): string {
  if ('all' in cond) {
    if (cond.all.length === 0) return '任何情况';
    return cond.all.map(explainCondition).join('、且');
  }
  if ('any' in cond) {
    if (cond.any.length === 0) return '任何情况';
    return `满足以下任一条件（${cond.any.map(explainCondition).join('，或')}）`;
  }
  if ('not' in cond) {
    return `不满足（${explainCondition(cond.not)}）`;
  }
  return `${FACT_LABELS[cond.fact]}${operatorPhrase(cond.fact, cond.op, cond.value)}`;
}

export function explainRecipient(r: Recipient): string {
  switch (r.kind) {
    case 'role':
      return ROLE_LABELS[r.role] ?? r.role;
    case 'project_role':
      return ROLE_LABELS[r.role] ?? r.role;
    case 'user':
      return '指定人员';
    case 'owner_of':
      return r.subject === 'work_item' ? '任务负责人' : 'Agent 负责人';
  }
}

export function explainAction(action: Action): string {
  switch (action.type) {
    case 'allow':
      return '系统会自动放行，你不需要处理';
    case 'allow_and_notify':
      return `系统会自动批准，并通知${action.notify.map(explainRecipient).join('、')}。你不需要手动审批`;
    case 'require_agent_review':
      return `系统会先交给 ${action.agents.join('、')} 审核，通过后自动继续`;
    case 'require_human_review':
      return `系统会暂停并请${explainRecipient(action.assignee)}审批，需在 ${action.dueInHours} 小时内处理`;
    case 'require_multiple_approvals':
      return `系统会请${action.approvers.map(explainRecipient).join('、')}${
        action.mode === 'all' ? '全部' : '多数'
      }批准，需在 ${action.dueInHours} 小时内处理`;
    case 'ask':
      return `系统会继续执行，同时向${explainRecipient(action.assignee)}提出建议供参考`;
    case 'pause':
      return '系统会暂停该任务，等待人工处理后才能继续';
    case 'deny':
      return `系统会拒绝该操作（${action.message}）`;
    case 'escalate':
      return `系统会将该事项升级给${explainRecipient(action.to)}`;
    case 'transfer_to_human':
      return `系统会把这项工作转交给${explainRecipient(action.assignee)}人工完成`;
  }
}

export function explainPolicy(condition: Condition, action: Action): string {
  return spaceCJK(`当${explainCondition(condition)}时，${explainAction(action)}。`);
}
