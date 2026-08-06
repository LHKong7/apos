import type { Action, Condition, FactKey, FactValue } from '@apos/contracts';

/**
 * 规则模板 —— 页面文档 13 §12.1 的建议：
 * 「MVP 只做模板化配置（选择场景 → 填几个参数），把省下的资源投入模拟功能」。
 *
 * ★ 这个建议是对的，理由不是省事：真正需要设定 Agent 边界的是项目负责人，
 *   不是工程师。给他一个条件表达式编辑器，他要么不敢配，要么配错 ——
 *   两种结果都比「只有五个模板」糟糕。模板把「我想要什么」直接映射成规则，
 *   中间不经过规则语法。
 *
 *   自由条件编辑仍然保留（单层 all/any），但它是第二条路，不是默认路。
 */

export interface TemplateParam {
  key: string;
  label: string;
  /** 填这个参数是在回答什么问题 —— 参数名本身往往不够 */
  hint?: string;
  type: 'select' | 'number' | 'role';
  options?: { value: string; label: string }[];
  default: string | number;
  suffix?: string;
}

export interface PolicyTemplate {
  id: string;
  scenario: string;
  name: string;
  /** 一句话说明这个模板解决什么问题 */
  purpose: string;
  /** 收紧还是放宽 —— 放宽类必须先模拟（§8） */
  direction: 'tighten' | 'loosen';
  params: TemplateParam[];
  build: (values: Record<string, string | number>) => { condition: Condition; action: Action };
}

const ROLE_OPTIONS = [
  { value: 'tech_lead', label: '技术负责人' },
  { value: 'pm', label: '项目负责人' },
  { value: 'dba', label: 'DBA' },
  { value: 'release_manager', label: '发布负责人' },
  { value: 'security', label: '安全负责人' },
  { value: 'sponsor', label: '业务负责人' },
];

const PROJECT_ROLES = new Set(['tech_lead', 'pm', 'sponsor']);

/** 按角色而不是具体人指派 —— 人员变动时规则不用改（§5.5） */
function assignee(role: string): Action extends { assignee: infer A } ? A : never {
  return (
    PROJECT_ROLES.has(role)
      ? { kind: 'project_role', role }
      : { kind: 'role', role }
  ) as never;
}

