-- 角色从枚举变成数据：组织可以自定义研发 / 运营 / 测试…，
-- 每个角色可以由人担任，也可以由 Agent 担任。见 docs/tech/09-security.md §2.2。
--
-- ★ 生成器给出的顺序是「加 NOT NULL 列 → 建外键」，两处都会炸：
--   非空表上加没有默认值的 NOT NULL 列 Postgres 直接拒绝；
--   而外键指向的 roles 表这会儿还是空的，现有成员行一条都对不上。
--   所以手写成「建表 → 预置内置角色 → 加可空列 → 回填 → 收紧 → 建外键」。

-- ── 1. 角色表 ────────────────────────────────────────────────────────
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"applies_to" text[] DEFAULT '{human}' NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_org_key_unique" UNIQUE("org_id","key")
);--> statement-breakpoint

ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── 2. 给每个已有组织预置内置角色 ────────────────────────────────────
-- ★ 这份权限清单是**快照**，不是真相来源。真相在 @apos/domain 的权限目录
--   （BUILTIN_ROLES 由目录反推），服务启动时 syncBuiltinRoles 会把内置角色
--   对齐到当前代码。迁移只负责让存量数据现在就能满足下面那条外键 ——
--   把它写成「以后也靠这段 SQL 维护」才是错的：迁移是历史，不是配置。
--
-- ★ 只有 executor / viewer 允许 Agent 担任。其余四个都带 Human Gate 权限
--   （确认需求、批准计划、处理决策），按 humanOnly 规则一律不能给 Agent。
INSERT INTO "roles" ("org_id", "key", "name", "description", "permissions", "applies_to", "builtin")
SELECT o."id", r."key", r."name", r."description", r."permissions"::text[], r."applies_to"::text[], true
FROM "organizations" o
CROSS JOIN (VALUES
  ('sponsor', '业务负责人', '需求确认、预算超限审批、业务验收、结项', '{project.view,project.schedule,requirement.create,requirement.edit,requirement.approve,clarification.answer,plan.generate,work_item.execute,work_item.takeover,decision.act,decision.remind,policy.view,integration.view,integration.resolve_conflict}', '{human}'),
  ('tech_lead', '技术负责人', '批准计划、放宽规则、强制放行、扩大 Agent 权限', '{project.view,project.settings.update,project.autonomy.change,project.schedule,project.members.manage,requirement.create,requirement.edit,clarification.answer,plan.generate,plan.approve,work_item.execute,work_item.takeover,work_item.force_pass,run.control,run.view_detailed,decision.act,decision.remind,policy.view,policy.tighten,policy.loosen,agent.update,agent.pause,agent.permissions.expand,convention.manage,integration.view,integration.connect,integration.grant_write,integration.change_sot,integration.disconnect,integration.resolve_conflict}', '{human}'),
  ('pm', '项目经理', '项目设置、收紧规则、调度与成员管理', '{project.view,project.settings.update,project.autonomy.change,project.schedule,project.members.manage,requirement.create,requirement.edit,requirement.approve,clarification.answer,plan.generate,work_item.execute,work_item.takeover,run.control,decision.act,decision.remind,policy.view,policy.tighten,agent.update,agent.pause,convention.manage,integration.view,integration.connect,integration.change_sot,integration.disconnect,integration.resolve_conflict,integration.configure_notification}', '{human}'),
  ('member', '成员', '执行任务、接管 Agent、处理决策', '{project.view,project.schedule,requirement.create,requirement.edit,clarification.answer,plan.generate,work_item.execute,work_item.takeover,decision.act,decision.remind,policy.view,integration.view,integration.resolve_conflict}', '{human}'),
  ('executor', '执行者', '只执行任务，不参与任何决策与审批', '{project.view,work_item.execute,policy.view}', '{human,agent}'),
  ('viewer', '只读', '只能看，不能做任何改动', '{project.view,policy.view}', '{human,agent}')
) AS r("key", "name", "description", "permissions", "applies_to");--> statement-breakpoint

-- ── 3. 成员表带上 org_id（外键要它） ─────────────────────────────────
ALTER TABLE "project_members" ADD COLUMN "org_id" uuid;--> statement-breakpoint

UPDATE "project_members" pm
   SET "org_id" = p."org_id"
  FROM "projects" p
 WHERE pm."project_id" = p."id";--> statement-breakpoint

-- 项目已被删掉却还留着成员行的话，org_id 补不上，外键也建不起来。
-- 这类孤儿行本来就不该存在，清掉。
DELETE FROM "project_members" WHERE "org_id" IS NULL;--> statement-breakpoint

ALTER TABLE "project_members" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- ── 4. 归一化角色取值 ────────────────────────────────────────────────
-- ★ Agent 行此前的 role 是一列自由文本（「这个 Agent 在本项目里干什么」），
--   现在它要指向真正的角色。归到 executor：干活不决策，
--   这正是那列自由文本一直以来表达的意思。
UPDATE "project_members"
   SET "role" = 'executor'
 WHERE "actor_type" = 'agent'
   AND "role" NOT IN ('executor', 'viewer');--> statement-breakpoint

-- 人类行理论上已被 0010 的 CHECK 约束过，这里兜一次底：
-- 外键建不起来的话整个迁移停住，而停住的原因会是一条查不到的数据。
UPDATE "project_members"
   SET "role" = 'member'
 WHERE "actor_type" = 'human'
   AND "role" NOT IN ('sponsor', 'tech_lead', 'pm', 'member', 'executor', 'viewer');--> statement-breakpoint

-- ── 5. CHECK 换成外键 ────────────────────────────────────────────────
-- ★ 外键比 CHECK 强的地方不在写入侧，在删除侧：
--   它让「正在被人担任的角色」删不掉。CHECK 给不了这个保证，
--   而「角色被删了，成员权限静默归零」是最难查的那种故障。
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_role_check";--> statement-breakpoint

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role_fk" FOREIGN KEY ("org_id","role") REFERENCES "public"."roles"("org_id","key") ON DELETE no action ON UPDATE no action;
