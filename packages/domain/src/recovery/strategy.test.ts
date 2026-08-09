import { describe, expect, it } from 'vitest';
import { ErrorClass } from '@apos/contracts';
import { decideRecovery, type RecoveryInput } from './strategy';

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    errorClass: 'tool_failure',
    attempt: 1,
    maxAttempts: 3,
    hasAlternativeAgent: true,
    costRatio: 1,
    consecutiveFailures: 1,
    ...overrides,
  };
}

describe('decideRecovery', () => {
  it('覆盖全部错误分类，不返回 undefined', () => {
    for (const cls of ErrorClass.options) {
      const d = decideRecovery(input({ errorClass: cls }));
      expect(d, `${cls} 未返回恢复决策`).toBeDefined();
      expect(d.action).toBeTruthy();
      expect(d.reason).toBeTruthy();
    }
  });

  it('★ 重试无用的错误立即找人，不浪费成本', () => {
    // permission_denied 重试 100 次也不会成功
    const perm = decideRecovery(input({ errorClass: 'permission_denied', attempt: 1 }));
    expect(perm.action).toBe('request_decision');
    expect(perm.decisionType).toBe('permission_request');

    const budget = decideRecovery(input({ errorClass: 'budget_exceeded', attempt: 1 }));
    expect(budget.action).toBe('request_decision');
    expect(budget.decisionType).toBe('budget_overrun');

    const invalid = decideRecovery(input({ errorClass: 'invalid_task', attempt: 1 }));
    expect(invalid.action).toBe('request_decision');
  });

  it('上下文不足：先自动补充上下文重试，再失败才找人', () => {
    expect(decideRecovery(input({ errorClass: 'context_insufficient', attempt: 1 })).action).toBe(
      'retry_with_context',
    );
    expect(decideRecovery(input({ errorClass: 'context_insufficient', attempt: 2 })).action).toBe(
      'request_decision',
    );
  });

  it('能力不匹配：有替代 Agent 就改派，没有就转人工', () => {
    expect(
      decideRecovery(input({ errorClass: 'capability_mismatch', hasAlternativeAgent: true })).action,
    ).toBe('switch_agent');
    expect(
      decideRecovery(input({ errorClass: 'capability_mismatch', hasAlternativeAgent: false }))
        .action,
    ).toBe('transfer_to_human');
  });

  it('外部依赖异常：退避重试到上限后转决策', () => {
    expect(decideRecovery(input({ errorClass: 'external_unavailable', attempt: 1 })).action).toBe(
      'retry',
    );
    expect(
      decideRecovery(input({ errorClass: 'external_unavailable', attempt: 3, maxAttempts: 3 }))
        .action,
    ).toBe('request_decision');
  });

  it('超时：先尝试拆分任务而不是盲目重试', () => {
    expect(decideRecovery(input({ errorClass: 'timeout', attempt: 1 })).action).toBe('split_task');
    expect(decideRecovery(input({ errorClass: 'timeout', attempt: 2 })).action).toBe(
      'transfer_to_human',
    );
  });

  it('★ 连续失败 3 次一律暂停升级，覆盖所有错误分类', () => {
    for (const cls of ErrorClass.options) {
      const d = decideRecovery(input({ errorClass: cls, consecutiveFailures: 3 }));
      expect(d.action, `${cls} 连续失败 3 次未暂停`).toBe('pause_and_escalate');
    }
  });

  it('★ 成本护栏优先于错误分类：花到预估 3 倍就停', () => {
    const d = decideRecovery(input({ errorClass: 'context_insufficient', costRatio: 3.2 }));
    expect(d.action).toBe('request_decision');
    expect(d.decisionType).toBe('cost_overrun_on_retry');
  });

  it('成本护栏不影响连续失败的更高优先级', () => {
    const d = decideRecovery(input({ costRatio: 5, consecutiveFailures: 3 }));
    expect(d.action).toBe('pause_and_escalate');
  });
});
