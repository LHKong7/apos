import { describe, expect, it } from 'vitest';
import type { Action, Condition, Policy } from '@apos/contracts';
import { auditPolicies, previewAutonomy } from './audit';
import { BASELINE_POLICIES } from './baseline';

let seq = 0;
function policy(
  name: string,
  priority: number,
  condition: Condition,
  action: Action,
  overrides: Partial<Policy> = {},
): Policy {
  seq++;
  return {
    id: `p-${seq}`,
    orgId: '00000000-0000-0000-0000-000000000000',
    projectId: '11111111-1111-1111-1111-111111111111',
    name,
    description: '',
    priority,
    enabled: true,
    condition,
    action,
    ...overrides,
  };
}

const ALLOW: Action = { type: 'allow' };
const GATE: Action = {
  type: 'require_human_review',
  assignee: { kind: 'project_role', role: 'tech_lead' },
  dueInHours: 4,
};

describe('规则集摘要', () => {
  /**
   * ★ 「N 类操作自动执行，M 类需要人类确认」是整页最重要的一行。
   *   用户不会去读 12 条规则再自己推导边界 —— 他要的就是这一句。
   */
  it('★ 把一堆规则翻译成「哪些自动、哪些找人」', () => {
    const { summary } = auditPolicies(BASELINE_POLICIES, 'agent_led_approval');

    const autoLabels = summary.auto.map((o) => o.label);
    const humanLabels = summary.human.map((o) => o.label);

    expect(autoLabels.length + humanLabels.length + summary.depends.length).toBeGreaterThan(0);
    // 付款在基线里是会签，任何情况下都不该出现在「自动执行」里
    expect(autoLabels).not.toContain('执行付款');
    expect([...humanLabels, ...summary.depends.map((o) => o.label)]).toContain('执行付款');
  });

  it('需要人时说清楚是谁', () => {
    const { summary } = auditPolicies(BASELINE_POLICIES, 'agent_led_approval');
    const payment = summary.human.find((o) => o.operationType === 'payment');
    if (payment) expect(payment.by).toBeTruthy();
  });

  /**
   * ★ 「视情况而定」必须说清楚是什么情况。
   *   一个只说「看情况」的摘要还不如不给 —— 用户仍然得自己去读规则。
   */
  it('★ 「视情况」的那一类要给出分界条件', () => {
    const rules = [
      policy(
        '生产部署要审批',
        10,
        { all: [{ fact: 'environment', op: 'eq', value: 'production' }, { fact: 'operationType', op: 'eq', value: 'deploy' }] },
        GATE,
      ),
      policy('其余部署放行', 20, { fact: 'operationType', op: 'eq', value: 'deploy' }, ALLOW),
    ];

    const { summary } = auditPolicies(rules, 'agent_autonomous');
    const deploy = summary.depends.find((o) => o.operationType === 'deploy');

    expect(deploy).toBeDefined();
    expect(deploy!.when).toContain('生产环境');
  });

  /**
   * ★ 真实的分界往往是析取的：「生产环境，或者风险高」。
   *   只在单个轴上找分界会一个都找不到，退化成「12 / 20 种情况需要人确认」——
   *   一句正确但毫无用处的话，用户看完还得自己去读规则。
   */
  it('★ 分界是「A 或 B」时也要说清楚，而不是退化成一个分数', () => {
    const { summary } = auditPolicies(BASELINE_POLICIES, 'agent_led_approval');
    const deploy = summary.depends.find((o) => o.operationType === 'deploy')!;

    expect(deploy.when).toBe('在生产环境，或风险等级为高、极高时需要人确认');
  });
});

describe('规则冲突', () => {
  /**
   * ★ 在「优先级先匹配、命中即停」的语义下，真正会伤人的冲突只有一种：
   *   规则作者以为自己加了一道闸，而那道闸永远轮不到。
   */
  it('★ 高优先级放行会让低优先级的更严要求永远不生效', () => {
    const rules = [
      policy('部署一律放行', 10, { fact: 'operationType', op: 'eq', value: 'deploy' }, ALLOW),
      policy(
        '生产部署要审批',
        20,
        { all: [{ fact: 'environment', op: 'eq', value: 'production' }, { fact: 'operationType', op: 'eq', value: 'deploy' }] },
        GATE,
      ),
    ];

    const { issues } = auditPolicies(rules, 'agent_led_approval');
    const conflict = issues.find((i) => i.type === 'conflict');

    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe('critical');
    // 给出具体反例，比任何描述都好懂
    expect(conflict!.example).toContain('生产环境');
  });

  it('严格程度递增的分层不算冲突', () => {
    const rules = [
      policy(
        '生产部署要审批',
        10,
        { all: [{ fact: 'environment', op: 'eq', value: 'production' }, { fact: 'operationType', op: 'eq', value: 'deploy' }] },
        GATE,
      ),
      policy('其余部署放行', 20, { fact: 'operationType', op: 'eq', value: 'deploy' }, ALLOW),
    ];

    expect(auditPolicies(rules, 'agent_led_approval').issues.some((i) => i.type === 'conflict')).toBe(
      false,
    );
  });
});

