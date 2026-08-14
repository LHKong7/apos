/**
 * 计划版本对比（页面文档 04）。
 *
 * ★ 重新规划会生成新版本，旧版标 superseded、两版都留着。
 *   但用户要批准的是 v2，而他脑子里记得的是 v1 ——
 *   不给 diff 的话，他只能把三十行任务清单整个重读一遍。
 *   而「重读一遍」的真实结果通常是不读，直接批。
 *   所以 diff 不是便利功能，是让「批准」这个动作重新有意义的东西。
 *
 * ★ 最重要的那一段不是任务增删，是**自动化边界的变化**：
 *   如果 v2 比 v1 多了一条「自动执行生产部署」，那是用户最需要看见的一行，
 *   而它会静静躺在一份三十行清单的中间。所以这一项单独算、单独排在最前面，
 *   并且只要边界放宽了就打上醒目标记。
 */

export interface PlanSide {
  version: number;
  status: string;
  createdAt: string;
  estimatedHours: number;
  estimatedTokens: number;
  tasks: PlanTaskSide[];
  /** 「批准后将自动发生」的快照 */
  autoActions: { title: string; detail?: string }[];
  /** 仍需人确认的节点快照 */
  humanGates: { taskTitle: string; reason?: string }[];
  risks: { title?: string; description?: string }[];
}

export interface PlanTaskSide {
  title: string;
  type: string;
  riskLevel: string;
  estimatedHours: number | null;
  estimatedTokens: number | null;
  requiresHuman: boolean;
}

export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface TaskDiff {
  title: string;
  kind: ChangeKind;
  /** changed 时逐字段列出，unchanged 时为空 */
  fields: FieldChange[];
  after: PlanTaskSide | null;
  before: PlanTaskSide | null;
}

export interface FieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
  /** 这个变化让边界更松了（更自动 / 更贵 / 风险更高） */
  loosened: boolean;
}

export interface PlanDiff {
  /**
   * ★ 排在最前，因为它是唯一一类「用户不看就会漏掉、漏掉就出事」的变化。
   *   其余变化最坏是计划不如预期，这一类最坏是批准了自己不知道的自动化。
   */
  boundary: {
    /** 新增的自动化动作 —— 用户上次批准时不存在的 */
    autoAdded: string[];
    autoRemoved: string[];
    /** 由「需人确认」变成「自动执行」的任务：边界放宽 */
    gatesRemoved: string[];
    /** 新增的人工确认点：边界收紧，是好事，但也要说 */
    gatesAdded: string[];
    /** 边界是否放宽了 —— 决定页面要不要红字提醒 */
    loosened: boolean;
  };
  tasks: TaskDiff[];
  metrics: FieldChange[];
  risks: { added: string[]; removed: string[] };
  /** 什么都没变（重新规划产出了一份一样的计划） */
  identical: boolean;
}

export function diffPlans(before: PlanSide, after: PlanSide): PlanDiff {
  const boundary = diffBoundary(before, after);
  const tasks = diffTasks(before.tasks, after.tasks);
  const metrics = diffMetrics(before, after);
  const risks = diffRisks(before, after);

  const identical =
    !boundary.loosened &&
    boundary.autoAdded.length === 0 &&
    boundary.autoRemoved.length === 0 &&
    boundary.gatesAdded.length === 0 &&
    tasks.every((t) => t.kind === 'unchanged') &&
    metrics.length === 0 &&
    risks.added.length === 0 &&
    risks.removed.length === 0;

  return { boundary, tasks, metrics, risks, identical };
}

function diffBoundary(before: PlanSide, after: PlanSide): PlanDiff['boundary'] {
  const beforeAuto = new Set(before.autoActions.map((a) => a.title));
  const afterAuto = new Set(after.autoActions.map((a) => a.title));
  const beforeGates = new Set(before.humanGates.map((g) => g.taskTitle));
  const afterGates = new Set(after.humanGates.map((g) => g.taskTitle));

  const autoAdded = [...afterAuto].filter((a) => !beforeAuto.has(a));
  const autoRemoved = [...beforeAuto].filter((a) => !afterAuto.has(a));

  /**
   * ★ 只算两版都有的任务。v2 新增的任务本来就没有 gate，
   *   算成「gate 被去掉了」会把每一次加任务都报成边界放宽，
   *   而一个总在喊狼来了的警告，用户第三次就不看了。
   */
  const shared = new Set(
    after.tasks.map((t) => t.title).filter((t) => before.tasks.some((b) => b.title === t)),
  );
  const gatesRemoved = [...beforeGates].filter((g) => shared.has(g) && !afterGates.has(g));
  const gatesAdded = [...afterGates].filter((g) => shared.has(g) && !beforeGates.has(g));

  return {
    autoAdded,
    autoRemoved,
    gatesRemoved,
    gatesAdded,
    /** 放宽 = 多了自动动作，或原本要人确认的现在不用了 */
    loosened: autoAdded.length > 0 || gatesRemoved.length > 0,
  };
}

