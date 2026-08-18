import { useState } from 'react';
import clsx from 'clsx';
import type { ConfigField, RuntimeKindSpec } from '@apos/contracts';
import { useT, useSpecText } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * 运行时配置 —— 逐键的表单 / Per-key runtime configuration form.
 *
 * ★★ 这一段此前是**一个 25 行的 JSON 文本框**，旁边挂着一份说明书。
 *
 *   schema 里明明写着每个键的类型、取值范围、默认值和「改了会影响成本
 *   还是安全」，而界面把这些全部降级成了一段可以随便打字的文本。
 *   代价有三层：不懂 JSON 的人配不了；懂的人也会把 `"maxTurns": "30"`
 *   写成字符串；而「取值范围」这类约束只有服务端会拦 ——
 *   报错来得比输入晚了整整一次保存（问题记录 #18 / #46）。
 *
 *   schema 已经是数据了，这里只是把它当数据用。
 *
 * ★★ 但 JSON 那条路必须留着，而且**不能只是个只读预览**：
 *   平台不认识的键（新版 CLI 刚加的参数、私有分支的开关）只能从那儿进来，
 *   而服务端本来就照收（保存后提示一句「有几个键我不认识」）。
 *   把逃生口封掉，等于让界面的更新速度成为运行时能力的上限。
 *
 * ★ 高级项默认收起。它们大多带着 `impact: 'safety'` —— 一个默认展开的
 *   危险开关，被误碰的概率比被用到的概率高。
 *
 * The schema already carries type, range, default and blast radius for every
 * key; this renders it instead of degrading it to free text. The raw JSON path
 * stays fully editable, because unknown keys are the only way a new CLI flag
 * gets through before the UI knows about it.
 */
export function RuntimeConfigForm({
  spec,
  value,
  onChange,
  renderJson,
}: {
  spec: RuntimeKindSpec;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** JSON 逃生口由调用方渲染 —— 它带着自己的解析错误状态，不该在这里复制一份 */
  renderJson: () => React.ReactNode;
}) {
  const t = useT();
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const basic = spec.fields.filter((f) => !f.advanced);
  const advanced = spec.fields.filter((f) => f.advanced);

  /** ★ 平台不认识的键：表单渲染不了它们，但要让用户知道它们还在 */
  const unknownKeys = Object.keys(value).filter((k) => !spec.fields.some((f) => f.key === k));

  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Button
          variant={mode === 'form' ? 'neutral' : 'ghost'}
          size="xs"
          onClick={() => setMode('form')}
        >
          {t('agentCfg.form.modeForm')}
        </Button>
        <Button
          variant={mode === 'json' ? 'neutral' : 'ghost'}
          size="xs"
          onClick={() => setMode('json')}
          title={t('agentCfg.form.modeJsonHint')}
        >
          {t('agentCfg.form.modeJson')}
        </Button>
        {unknownKeys.length > 0 && (
          <span
            className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"
            title={t('agentCfg.form.customKeysHint', { keys: unknownKeys.join(', ') })}
          >
            {t('agentCfg.form.customKeys', { count: unknownKeys.length })}
          </span>
        )}
      </div>

      {mode === 'json' ? (
        renderJson()
      ) : (
        <div className="space-y-2">
          {basic.map((f) => (
            <FieldInput key={f.key} field={f} value={value[f.key]} onChange={(v) => set(f.key, v)} />
          ))}

          {advanced.length > 0 && (
            <div className="rounded border border-slate-200 bg-white p-2">
              <Button
                variant="link"
                onClick={() => setShowAdvanced((v) => !v)}
                className="h-auto p-0 text-[11px] font-normal text-slate-500 underline hover:text-slate-700"
              >
                {showAdvanced
                  ? t('agentCfg.form.hideAdvanced')
                  : t('agentCfg.form.showAdvanced', { count: advanced.length })}
              </Button>
              {showAdvanced && (
                <div className="mt-2 space-y-2">
                  {advanced.map((f) => (
                    <FieldInput
                      key={f.key}
                      field={f}
                      value={value[f.key]}
                      onChange={(v) => set(f.key, v)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/*
            ★ `json` 类型的字段（环境变量表）在表单模式下渲染不了得体的控件，
              直说让用户切过去，而不是给一个假的输入框。
          */}
          {spec.fields.some((f) => f.type === 'json') && (
            <p className="text-[11px] text-slate-500">{t('agentCfg.form.jsonFieldsHint')}</p>
          )}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const sx = useSpecText();
  const label = sx(field.label, field.labelEn);
  const help = field.help ? sx(field.help, field.helpEn) : null;
  /** ★ 没设过就落到默认值 —— 空着的输入框和「默认是 30」是两件事 */
  const current = value === undefined ? field.default : value;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-1.5">
        <Label className="text-[11px] font-medium text-slate-700">{label}</Label>
        <code className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">{field.key}</code>
        {/*
          ★ 影响范围就地标出来，不埋在说明书里。
            「改这个会花更多钱」「改这个会放宽安全边界」是按下去之前
            就该看见的，不是保存之后才发现的。
        */}
        {field.impact === 'cost' && (
          <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-800">
            {t('agentCfg.impact.cost')}
          </span>
        )}
        {field.impact === 'safety' && (
          <span className="rounded bg-rose-50 px-1 text-[10px] text-rose-700">
            <span aria-hidden>⚠ </span>
            {t('agentCfg.impact.safety')}
          </span>
        )}
      </div>

      <div className="mt-0.5">
        {field.type === 'boolean' ? (
          <Label className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <Checkbox
              checked={Boolean(current)}
              onCheckedChange={(v) => onChange(Boolean(v))}
            />
            {t('agentCfg.form.enabled')}
          </Label>
        ) : field.type === 'select' ? (
          <Select value={String(current ?? '')} onValueChange={onChange}>
            <SelectTrigger aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {sx(o.label, o.labelEn)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : field.type === 'number' ? (
          <Input
            type="number"
            min={field.min}
            max={field.max}
            value={current === null || current === undefined ? '' : String(current)}
            /**
             * ★ 空串存 undefined 而不是 0 —— 「清空」和「填 0」是两个意思，
             *   而 0 在 maxTurns 这类字段上意味着「一步都不许走」。
             */
            onChange={(e) =>
              onChange(e.target.value === '' ? undefined : Number(e.target.value))
            }
          />
        ) : field.type === 'string_list' ? (
          <Input
            value={Array.isArray(current) ? current.join(', ') : ''}
            placeholder={t('agentCfg.form.commaSeparated')}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              )
            }
          />
        ) : field.type === 'json' ? (
          <p className="rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
            {t('agentCfg.form.editInJson')}
          </p>
        ) : (
          <Input
            value={current === null || current === undefined ? '' : String(current)}
            onChange={(e) => onChange(e.target.value || undefined)}
          />
        )}
      </div>

      {help && <p className="mt-0.5 text-[11px] text-slate-500">{help}</p>}
      <p className="text-[11px] text-slate-400">
        {t('agentCfg.defaultValue', { value: describeDefault(field) })}
      </p>
    </div>
  );
}

/** ★ 默认值一直显示着 —— 「我改成什么了」只有对着原值才说得清 */
function describeDefault(f: ConfigField): string {
  const v = f.default;
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (v && typeof v === 'object') return Object.keys(v).join(', ') || '—';
  if (v === '' || v === null || v === undefined) return '—';
  return String(v);
}
