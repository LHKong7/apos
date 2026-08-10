-- 组织：slug + 「账号↔组织」多对多
--
-- ★★ drizzle 生成的版本会**先删列再建表**，也就是把 users.org_id 里的归属
--   直接丢掉；slug 也是不带默认值的 NOT NULL，有数据就直接失败。
--   所以这份是手写的：先建表、再回填、最后才收紧约束。
--
-- 语义变化：users 从「组织内的账号」变成**全局账号**，归属与组织角色
-- 搬到 organization_members。一个人因此可以同时属于多个组织，
-- 并且在不同组织里担任不同的组织角色。

-- ── 1. 归属表 ────────────────────────────────────────────────────────
CREATE TABLE "organization_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_role" text DEFAULT 'member' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "organization_members_role_check" CHECK ("organization_members"."org_role" in ('org_admin', 'admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint

-- ★ 回填必须在删列之前。顺序反了就是「所有人都不属于任何组织」——
--   而那个状态下每个请求都会 401，看起来像认证坏了。
INSERT INTO "organization_members" ("org_id", "user_id", "org_role")
SELECT "org_id", "id", "org_role" FROM "users"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ── 2. organizations 的新列 ──────────────────────────────────────────
ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- 从名字推 slug。中文名 regexp 之后会是空串，回落到 org-<id 前缀>
UPDATE "organizations"
   SET "slug" = NULLIF(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), '');--> statement-breakpoint
UPDATE "organizations"
   SET "slug" = 'org-' || left("id"::text, 8)
 WHERE "slug" IS NULL;--> statement-breakpoint

-- 同名组织会推出同一个 slug，加 id 前缀区分（slug 全局唯一）
UPDATE "organizations" o
   SET "slug" = o."slug" || '-' || left(o."id"::text, 8)
 WHERE EXISTS (SELECT 1 FROM "organizations" x WHERE x."slug" = o."slug" AND x."id" <> o."id");--> statement-breakpoint

ALTER TABLE "organizations" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_unique" UNIQUE("slug");--> statement-breakpoint

-- ── 3. users 收尾 ────────────────────────────────────────────────────
-- ★ email 从「组织内唯一」变成全局唯一。同一个邮箱此前可以在两个组织里
--   各有一个账号 —— 那两行现在必须合并，而合并是业务决定不是迁移能替做的。
--   所以在这里显式报错，而不是让 Postgres 抛一句认不出来的约束冲突。
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(email, '、') INTO dup
    FROM (SELECT email FROM users GROUP BY email HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '这些邮箱在多个组织里各有一个账号，无法合并成全局账号：%。请先人工合并（保留一行，把另一行的 project_members / 各处 actor_id 指过去）后重跑迁移', dup;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "users" DROP CONSTRAINT "users_orgId_email_unique";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_org_role_check";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_org_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "org_role";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");
