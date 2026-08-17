/**
 * 开发数据种子。
 *
 * 刻意不直接 INSERT 一堆 work_items —— 那样造出来的是「看起来像」的数据，
 * 状态、事件、Run 之间对不上。这里走真实链路：建需求 → 结构化 → 批准
 * → 生成计划 → 批准 → 调度执行，让看板上的每张卡片都有完整的事件与 Run，
 * 前端调试的就是真实形态。
 *
 * 用法：pnpm --filter @apos/api seed
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  agents,
  createDatabase,
  organizationMembers,
  organizations,
  projectAgentPermissions,
  projectMembers,
  projects,
  users,
  workItems,
  type Database,
} from '@apos/db';
import { MockRuntime, RuntimeRegistry } from '@apos/agent-runtimes';
import { IntegrationRegistry, MemoryIntegrationAdapter } from '@apos/integrations';
import { DevExternalStore } from '../modules/integration/dev-store';
import {
  createIntegration,
  linkObject,
  runSync,
} from '../http/integrations';
import { humanActor } from '@apos/contracts';
import { CODE_DEVELOPER, expandProfile } from '@apos/domain';
import { StubPlanningProvider } from '../modules/planning/stub-provider';
import { analyzeRequirement, approveRequirement } from '../modules/requirement/service';
import { approvePlan, generatePlan } from '../modules/planning/service';
import { scheduleRound } from '../modules/flow/scheduler';
import { dispatchRun } from '../modules/agent/dispatch';
import { transition } from '../modules/flow/transition';
import { createRole, syncBuiltinRoles } from '../http/roles';
import { ensureSuperadminAccount } from '../modules/auth';
import { allocateNumbers } from '../modules/work-item/numbering';
import { seedHistory } from './seed-history';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://apos@localhost:5433/apos';

async function main() {
  const db = createDatabase({ url: DATABASE_URL, singleConnection: true });

  if (process.argv.includes('--reset')) {
    console.log('清空业务表…');
    await db.execute(sql`
      TRUNCATE TABLE
        events, run_events, artifacts,
        decision_approvals, decision_evidence, decision_options, decisions,
        agent_runs, agent_permission_changes, agents,
        repositories, project_conventions,
        work_item_dependencies, work_items, plans,
        requirement_assumptions, requirement_clarifications, requirements,
        policy_versions, policies,
        project_members, roles, projects, organization_members, users, organizations
      RESTART IDENTITY CASCADE
    `);
  }

  const [org] = await db
    .insert(organizations)
    .values({ name: 'Acme', slug: 'acme', description: '演示组织' })
    .returning();
  const orgId = org!.id;

  // 建组织就要预置内置角色 —— 成员表对 roles 有外键（§2.2）
  await syncBuiltinRoles(db, orgId);

  /**
   * ★★ 种子**不建账号**。
   *
   *   账号只有两个来源：超管来自 .env（modules/auth/bootstrap.ts），
   *   其余由超管在界面上创建。种子再造几个演示账号的话，那几个号
   *   既没有口令也没人管，却是真实的组织成员 —— 一个能在生产库里
   *   长出无主账号的种子脚本，比没有演示数据糟得多。
   *
   * ★ 代价要说清楚：演示数据因此只有一个人。「只看需我处理」、
   *   「决策不可代行」、viewer 的只读形态，都需要第二个人才看得出来。
   *   要验证那些，登录超管后在「组织设置 → 成员」里建几个号，
   *   分别给 pm / sponsor / viewer 角色，再换着登录。
   */
  const { userId: adminId } = await ensureSuperadminAccount(db, (m) => console.log(m));
  if (!adminId) {
    throw new Error(
      '种子数据需要一个账号来充当负责人，但超管还不存在。\n' +
        '请在 .env 里设置 APOS_SUPERADMIN_EMAIL 与 APOS_SUPERADMIN_PASSWORD 后重跑。',
    );
  }
  const [admin] = await db.select().from(users).where(eq(users.id, adminId));

  /**
   * ★ 审批范围要给全：决策卡片按 approvalScopes 找责任人（产品文档 8.7.5），
   *   一个都不给的话，演示里的高风险决策会显示「找不到能批的人」——
   *   那是数据没造对，不是产品在表达什么。
   */
  await db
    .update(users)
    .set({ approvalScopes: ['database', 'production', 'budget'] })
    .where(eq(users.id, adminId));

  // 归属与组织角色在 organization_members —— 账号本身是全局的
  await db
    .insert(organizationMembers)
    .values({ orgId, userId: adminId, orgRole: 'org_admin' })
    .onConflictDoNothing();

  /**
   * 演示数据里所有角色都由这一个人担任。
   *
   * ★ 保留这几个名字（而不是全文替换成 admin），是为了让「这里本来该是
   *   几个不同的人」这件事在代码里仍然看得见 —— 哪天要恢复多人演示，
   *   要改的就只有这几行。
   *
   *   sponsor / viewer 两个角色在下面已经没有落点了（一个人在一个项目里
   *   只能有一个角色），所以连变量都不留：留一个没人用的别名，
   *   只会让人以为演示数据里还有那两个视角。
   */
  const lead = admin;
  const dba = admin;
  const pm = admin;

  const [project] = await db
    .insert(projects)
    .values({
      orgId,
      name: '订单系统重构',
      // 工作项编号的前缀 —— 演示数据里要看得见 ORD-1 这种形态
      identifier: 'ORD',
      goal: '把订单查询从 8s 降到 1s 以内，并支持多条件组合查询',
      techLeadId: lead!.id,
      autonomyLevel: 'agent_led_approval',
      tokenBudget: 5_000_000,
      wipLimits: { execution: 3, review: 4 },
    })
    .returning();
  const projectId = project!.id;

  /**
   * ★ 只有一行：project_members 的主键是 (project, actorType, actorId)，
   *   同一个人担任五个角色写不进去。角色取 tech_lead ——
   *   演示链路里需要它批计划。
   *
   * ★★ 于是「需求确认归 sponsor，tech_lead 也批不了」（§2.3）这条
   *   在演示数据上验证不了：批需求的人和批计划的人成了同一个。
   *   这不是规则被放宽了（服务端照判），是种子数据看不见它。
   */
  await db.insert(projectMembers).values({
    orgId,
    projectId,
    actorType: 'human',
    actorId: lead!.id,
    role: 'tech_lead',
  });

  // ── Agent ────────────────────────────────────────────────────────────
  // ★ 工具名用 mock 运行时的词汇表（read_file / write_file / …），
  //   不是 Claude Code 的（Read / Edit / …）。两者不通用：
  //   计划里的 requiredTools 按运行时词汇写，对不上就永远匹配不到 Agent。
  const registry = new RuntimeRegistry();
  const runtime = new MockRuntime({}, { steps: ['分析现状', '实现逻辑', '补充测试'] });

  const agentRows = await db
    .insert(agents)
    .values([
      {
        orgId,
        name: 'code-agent-1',
        type: 'code',
        runtimeKind: 'mock',
        model: 'claude-opus-5',
        skills: ['TypeScript', 'SQL 优化', 'API 设计'],
        applicableTypes: ['task', 'bug', 'research'],
        /** ★ 组织级只定**上限**；实际能做什么按项目选档案（见下面的授权行） */
        capabilityCeiling: [
          'workspace.read',
          'workspace.write',
          'command.build',
          'command.test',
          'artifact.create',
          'repository.push',
          'pull_request.create',
        ],
        deniedCapabilities: ['pull_request.merge'],
        maxConcurrency: 3,
        tokenLimitPerRun: 800_000,
        ownerId: lead!.id,
        stats: { successRate: 0.92, sampleSize: 25, avgTokens: 5.2 },
      },
      {
        orgId,
        name: 'test-agent-1',
        type: 'test',
        runtimeKind: 'mock',
        model: 'claude-sonnet-5',
        skills: ['测试', 'Playwright'],
        applicableTypes: ['test', 'task'],
        capabilityCeiling: [
          'workspace.read',
          'workspace.write',
          'command.build',
          'command.test',
          'artifact.create',
        ],
        deniedCapabilities: ['pull_request.merge'],
        maxConcurrency: 2,
        tokenLimitPerRun: 400_000,
        ownerId: lead!.id,
        stats: { successRate: 0.81, sampleSize: 16, avgTokens: 2.1 },
      },
      {
        orgId,
        name: 'review-agent-1',
        type: 'review',
        runtimeKind: 'mock',
        model: 'claude-sonnet-5',
        skills: ['代码评审'],
        applicableTypes: ['review'],
        /** ★ 评审 Agent 只读 —— 上限里就没有写能力，项目里也授不出来 */
        capabilityCeiling: ['workspace.read', 'command.test', 'artifact.create'],
        deniedCapabilities: ['workspace.write', 'pull_request.merge'],
        maxConcurrency: 2,
        tokenLimitPerRun: 250_000,
        ownerId: lead!.id,
        stats: { successRate: 0.95, sampleSize: 40, avgTokens: 0.9 },
      },
      {
        orgId,
        name: 'ops-agent-1',
        type: 'ops',
        runtimeKind: 'mock',
        model: 'claude-sonnet-5',
        skills: ['部署', '灰度发布'],
        applicableTypes: ['release'],
        capabilityCeiling: [
          'workspace.read',
          'artifact.create',
          'repository.push',
          'pull_request.create',
        ],
        deniedCapabilities: ['pull_request.merge'],
        maxConcurrency: 1,
        tokenLimitPerRun: 200_000,
        ownerId: lead!.id,
        stats: { successRate: 0.88, sampleSize: 12, avgTokens: 1.4 },
      },
    ])
    .returning();

  // ★ 每个 Agent 一个适配器实例：注册表按 agentId 键控，
  //   因为 Agent 各自带一套运行时参数
  for (const a of agentRows) registry.register(a.id, runtime);

  /**
   * ── 自定义角色（09-security §2.2）────────────────────────────────────
   *
   * ★★ 这几行是整套角色机制的演示入口：内置的六个覆盖「项目怎么运转」，
   *   覆盖不了「这个组织怎么分工」。研发、测试、运营各自是什么权限，
   *   由超管在这里定义。
   *
   * ★ 「研发」「测试」允许 Agent 担任，「运营」只给人 —— 差别不是随便定的：
   *   前两个只含执行类权限，后一个含处理决策（humanOnly），
   *   服务端会按这条规则校验，塞不进去。
   */
  const roleCtx = { orgId, actorId: lead!.id, correlationId: randomUUID() };
  await createRole(db, roleCtx, {
    key: 'dev',
    name: '研发',
    description: '写代码、跑测试、接管任务；不参与需求与计划审批',
    permissions: [
      'project.view',
      'policy.view',
      'work_item.execute',
      'work_item.takeover',
      'plan.generate',
      'clarification.answer',
      'integration.view',
    ],
    appliesTo: ['human', 'agent'],
  });
  await createRole(db, roleCtx, {
    key: 'qa',
    name: '测试',
    description: '执行测试任务、看规则与集成状态；不能改任何配置',
    permissions: ['project.view', 'policy.view', 'work_item.execute', 'integration.view'],
    appliesTo: ['human', 'agent'],
  });
  await createRole(db, roleCtx, {
    key: 'ops',
    name: '运营',
    description: '处理决策、催办、看数据；不碰代码与计划',
    permissions: ['project.view', 'policy.view', 'decision.act', 'decision.remind'],
    // ★ 含 decision.act（humanOnly），所以只能给人 —— 这不是选择，是校验结果
    appliesTo: ['human'],
  });

  /**
   * ★★ 让 Agent 真正担任角色。
   *
   *   在此之前 Agent 只是「被派发任务的对象」，不在成员表里。
   *   现在它和人一样是项目成员、担任同一套角色里的一个 ——
   *   这才是「Human–Agent 混合团队」在数据上的样子：
   *   「测试」这个岗位上，可能坐着一个人，也可能是 test-agent-1。
   */
  const [codeAgent, testAgent] = agentRows;
  await db.insert(projectMembers).values([
    { orgId, projectId, actorType: 'agent', actorId: codeAgent!.id, role: 'dev' },
    { orgId, projectId, actorType: 'agent', actorId: testAgent!.id, role: 'qa' },
  ]);

  /**
   * ★★ 项目级能力授权 —— 「同一个 Agent 在不同项目里可以是两套权限」
   *   在种子数据里就该看得见。
   *
   *   code-agent-1 给 code_developer（能推分支、能开 PR，**不能合并**），
   *   test-agent-1 给默认的 standard_executor（工作区里干活，出不去）。
   *   这两档的差别正是这套模型要表达的东西：合并是 Agent 自主与
   *   「人来点一下」之间唯一的那道闸。
   *
   * ★ 不给 test-agent-1 写授权行，是因为**「没配置」本身就是一种正确状态**：
   *   它落到默认档案上，而默认档案安全且够用。种子数据里两种都出现一次，
   *   界面上「用的是默认档案」那句提示才有东西可显示。
   *
   * Seed one explicit grant and one default so both states are visible: an
   * agent configured as a developer (may push and open PRs, may not merge) and
   * one left unconfigured, which lands on the safe default profile.
   */
  const developerGrant = expandProfile(CODE_DEVELOPER);
  await db.insert(projectAgentPermissions).values({
    orgId,
    projectId,
    agentId: codeAgent!.id,
    profileKey: developerGrant.profileKey,
    profileVersion: developerGrant.profileVersion,
    allowedCapabilities: developerGrant.allowedCapabilities,
    deniedCapabilities: developerGrant.deniedCapabilities,
    resourceScopes: [{ kind: 'repo', ref: 'order-service', access: 'write' }],
    updatedBy: lead!.id,
  });

  // ── 走真实链路：需求 → 计划 → 执行 ────────────────────────────────
  const provider = new StubPlanningProvider();
  const correlationId = randomUUID();
  const actor = humanActor(lead!.id);

  const { requirements } = await import('@apos/db');
  const [requirement] = await db
    .insert(requirements)
    .values({
      orgId,
      projectId,
      rawInput:
        '订单列表现在查一次要 8 秒，用户投诉很多。需要支持按状态、时间范围、金额区间组合查询，' +
        '并且要加索引优化。涉及生产数据库变更。',
      inputMethod: 'manual',
    })
    .returning();

  console.log('结构化需求…');
  await analyzeRequirement(db, provider, {
    requirementId: requirement!.id,
    correlationId,
    actor,
  });

  // 澄清问题一律用建议答案，让种子可重复执行
  const { requirementClarifications } = await import('@apos/db');
  const questions = await db
    .select()
    .from(requirementClarifications)
    .where(eq(requirementClarifications.requirementId, requirement!.id));

  const { answerClarification } = await import('../modules/requirement/service');
  for (const q of questions) {
    await answerClarification(db, {
      clarificationId: q.id,
      answer: q.agentSuggestion ?? '按默认方案处理',
      usedSuggestion: Boolean(q.agentSuggestion),
      actorId: lead!.id,
      correlationId,
    });
  }

  await approveRequirement(db, {
    requirementId: requirement!.id,
    approverId: lead!.id,
    correlationId,
  });

  console.log('生成计划…');
  const plan = await generatePlan(db, provider, { requirementId: requirement!.id, correlationId });

  console.log('批准计划…');
  const approved = await approvePlan(db, {
    planId: plan.planId,
    approverId: lead!.id,
    correlationId,
    acknowledgedOverrun: true,
  });
  if (!approved.ok) throw new Error('计划批准失败：预算不足');

  /**
   * 多轮调度。
   *
   * 一轮不够：WIP 上限（execution 3）会挡住后续任务，依赖链上的后置任务
   * 也要等前置完成。反复调度直到没有新派发，看板才会有跨列的分布，
   * 而不是所有卡片挤在 Execution。
   */
  console.log('调度执行…');
  for (let round = 0; round < 8; round++) {
    const result = await scheduleRound(db, registry, { projectId, correlationId });
    await sleep(500);
    if (result.scanned === 0 && round > 2) break;
  }

  // ── 造出各种卡片状态，让前端能看到全部形态 ─────────────────────────
  const items = await db
    .select()
    .from(workItems)
    .where(eq(workItems.projectId, projectId))
    .orderBy(workItems.position);

  /**
   * 一张走完全程的卡片，让 Release / Done 列不空。
   *
   * 用 transition 一步步推，而不是直接 UPDATE status ——
   * 直接改状态造出来的卡片没有事件、没有 Lead Time，
   * 前端的时间线和「已完成」卡片就都是空的。
   */
  const reviewed = items.filter((i) => i.status === 'reviewing');
  const shipped = reviewed[0];
  if (shipped) {
    for (const trigger of ['review_passed', 'release_started', 'release_completed', 'accepted'] as const) {
      const moved = await transition(db, {
        workItemId: shipped.id,
        trigger,
        actor,
        reason: '种子数据：推到已完成',
        correlationId,
      });
      if (!moved.ok) {
        console.log(`  （${shipped.title} 停在 ${trigger} 之前：${moved.code}）`);
        break;
      }
    }
    console.log(`  已完成卡片  ${shipped.title}`);
  }

  /**
   * 一张不在计划依赖链上的独立任务。
   *
   * 计划生成的任务是一条依赖链，头部执行完之前后面的都动不了 ——
   * 这让「手动拖动」这条异常路径在演示数据上根本走不通。
   * 真实项目里也总有临时插进来的独立任务，补一张。
   */
  const [standaloneNumber] = await allocateNumbers(db, projectId, 1);
  const [standalone] = await db
    .insert(workItems)
    .values({
      orgId,
      projectId,
      number: standaloneNumber!,
      type: 'bug',
      status: 'executing',
      stage: 'execution',
      title: '修复导出 CSV 时的编码乱码',
      description: '客服反馈导出的订单 CSV 在 Excel 里中文全是乱码，缺 BOM 头。',
      riskLevel: 'low',
      priority: 1,
      ownerId: pm!.id,
      executorType: 'human',
      executorId: pm!.id,
      estimatedTokens: 40_000,
      position: 100,
    })
    .returning();
  console.log(`  独立任务    ${standalone!.title}（可用于试拖拽）`);

  // 剩下的挑三张分别做成阻塞 / 失败 / 待决策
  const shapeable = items.filter(
    (i) => i.id !== shipped?.id && i.status !== 'done' && i.status !== 'cancelled',
  );
  const [blocked, risky] = shapeable;

  if (blocked) {
    await db
      .update(workItems)
      .set({
        blockedSince: new Date(Date.now() - 8 * 3600_000 - 12 * 60_000),
        blockedReason: '等待 DBA 审批生产库索引变更',
        ownerId: dba!.id,
      })
      .where(eq(workItems.id, blocked.id));
    console.log(`  阻塞卡片    ${blocked.title}`);
  }

  /**
   * 失败卡片。
   *
   * 用一张独立任务而不是从计划链里挑 —— 链上的任务依赖没满足时
   * 根本派发不出去，注入失败样本会静默落空（种子跑完看起来一切正常，
   * 但界面上的失败态、错误 Tab、恢复决策全都没有数据）。
   */
  const [failingNumber] = await allocateNumbers(db, projectId, 1);
  const [failing] = await db
    .insert(workItems)
    .values({
      orgId,
      projectId,
      number: failingNumber!,
      type: 'bug',
      status: 'ready',
      stage: 'execution',
      title: '支付回调偶发超时',
      description: '线上每天约 20 笔支付回调超时，需要定位原因。',
      riskLevel: 'medium',
      priority: 1,
      ownerId: lead!.id,
      estimatedTokens: 100_000,
      position: 101,
    })
    .returning();

  {
    const failRuntime = new MockRuntime(
      {},
      {
        outcome: 'failed',
        steps: ['复现问题', '定位调用链'],
        error: {
          class: 'context_insufficient',
          message: '无法定位 orders 表的 schema 定义',
          selfReport:
            '我需要 orders 表的结构定义来判断回调写入是否有锁竞争，' +
            '但在 order-service 仓库里没有找到 migration 或 schema 文件。' +
            '可能在其他仓库，或者由 DBA 单独维护。',
        },
      },
    );
    const failRegistry = new RuntimeRegistry();
    failRegistry.register(agentRows[1]!.id, failRuntime);

    const dispatched = await dispatchRun(db, failRegistry, {
      workItemId: failing!.id,
      agentId: agentRows[1]!.id,
      correlationId,
    });
    await sleep(700);
    console.log(`  失败卡片    ${failing!.title}（${dispatched.ok ? '已失败' : '派发失败'}）`);
  }

  // 待决策卡片：高风险 + 超时，用来验证 decision_overdue 的强化展示
  if (risky) {
    await db
      .update(workItems)
      .set({ riskLevel: 'high', ownerId: dba!.id })
      .where(eq(workItems.id, risky.id));

    const moved = await transition(db, {
      workItemId: risky.id,
      trigger: 'decision_required',
      actor,
      reason: '生产库索引变更需要 DBA 审批',
      correlationId,
    });

    const { decisions } = await import('@apos/db');
    await db
      .update(decisions)
      .set({
        assigneeId: dba!.id,
        title: '生产库索引变更审批',
        dueAt: new Date(Date.now() - 2 * 3600_000),
      })
      .where(eq(decisions.workItemId, risky.id));
    console.log(`  待决策卡片  ${risky.title}（${moved.ok ? moved.to : '流转失败'}）`);
  }

  /**
   * 项目级 Policy。
   *
   * 只有组织基线的话，Policy 页上「项目自定义」永远是空的，
   * 而「只能收紧不能放宽」「冲突检测」这些真正要验的东西
   * 全都需要至少一条项目规则才跑得到。
   */
  {
    const { policies } = await import('@apos/db');
    await db.insert(policies).values([
      {
        orgId,
        projectId,
        name: '低风险任务自动批准',
        description: '测试通过且 token 用量可控的低风险任务无需人工审批',
        priority: 100,
        condition: {
          all: [
            { fact: 'riskLevel', op: 'eq', value: 'low' },
            { fact: 'runTokens', op: 'lt', value: 200_000 },
          ],
        },
        action: { type: 'allow_and_notify', notify: [{ kind: 'project_role', role: 'pm' }] },
        createdBy: lead!.id,
      },
      {
        orgId,
        projectId,
        name: '预算用掉八成后提醒技术负责人',
        description: '在真正超限之前先打个招呼，别等到卡住才发现',
        priority: 110,
        condition: { fact: 'budgetUsedPct', op: 'gte', value: 80 },
        action: { type: 'ask', assignee: { kind: 'project_role', role: 'tech_lead' } },
        createdBy: lead!.id,
      },
      {
        // 刻意留一条依赖未接入数据源的规则 —— 它看起来配好了，实际永远不命中。
        // 这正是 Policy 页体检要抓的那类失效
        orgId,
        projectId,
        name: '安全扫描通过才允许部署',
        description: '',
        priority: 120,
        condition: {
          all: [
            { fact: 'securityScan', op: 'eq', value: 'passed' },
            { fact: 'operationType', op: 'eq', value: 'deploy' },
          ],
        },
        action: { type: 'allow' },
        createdBy: lead!.id,
      },
    ]);
    console.log('  项目规则    3 条（含一条依赖未接入数据源的，供体检验证）');
  }

  // ── 60 天历史（只给 Analytics 用，不走真实链路，原因见 seed-history.ts）──
  const history = await seedHistory({
    db,
    orgId,
    projectId,
    planId: plan.planId,
    agentIds: agentRows.map((a) => a.id),
    userIds: [lead!.id, pm!.id, dba!.id],
    dbaId: dba!.id,
    now: Date.now(),
  });
  console.log(`  历史数据    ${history} 项已完成任务（近 60 天，供 Analytics）`);

  // ── 集成（页面文档 14）────────────────────────────────────────────
  /**
   * 连一个 Jira 并制造一个真实冲突。
   *
   * ★ 冲突不是编出来的假数据：外部改了状态 → 拉取 → SoT 判定 → 落库，
   *   走的是和线上完全一样的那条路径。假造一条 sync_conflicts 记录
   *   看起来一样，但它证明不了同步引擎能工作，也就没有价值。
   */
  const externalStore = new DevExternalStore(db);
  const jira = new MemoryIntegrationAdapter('jira', externalStore);
  const integrationRegistry = new IntegrationRegistry();
  integrationRegistry.register(jira);
  for (const p of ['github', 'slack'] as const) {
    integrationRegistry.register(new MemoryIntegrationAdapter(p, externalStore));
  }

  const jiraConn = await createIntegration(db, integrationRegistry, {
    projectId,
    provider: 'jira',
    displayName: 'ORDER (Scrum Board)',
    config: { projectKey: 'ORDER' },
    credential: 'jira-pat-demo-7c41',
    userId: lead!.id,
  });

  /**
   * ★ webhookUrl 指向 API 自己的开发接收端，让「配置 → 判定 → 投递 → 记录」
   *   这条链路在演示环境里真的跑一遍。生产部署里它指向真的 Slack。
   */
  await createIntegration(db, integrationRegistry, {
    projectId,
    provider: 'slack',
    displayName: '#order-refactor',
    config: {
      channel: 'order-refactor',
      webhookUrl: `${process.env['API_BASE_URL'] ?? 'http://localhost:3000'}/api/v1/dev/webhook-sink`,
    },
    credential: 'xoxb-demo-9f22',
    userId: pm!.id,
  });

  const syncable = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), isNull(workItems.deletedAt)))
    .limit(3);

  for (const [i, item] of syncable.entries()) {
    const key = `ORDER-${140 + i}`;
    await jira.seed({
      externalKey: key,
      url: `https://jira.example/browse/${key}`,
      fields: { status: item.status, assignee: '张伟' },
      lastChange: { originTag: null, by: '李娜', at: new Date().toISOString() },
    });
    await linkObject(db, {
      integrationId: jiraConn.id,
      workItemId: item.id,
      externalKey: key,
      externalUrl: `https://jira.example/browse/${key}`,
    });
  }

  // 先同步一轮建立基准，再让外部改一次 —— 这样才会被判为真冲突
  await runSync(db, integrationRegistry, jiraConn.id);
  await jira.externalEdit('ORDER-140', 'status', 'done', '李娜', new Date().toISOString());
  await jira.externalEdit('ORDER-141', 'assignee', '王强', '李娜', new Date().toISOString());
  const syncSummary = await runSync(db, integrationRegistry, jiraConn.id);
  console.log(
    `  集成        Jira + Slack；同步 ${syncSummary.objects} 个对象，` +
      `冲突 ${syncSummary.conflicts}、接受 ${syncSummary.accepted}、回写 ${syncSummary.writtenBack}`,
  );

  const final = await db.select().from(workItems).where(eq(workItems.projectId, projectId));
  const byStage = final.reduce<Record<string, number>>((acc, i) => {
    acc[i.stage] = (acc[i.stage] ?? 0) + 1;
    return acc;
  }, {});

  console.log('\n✓ 种子数据就绪');
  console.log(`  项目      ${project!.name}  ${projectId}`);
  console.log(`  任务      ${final.length} 项`, byStage);
  /**
   * ★ 只有超管一个人。要看出 RBAC 的形态（「只看需我处理」、
   *   viewer 的只读、「决策不可代行」）得自己再建几个号 ——
   *   这里把下一步直接写出来，否则演示者只会得出「产品没有权限体系」的印象。
   */
  console.log('\n  登录身份：');
  console.log(`    ${admin!.name}  ${admin!.email}  tech_lead + 组织管理员`);
  console.log('    口令是 .env 里的 APOS_SUPERADMIN_PASSWORD');
  console.log(
    '\n  演示数据只有这一个人。要看权限边界（只读视角、决策不可代行），\n' +
      '  登录后到「组织设置 → 成员」建几个号，分别给 pm / sponsor / viewer 角色。',
  );
  // 单机部署里前端和 API 同源（默认 :8080），不是开发时的 Vite :5173——
  // 打印一个打不开的链接比不打印更误导
  const webBase = process.env['WEB_BASE_URL'] ?? 'http://localhost:5173';
  console.log(`\n  看板  ${webBase}/projects/${projectId}/board\n`);

  await closeDb(db);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function closeDb(db: Database) {
  const client = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
  await client?.end?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
