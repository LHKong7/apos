-- 关掉托管 Postgres（Supabase）自带的那条「匿名 REST 通道」。
--
-- ★★ 为什么非做不可：
--
--   Supabase 会给 public schema 下的**每一张表**自动生成一套 PostgREST 接口，
--   并且默认把权限授给 anon / authenticated 两个角色。也就是说，把这套库迁上去
--   之后，任何拿到项目 anon key 的人（那把 key 本来就是给浏览器用的、公开的）
--   可以直接
--
--     GET https://<ref>.supabase.co/rest/v1/users?select=*
--     GET https://<ref>.supabase.co/rest/v1/repositories?select=*
--
--   把用户表、Agent 运行记录、以及 repositories 里加密存放的仓库凭证整张拖走 ——
--   完全绕开 apps/api 这一侧的 JWT 与 RBAC（docs/tech/09-security.md）。
--
--   ★ 这个洞不会有任何症状：应用照常跑，日志干净，权限矩阵页面上一切正常。
--     它只有在被人拖库之后才会被发现。
--
-- ★★ 为什么开 RLS 却一条 policy 都不写：
--
--   Postgres 里**表的属主天然绕过 RLS**（除非额外 FORCE ROW LEVEL SECURITY）。
--   建表的是迁移用的那个角色，后端连的也是它 —— 所以后端读写完全不受影响，
--   一行业务代码都不用改。而 anon / authenticated 不是属主，RLS 一开、
--   policy 一条没有，它们看到的就是零行。
--
--   ★ 这正是「兼容」的关键：本机与 docker-compose 那套 Postgres 上，
--     这条迁移的效果是「开了 RLS，但连得上库的只有属主」，行为一个字不变；
--     下面 REVOKE 那段因为本机根本没有 anon / authenticated 角色，直接跳过。
--
-- ★ 要把某张表重新交给 PostgREST 用的话，是显式地给它写 policy 并授权，
--   而不是回来关掉这里 —— 「默认全关，要开就得写明白」是唯一能长期守住的形态。
DO $$
DECLARE
  target record;
  grantee text;
BEGIN
  ------------------------------------------------------------------
  -- 1. public 下所有表开 RLS
  --
  -- ★ 动态枚举而不是把 35 张表名抄一遍：抄下来的清单会在下一次
  --   `drizzle-kit generate` 加表时**默默过期**，而过期的表现正是
  --   「新加的那张表是公开的」—— 与上面说的那个洞一模一样。
  --   drizzle 自己的迁移记录在 drizzle schema 下，不在这个范围里。
  ------------------------------------------------------------------
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')   -- 普通表与分区表
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.relname);
  END LOOP;

  ------------------------------------------------------------------
  -- 2. 回收 PostgREST 两个角色的权限
  --
  -- 单靠 RLS 已经拦得住取数，这一步再把「表的存在本身」也收掉，
  -- 免得对面能靠 REST 的报错差异枚举出表结构。
  --
  -- ★ ALTER DEFAULT PRIVILEGES 这两行才是**将来**新增的表的护栏：
  --   下一次迁移建出来的表不会再被自动授权给 anon / authenticated，
  --   哪怕那次迁移的作者根本没听说过这件事。
  ------------------------------------------------------------------
  FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- ★ 角色不存在就跳过 —— 本机 / docker-compose 的 Postgres 没有这两个角色，
    --   不判断的话这条迁移会在那边直接失败，等于「为了上 Supabase 把本机搞坏」
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee);

    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', grantee);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', grantee);
    EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM %I', grantee);

    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', grantee);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', grantee);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM %I', grantee);
  END LOOP;
END $$;
