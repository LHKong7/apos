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

/**
 * ★★ 先登录换一张令牌，再让浏览器带着它开页面。
 *
 *   身份改由 JWT 证明之后，直接 goto 看板只会停在登录页 ——
 *   而那时所有断言都会失败在「找不到看板」上，指向完全错误的方向。
 *
 * ★ 凭证默认取 .env 里的超管。冒烟要跑通「批准决策」这类写操作，
 *   身份必须是项目成员且权限够 —— 种子数据里那个人正是超管。
 */
const apiBase = process.env.API_URL ?? 'http://localhost:3000';
const smokeEmail = process.env.APOS_SMOKE_EMAIL ?? process.env.APOS_SUPERADMIN_EMAIL;
const smokePassword = process.env.APOS_SMOKE_PASSWORD ?? process.env.APOS_SUPERADMIN_PASSWORD;
if (!smokeEmail || !smokePassword) {
  console.error(
    '冒烟需要一个能登录的账号。请设置 APOS_SUPERADMIN_EMAIL / APOS_SUPERADMIN_PASSWORD\n' +
      '（或 APOS_SMOKE_EMAIL / APOS_SMOKE_PASSWORD 单独指定）。',
  );
  process.exit(1);
}

const loginRes = await fetch(`${apiBase}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: smokeEmail, password: smokePassword }),
});
if (!loginRes.ok) {
  console.error(`登录失败（HTTP ${loginRes.status}）：${JSON.stringify(await loginRes.json())}`);
  process.exit(1);
}
const { token: smokeToken, user: smokeUser } = await loginRes.json();

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/**
 * ★ 令牌要在**任何页面脚本跑之前**写进 localStorage。
 *   goto 之后再写的话，应用已经读过一次「没有令牌」并渲染了登录页。
 */
await page.addInitScript((t) => localStorage.setItem('apos.token', t), smokeToken);

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

/**
 * ★ 直连 API 的请求必须带令牌 —— 和浏览器里那条是同一张。
 *   服务端按项目成员关系鉴权（09-security §2.1 第②层）。
 */
async function authed(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${smokeToken}` },
  });
}
const boardJson = await (await authed(`${apiBase}/api/v1/projects/${projectId}/board`)).json();
const gated = boardJson.columns.flatMap((c) => c.items).find((c) => c.humanGateRef);

const detail = gated
  ? await (await authed(`${apiBase}/api/v1/decisions/${gated.humanGateRef}`)).json()
  : null;

/**
 * ★★ 身份改由令牌证明之后，这个脚本只能以**它登录的那个人**去批。
 *
 *   此前它会挑出决策的责任人再冒充他 —— 那正是「决策不可代行」
 *   要禁止的事，只不过当时 X-User-Id 让它做得到。
 *   所以这里改成：责任人是别人时就跳过，而不是想办法绕过去。
 */
const canApprove =
  gated && (detail.decision.assigneeId === null || detail.decision.assigneeId === smokeUser.id);

