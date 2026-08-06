import { ANY_STATE, PREVIOUS_STATE, type WorkItemMachine } from './machine.js';

/**
 * Work Item 状态机 —— docs/tech/04-flow-engine.md §2.1
 *
 * 自动流转（产品文档 8.4.4）：
 *   创建 → ready → (Run 启动) executing → (输出完成) reviewing
 *        → (测试+Review 通过) waiting_for_release → (发布完成) acceptance → done
 */
export const WORK_ITEM_MACHINE: WorkItemMachine = {
  initial: 'draft',
  transitions: [
    // ── Intake / Planning ────────────────────────────────────────────────
    { from: 'draft', trigger: 'plan_approved', to: 'ready' },
    { from: 'planning', trigger: 'plan_approved', to: 'ready' },
    { from: 'awaiting_plan_approval', trigger: 'plan_approved', to: 'ready' },

    // ── Execution ────────────────────────────────────────────────────────
    {
      from: 'ready',
      trigger: 'run_dispatched',
      to: 'executing',
      guards: ['dependenciesSatisfied', 'wipAvailable', 'executorAssigned'],
    },
    {
      from: 'ready',
      trigger: 'assigned_to_human',
      to: 'ready',
      guards: ['dependenciesSatisfied'],
      effects: ['notifyAssignee'],
    },
    {
      from: 'ready',
      trigger: 'human_work_started',
      to: 'executing',
      guards: ['dependenciesSatisfied'],
      effects: ['recordActualStart'],
    },

    {
      from: 'executing',
      trigger: 'agent_run_completed',
      to: 'reviewing',
      guards: ['hasOutput'],
    },
    { from: 'executing', trigger: 'human_work_completed', to: 'reviewing' },
    { from: 'executing', trigger: 'agent_run_failed', to: 'failed' },
    { from: 'executing', trigger: 'dependency_lost', to: 'blocked' },
    {
      from: 'executing',
      trigger: 'human_took_over',
      to: 'executing',
      effects: ['switchExecutorToHuman'],
    },

    // ── Failure & Recovery ───────────────────────────────────────────────
    { from: 'failed', trigger: 'retry_requested', to: 'ready' },
    { from: 'failed', trigger: 'reassigned', to: 'ready', effects: ['clearFailureCount'] },
    {
      from: 'failed',
      trigger: 'escalated_to_human',
      to: 'executing',
      effects: ['switchExecutorToHuman'],
    },
    { from: 'blocked', trigger: 'blocker_cleared', to: 'ready', effects: ['clearBlocked'] },
    { from: 'blocked', trigger: 'reassigned', to: 'ready', effects: ['clearBlocked'] },
    {
      from: 'blocked',
      trigger: 'escalated_to_human',
      to: 'executing',
      effects: ['clearBlocked', 'switchExecutorToHuman'],
    },

    // ── Review ───────────────────────────────────────────────────────────
    {
      from: 'reviewing',
      trigger: 'review_passed',
      to: 'waiting_for_release',
      guards: ['acceptanceCriteriaMet', 'qualityGatePassed'],
    },
    { from: 'reviewing', trigger: 'review_rejected', to: 'changes_requested' },
    { from: 'reviewing', trigger: 'review_conflict', to: 'awaiting_decision' },
    { from: 'changes_requested', trigger: 'rework_started', to: 'ready' },

    // ── Release ──────────────────────────────────────────────────────────
    { from: 'waiting_for_release', trigger: 'release_started', to: 'releasing' },
    { from: 'releasing', trigger: 'release_completed', to: 'acceptance' },
    { from: 'releasing', trigger: 'release_failed', to: 'failed', effects: ['createIncident'] },

    // ── Acceptance ───────────────────────────────────────────────────────
    { from: 'acceptance', trigger: 'accepted', to: 'done', effects: ['recordActualEnd'] },
    { from: 'acceptance', trigger: 'acceptance_rejected', to: 'changes_requested' },

    // ── Decision（可从任意状态进入，批准后回到原状态）──────────────────────
    {
      from: ANY_STATE,
      trigger: 'decision_required',
      to: 'awaiting_decision',
      effects: ['rememberPreviousStatus'],
    },
    {
      from: 'awaiting_decision',
      trigger: 'decision_approved',
      to: PREVIOUS_STATE,
      effects: ['applyConstraints', 'clearPreviousStatus'],
    },
    { from: 'awaiting_decision', trigger: 'decision_rejected', to: 'cancelled' },
    {
      from: 'awaiting_decision',
      trigger: 'escalated_to_human',
      to: 'executing',
      effects: ['switchExecutorToHuman', 'clearPreviousStatus'],
    },

    // ── Cancel ───────────────────────────────────────────────────────────
    { from: ANY_STATE, trigger: 'cancelled', to: 'cancelled' },
  ],
};