const ENV_OPTIONS = [
  { value: 'production', label: '生产环境' },
  { value: 'staging', label: '预生产环境' },
  { value: 'test', label: '测试环境' },
  { value: 'dev', label: '开发环境' },
];

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: 'auto-approve-low-risk',
    scenario: '减少审批',
    name: '低风险任务自动批准',
    purpose: '测试通过、成本可控的低风险任务不再找人审批',
    direction: 'loosen',
    params: [
      {
        key: 'maxCost',
        label: '单次执行成本上限',
        hint: '超过这个金额仍然找人 —— 便宜的错误可以接受，贵的不行',
        type: 'number',
        default: 10,
        suffix: 'USD',
      },
      {
        key: 'requireTests',
        label: '是否要求自动测试通过',
        type: 'select',
        options: [
          { value: 'yes', label: '要求（推荐）' },
          { value: 'no', label: '不要求' },
        ],
        default: 'yes',
      },
      {
        key: 'notify',
        label: '自动批准后通知谁',
        type: 'role',
        options: ROLE_OPTIONS,
        default: 'pm',
      },
    ],
    build: (v) => ({
      condition: {
        all: [
          { fact: 'riskLevel', op: 'eq', value: 'low' },
          { fact: 'runCost', op: 'lt', value: Number(v.maxCost) },
          ...(v.requireTests === 'yes'
            ? ([{ fact: 'testsResult', op: 'eq', value: 'passed' }] as Condition[])
            : []),
        ],
      },
      action: {
        type: 'allow_and_notify',
        notify: [assignee(String(v.notify))],
      },
    }),
  },

  {
    id: 'gate-environment',
    scenario: '环境管控',
    name: '指定环境的操作必须审批',
    purpose: '生产环境（或其他指定环境）的任何变更都要人点头',
    direction: 'tighten',
    params: [
      { key: 'env', label: '哪个环境', type: 'select', options: ENV_OPTIONS, default: 'production' },
      { key: 'approver', label: '谁来审批', type: 'role', options: ROLE_OPTIONS, default: 'release_manager' },
      { key: 'dueInHours', label: '期望多久内处理', type: 'number', default: 4, suffix: '小时' },
    ],
    build: (v) => ({
      condition: {
        all: [
          { fact: 'environment', op: 'eq', value: String(v.env) },
          { fact: 'operationType', op: 'in', value: ['deploy', 'db_ddl', 'db_dml', 'delete_resource'] },
        ],
      },
      action: {
        type: 'require_human_review',
        assignee: assignee(String(v.approver)),
        dueInHours: Number(v.dueInHours),
      },
    }),
  },

  {
    id: 'failure-to-human',
    scenario: '异常兜底',
    name: 'Agent 连续失败转人工',
    purpose: '反复失败说明有系统性问题，继续重试只是在烧钱',
    direction: 'tighten',
    params: [
      {
        key: 'threshold',
        label: '连续失败几次后转人工',
        hint: '设太小会频繁打扰人，设太大会浪费预算',
        type: 'number',
        default: 3,
        suffix: '次',
      },
      { key: 'escalateTo', label: '升级给谁', type: 'role', options: ROLE_OPTIONS, default: 'tech_lead' },
    ],
    build: (v) => ({
      condition: { fact: 'consecutiveFailures', op: 'gte', value: Number(v.threshold) },
      action: { type: 'escalate', to: assignee(String(v.escalateTo)) },
    }),
  },

  {
    id: 'cost-gate',
    scenario: '成本管控',
    name: '单次执行超过金额需审批',
    purpose: '贵的执行先问一句，避免一个跑飞的任务吃掉预算',
    direction: 'tighten',
    params: [
      { key: 'threshold', label: '成本阈值', type: 'number', default: 20, suffix: 'USD' },
      { key: 'approver', label: '谁来审批', type: 'role', options: ROLE_OPTIONS, default: 'tech_lead' },
    ],
    build: (v) => ({
      condition: { fact: 'runCost', op: 'gte', value: Number(v.threshold) },
      action: {
        type: 'require_human_review',
        assignee: assignee(String(v.approver)),
        dueInHours: 4,
      },
    }),
  },

  {
    id: 'agent-review-first',
    scenario: '减少审批',
    name: '先让 Review Agent 过一遍',
    purpose: '把人从第一轮检查里解放出来，只在 Agent 有意见时才介入',
    direction: 'loosen',
    params: [
      {
        key: 'risk',
        label: '适用到哪个风险等级为止',
        type: 'select',
        options: [
          { value: 'low', label: '仅低风险' },
          { value: 'medium', label: '低与中风险' },
        ],
        default: 'medium',
      },
    ],
    build: (v) => ({
      condition: {
        all: [
          {
            fact: 'riskLevel',
            op: 'in',
            value: (v.risk === 'low' ? ['low'] : ['low', 'medium']) as FactValue,
          },
          { fact: 'operationType', op: 'in', value: ['code_change', 'read'] },
        ],
      },
      action: { type: 'require_agent_review', agents: ['review-agent'] },
    }),
  },

  {
    id: 'external-facing',
    scenario: '对外内容',
    name: '涉及外部客户的内容必须人工确认',
    purpose: '发出去就收不回来的东西，让人看一眼',
    direction: 'tighten',
    params: [
      { key: 'approver', label: '谁来确认', type: 'role', options: ROLE_OPTIONS, default: 'pm' },
    ],
    build: (v) => ({
      condition: { fact: 'externalFacing', op: 'eq', value: true },
      action: {
        type: 'require_human_review',
        assignee: assignee(String(v.approver)),
        dueInHours: 4,
      },
    }),
  },
];

export function templateById(id: string): PolicyTemplate | undefined {
  return POLICY_TEMPLATES.find((t) => t.id === id);
}

/** 可编辑的 fact 白名单。网格外的 fact 也能用，但要让用户知道模拟测不到它 */
export const EDITABLE_FACTS: FactKey[] = [
  'riskLevel',
  'workItemType',
  'operationType',
  'environment',
  'dataSensitivity',
  'externalFacing',
  'reversible',
  'runCost',
  'budgetUsedPct',
  'consecutiveFailures',
  'testsResult',
  'securityScan',
  'agentReview',
  'agentConfidence',
  'impactTaskCount',
];
