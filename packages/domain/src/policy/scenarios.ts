import {
  Environment,
  OperationType,
  RiskLevel,
  type AutonomyLevel,
  type PolicyContext,
} from '@apos/contracts';

/**
 * 场景网格 —— 摘要、冲突检测、不可达检测、覆盖缺口全都建立在它之上。
 *
 * ★ 为什么是枚举而不是求解：
 *   「这两条规则会冲突吗」在一般情况下是个约束求解问题。真去实现一个
 *   小型 SMT 求解器，代价大、结果还难以向用户解释 ——
 *   而这一页的用户要的不是「已证明无冲突」，是「给我看那个会出问题的场景」。
 *   把有限的、真实存在的场景跑一遍，得到的正是可以直接展示的反例。
 *
 * ★ 代价必须说清楚：网格覆盖不到的组合检测不出来。所以页面上写的是
 *   「检测到 N 个问题」，不是「没有问题」—— 后者是个我们给不出的保证。
 */

/** 只在这几个轴上展开。其余 fact 取一个中性默认，避免组合爆炸。 */
const AXES = {
  operationType: OperationType.options,
  riskLevel: RiskLevel.options,
  environment: [...Environment.options, null] as (Environment | null)[],
} as const;

export interface Scenario {
  key: string;
  context: PolicyContext;
}

/** 网格之外的 fact 取值。刻意取「一切正常」的一侧 —— */
/** 这样命中的规则都是因为场景本身的性质，而不是因为测试没过。 */
function baseContext(autonomyLevel: AutonomyLevel): PolicyContext {
  return {
    projectType: 'development',
    workItemType: 'task',
    riskLevel: 'low',
    reversible: true,
    externalFacing: false,
    environment: null,
    dataSensitivity: 'internal',
    impactTaskCount: 1,
    impactServices: [],
    operationType: 'read',
    agentType: 'coder',
    agentConfidence: 0.85,
    agentSuccessRate: 0.9,
    consecutiveFailures: 0,
    runTokens: 2,
    projectTokensSpent: 100,
    projectTokenBudget: 1000,
    budgetUsedPct: 10,
    testsResult: 'passed',
    testCoverage: 80,
    securityScan: 'passed',
    agentReview: 'passed',
    autonomyLevel,
  };
}

export function buildScenarios(autonomyLevel: AutonomyLevel): Scenario[] {
  const base = baseContext(autonomyLevel);
  const out: Scenario[] = [];

  for (const operationType of AXES.operationType) {
    for (const riskLevel of AXES.riskLevel) {
      for (const environment of AXES.environment) {
        out.push({
          key: `${operationType}|${riskLevel}|${environment ?? 'none'}`,
          context: {
            ...base,
            operationType,
            riskLevel,
            environment,
            // 高风险操作通常不可逆，让场景更贴近真实
            reversible: !['delete_resource', 'payment', 'deploy'].includes(operationType),
            externalFacing: operationType === 'send_external',
            dataSensitivity:
              operationType === 'access_sensitive_data' ? 'restricted' : base.dataSensitivity,
          },
        });
      }
    }
  }

  return out;
}

export const OPERATION_LABELS: Record<string, string> = {
  read: '读取代码与文档',
  code_change: '修改代码',
  db_ddl: '数据库结构变更',
  db_dml: '数据库数据变更',
  deploy: '部署发布',
  delete_resource: '删除资源',
  permission_change: '权限变更',
  access_sensitive_data: '访问敏感数据',
  send_external: '对外发送信息',
  payment: '执行付款',
  security_policy_change: '安全策略变更',
  high_cost_resource: '申请高成本资源',
};

export const ENV_LABELS: Record<string, string> = {
  dev: '开发环境',
  test: '测试环境',
  staging: '预生产环境',
  production: '生产环境',
  none: '不涉及特定环境',
};