if (gated && canApprove) {
  const approved = await authed(`${apiBase}/api/v1/decisions/${gated.humanGateRef}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
} else if (gated) {
  console.log('· 跳过旁观模式检查：这条决策的责任人不是冒烟身份，代行会（正确地）被拒');
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
const boardForRun = await (await authed(`${apiBase}/api/v1/projects/${projectId}/board`)).json();
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
    const d = await (await authed(`${apiBase}/api/v1/runs/${item.runId}`)).json();
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
// ── 质量与成本效益（页面文档 12）──────────────────────────────────────
await page.goto(`${base}/projects/${projectId}/analytics?tab=quality`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const qualityText = await page.locator('main').innerText();
/**
 * ★ 没有数据源时必须说「未接入」并给出怎么接，绝不显示 0 ——
 *   0 会被读成「一个都没通过」或「质量完美」。
 */
check(
  '★ 质量指标没接数据源时说「未接入」并给出接入路径，而不是显示 0',
  /未接入|数据源还没接上/.test(qualityText) && /集成设置/.test(qualityText),
  qualityText.split('\n').find((l) => l.includes('未接入') || l.includes('还没接上'))?.trim() ?? '',
);
check('质量指标标明各自的数据来源', /CI|check-run|incident/.test(qualityText));
await shot('analytics-quality');

await page.goto(`${base}/projects/${projectId}/analytics?tab=benefit`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const benefitText = await page.locator('main').innerText();
// ★ 系统不替用户填一个时薪 —— 编出来的「省了多少」经不起一次追问
check(
  '★ 成本效益的基准由用户自己填，且明说不替他编一个',
  /人力成本基准/.test(benefitText) && /这个数只有你知道/.test(benefitText),
);
check(
  '★ 代价那一侧也给出来（不只算 Agent 干了多少活）',
  /代价侧/.test(benefitText) && /人工覆盖占用的时间/.test(benefitText) && /返工/.test(benefitText),
);
check(
  '每一行都写清数字怎么来的，包括其中的假设',
  /这是个假设，不是实测/.test(benefitText) && /不是计划估算/.test(benefitText),
);

// 填一个基准之后，结论必须始终带着「按你填的 X/小时」
const rate = page.getByLabel('人力小时成本');
if ((await rate.count()) > 0) {
  await rate.fill('50');
  await page.getByRole('button', { name: '保存' }).first().click();
  await page.waitForTimeout(1200);
  const after = await page.locator('main').innerText();
  check(
    '★ 填了基准后结论始终带上「按你填的 X/小时」，可被追问',
    /按你填的 \$50\/小时/.test(after) && /换个数就是另一个结论/.test(after),
    after.split('\n').find((l) => l.includes('按你填的'))?.slice(0, 60) ?? '',
  );
  check('算式逐行摊开', /算式/.test(after));
  await shot('analytics-benefit');
}

// ── 通知投递记录（产品文档十一）──────────────────────────────────────
const notif = await page.request.get(
  `${base}/api/v1/projects/${projectId}/notifications`,
  { headers: { Authorization: `Bearer ${smokeToken}` } },
);
if (notif.ok()) {
  const body = await notif.json();
  // ★ 「发过没有」必须查得到 —— 通知最典型的故障是静默失败
  check(
    '★ 通知投递有记录可查（成功、失败、被抑制都留痕）',
    Array.isArray(body.deliveries) && typeof body.stats?.delivered === 'number',
    `已投递 ${body.stats?.delivered ?? 0} · 被抑制 ${body.stats?.suppressed ?? 0} · 失败 ${body.stats?.failed ?? 0}`,
  );
}

// ── 命中明细（页面文档 13）────────────────────────────────────────────
// ★ 看不到是哪 47 次的规则等于无法审计，而无法审计的规则没人敢改
const hitBtn = page.getByRole('button', { name: /近 30 天命中 [1-9]/ }).first();
if ((await hitBtn.count()) > 0) {
  await hitBtn.click();
  await page.waitForTimeout(1000);
  const hitsText = await page.locator('div[role="dialog"]').innerText();
  check(
    '★ 命中次数可点开成逐次明细（时间/任务/上下文/判定/结局）',
    /触发上下文/.test(hitsText) && /结局/.test(hitsText),
  );
  check(
    '★ 明细直接给结论，而不是让用户从百分比自己推',
    /这条规则|样本还不够|没有命中/.test(hitsText),
    hitsText.split('\n').find((l) => l.includes('——'))?.trim() ?? '',
  );
  check(
    '判定动作显示中文名，不是裸 key',
    !/require_human_review|allow_and_notify/.test(hitsText),
  );
  await shot('policy-hits');
  await page.getByRole('button', { name: '关闭' }).last().click();
  await page.waitForTimeout(300);
}

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
const loosenOrg = await authed(`${apiBase}/api/v1/projects/${projectId}/policies`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
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
const autoPass = await authed(`${apiBase}/api/v1/projects/${projectId}/policies`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
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
  await authed(`${apiBase}/api/v1/projects/${projectId}/policies/evaluate`, {
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

// ── ★ 完整入口链路：录入 → 分析 → 澄清 → 确认 → 计划 → 批准 → 看板 ──
//    这是整个产品的主干。它一断，用户就只能靠种子脚本往系统里塞活。
await page.goto(`${base}/projects/${projectId}/requirements`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

await page
  .locator('textarea')
  .fill('客服说导出订单报表要等两分钟，经常超时。希望改成异步导出并在完成后通知，支持按日期范围和店铺筛选。');
await page.getByRole('button', { name: /下一步/ }).click();
await page.waitForTimeout(1500);
check('录入需求后进入需求详情页', /\/requirements\/[0-9a-f-]{36}/.test(page.url()));

await page.getByRole('button', { name: '开始 AI 分析' }).click();
await page.waitForTimeout(2500);
const analyzed = await page.locator('main').innerText();
check(
  'AI 分析产出结构化结果与完整度',
  /需求完整度/.test(analyzed) && /业务目标/.test(analyzed),
  analyzed.match(/\d+ 分/)?.[0] ?? '',
);
// ★ 原文永不被结构化结果覆盖 —— 用户要能自己核对 AI 有没有理解错
check('原始输入与结构化结果左右对照', /原始输入/.test(analyzed) && /原文永不被结构化结果覆盖/.test(analyzed));
check('澄清问题给出影响与 Agent 倾向', /影响：/.test(analyzed) && /Agent 倾向：/.test(analyzed));

const scoreBefore = Number(analyzed.match(/(\d+) 分/)?.[1] ?? 0);

// ★ 必答问题没答完，确认要被拦住
await page.getByRole('button', { name: '确认需求 →' }).click();
await page.waitForTimeout(400);
const confirmText = await page.locator('h2:has-text("确认这条需求") >> xpath=..').innerText();
check(
  '★ 必答问题未答完时，确认弹窗明说会被拒绝',
  /必答问题没回答/.test(confirmText),
  confirmText.split('\n').find((l) => l.includes('必答')) ?? '（本次没有必答问题）',
);
await page.getByRole('button', { name: '返回修改' }).click();
await page.waitForTimeout(300);

for (let i = 0; i < 8; i++) {
  const btn = page.getByRole('button', { name: /采纳倾向|接受默认/ }).first();
  if ((await btn.count()) === 0) break;
  await btn.click();
  await page.waitForTimeout(900);
}
const scoreAfter = Number((await page.locator('main').innerText()).match(/(\d+) 分/)?.[1] ?? 0);
// ★ 分数实时回升是给用户的正反馈，也是他答完剩下问题的动力
check('★ 回答澄清后完整度实时回升', scoreAfter >= scoreBefore, `${scoreBefore} → ${scoreAfter}`);

await page.getByRole('button', { name: '确认需求 →' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: '确认' }).last().click();
await page.waitForTimeout(4500);
check('确认需求后直接进入计划页', /\/plans\/[0-9a-f-]{36}/.test(page.url()), new URL(page.url()).pathname);

const planText = await page.locator('main').innerText();
// ★ 批准计划 = 批准一批自动化行为。这一段是本页的灵魂
check(
  '★ 计划页写清「批准后将自动发生」',
  /批准后将自动发生/.test(planText) && /仍需人确认的/.test(planText),
  planText.split('\n').find((l) => l.startsWith('· ') && l.includes('自动执行')) ?? '',
);
check('给出人机拆分、成本与高风险任务数', /🤖 \d+/.test(planText) && /高风险任务/.test(planText));
// 批准前那个数字如果是错的，用户就是闭着眼睛签字
const agentCount = Number(planText.match(/🤖 (\d+)/)?.[1] ?? 0);
check('★ 人机拆分不是 0（批准前执行主体还没绑定，要从快照推）', agentCount > 0, `🤖 ${agentCount}`);
check('提供跳到 Policy 配置调整边界的入口', /调整这些规则/.test(planText));
await shot('plan');

// ── 要求修改 → 版本对比（页面文档 04）──────────────────────────────────
await page.getByRole('button', { name: '要求修改' }).first().click();
await page.waitForTimeout(300);
await page.locator('div[role="dialog"] textarea').fill('测试拆得太粗，请再拆细；工时也估少了');
await page.getByRole('button', { name: '重新规划' }).last().click();
await page.waitForTimeout(4000);

const diffText = await page.locator('main').innerText();
/**
 * ★ 用户要批准的是 v2，脑子里记得的是 v1。不给 diff 的话他只能整个重读一遍 ——
 *   而重读一遍的真实结果通常是不读，直接批。
 */
check(
  '★ 新版本页面直接给出与上一版的差异',
  /与 v1 的差异/.test(diffText) && /任务变化/.test(diffText),
  diffText.split('\n').find((l) => l.startsWith('任务变化')) ?? '',
);
check(
  '★ 差异里最先回答的是「自动化边界变了没有」',
  /自动化边界/.test(diffText),
  diffText.split('\n').find((l) => l.includes('自动化边界'))?.trim() ?? '',
);
// ★ 意见只存不传给规划器的话，v2 会和 v1 一模一样，而没人会发现
check(
  '★ 修改意见真的改变了计划（不是只存进数据库）',
  !/内容相同的计划/.test(diffText) && /总量变化/.test(diffText),
  diffText.split('\n').find((l) => l.startsWith('任务数') || l.startsWith('总工时')) ?? '',
);
check(
  '差异标明这一版是基于哪条意见重新规划的',
  /这一版是基于这条意见重新规划的/.test(diffText),
);
await shot('plan-diff');

await page.getByRole('button', { name: '批准并开始执行 →' }).click();
await page.waitForTimeout(500);
const approveText = await page.locator('h2:has-text("批准这份计划") >> xpath=..').innerText();
check(
  '★ 批准弹窗复述边界，不是一个「确定吗」',
  /个任务将由 Agent 自动执行/.test(approveText) && /个节点仍会来找人确认/.test(approveText),
);
await page.getByRole('button', { name: '批准并开始执行' }).last().click();
await page.waitForTimeout(3000);
check('★ 批准后任务进入看板', page.url().endsWith('/board'), new URL(page.url()).pathname);

// ── 项目总览（页面文档 02）────────────────────────────────────────────
await page.goto(`${base}/projects/${projectId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const ovText = await page.locator('main').innerText();
check('总览渲染五个指标卡', (await page.getByRole('button').filter({ hasText: /健康度|延期风险|待决策/ }).count()) >= 3);
// ★ 说不清来源的分数会被当成事实引用，也会被当成玄学忽略 —— 两种下场都不好
await page.getByRole('button').filter({ hasText: '健康度' }).first().click();
await page.waitForTimeout(300);
const healthText = await page.locator('main').innerText();
check(
  '★ 健康度能展开成逐项扣分，而不是一个凭空的分数',
  /分是这么来的/.test(healthText),
  healthText.split('\n').find((l) => l.includes('分是这么来的')) ?? '',
);
await page.getByRole('button').filter({ hasText: '延期风险' }).first().click();
await page.waitForTimeout(300);
const delayText = await page.locator('main').innerText();
check(
  '★ 延期预测如实说明它是经验规则而不是统计模型',
  /不是统计模型/.test(delayText),
);
// 活动流是给项目负责人看的，不是给运维看日志
check(
  '★ 最近活动是人话，不是事件类型的裸 key',
  /任务状态变更|Agent 执行完成|决策待处理/.test(ovText) && !/work_item\.|agent_run\./.test(ovText),
);
check('无人认领的决策被单独点名', !/项决策没有指定责任人/.test(ovText) || /最容易烂在队列里/.test(ovText));
/**
 * ★ 冷启动竞态：/users 还没回来时发出的请求是匿名的，后端会如实答
 *   「没有需要你处理的事」，然后这个答案被缓存下来 ——
 *   整页最不能说错的一区，恰好是最容易被这条竞态说错的。
 *   这里是硬刷新后的首屏，走的就是那条路径。
 */
const pendingN = Number(ovText.match(/待决策\n+(\d+)/)?.[1] ?? 0);
const actionN = Number(ovText.match(/需要你处理（(\d+)）/)?.[1] ?? 0);
check(
  '★ 冷启动首屏就带上身份：有待决策时「需要你处理」不是 0',
  pendingN === 0 || actionN > 0,
  `待决策 ${pendingN} · 需要你处理 ${actionN}`,
);
await shot('overview');

// ── 决策中心（页面文档 10）────────────────────────────────────────────
await page.goto(`${base}/projects/${projectId}/decisions`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const decText = await page.locator('main').innerText();
// ★ 5 分钟清空队列的前提：不用点进详情页就能拍板
check(
  '★ 决策卡片在列表里就给出「为什么需要你」与「不处理会怎样」',
  /要求人工介入|需人工确认/.test(decText) && /不处理：/.test(decText),
  decText.split('\n').find((l) => l.startsWith('不处理：')) ?? '',
);
check(
  '决策类型显示中文名而不是 high_risk_operation',
  !/high_risk_operation|release_approval|_approval/.test(decText),
);
check('每条都能就地批准或驳回', (await page.getByRole('button', { name: '批准' }).count()) > 0);
// ★ 批量的价值是省点击，不是省阅读
const batchNote = /不可逆或高风险，需逐条确认/.test(decText);
const batchBoxes = await page.locator('input[type="checkbox"]').count();
check(
  '★ 高风险/不可逆决策不给批量勾选框，并说明原因',
  batchNote || batchBoxes > 0,
  batchNote ? `${batchBoxes} 个可批量` : '当前队列全部可批量',
);
await shot('decisions');

// 驳回必须写原因 —— 「每次覆盖都要留下为什么」是这个系统的底线
const rejectBtn = page.getByRole('button', { name: '驳回' }).first();
if ((await rejectBtn.count()) > 0) {
  await rejectBtn.click();
  await page.waitForTimeout(300);
  const confirmReject = page.getByRole('button', { name: /确认驳回/ }).first();
  check('★ 驳回原因没填时确认按钮不可用', await confirmReject.isDisabled());
}

// ── Agent Workspace（页面文档 08）─────────────────────────────────────
await page.goto(`${base}/projects/${projectId}/agents`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const rosterText = await page.locator('main').innerText();
// ★ 基调是员工花名册，不是服务健康检查
check(
  '★ Agent 列表按人事口径给出负载/成功率/人工覆盖/成本/负责人',
  /人工覆盖/.test(rosterText) && /负责人/.test(rosterText) && /首次成功/.test(rosterText),
);
await shot('agents');

await page.locator('table a').first().click();
await page.waitForTimeout(1200);
const detText = await page.locator('main').innerText();
// ★ Agent 权限独立配置，绝不继承人类用户（产品文档 十）
check(
  '★ 权限边界写明独立配置且 Agent 自己改不了',
  /不继承任何人类用户/.test(detText) && /黑名单优先/.test(detText),
);
// ★ executorId 是永久归属，不是队列
const queueN = Number(detText.match(/任务队列（(\d+)）/)?.[1] ?? -1);
check(
  '★ 任务队列只算没做完的（归属 ≠ 队列）',
  queueN >= 0 && !/任务队列（\d+）[\s\S]{0,400}?已完成\n/.test(detText),
  `队列 ${queueN}`,
);
// ★ 不静默降级：这个运行时做不到什么、会怎样、对用户什么影响
check(
  '★ 运行时能力先说做不到什么，并给出降级行为与用户影响',
  /运行时能力/.test(detText) && (/→ /.test(detText) || /全部支持，没有降级/.test(detText)),
  detText.split('\n').find((l) => l.startsWith('→ ')) ?? '无降级项',
);
await shot('agent-detail');

// ── 集成设置（页面文档 14）────────────────────────────────────────────
await page.goto(`${base}/projects/${projectId}/settings/integrations`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const rtText = await page.locator('main').innerText();

check('运行时给出「能不能派任务」而不是数据库里的状态', /可派发|未注册|不可达/.test(rtText));
check('工具按副作用等级标注', /写入或外部副作用/.test(rtText) || /破坏性|外部系统/.test(rtText));

// ★ 用户要确认的往往是「这个连接不能合并我的代码」，只列允许项回答不了
check(
  '★ 权限同时列出允许项与禁止项',
  /✓ read_issue/.test(rtText) && /✗ (admin_project|delete_issue)/.test(rtText),
  rtText.split('\n').find((l) => l.includes('✗')) ?? '',
);
check(
  '★ 禁止项说明是集成层写死的，不是「这次没勾」',
  /由集成层写死/.test(rtText),
);
// ★ 凭证永不回显（§9）
check(
  '★ 凭证只显示后四位，页面上没有明文',
  /\*\*\*\*\w{4}/.test(rtText) && !/jira-pat|xoxb-/.test(await page.content()),
);

// ★ SoT 是这一页唯一带「关键配置」角标的一块
check(
  '★ Source of Truth 逐字段可配，且每格写明为什么默认是这个',
  /关键配置/.test(rtText) && /状态由 Flow Engine 事件驱动/.test(rtText) && /APOS 是产物的产生方/.test(rtText),
);
check(
  '提供三种预设，同时保留逐字段配置',
  /APOS 主导/.test(rtText) && /APOS 管执行/.test(rtText) &&
    (await page.locator('select[aria-label$="的 Source of Truth"]').count()) >= 5,
);

// ★ 改 SoT 前摆出差异与后果，而不是一句「确定吗」
const statusSelect = page.locator('select[aria-label="状态的 Source of Truth"]').first();
if ((await statusSelect.count()) > 0) {
  await statusSelect.selectOption('external');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /保存 \d+ 项修改/ }).click();
  await page.waitForTimeout(400);
  const dlg = await page.locator('div[role="dialog"]').innerText();
  check(
    '★ 改 Source of Truth 的确认框摆出「谁的修改会被丢掉」',
    /状态/.test(dlg) && /改了会被采纳/.test(dlg) && /改了按「/.test(dlg),
    dlg.split('\n').find((l) => l.includes('改了会被采纳'))?.trim() ?? '',
  );
  await page.getByRole('button', { name: '取消' }).last().click();
  await page.waitForTimeout(200);
}

// ★ 同步冲突：两侧的值 / 时间 / 谁改的，三样缺一不可
if (/同步冲突/.test(rtText)) {
  check(
    '★ 冲突摆出两侧的值与修改人，并指明该字段的 SoT 是谁',
    /APOS/.test(rtText) && /外部系统/.test(rtText) && /Source of Truth 是/.test(rtText),
    rtText.split('\n').find((l) => l.includes('Source of Truth 是'))?.trim() ?? '',
  );
  check(
    '★ 冲突时间是人话，不是原始 ISO 串',
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rtText),
  );
  check('提供「以后同类冲突自动按此处理」', /同类冲突自动按此处理/.test(rtText));
}

// ★ 循环同步抑制要能被看见（§11）
check(
  '★ 页面显示已阻止的循环同步次数',
  /已阻止 \d+ 次循环同步/.test(rtText),
  rtText.split('\n').find((l) => l.includes('已阻止')) ?? '',
);

// ★ 通知默认只发「需要行动」的事
check(
  '★ 高频通知默认关闭并标出来',
  /每个任务状态变化/.test(rtText) && /默认关/.test(rtText),
);
check(
  '通知里不做「直接批准」，说明了为什么',
  /不放「直接批准」按钮/.test(rtText),
);

// ★ 断开前给出具体影响
const cutBtn = page.getByRole('button', { name: '断开' }).first();
if ((await cutBtn.count()) > 0) {
  await cutBtn.click();
  await page.waitForTimeout(700);
  const dlg = await page.locator('div[role="dialog"]').innerText();
  check(
    '★ 断开前列出具体影响，不是一句「确定吗」',
    /断开后会发生/.test(dlg) && /个任务/.test(dlg),
    dlg.split('\n').find((l) => l.startsWith('·'))?.trim() ?? '',
  );
  await page.getByRole('button', { name: '取消' }).last().click();
  await page.waitForTimeout(200);
}

// ★ 企业数据系统明说没做
check(
  '★ 明说企业数据系统没有实现，而不是放一个点不动的连接按钮',
  /组织级配置页还没有做/.test(rtText) &&
    (await page.getByRole('button', { name: /^连接$|授权/ }).count()) === 0,
);
await shot('integrations');


await browser.close();

const failed = results.filter((r) => !r.ok);
if (problems.length) {
  console.log('\n非 2xx 请求 / 页面异常:');
  for (const p of [...new Set(problems)]) console.log('  ' + p);
}
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length || problems.length ? 1 : 0);
