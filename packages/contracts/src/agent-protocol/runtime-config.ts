import { z } from 'zod';

/**
 * Headless CLI 的运行时配置 schema —— 由平台统一定义，Agent 逐个覆盖。
 *
 * ★ 为什么要有这层 schema，而不是让每个 Agent 存一坨自由 JSON：
 *
 *   1. **前端不必为每种 CLI 各写一个表单**。加一种 CLI 只改这一个文件，
 *      配置界面自动长出对应的字段。
 *   2. **服务端能校验**。`effort: 'ultra'` 这种值如果放行，表现是派发成功
 *      但 CLI 启动时报一句没人看的参数错误 —— 在保存那一刻拒掉才对。
 *   3. **影响可标注**。哪些字段影响成本、哪些影响安全边界，界面要能凸显。
 *      一个把 maxTurns 从 60 调到 500 的人，应该当场看到「这会显著提高单次成本」。
 *
 * ★ 这里只描述**能配什么**，不描述**怎么用**。怎么用是各适配器的事，
 *   两边靠 key 对齐（见 runtime-factory 的 buildOptions）。
 */

export const ConfigFieldType = z.enum(['string', 'number', 'boolean', 'select', 'string_list']);
export type ConfigFieldType = z.infer<typeof ConfigFieldType>;

export interface ConfigFieldOption {
  value: string;
  label: string;
  help?: string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  default: unknown;
  help?: string;
  options?: ConfigFieldOption[];
  min?: number;
  max?: number;
  /** 界面据此凸显：调这个字段会花更多钱 / 会放宽安全边界 */
  impact?: 'cost' | 'safety';
  /** 折叠进「高级」，默认不展示 */
  advanced?: boolean;
}

export interface RuntimeKindSpec {
  kind: string;
  label: string;
  description: string;
  /** null = 该运行时不需要凭证 */
  credential: { label: string; help: string } | null;
  /** null = 不支持自定义接入地址 */
  endpoint: { label: string; help: string } | null;
  /** 部署环境的前置条件，界面上提前说，而不是等第一次派发才失败 */
  prerequisite: string | null;
  fields: ConfigField[];
}

const PASSTHROUGH_ENV: ConfigField = {
  key: 'passthroughEnv',
  label: '透传环境变量',
  type: 'string_list',
  default: [],
  advanced: true,
  impact: 'safety',
  help:
    '默认只给子进程 PATH / HOME / 该运行时自己的凭证。这里每加一个变量名，' +
    '就等于把它交给 Agent —— 不要把数据库口令、其他服务的 token 放进来。',
};

