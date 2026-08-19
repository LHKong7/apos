import { describe, expect, it } from 'vitest';
import { en } from '../../lib/i18n/en';
import type { DiagnosticActionLabel, DiagnosticMessageCode } from '@apos/domain';

/**
 * ★★ 码与词条必须齐。
 *
 *   domain 那边加一个新的诊断码、前端忘了加词条，界面上出现的是
 *   `diag.msg.some_new_code` 这样一串裸 key —— 而它长得像 bug，
 *   不像「这条诊断说的是什么」。这条测试让那个疏漏在 CI 上就红。
 *
 * ★ 反过来那半也查：词条留着而码已经删了，是没人会去清的死词条。
 */

const MESSAGE_CODES: DiagnosticMessageCode[] = [
  'cycle',
  'blocking_amplified',
  'blocking_amplified_critical_path',
  'pseudo_serial',
  'approval_bottleneck',
  'single_point',
  'agent_overload',
];

const ACTION_LABELS: DiagnosticActionLabel[] = [
  'expedite',
  'reassign',
  'locateOnBoard',
  'adjustPolicy',
  'addBackupApprover',
  'splitOffIndependentPart',
  'spreadAcrossAgents',
  'breakDependencyManually',
  'adjustDependency',
];

describe('图诊断的码都有词条', () => {
  it('每个 messageCode 都有对应词条', () => {
    const missing = MESSAGE_CODES.filter(
      (code) => en[`diag.msg.${code}` as keyof typeof en] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('每个 labelCode 都有对应词条', () => {
    const missing = ACTION_LABELS.filter(
      (code) => en[`diag.action.${code}` as keyof typeof en] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('没有多余的诊断词条留在目录里', () => {
    const declared = new Set([
      ...MESSAGE_CODES.map((c) => `diag.msg.${c}`),
      ...ACTION_LABELS.map((c) => `diag.action.${c}`),
    ]);
    const orphans = Object.keys(en).filter(
      (k) => (k.startsWith('diag.msg.') || k.startsWith('diag.action.')) && !declared.has(k),
    );
    expect(orphans).toEqual([]);
  });
});