describe('覆盖缺口', () => {
  /**
   * ★ 用户配了几条规则就以为安全了，而漏配的场景悄悄走默认策略。
   *   出事时没人知道「原来这里根本没规则」。
   */
  it('★ 高风险操作没规则覆盖时明确报出来', () => {
    const rules = [policy('低风险放行', 10, { fact: 'riskLevel', op: 'eq', value: 'low' }, ALLOW)];
    const { issues } = auditPolicies(rules, 'agent_led_approval');
    const gaps = issues.filter((i) => i.type === 'coverage_gap');

    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]!.example).toBeTruthy();
  });

  /**
   * ★ 基线规则只管住了**生产环境**的库变更与部署。开发环境的同类操作
   *   没有任何规则，走的是自治等级的默认策略 —— 这正是「覆盖缺口」
   *   要抓的东西：规则看起来配了，实际只盖住了一半。
   */
  it('★ 只在生产环境设了闸时，其他环境仍算缺口', () => {
    const { issues } = auditPolicies(BASELINE_POLICIES, 'agent_led_approval');
    const gaps = issues.filter((i) => i.type === 'coverage_gap');

    const dbGap = issues.find((i) => i.message.includes('数据库结构变更'))!;
    expect(dbGap).toBeDefined();
    // 反例必须指出是哪个环境漏了，否则用户不知道该补什么
    expect(`${dbGap.message}${dbGap.example ?? ''}`).toContain('开发环境');
    void gaps;
  });

  /**
   * ★ 同一个操作既被某条规则放行、又在别的场景下没规则覆盖时，
   *   只出一条。分两条报读起来像同一件事说了两遍 ——
   *   用户会怀疑体检在凑数，然后连真正重要的那条一起略过。
   */
  it('★ 一个操作只出一条，两种成因写在同一句里', () => {
    const rules = [
      policy('低风险放行', 100, { fact: 'riskLevel', op: 'eq', value: 'low' }, ALLOW),
    ];
    const { issues } = auditPolicies(rules, 'agent_led_approval');
    const dbIssues = issues.filter((i) => i.message.includes('数据库结构变更'));

    expect(dbIssues).toHaveLength(1);
    expect(dbIssues[0]!.message).toContain('低风险放行');
    expect(dbIssues[0]!.message).toContain('默认放行');
  });

  it('付款这类全场景覆盖的操作不报缺口', () => {
    const { issues } = auditPolicies(BASELINE_POLICIES, 'agent_led_approval');
    const gaps = issues.filter((i) => i.type === 'coverage_gap');
    expect(gaps.some((g) => g.message.includes('执行付款'))).toBe(false);
  });
});

describe('过度宽松', () => {
  it('高风险操作被自动放行时报 critical', () => {
    const rules = [policy('全放行', 10, { fact: 'riskLevel', op: 'in', value: ['low', 'medium', 'high', 'critical'] }, ALLOW)];
    const { issues } = auditPolicies(rules, 'agent_autonomous');

    expect(issues.some((i) => i.type === 'too_permissive' && i.severity === 'critical')).toBe(true);
  });

  /**
   * ★ 删除资源、权限变更、付款三类由安全底线硬编码挡住，
   *   任何 Policy 配置都放行不了。它们不该出现在「过度宽松」里 ——
   *   报一个实际不会发生的风险，等于教用户忽略这类提示。
   */
  it('★ 安全底线挡住的三类操作不重复报警', () => {
    const rules = [policy('全放行', 10, { fact: 'riskLevel', op: 'in', value: ['low', 'medium', 'high', 'critical'] }, ALLOW)];
    const { issues } = auditPolicies(rules, 'agent_autonomous');
    const permissive = issues.filter((i) => i.type === 'too_permissive');

    for (const issue of permissive) {
      expect(issue.message).not.toContain('删除资源');
      expect(issue.message).not.toContain('权限变更');
      expect(issue.message).not.toContain('执行付款');
    }
  });
});

