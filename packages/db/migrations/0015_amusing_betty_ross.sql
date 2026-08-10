-- 工作项的人类可读编号：`<项目前缀>-<项目内序号>`（ORD-19）
--
-- ★★ 在此之前工作项只有 uuid。站会上没法念，聊天里没法提，
--   提交信息里写进去也没人认得 —— 「那个订单导出的任务」是唯一的指代方式，
--   而一个项目里往往有三个。
--
-- ★ drizzle 生成的版本只加列不回填：所有存量项目会共用默认前缀 `TASK`，
--   所有存量工作项的编号是 NULL。那等于这个功能对现有数据不生效，
--   而现有数据恰恰是唯一有人在看的数据。

ALTER TABLE "projects" ADD COLUMN "identifier" text DEFAULT 'TASK' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "work_item_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "number" integer;--> statement-breakpoint

-- ── 项目前缀 ─────────────────────────────────────────────────────────
-- 从项目名取大写字母数字（"Order Service" → ORDERSERVICE → ORDE）。
-- 中文名取不出东西，回落到 PRJ，再由下面的去重加序号。
UPDATE "projects"
   SET "identifier" = COALESCE(
     NULLIF(left(regexp_replace(upper("name"), '[^A-Z0-9]', '', 'g'), 4), ''),
     'PRJ'
   );--> statement-breakpoint

-- 组织内去重：同前缀的按创建顺序加序号（ORDE / ORDE2 / ORDE3…）
WITH ranked AS (
  SELECT "id",
         "identifier",
         row_number() OVER (
           PARTITION BY "org_id", "identifier" ORDER BY "created_at", "id"
         ) AS rn
    FROM "projects"
)
UPDATE "projects" p
   SET "identifier" = r."identifier" || r.rn::text
  FROM ranked r
 WHERE p."id" = r."id" AND r.rn > 1;--> statement-breakpoint

-- ── 工作项编号 ───────────────────────────────────────────────────────
-- ★ 按创建顺序编号，不按 id —— 编号要和人的记忆顺序一致，
--   否则「上周那个 3 号」指向的是随机一条。
WITH numbered AS (
  SELECT "id",
         row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") AS n
    FROM "work_items"
)
UPDATE "work_items" w
   SET "number" = numbered.n
  FROM numbered
 WHERE w."id" = numbered."id";--> statement-breakpoint

-- ★ 游标必须推到已用的最大值，否则下一条新任务会分到一个已占用的号，
--   而表现是插入时唯一约束冲突 —— 在「新建任务」这个动作上，
--   没有比这更让人摸不着头脑的报错。
UPDATE "projects" p
   SET "work_item_seq" = COALESCE(m.max_n, 0)
  FROM (SELECT "project_id", max("number") AS max_n FROM "work_items" GROUP BY "project_id") m
 WHERE p."id" = m."project_id";--> statement-breakpoint

ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_number_unique" UNIQUE("project_id","number");
