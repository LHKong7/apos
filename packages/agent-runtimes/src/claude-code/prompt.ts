import type { TaskDispatch } from '@apos/contracts';
import { buildGovernanceRules, buildPersona } from '../prompt';
import type { MappedPermissions } from './permissions';

export { buildPrompt } from '../prompt';

/**
 * 追加到 claude_code 预设之后的系统提示 —— prompt 三层里的第 1、2 层。
 *
 * 第 3 层（项目工程约定）走 `TaskDispatch.context`，由 buildPrompt 渲染，
 * 不在这里重复。这里只写「规则」，任务内容在 prompt 里。
 */
export function buildSystemAppend(task: TaskDispatch, mapped: MappedPermissions): string {
  const persona = buildPersona(task);
  const rules = buildGovernanceRules(task, {
    writable: mapped.writable,
    otherScopes: mapped.otherScopes,
  });
  return persona ? `${rules}\n\n${persona}` : rules;
}