export const RUNTIME_KIND_SPECS: RuntimeKindSpec[] = [
  {
    kind: 'claude_code',
    label: 'Claude Code',
    description: '基于 Claude Agent SDK。工具级权限、实时事件流、执行中可注入约束，能力最完整。',
    credential: {
      label: 'Anthropic API Key',
      help: '推荐填 `env:变量名`，凭证只留在进程环境、不进数据库，且多个 Agent 共用同一变量名时轮换只需改一处。',
    },
    endpoint: null,
    prerequisite: null,
    fields: [
      {
        key: 'model',
        label: '模型',
        type: 'select',
        default: 'claude-opus-5',
        impact: 'cost',
        options: [
          { value: 'claude-opus-5', label: 'Opus 5', help: '最强，单价最高' },
          { value: 'claude-sonnet-5', label: 'Sonnet 5', help: '均衡，多数编码任务够用' },
          { value: 'claude-haiku-4-5', label: 'Haiku 4.5', help: '最快最省，适合评审、分类这类轻任务' },
        ],
      },
      {
        key: 'effort',
        label: '推理强度',
        type: 'select',
        default: 'xhigh',
        impact: 'cost',
        help: '直接影响思考的 token 量。评审类 Agent 用 low 通常就够，大重构才需要 max。',
        options: [
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
          { value: 'xhigh', label: 'xhigh（默认）' },
          { value: 'max', label: 'max' },
        ],
      },
      {
        key: 'maxTurns',
        label: '最大轮次',
        type: 'number',
        default: 60,
        min: 1,
        max: 500,
        impact: 'cost',
        help: '同时是进度条的分母。调高会显著抬高单次执行的成本上限。',
      },
      {
        key: 'onUngrantedTool',
        label: '遇到未授权工具',
        type: 'select',
        default: 'escalate',
        impact: 'safety',
        options: [
          {
            value: 'escalate',
            label: '停下来请人决策（默认）',
            help: '中断执行并生成一条待办，人可以当场授权后重试',
          },
          {
            value: 'deny',
            label: '拒绝但让它继续',
            help: 'Agent 自己收敛，不打扰人。适合跑批量低风险任务',
          },
        ],
      },
      PASSTHROUGH_ENV,
    ],
  },

  {
    kind: 'codex',
    label: 'Codex CLI',
    description:
      'OpenAI Codex CLI。权限是沙箱级而非工具级 —— 表达不了「Bash 可用但 rm 不可用」，映射时一律收紧。',
    credential: {
      label: 'OpenAI API Key',
      help: '推荐填 `env:变量名`。',
    },
    endpoint: {
      label: '接入地址',
      help: '自建网关或代理才填，留空走官方端点。',
    },
    prerequisite: '需要 codex CLI 已安装且在 PATH 中（或在下方指定可执行文件路径）。',
    fields: [
      {
        key: 'model',
        label: '模型',
        type: 'select',
        default: 'gpt-5-codex',
        impact: 'cost',
        options: [
          { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
          { value: 'gpt-5', label: 'GPT-5' },
          { value: 'o4-mini', label: 'o4-mini', help: '更省，适合轻任务' },
        ],
      },
      {
        key: 'approvalPolicy',
        label: '审批策略',
        type: 'select',
        default: 'never',
        impact: 'safety',
        help:
          '非交互执行下只有 never 是真正可用的 —— 其余档位会让 CLI 挂起等人在终端上确认，' +
          '而这里没有终端，表现是 Run 一直卡着直到超时。',
        options: [
          { value: 'never', label: 'never（默认，推荐）' },
          { value: 'on-failure', label: 'on-failure' },
          { value: 'untrusted', label: 'untrusted' },
        ],
      },
      {
        key: 'binary',
        label: '可执行文件',
        type: 'string',
        default: 'codex',
        advanced: true,
        help: '不在 PATH 里时填绝对路径。',
      },
      PASSTHROUGH_ENV,
    ],
  },

  {
    kind: 'mock',
    label: '内存运行时（演示 / 测试）',
    description: '不调用任何外部模型，按脚本产生事件。用于演练流程与验证降级路径，不会产生费用。',
    credential: null,
    endpoint: null,
    prerequisite: null,
    fields: [
      {
        key: 'outcome',
        label: '模拟结果',
        type: 'select',
        default: 'completed',
        options: [
          { value: 'completed', label: '成功' },
          { value: 'failed', label: '失败' },
        ],
      },
      {
        key: 'stepDelayMs',
        label: '每步延迟（毫秒）',
        type: 'number',
        default: 300,
        min: 0,
        max: 60_000,
        help: '调大可以观察执行中的进度与干预操作。',
      },
    ],
  },
];

export function runtimeKindSpec(kind: string): RuntimeKindSpec | null {
  return RUNTIME_KIND_SPECS.find((s) => s.kind === kind) ?? null;
}

export function isKnownRuntimeKind(kind: string): boolean {
  return runtimeKindSpec(kind) !== null;
}

export interface ConfigValidationIssue {
  key: string;
  message: string;
}

/**
 * 校验并归一化配置。
 *
 * ★ 未知字段会被**丢弃**而不是报错：schema 演进时（删掉一个字段）
 *   老 Agent 的库里还留着那个 key，报错会让它们全部改不动。
 *
 * ★ 缺失字段用默认值补齐，所以适配器侧永远能拿到完整配置，
 *   不用到处写 `?? 默认值` —— 那种散落的默认值迟早和这里对不上。
 */
export function validateRuntimeConfig(
  kind: string,
  input: Record<string, unknown> | null | undefined,
): { ok: true; config: Record<string, unknown> } | { ok: false; issues: ConfigValidationIssue[] } {
  const spec = runtimeKindSpec(kind);
  if (!spec) return { ok: false, issues: [{ key: 'kind', message: `不支持的运行时类型：${kind}` }] };

  const raw = input ?? {};
  const config: Record<string, unknown> = {};
  const issues: ConfigValidationIssue[] = [];

  for (const field of spec.fields) {
    const value = raw[field.key];
    if (value === undefined || value === null || value === '') {
      config[field.key] = field.default;
      continue;
    }

    switch (field.type) {
      case 'select': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (typeof value !== 'string' || !allowed.includes(value)) {
          issues.push({
            key: field.key,
            message: `${field.label} 只能是：${allowed.join(' / ')}`,
          });
          continue;
        }
        config[field.key] = value;
        break;
      }

      case 'number': {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n)) {
          issues.push({ key: field.key, message: `${field.label} 必须是数字` });
          continue;
        }
        if (field.min !== undefined && n < field.min) {
          issues.push({ key: field.key, message: `${field.label} 不能小于 ${field.min}` });
          continue;
        }
        if (field.max !== undefined && n > field.max) {
          issues.push({ key: field.key, message: `${field.label} 不能大于 ${field.max}` });
          continue;
        }
        config[field.key] = n;
        break;
      }

      case 'boolean':
        config[field.key] = Boolean(value);
        break;

      case 'string_list': {
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          issues.push({ key: field.key, message: `${field.label} 必须是字符串列表` });
          continue;
        }
        config[field.key] = value;
        break;
      }

      case 'string':
      default: {
        if (typeof value !== 'string') {
          issues.push({ key: field.key, message: `${field.label} 必须是文本` });
          continue;
        }
        config[field.key] = value;
        break;
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, config };
}

/** 只取默认值，用于新建表单的初始状态 */
export function defaultRuntimeConfig(kind: string): Record<string, unknown> {
  const spec = runtimeKindSpec(kind);
  if (!spec) return {};
  return Object.fromEntries(spec.fields.map((f) => [f.key, f.default]));
}
