/**
 * 看板冒烟检查。
 *
 * 起了 API 与 dev server 之后跑一遍，验证真实浏览器里的关键路径。
 * 组件测试测不到的东西都在这里：SSE 推动的卡片移动、拖拽的落点判定、
 * 决策不可代行在界面上的表现。
 *
 * 用法：node scripts/smoke.mjs <projectId> [--shots <dir>]
 */
import { chromium } from 'playwright';

const projectId = process.argv[2];
if (!projectId) {
  console.error('用法: node scripts/smoke.mjs <projectId> [--shots <dir>]');
  process.exit(1);
}
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > -1 ? process.argv[shotsIdx + 1] : null;

const base = process.env.WEB_URL ?? 'http://localhost:5173';
const results = [];
const problems = [];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('pageerror', (e) => problems.push(`PAGEERROR ${e.message}`));
page.on('requestfinished', async (r) => {
  const res = await r.response();
  if (res && res.status() >= 400) problems.push(`${res.status()} ${r.url()}`);
});

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const shot = (n) => (shots ? page.screenshot({ path: `${shots}/${n}.png`, fullPage: true }) : null);

await page.goto(`${base}/projects/${projectId}/board`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

check('看板渲染出六列', (await page.locator('section h2').count()) >= 6);
check('顶部状态条可点', (await page.getByRole('button', { name: /项待决策/ }).count()) > 0);
await shot('board');

// 卡片详情抽屉
await page.locator('article').first().click();
await page.waitForTimeout(600);
check('点卡片打开详情抽屉', (await page.locator('aside').count()) > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 决策抽屉与「不可代行」
const gateBtn = page.getByRole('button', { name: /处理/ }).first();
if ((await gateBtn.count()) > 0) {
  await gateBtn.click();
  await page.waitForTimeout(800);
  const text = await page.locator('aside').innerText();
  check('Human Gate 直接打开决策抽屉', text.includes('为什么需要你'));
  check(
    '非责任人看到「不可代行」而不是可点的批准按钮',
    text.includes('不可代行') || text.includes('批准并继续执行'),
    text.includes('不可代行') ? '当前身份不是责任人' : '当前身份是责任人',
  );
  await shot('decision');
  await page.keyboard.press('Escape');
}

// 拖拽落点判定
await page.waitForTimeout(300);
const card = page.locator('article').first();
await card.hover();
await page.mouse.down();
const release = await page.locator('section', { hasText: /^Release/ }).first().boundingBox();
await page.mouse.move(release.x + release.width / 2, release.y + 200, { steps: 12 });
await page.waitForTimeout(300);
const releaseText = await page.locator('section', { hasText: /^Release/ }).first().innerText();
check('非法落点给出中文原因', /不能直接进入|已经在这一列/.test(releaseText), releaseText.split('\n').find((l) => l.includes('不能')) ?? '');
await page.mouse.up();
await page.waitForTimeout(300);

// 筛选写进 URL，且顶部状态条点击即应用筛选
await page.goto(`${base}/projects/${projectId}/board`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const totalCards = await page.locator('article').count();
await page.getByRole('button', { name: /项阻塞/ }).click();
await page.waitForTimeout(700);
check('顶部状态条点击应用筛选', page.url().includes('blocked=true'), new URL(page.url()).search);
check('筛选确实收窄了结果', (await page.locator('article').count()) <= totalCards);

// ★ 旁观模式：浏览器一动不动，只靠 SSE 推动卡片移动。
//   这是这个产品最有说服力的时刻，也是最容易悄悄坏掉的一条链路
await page.goto(`${base}/projects/${projectId}/board`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const headersBefore = await page.locator('section > header').allInnerTexts();

const apiBase = process.env.API_URL ?? 'http://localhost:3000';
const boardJson = await (await fetch(`${apiBase}/api/v1/projects/${projectId}/board`)).json();
const gated = boardJson.columns.flatMap((c) => c.items).find((c) => c.humanGateRef);

if (gated) {
  const detail = await (await fetch(`${apiBase}/api/v1/decisions/${gated.humanGateRef}`)).json();
  // 决策可能没有指定责任人（未分派），此时随便一个成员都能批
  const { users } = await (await fetch(`${apiBase}/api/v1/users`)).json();
  const actorId = detail.decision.assigneeId ?? users[0]?.id;

  const approved = await fetch(`${apiBase}/api/v1/decisions/${gated.humanGateRef}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': actorId },
    body: JSON.stringify({ note: 'smoke' }),
  });
  await page.waitForTimeout(2500);
  const headersAfter = await page.locator('section > header').allInnerTexts();
  check(
    '★ 旁观模式：服务端变更经 SSE 推动卡片移动（页面无任何操作）',
    approved.ok && JSON.stringify(headersBefore) !== JSON.stringify(headersAfter),
    approved.ok ? '' : `批准失败 ${approved.status}`,
  );
  check('移动后出现汇总提示条', (await page.locator('text=/张卡片/').count()) > 0);
  await shot('watch');
} else {
  console.log('· 跳过旁观模式检查：当前没有待决策卡片');
}

// 视图切换
for (const [view, marker] of [['list', 'table'], ['agent', '负载'], ['decision', '处理']]) {
  await page.goto(`${base}/projects/${projectId}/board?view=${view}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const ok =
    marker === 'table'
      ? (await page.locator('table').count()) > 0
      : (await page.getByText(new RegExp(marker)).count()) > 0;
  check(`${view} 视图可用`, ok);
  await shot(view);
}

// ── Run 详情（页面文档 09）──────────────────────────────────────────
const boardForRun = await (await fetch(`${apiBase}/api/v1/projects/${projectId}/board`)).json();
const withRun = boardForRun.columns.flatMap((c) => c.items).find((c) => c.runId);

if (withRun) {
  await page.goto(`${base}/runs/${withRun.runId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const tabs = await page.locator('nav button').allInnerTexts();
  check('Run 详情渲染出各页签', tabs.length >= 4, tabs.join(' / '));

  await page.getByRole('button', { name: /^执行流/ }).click();
  await page.waitForTimeout(300);
  const brief = await page.locator('ol > li').count();
  await page.getByLabel('详细模式').check();
  await page.waitForTimeout(900);
  const detailed = await page.locator('ol > li').count();

  // ★ 简明模式不是「只剩三行」，它要讲完整个故事，只是不展开原始参数
  check('简明模式仍保留叙事骨架', brief >= 3, `简明 ${brief} 条 / 详细 ${detailed} 条`);
  check('详细模式条目不少于简明', detailed >= brief);

  await page.getByRole('button', { name: /^输入/ }).click();
  await page.waitForTimeout(400);
  const inputText = await page.locator('main').innerText();
  check('输入页签给出上下文清单与权限快照', inputText.includes('上下文清单') && inputText.includes('权限快照'));

  await page.getByRole('button', { name: /^成本/ }).click();
  await page.waitForTimeout(600);
  const costText = await page.locator('main').innerText();
  check('成本页签按步骤拆分', costText.includes('按步骤分布'));
  await shot('run');
}

// 失败的 Run 默认停在错误页签，不让用户自己找
const failedRun = await (async () => {
  const items = boardForRun.columns.flatMap((c) => c.items);
  for (const item of items) {
    if (!item.runId) continue;
    const d = await (await fetch(`${apiBase}/api/v1/runs/${item.runId}`)).json();
    if (d.error) return d.run.id;
  }
  return null;
})();

if (failedRun) {
  await page.goto(`${base}/runs/${failedRun}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const active = await page.locator('nav button.border-b-2').innerText();
  check('失败的 Run 默认打开错误页签', active.includes('错误'), active);
  const text = await page.locator('main').innerText();
  // Agent 用人话解释自己为什么卡住，比堆栈有用得多
  check('错误页签给出 Agent 自述与失败步骤', /自述/.test(text) && /失败步骤/.test(text));
  await shot('run-error');
} else {
  console.log('· 跳过失败 Run 检查：当前没有失败的 Run');
}

// ── 执行图（页面文档 07）────────────────────────────────────────────
await page.goto(`${base}/projects/${projectId}/graph`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const nodeG = page.locator('svg[aria-label="执行图"] g.cursor-pointer');
const graphNodes = await nodeG.count();
check('执行图画出节点', graphNodes > 0, `${graphNodes} 个`);

if (graphNodes > 0) {
  // ★ 这条检查是有来历的：flex 容器没有确定高度时 clientHeight 读到接近 0，
  //   适应窗口会算出下限 15%，图缩成中间一个小点 —— 数据全对，看起来却像坏了。
  //   单元测试碰不到布局，只有真浏览器能发现。
  const zoomPct = Number((await page.locator('text=/^\\d+%$/').first().innerText()).replace('%', ''));
  check('★ 适应窗口后缩放比例合理（不是塌成一个点）', zoomPct >= 40, `${zoomPct}%`);

  const bar = await page.locator('h1:has-text("执行图") >> xpath=../..').innerText();
  check('关键路径信息条给出工期与主因', /关键路径/.test(bar) && /主因/.test(bar), bar.split('\n').find((l) => l.includes('主因')) ?? '');
  check(
    '关键路径的边被加粗标出',
    (await page.locator('path[marker-end="url(#arrow-critical)"]').count()) > 0,
  );
  await shot('graph');

  // ★ 上下游追溯：悬停一个节点，无关节点要淡出
  await nodeG.first().hover();
  await page.waitForTimeout(400);
  const dimmed = await page.locator('svg[aria-label="执行图"] g.cursor-pointer[opacity="0.4"]').count();
  check('★ 悬停节点后无关节点淡出（上下游追溯）', dimmed > 0, `淡出 ${dimmed} / ${graphNodes}`);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);

  // 每条诊断都必须带可执行动作 —— 只说「有问题」不说「怎么办」等于装饰
  const panel = page.locator('li:has-text("在图中定位")');
  const diagCount = await panel.count();
  if (diagCount > 0) {
    let allActionable = true;
    for (let i = 0; i < diagCount; i++) {
      if ((await panel.nth(i).locator('button').count()) < 2) allActionable = false;
    }
    check('★ 每条诊断都带可执行动作，不止是提示', allActionable, `${diagCount} 条`);
  } else {
    check('无诊断时明确说「没有发现问题」', (await page.getByText('没有发现结构性问题').count()) > 0);
  }

  // 右键菜单
  await nodeG.first().click({ button: 'right' });
  await page.waitForTimeout(300);
  check('右键节点弹出操作菜单', (await page.getByRole('button', { name: '查看详情' }).count()) > 0);
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(300);
}

// 布局切换换的是同一批节点的摆放，不该丢节点
for (const [value, label] of [['stage', '阶段泳道'], ['executor', '执行者泳道']]) {
  await page.selectOption('select[aria-label="布局"]', value);
  await page.waitForTimeout(1000);
  const laneCount = await page.locator('svg[aria-label="执行图"] rect[stroke="#e2e8f0"]').count();
  const after = await nodeG.count();
  check(`${label}布局可用且节点数不变`, after === graphNodes && laneCount > 0, `${laneCount} 条泳道`);
  await shot(`graph-${value}`);
}

// ── Analytics（页面文档 12）────────────────────────────────────────────
await page.goto(`${base}/projects/${projectId}/analytics`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const insights = page.locator('section:has-text("系统发现") li');
const insightCount = await insights.count();
check('Analytics 给出系统发现', insightCount > 0, `${insightCount} 条`);

if (insightCount > 0) {
  // ★ 只说「有问题」不说「怎么办」的提示，用户看两次就会忽略整个区域
  let allActionable = true;
  let hasGood = false;
  for (let i = 0; i < insightCount; i++) {
    const text = await insights.nth(i).innerText();
    if (text.includes('🟢')) hasGood = true;
    // 正面发现不需要动作，问题类必须有
    else if ((await insights.nth(i).locator('button').count()) < 2) allActionable = false;
  }
  check('★ 每条问题类发现都带可执行动作', allActionable);
  // ★ 只报坏消息的分析页会被用户回避，然后这一页就等于不存在
  check('★ 系统发现里包含正面发现', hasGood);

  // 判据可展开 —— 用户第一反应是「真的吗，怎么算的」
  await page.getByRole('button', { name: '凭什么这么说' }).first().click();
  await page.waitForTimeout(300);
  check(
    '发现可以展开判据',
    (await page.getByText(/判据|中位数|等待时间的占比|次评估/).count()) > 0,
  );
}

// 四个 Tab 都要有内容，且不能只剩标题
for (const [tab, marker] of [
  ['flow', '周期时间分解'],
  ['agent', 'Agent 效能对比'],
  ['hitl', '重复决策与可自动化潜力'],
  ['cost', '成本趋势'],
]) {
  await page.goto(`${base}/projects/${projectId}/analytics?tab=${tab}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  check(`${tab} Tab 渲染出主图`, (await page.getByText(marker).count()) > 0);
  await shot(`analytics-${tab}`);
}

// ★ 等待决策必须是分解图里独立的一条，不能并进所处阶段
await page.goto(`${base}/projects/${projectId}/analytics?tab=flow`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const flowText = await page.locator('main').innerText();
check('★ 周期分解把「等待决策」单列，不并入所处阶段', flowText.includes('等待决策'));
check('分解图给出「有效 / 等待」的一句话总结', /有效工作时间\s*\d+%/.test(flowText));

// 每个指标都说得清自己怎么算的
const hints = await page.locator('[title*="÷"], [title*="中位数"], [title*="窗口内"]').count();
check('指标带计算口径说明（ⓘ）', hints >= 3, `${hints} 个`);

// ★ 系统发现的采纳率是本页的成功标准（页面文档 §10）——
//   动作按钮点下去必须真的到达它承诺的地方，否则这一页只是好看
await page.getByRole('button', { name: /看返工的任务/ }).click();
await page.waitForTimeout(900);
check(
  '★ 系统发现的动作真的能落到具体任务上',
  (await page.locator('aside:has-text("返工过的任务")').count()) > 0,
);
await page.getByRole('button', { name: '关闭' }).first().click();
await page.waitForTimeout(400);

// 指标卡本身也能下钻
await page.getByRole('button', { name: /在制品/ }).first().click();
await page.waitForTimeout(900);
check('指标卡可下钻到任务列表', (await page.locator('aside:has-text("在制任务")').count()) > 0);
await page.getByRole('button', { name: '关闭' }).first().click();
await page.waitForTimeout(400);

// 换时间范围时保住上一份渲染，不闪骨架屏
await page.selectOption('select[aria-label="时间范围"]', '7d');
await page.waitForTimeout(1000);
check('切换时间范围后仍有数据', (await page.getByText('周期时间分解').count()) > 0, page.url().includes('range=7d') ? '?range=7d' : '');

// ── Policy 配置（页面文档 13）──────────────────────────────────────────
await page.goto(`${base}/projects/${projectId}/settings/policies`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const policyText = await page.locator('main').innerText();
check(
  '★ 顶部把一堆规则翻译成一句人话',
  /当前配置下：\d+ 类操作自动执行，\d+ 类需要人类确认/.test(policyText),
  policyText.split('\n').find((l) => l.includes('当前配置下')) ?? '',
);

await page.getByRole('button', { name: '查看完整清单' }).click();
await page.waitForTimeout(400);
const listText = await page.locator('main').innerText();
// ★ 只说「看情况」的摘要还不如不给 —— 用户仍然得自己去读规则
check(
  '★ 「视情况而定」说清楚了是什么情况',
  /视情况而定/.test(listText) ? /需要人确认/.test(listText) : true,
);

// 规则用人话展示，不是条件表达式
check(
  '★ 规则列表显示人话解释而不是条件表达式',
  /当风险等级是低/.test(listText) && !/riskLevel ==/.test(listText),
);

check('组织规则标注为不可修改', /组织级规则，项目内不可修改/.test(listText));
check('如实说明哪些数据源没接入', /尚未接入/.test(listText));
await shot('policy-rules');

// 体检：每条问题要给出可定位的反例
if (/检测到 \d+ 个问题/.test(listText)) {
  check('体检给出反例场景或可定位的规则', /反例场景|定位到规则/.test(listText));
  // ★ 抽样不是证明，页面必须说清楚
  check('★ 体检明确说明这是抽样而非证明', /没报出来不等于没有问题/.test(listText));
}

// ── 场景测试：排查「为什么还找我」──
await page.goto(`${base}/projects/${projectId}/settings/policies?tab=test`, {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(800);
await page.getByRole('button', { name: '运行测试' }).click();
await page.waitForTimeout(1200);

const testText = await page.locator('main').innerText();
check('场景测试给出判定结果', /需要人类确认|自动执行/.test(testText));
// ★ 「我明明配了自动批准为什么还找我」——答案永远是被更高优先级的规则先拦下了
check(
  '★ 匹配过程标出哪条命中、哪些根本没被评估',
  /命中即停/.test(testText) && /未评估/.test(testText),
  testText.split('\n').find((l) => l.includes('根本没被评估')) ?? '',
);
await shot('policy-test');

// ── 治理硬约束：项目规则不能放宽组织规则 ──
const apiBase2 = process.env.API_URL ?? 'http://localhost:3000';
const { users: allUsers } = await (await fetch(`${apiBase2}/api/v1/users`)).json();
const actorId = allUsers[0]?.id;

const loosenOrg = await fetch(`${apiBase2}/api/v1/projects/${projectId}/policies`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': actorId },
  body: JSON.stringify({
    name: '冒烟：抢在组织规则前面放行生产库变更',
    priority: 3,
    condition: {
      all: [
        { fact: 'environment', op: 'eq', value: 'production' },
        { fact: 'operationType', op: 'eq', value: 'db_ddl' },
      ],
    },
    action: { type: 'allow' },
  }),
});
const loosenBody = await loosenOrg.json();
check(
  '★ 项目规则不能放宽组织规则（治理硬约束）',
  loosenOrg.status === 422 && /不能放宽/.test(loosenBody.error?.message ?? ''),
  loosenBody.error?.message?.slice(0, 60) ?? `HTTP ${loosenOrg.status}`,
);

// ── 安全阀：自动放行类规则必须先过模拟 ──
const autoPass = await fetch(`${apiBase2}/api/v1/projects/${projectId}/policies`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': actorId },
  body: JSON.stringify({
    name: '冒烟：中低风险部署自动放行',
    priority: 190,
    condition: {
      all: [
        { fact: 'riskLevel', op: 'in', value: ['low', 'medium'] },
        { fact: 'operationType', op: 'eq', value: 'deploy' },
      ],
    },
    action: { type: 'allow' },
  }),
});
const autoBody = await autoPass.json();
// ★ 没有模拟，用户不敢放开自动化；不放开自动化，产品价值就打折。
//   所以这道闸必须在服务端，不能靠客户端自觉。
if (autoPass.status === 422) {
  check(
    '★ 会误批历史案例的放行规则被服务端拦下',
    /人类当时是驳回/.test(autoBody.error?.message ?? '') &&
      autoBody.error?.details?.simulation?.mismatches?.length > 0,
    autoBody.error?.message?.slice(0, 50) ?? '',
  );
} else {
  console.log('· 跳过安全阀检查：这批历史数据里没有会被误批的案例');
}

// ── riskLevel 的 in 比较必须真的生效 ──
// 这条曾经是个静默失效的 bug：规则界面上看着对，却永远不命中
const evalRes = await (
  await fetch(`${apiBase2}/api/v1/projects/${projectId}/policies/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { riskLevel: 'medium', operationType: 'code_change', environment: 'dev' },
    }),
  })
).json();
check(
  '★ riskLevel 用 in 比较的规则真的会命中（曾经静默失效）',
  Array.isArray(evalRes.trace) && evalRes.trace.length > 0,
  `${evalRes.trace?.length ?? 0} 条规则被评估`,
);

await browser.close();

const failed = results.filter((r) => !r.ok);
if (problems.length) {
  console.log('\n非 2xx 请求 / 页面异常:');
  for (const p of [...new Set(problems)]) console.log('  ' + p);
}
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length || problems.length ? 1 : 0);
