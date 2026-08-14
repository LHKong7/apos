ALTER TABLE "agent_runs" ADD COLUMN "tokens_cache_write" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "token_limit_per_run" bigint;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "token_limit_daily" bigint;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "estimated_tokens" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "token_budget" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tokens_spent" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "tokens_delta" bigint;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "estimated_tokens" bigint;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "actual_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
--
-- 记账单位从美元换成 token。
-- Switch the unit of account from USD to tokens.
--
-- 已发生的用量可以精确重算 —— agent_runs 一直在记 token 明细，
-- 这里只是把冗余累加列换个来源，不涉及任何换算假设。
--
-- Usage that already happened is recomputed exactly: agent_runs has been
-- recording the token breakdown all along, so the redundant roll-up columns
-- just change their source. No conversion assumption is involved.
--
UPDATE "work_items" w SET "actual_tokens" = COALESCE((
  SELECT SUM(r."tokens_input" + r."tokens_output" + r."tokens_cache_read" + r."tokens_cache_write")
  FROM "agent_runs" r WHERE r."work_item_id" = w."id"
), 0);--> statement-breakpoint
UPDATE "projects" p SET "tokens_spent" = COALESCE((
  SELECT SUM(r."tokens_input" + r."tokens_output" + r."tokens_cache_read" + r."tokens_cache_write")
  FROM "agent_runs" r WHERE r."project_id" = p."id"
), 0);
--
-- ★ 用户手工配的上限与预算**不换算**，一律留空。
--
--   美元换 token 需要一个单价，而单价随模型、随缓存命中率变 ——
--   折算出来的数字没有依据，却会摆在界面上像是用户自己设的。
--   留空的代价是这几道守卫在重新填之前不生效，但那是看得见的代价：
--   界面显示「未设置」，而一个编出来的上限不会显示任何东西。
--   同一条理由见 analytics/benefit.ts 拒绝猜人力时薪。
--
--   涉及：projects.token_budget、agents.token_limit_per_run /
--   token_limit_daily、work_items.estimated_tokens、plans.estimated_tokens。
--
-- User-configured limits and budgets are deliberately NOT converted.
--
--   Converting USD to tokens needs a unit price, and that price moves with
--   the model and the cache-hit rate. The resulting number would have no
--   basis yet would sit in the UI looking like something the user chose.
--   Leaving them empty means those guardrails do not apply until they are
--   re-entered — but that cost is visible ("not set" on screen), whereas an
--   invented limit shows nothing at all. Same reasoning as benefit.ts
--   refusing to guess an hourly labour rate.
--