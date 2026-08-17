-- ★★ 给每个「已经在项目里的 Agent」补一份项目级授权。
--
--   权限从组织级挪到项目级之后，求值器读的是 project_agent_permissions。
--   升级不会凭空长出这张表里的行 —— 不补的话，所有在跑的 Agent 一夜之间
--   落到默认档案（standard_executor）上：原本能推分支的推不了了，
--   而现象是任务跑到最后一步安静失败，没有任何一条日志说是权限变了。
--   与 0026 那次是同一类事故，也是同一条纪律：升级不能改变既有行为。
--
-- ★★ 从旧的工具名**反推**语义能力，而不是一律给默认档案。
--
--   反推的映射写在下面每一段的 CASE 里，是一个明确的、可以事后核对的决定。
--   两个方向都刻意保守：
--   - `workspace.write` 要求「有写类工具」**且**「有一个可写的仓库范围」——
--     旧模型里这两件事分开配，只满足一件的 Agent 实际上写不了任何东西。
--   - 裸 `Bash` 映射成 command.build + command.test，**比原来窄**：
--     新模型给的是带作用域的规则。窄的方向是安全的，而且看得见
--     （任务失败），宽的方向看不见。
--
-- ★ profile_key 记成 'legacy_import'，version 0。
--   它不是内置档案，因此永远不会被「档案升级」带着走 —— 这份授权是从
--   历史配置反推出来的，它该一直等着人来复核，而不是某天跟着平台一起变。
--
-- Backfill one project-scoped grant per existing project Agent, deriving
-- semantic capabilities from the legacy tool names rather than dropping
-- everyone onto the default profile. Both directions of the mapping are
-- deliberately conservative: narrowing is visible (a task fails), widening is
-- not. Rows are marked `legacy_import` so no profile upgrade ever moves them.

INSERT INTO "project_agent_permissions" (
  "org_id", "project_id", "agent_id", "member_actor_type",
  "profile_key", "profile_version",
  "allowed_capabilities", "denied_capabilities", "resource_scopes", "updated_by"
)
SELECT
  a."org_id",
  m."project_id",
  a."id",
  'agent'::"actor_type",
  'legacy_import',
  0,
  (
    -- workspace.read / artifact.create：所有 Agent 都有。
    -- ★ 前者是任何执行的前提，后者是 Run 的结果通道而不是一个工具 ——
    --   不给的话，反推出来的 Agent 连执行摘要都交不上来。
    ARRAY['workspace.read', 'artifact.create']
    -- ★ 写能力要「有写工具」且「有可写仓库」。旧模型两件事分开配，
    --   只满足一件的 Agent 实际写不了东西 —— 补成能写就是凭空提权。
    || CASE
         WHEN (a."allowed_tools" && ARRAY['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
          AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(a."resource_scopes") s
                WHERE s->>'kind' = 'repo' AND s->>'access' = 'write'
              )
         THEN ARRAY['workspace.write']
         ELSE ARRAY[]::text[]
       END
    -- 任何 Bash 形态的授权 → 构建 + 测试（带作用域，比裸 Bash 窄）
    || CASE
         WHEN EXISTS (
                SELECT 1 FROM unnest(a."allowed_tools") t
                WHERE t = 'Bash' OR t LIKE 'Bash(%'
              )
         THEN ARRAY['command.build', 'command.test']
         ELSE ARRAY[]::text[]
       END
    || CASE
         WHEN (a."allowed_tools" && ARRAY['WebFetch', 'WebSearch'])
         THEN ARRAY['network.external']
         ELSE ARRAY[]::text[]
       END
  ),
  -- ★ 硬拒绝一律补齐平台底线那两条。旧模型里没有「能力」的说法，
  --   于是没有任何一个 Agent 显式禁过它们 —— 而它们本就不该能被授予。
  ARRAY['permission.manage', 'policy.manage'],
  -- ★ 资源范围**原样搬过来**：它在旧模型里已经是显式配置，
  --   反推没有意义，改写则是替用户改了他配过的东西。
  a."resource_scopes",
  a."owner_id"
FROM "project_members" m
JOIN "agents" a ON a."id" = m."actor_id"
WHERE m."actor_type" = 'agent'
-- ★ 组织对不上的不补：project_members 与 agents 各自带 org_id，
--   历史数据里理论上不该出现分歧，真出现了也不该由这条迁移替它决定归属。
  AND a."org_id" = m."org_id"
ON CONFLICT ("project_id", "agent_id") DO NOTHING;