describe('其余体检项', () => {
  it('全都要审批时提示 Agent 无法自主工作', () => {
    const rules = [policy('全部审批', 1, { fact: 'riskLevel', op: 'in', value: ['low', 'medium', 'high', 'critical'] }, GATE)];
    const { issues } = auditPolicies(rules, 'human_led');

    expect(issues.some((i) => i.type === 'everything_gated')).toBe(true);
  });

  it('零命中的项目规则给出提示，组织规则不提示', () => {
    const projectRule = policy('从没命中过', 100, { fact: 'runCost', op: 'gt', value: 9999 }, GATE);
    const orgRule = policy('组织规则', 5, { fact: 'runCost', op: 'gt', value: 9999 }, GATE, {
      projectId: null,
    });

    const stats = [projectRule, orgRule].map((p) => ({
      policyId: p.id,
      hits30d: 0,
      ageDays: 30,
      avgWaitSeconds: null,
    }));
    const { issues } = auditPolicies([projectRule, orgRule], 'agent_led_approval', stats);
    const zeroHit = issues.filter((i) => i.type === 'zero_hit');

    expect(zeroHit.map((i) => i.policyIds[0])).toContain(projectRule.id);
    expect(zeroHit.map((i) => i.policyIds[0])).not.toContain(orgRule.id);
  });

  /**
   * ★ 对一条五分钟前刚建的规则说「近 30 天一次都没命中」，字面上没错，
   *   作为提示是纯噪声 —— 而体检区一旦有噪声，用户连带会略过真正重要的几条。
   */
  it('★ 刚建的规则不报零命中', () => {
    const fresh = policy('刚建的', 100, { fact: 'runCost', op: 'gt', value: 9999 }, GATE);
    const { issues } = auditPolicies([fresh], 'agent_led_approval', [
      { policyId: fresh.id, hits30d: 0, ageDays: 0.01, avgWaitSeconds: null },
    ]);

    expect(issues.some((i) => i.type === 'zero_hit')).toBe(false);
  });

  /**
   * ★ 数据源没接入本来就是零命中的原因。两条一起报，第二条读起来像凑数，
   *   而怀疑一旦开始，真正重要的那条也会被一并略过。
   */
  it('★ 已经因「数据源没接入」报过的规则，不再重复报零命中', () => {
    const rule = policy('测试通过才放行', 100, { fact: 'testsResult', op: 'eq', value: 'passed' }, ALLOW);
    const { issues } = auditPolicies(
      [rule],
      'agent_led_approval',
      [{ policyId: rule.id, hits30d: 0, ageDays: 60, avgWaitSeconds: null }],
      [],
    );

    expect(issues.some((i) => i.type === 'missing_data_source')).toBe(true);
    expect(issues.some((i) => i.type === 'zero_hit')).toBe(false);
  });

  /**
   * ★ 这类失效最阴险：列表里赫然写着「测试通过才自动批准」，
   *   而测试结果压根没接进来，条件永远匹配不上 ——
   *   规则从没生效过，但用户以为它在保护自己。
   */
  it('★ 条件依赖未接入的数据源时明确说明该规则不会命中', () => {
    const rules = [
      policy('测试通过才放行', 10, { fact: 'testsResult', op: 'eq', value: 'passed' }, ALLOW),
    ];

    const { issues } = auditPolicies(rules, 'agent_led_approval', [], []);
    const missing = issues.find((i) => i.type === 'missing_data_source');

    expect(missing).toBeDefined();
    expect(missing!.message).toContain('不会命中');

    // 接入之后就不该再报
    const wired = auditPolicies(rules, 'agent_led_approval', [], ['testsResult']);
    expect(wired.issues.some((i) => i.type === 'missing_data_source')).toBe(false);
  });

  it('不可达规则报出来，但用网格外 fact 的规则不误报', () => {
    const rules = [
      policy('低风险放行', 10, { fact: 'riskLevel', op: 'eq', value: 'low' }, ALLOW),
      // 被上一条完全覆盖
      policy('低风险也放行', 20, { fact: 'riskLevel', op: 'eq', value: 'low' }, ALLOW),
      // 用的是网格测不到的 fact，不该被判为不可达
      policy('成本高的审批', 30, { fact: 'runCost', op: 'gt', value: 100 }, GATE),
    ];

    const { issues } = auditPolicies(rules, 'agent_autonomous');
    const unreachable = issues.filter((i) => i.type === 'unreachable');

    expect(unreachable.some((i) => i.message.includes('低风险也放行'))).toBe(true);
    expect(unreachable.some((i) => i.message.includes('成本高的审批'))).toBe(false);
  });
});

describe('自治等级切换预览', () => {
  /**
   * ★ 「切换到 Agent-autonomous 后会更自动化一些」是句废话。
   *   用户要的是具体清单：哪几类操作从此不再找我。
   */
  it('★ 给出具体哪几类操作的判定会变', () => {
    const preview = previewAutonomy(BASELINE_POLICIES, 'human_led', 'agent_autonomous');

    expect(preview.autoAfter).toBeGreaterThan(preview.autoBefore);
    expect(preview.becomesAuto.length).toBeGreaterThan(0);
  });

  it('收紧方向也能预览', () => {
    const preview = previewAutonomy(BASELINE_POLICIES, 'agent_autonomous', 'human_led');
    expect(preview.becomesGated.length).toBeGreaterThan(0);
  });
});
