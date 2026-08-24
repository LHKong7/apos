import { useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api/client';
import { apiErrorMessage } from '../../lib/api/errors';
import { qk } from '../../lib/query/keys';
import { QueryBoundary } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { relativeTime, tokens } from '../../lib/format';
import { useOrgStore } from '../../stores/org';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const AUTONOMY_KEYS: Record<string, MessageKey> = {
  human_led: 'project.autonomy.humanLed',
  agent_led_approval: 'project.autonomy.agentApproval',
  agent_autonomous: 'project.autonomy.agentAutonomous',
};

export function ProjectListPage() {
  const t = useT();
  const projects = useQuery({ queryKey: qk.projects(), queryFn: api.projects });
  const org = useOrgStore((s) => s.org);
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto w-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-5 flex items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('project.title')}</h1>
          <p className="mt-0.5 text-xs text-slate-400">{t('project.subtitle')}</p>
        </div>
        {org && (
          <span className="self-start rounded-full border border-slate-200 bg-slate-100/60 px-2 py-0.5 text-[11px] text-slate-500">
            {org.name}
          </span>
        )}
        {/*
          ★★ 在此之前这一页只有列表：`POST /api/v1/projects` 存在，
            但界面上没有任何入口，空态提示是「先跑一遍 seed」——
            也就是说建项目这件事只有开发者做得到。
        */}
        <Button variant="ghost"
          onClick={() => setCreating(true)}
          className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-auto self-start rounded-md bg-gradient-to-r from-brand-alt via-brand to-brand-far px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:brightness-110"
        >
          + {t('project.new')}
        </Button>
      </div>

      <QueryBoundary
        query={projects}
        isEmpty={(d) => d.projects.length === 0}
        empty={{
          icon: '📁',
          message: org ? t('project.emptyInOrg', { org: org.name }) : t('project.empty'),
          hint: t('project.emptyHint'),
          action: { label: t('project.new'), onClick: () => setCreating(true) },
        }}
      >
        {(data) => (
          <ul className="space-y-2">
            {data.projects.map((p) => (
              <li key={p.id}>
                {/* 进项目先到总览 —— 「现在什么情况、要不要我管」比一屏卡片先回答 */}
                <Link
                  to={`/projects/${p.id}`}
                  className="lift group relative flex items-center gap-4 overflow-hidden rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm hover:border-brand/40 hover:shadow-md"
                >
                  {/* 悬停时左侧亮起一道品牌色 —— 指明「点这里会进去」，
                      比整块变底色更轻，不会在一屏十几行里造成闪烁感 */}
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-brand-alt to-brand-far opacity-0 transition-opacity group-hover:opacity-100"
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-medium text-slate-900">{p.name}</h2>
                    {p.goal && <p className="mt-0.5 truncate text-xs text-slate-500">{p.goal}</p>}
                  </div>
                  <span className="shrink-0 rounded-full border border-slate-200 bg-slate-100/70 px-2 py-0.5 text-[11px] text-slate-600">
                    {AUTONOMY_KEYS[p.autonomyLevel]
                      ? t(AUTONOMY_KEYS[p.autonomyLevel]!)
                      : p.autonomyLevel}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
                    {tokens(p.tokensSpent)}
                    {p.tokenBudget !== null && (
                      <span className="text-slate-400"> / {tokens(p.tokenBudget)}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {relativeTime(p.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>

      {creating && <CreateProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [autonomyLevel, setAutonomyLevel] = useState('agent_led_approval');
  const [budget, setBudget] = useState('');
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: (tokenBudget: number | undefined) =>
      api.createProject({
        name: name.trim(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        autonomyLevel,
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
      }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: qk.projects() });
      navigate(`/projects/${res.project.id}`);
      onClose();
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || !Array.isArray(error.details)) return;
      const budgetIssue = error.details.some((issue: unknown) => {
        const path = (issue as { path?: unknown })?.path;
        return Array.isArray(path) && path.includes('tokenBudget');
      });
      if (budgetIssue) setBudgetError(t('project.budgetInvalid'));
    },
  });

  return (
    <Modal onClose={onClose} title={t('project.new')}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{t('project.new')}</h2>
        <p className="text-[11px] text-slate-500">
          {t('project.newHint')}
        </p>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">{t('project.name')}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('project.namePlaceholder')}
            className="mt-1" />
        </Label>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">
            {t('project.goal')}
            <span className="ml-1 font-normal text-slate-400">{t('login.field.optional')}</span>
          </span>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder={t('project.goalPlaceholder')}
            className="mt-1"
          />
        </Label>

        <div className="block">
          <Label htmlFor="new-project-autonomy" className="text-slate-700">
            {t('project.autonomyLevel')}
          </Label>
          <Select value={autonomyLevel} onValueChange={setAutonomyLevel}>
            <SelectTrigger id="new-project-autonomy" className="mt-1 bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(AUTONOMY_KEYS).map(([value, labelKey]) => (
                <SelectItem key={value} value={value}>
                  {t(labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/*
            ★ 这一项决定「哪些事 Agent 可以自己做」，是项目里最该被
              一眼看见的设置。默认取中间那档，而不是最自主的那档。
          */}
          <p className="mt-1 text-[11px] text-slate-500">
            {t('project.autonomyHint')}
          </p>
        </div>

        <Label className="block">
          <span className="text-xs font-medium text-slate-700">
            {t('project.budgetCap')}
            <span className="ml-1 font-normal text-slate-400">{t('project.budgetHint')}</span>
          </span>
          <Input
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              setBudgetError(null);
            }}
            placeholder="500000"
            inputMode="numeric"
            type="number"
            min={1}
            step={1}
            aria-invalid={Boolean(budgetError)}
            aria-describedby="new-project-budget-error"
            className="mt-1" />
          {budgetError && (
            <span id="new-project-budget-error" className="mt-1 block text-[11px] text-rose-600">
              {budgetError}
            </span>
          )}
        </Label>

        {create.error instanceof ApiError && !budgetError && (
          <p className="text-xs text-rose-600">{apiErrorMessage(create.error, t('project.createFailed'))}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm"
            onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="neutral" size="sm"
            disabled={!name.trim() || create.isPending}
            onClick={() => {
              const value = budget.trim();
              if (value && (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value)))) {
                setBudgetError(t('project.budgetInvalid'));
                return;
              }
              setBudgetError(null);
              create.mutate(value ? Number(value) : undefined);
            }}>
            {create.isPending ? t('project.creating') : t('project.create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
