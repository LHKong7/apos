-- 取消「运行时接入」层：Agent 自带 CLI 类型、凭证与个性化配置。
--
-- ★ 生成器给出的顺序是「先 DROP TABLE agent_runtimes，再 ADD COLUMN ... NOT NULL」，
--   两处都会炸：接入表一删，回填的数据来源就没了；而在非空的 agents 表上加一个
--   没有默认值的 NOT NULL 列，Postgres 直接拒绝。所以这里手写成
--   「加可空列 → 回填 → 收紧为 NOT NULL → 删旧列 → 删表」。

-- ── 1. 先加可空列 ────────────────────────────────────────────────────
ALTER TABLE "agents" ADD COLUMN "runtime_kind" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "endpoint" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "credential_ref" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "credential_hint" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_check_at" timestamp with time zone;--> statement-breakpoint

-- ── 2. 从接入层回填 ──────────────────────────────────────────────────
-- runtime_config 留空对象：空 = 全部用平台默认值，正好等价于改造前那套写死的行为。
UPDATE "agents" a SET
  "runtime_kind"    = r."kind",
  "endpoint"        = r."endpoint",
  "credential_ref"  = r."credential_ref",
  "credential_hint" = r."credential_hint",
  "capabilities"    = r."capabilities",
  "last_check_at"   = r."last_check_at"
FROM "agent_runtimes" r
WHERE a."runtime_id" = r."id";--> statement-breakpoint

-- ★ 兜底成 mock 而不是某个真实运行时：接入行丢失时我们并不知道它原本是什么，
--   猜成 claude_code 会让一个配置不明的 Agent 直接开始花钱。mock 不花钱，
--   且会在界面上显示为「演示运行时」，足够醒目。
UPDATE "agents" SET "runtime_kind" = 'mock' WHERE "runtime_kind" IS NULL;--> statement-breakpoint

-- ── 3. 收紧约束，删旧列与接入表 ──────────────────────────────────────
ALTER TABLE "agents" ALTER COLUMN "runtime_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_runtime_id_agent_runtimes_id_fk";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "runtime_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "runtime_ref";--> statement-breakpoint
DROP TABLE "agent_runtimes" CASCADE;
