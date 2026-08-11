-- 两件事：给 storage_targets 补上 RLS，以及回填 agent_runs.workspace 的 mounts。
--
-- ★ 分成独立一条迁移而不是并进 0019：0019 是 drizzle-kit 由 schema 生成的，
--   下次改 schema 会被重新生成覆盖。手写的东西必须待在自己的文件里。

------------------------------------------------------------------
-- 1. storage_targets 的 RLS
--
-- ★★ 0017 那条迁移是「遍历当时存在的所有表」，所以它管不到之后新建的表。
--   storage_targets 里存的是对象存储的凭证引用 —— 正是最不该出现在
--   匿名 REST 接口上的那一类数据。漏掉它的后果没有任何症状：
--   应用照常跑、日志干净，只有被拖库之后才会知道（理由详见 0017 的注释）。
--
-- ★ 开 RLS 却一条 policy 都不写：表的属主天然绕过 RLS，而后端连的就是属主，
--   所以后端读写不受影响；anon / authenticated 不是属主，看到的是零行。
------------------------------------------------------------------

ALTER TABLE public.storage_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
BEGIN
  -- 本机与 docker-compose 上没有这两个角色，直接跳过
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.storage_targets FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.storage_targets FROM authenticated;
  END IF;
END
$$;
--> statement-breakpoint

------------------------------------------------------------------
-- 2. 回填 agent_runs.workspace 的 mounts
--
-- ★★ 为什么需要它。
--
--   `mounts` 是「本次执行的全部挂载点」，收尾时逐个回收。它是在
--   `workspace` 这个 jsonb 列**内部**加的字段，所以加它的时候不需要 DDL，
--   代价是老行里没有这个键 —— 而没有它，那些 Run 的参考仓库工作树
--   一个都回收不掉（用主仓库的镜像目录去 remove 参考仓库的工作树是找不到的）。
--
--   代码侧一直有个回退：读不到 mounts 就退回主路径。这条迁移把数据补齐，
--   于是那个回退从「正确性依赖」降级成「滚动发布窗口期的保险」——
--   迁移跑完之后仍可能有老进程在写老结构的行，所以回退不删，但它不再是
--   唯一防线。
--
-- ★ 只补形状完整的行。path 或 repoId 缺失的行本来就是坏的，
--   给它编一个 mounts 只会把「坏数据」伪装成「好数据」。
------------------------------------------------------------------

UPDATE agent_runs
SET workspace = workspace || jsonb_build_object(
      'mounts',
      jsonb_build_array(
        jsonb_build_object(
          'path',   workspace ->> 'path',
          'repoId', workspace ->> 'repoId',
          'role',   'primary'
        )
      )
    )
WHERE workspace IS NOT NULL
  AND jsonb_typeof(workspace) = 'object'
  AND workspace ? 'path'
  AND workspace ? 'repoId'
  AND NOT (workspace ? 'mounts');
