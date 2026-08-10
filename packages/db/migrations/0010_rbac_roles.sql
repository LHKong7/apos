-- RBAC：角色取值收进库里，并为成员关系查询建索引。
-- 见 docs/tech/09-security.md §2.2。
--
-- ★ 生成器只会输出 ADD CONSTRAINT。直接上会在任何存过库外取值的实例上
--   失败，而失败点是「迁移跑不动」——升级停在这里，没人能从报错里看出
--   是哪一行数据的问题。所以先归一化，再收紧。

-- ── 1. 先把库外取值归一化 ────────────────────────────────────────────
-- ★ 一律降到最低权限那一档，不猜「他大概是想当管理员」：
--   猜错的方向决定后果。降错了是有人来说「我进不去了」，
--   升错了是没有人会来说任何话。
UPDATE "users"
   SET "org_role" = 'member'
 WHERE "org_role" NOT IN ('org_admin', 'admin', 'member');--> statement-breakpoint

UPDATE "project_members"
   SET "role" = 'member'
 WHERE "actor_type" = 'human'
   AND "role" NOT IN ('sponsor', 'tech_lead', 'pm', 'member', 'viewer');--> statement-breakpoint

-- ── 2. 收紧 ──────────────────────────────────────────────────────────
-- ★ 「这个人是哪些项目的成员」现在是每个请求都要问的问题（授权闸门、
--   决策收件箱、项目列表）。主键是 (project_id, …)，前缀对不上这类查询。
CREATE INDEX "project_members_actor_idx" ON "project_members" USING btree ("actor_type","actor_id");--> statement-breakpoint

-- ★ 只约束人类行：Agent 与人类同表，但 Agent 的 role 是执行角色
--   （「这个 Agent 在本项目里干什么」），不是权限角色。
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role_check" CHECK ("project_members"."actor_type" <> 'human' or "project_members"."role" in ('sponsor', 'tech_lead', 'pm', 'member', 'viewer'));--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_org_role_check" CHECK ("users"."org_role" in ('org_admin', 'admin', 'member'));
