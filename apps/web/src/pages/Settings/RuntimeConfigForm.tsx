import { useState } from 'react';
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
 * Per-key runtime configuration form / 运行时配置 —— 逐键的表单。
 *
 * ★★ This used to be **one 25-line JSON textarea** with a manual next to it.
 *
 *   The schema already states each key's type, permitted range, default, and
 *   whether changing it affects cost or safety — and the UI degraded all of
 *   that into free text anyone could type into. The cost came in three layers:
 *   people who do not know JSON could not configure it at all; people who do
 *   still wrote `"maxTurns": "30"` as a string; and constraints like the
 *   permitted range were caught only by the server — so the error arrived a
 *   whole save later than the input (issues #18 / #46).
 *
 *   The schema is already data; this just uses it as data. It renders type,
 *   range, default, and blast radius for every key instead of degrading them to
 *   free text.
 *
 * ★★ But the JSON path has to stay, and it **must not be a read-only preview**:
 *   keys the platform does not know about (a flag a new CLI version just added,
 *   a switch on a private branch) can only get in that way, and the server
 *   accepts them anyway (it just notes after saving that a few keys were
 *   unrecognized). Sealing the escape hatch would make the UI's release cadence
 *   the ceiling on what the runtime can do.
 *
 * ★ Advanced fields are collapsed by default. Most of them carry
 *   `impact: 'safety'` — a dangerous switch that is expanded by default is more
 *   likely to be hit by accident than to be used on purpose.
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
  /** The caller renders the JSON escape hatch — it owns its own parse-error state, which must not be duplicated here */
  renderJson: () => React.ReactNode;
}) {
  const t = useT();
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const basic = spec.fields.filter((f) => !f.advanced);
  const advanced = spec.fields.filter((f) => f.advanced);

  /** ★ Keys the platform does not know: the form cannot render them, but the user must see they are still there */
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
            ★ A `json`-typed field (the environment variable map) has no decent
              control in form mode, so say so and point the user at the JSON
              tab instead of offering a fake input.
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
  /** ★ Never set falls back to the default — an empty input and "the default is 30" are two different things */
  const current = value === undefined ? field.default : value;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-1.5">
        <Label className="text-[11px] font-medium text-slate-700">{label}</Label>
        <code className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">{field.key}</code>
        {/*
          ★ The blast radius is marked in place, not buried in a manual.
            "Changing this will cost more money" and "changing this widens the
            safety boundary" are things to see before pressing the control, not
            to discover after saving.
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
             * ★ An empty string stores undefined, not 0 — "cleared" and "set
             *   to 0" mean different things, and on a field like maxTurns 0
             *   means "not allowed to take a single step".
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

/** ★ The default stays on screen — "what did I change it to" only makes sense next to the original */
function describeDefault(f: ConfigField): string {
  const v = f.default;
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (v && typeof v === 'object') return Object.keys(v).join(', ') || '—';
  if (v === '' || v === null || v === undefined) return '—';
  return String(v);
}
