--
-- 0028 加列并重算，这里删掉旧的美元列。分成两个迁移是为了让「加列 → 回填 →
-- 删列」三步各自可回滚，而不是一个失败就卡在半路的大事务。
--
-- agent_runs.cost 与 run_events.cost_delta 故意保留 —— 那是运行时结算的
-- 权威账目，删了算不回来；它们只是不再参与任何判定（见 schema/core.ts）。
--
-- 0028 added the columns and recomputed them; this drops the old USD ones.
-- Splitting them keeps add → backfill → drop individually revertible instead
-- of one large transaction that strands the schema halfway on failure.
--
-- agent_runs.cost and run_events.cost_delta are deliberately kept: they are
-- the runtime's settled bill and cannot be recomputed once dropped. They
-- simply no longer feed any decision (see schema/core.ts).
--
ALTER TABLE "agents" DROP COLUMN "cost_limit_per_run";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "cost_limit_daily";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "estimated_cost";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "budget_amount";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "budget_currency";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "cost_spent";--> statement-breakpoint
ALTER TABLE "work_items" DROP COLUMN "estimated_cost";--> statement-breakpoint
ALTER TABLE "work_items" DROP COLUMN "actual_cost";