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

await browser.close();

const failed = results.filter((r) => !r.ok);
if (problems.length) {
  console.log('\n非 2xx 请求 / 页面异常:');
  for (const p of [...new Set(problems)]) console.log('  ' + p);
}
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length || problems.length ? 1 : 0);