function diffTasks(before: PlanTaskSide[], after: PlanTaskSide[]): TaskDiff[] {
  const beforeByTitle = indexByTitle(before);
  const afterByTitle = indexByTitle(after);
  const out: TaskDiff[] = [];

  // 保持 after 的顺序 —— 用户读的是新版，diff 应该跟着新版走
  for (const task of after) {
    const key = takeKey(afterByTitle, task);
    const prev = beforeByTitle.get(key)?.shift();

    if (!prev) {
      out.push({ title: task.title, kind: 'added', fields: [], after: task, before: null });
      continue;
    }

    const fields = diffTaskFields(prev, task);
    out.push({
      title: task.title,
      kind: fields.length > 0 ? 'changed' : 'unchanged',
      fields,
      after: task,
      before: prev,
    });
  }

  // before 里剩下的就是被删掉的
  for (const [, rest] of beforeByTitle) {
    for (const gone of rest) {
      out.push({ title: gone.title, kind: 'removed', fields: [], after: null, before: gone });
    }
  }

  return out;
}

function diffTaskFields(before: PlanTaskSide, after: PlanTaskSide): FieldChange[] {
  const out: FieldChange[] = [];

  if (before.requiresHuman !== after.requiresHuman) {
    out.push({
      field: 'requiresHuman',
      label: '执行方式',
      before: before.requiresHuman ? '👤 需要人' : '🤖 Agent',
      after: after.requiresHuman ? '👤 需要人' : '🤖 Agent',
      // 从「需要人」变成「Agent」是放宽
      loosened: before.requiresHuman && !after.requiresHuman,
    });
  }

  if (before.riskLevel !== after.riskLevel) {
    out.push({
      field: 'riskLevel',
      label: '风险',
      before: before.riskLevel,
      after: after.riskLevel,
      loosened: (RISK_RANK[after.riskLevel] ?? 0) > (RISK_RANK[before.riskLevel] ?? 0),
    });
  }

  if (numChanged(before.estimatedHours, after.estimatedHours)) {
    out.push({
      field: 'estimatedHours',
      label: '工时',
      before: fmtNum(before.estimatedHours, 'h'),
      after: fmtNum(after.estimatedHours, 'h'),
      loosened: (after.estimatedHours ?? 0) > (before.estimatedHours ?? 0),
    });
  }

  if (numChanged(before.estimatedTokens, after.estimatedTokens)) {
    out.push({
      field: 'estimatedTokens',
      label: 'token 用量',
      before: fmtNum(before.estimatedTokens, ''),
      after: fmtNum(after.estimatedTokens, ''),
      loosened: (after.estimatedTokens ?? 0) > (before.estimatedTokens ?? 0),
    });
  }

  if (before.type !== after.type) {
    out.push({
      field: 'type',
      label: '类型',
      before: before.type,
      after: after.type,
      loosened: false,
    });
  }

  return out;
}

function diffMetrics(before: PlanSide, after: PlanSide): FieldChange[] {
  const out: FieldChange[] = [];

  if (before.tasks.length !== after.tasks.length) {
    out.push({
      field: 'taskCount',
      label: '任务数',
      before: String(before.tasks.length),
      after: String(after.tasks.length),
      loosened: after.tasks.length > before.tasks.length,
    });
  }

  if (numChanged(before.estimatedHours, after.estimatedHours)) {
    out.push({
      field: 'estimatedHours',
      label: '总工时',
      before: fmtNum(before.estimatedHours, 'h'),
      after: fmtNum(after.estimatedHours, 'h'),
      loosened: after.estimatedHours > before.estimatedHours,
    });
  }

  if (numChanged(before.estimatedTokens, after.estimatedTokens)) {
    out.push({
      field: 'estimatedTokens',
      label: '预估 token 用量',
      before: fmtNum(before.estimatedTokens, ''),
      after: fmtNum(after.estimatedTokens, ''),
      loosened: after.estimatedTokens > before.estimatedTokens,
    });
  }

  const beforeHuman = before.tasks.filter((t) => t.requiresHuman).length;
  const afterHuman = after.tasks.filter((t) => t.requiresHuman).length;
  if (beforeHuman !== afterHuman) {
    out.push({
      field: 'humanTasks',
      label: '需人确认的任务',
      before: String(beforeHuman),
      after: String(afterHuman),
      // 需人确认的变少 = 自动化比例上升 = 边界放宽
      loosened: afterHuman < beforeHuman,
    });
  }

  return out;
}

function diffRisks(before: PlanSide, after: PlanSide): { added: string[]; removed: string[] } {
  const label = (r: { title?: string; description?: string }) => r.title ?? r.description ?? '';
  const b = new Set(before.risks.map(label).filter(Boolean));
  const a = new Set(after.risks.map(label).filter(Boolean));
  return {
    added: [...a].filter((x) => !b.has(x)),
    removed: [...b].filter((x) => !a.has(x)),
  };
}

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * 按标题分组。
 *
 * ★ 同名任务是存在的（「单元测试」可能有两条），所以每个标题存一个队列，
 *   按顺序配对。用 Map<string, Task> 的话，第二条同名任务会覆盖第一条，
 *   diff 里就会莫名其妙地出现一条「删除」加一条「新增」。
 */
function indexByTitle(tasks: PlanTaskSide[]): Map<string, PlanTaskSide[]> {
  const m = new Map<string, PlanTaskSide[]>();
  for (const t of tasks) {
    const list = m.get(t.title);
    if (list) list.push(t);
    else m.set(t.title, [t]);
  }
  return m;
}

function takeKey(_index: Map<string, PlanTaskSide[]>, task: PlanTaskSide): string {
  return task.title;
}

function numChanged(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(a - b) > 0.005;
}

function fmtNum(n: number | null, unit: string): string {
  if (n === null) return '—';
  const rounded = Math.round(n * 100) / 100;
  return `${rounded}${unit}`;
}
