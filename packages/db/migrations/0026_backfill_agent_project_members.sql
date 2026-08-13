-- ★★ 把「已经在项目里跑过」的 Agent 补登记成项目成员。
--
--   调度器把项目成员关系变成了派发的硬性前置（packages/domain flow/matching.ts
--   的 inProject）—— 不是本项目成员的 Agent 一律不进候选。这条判定本身是对的：
--   它是授权问题，不是匹配偏好。
--
--   但它是**加**上去的，而升级不会凭空长出成员关系。已经在跑的部署里，
--   Agent 从来没有被显式加进过任何项目，于是升级之后它们**全部**停止被派发，
--   现象是任务安静地停在 ready、调度器每轮都回一句「不是本项目成员」。
--   没有报错、没有失败，只是不动了 —— 正是这个仓库反复吃过的那种亏：
--   配置没生效而现场毫无迹象。
--
--   判据用 agent_runs：一个 Agent 在哪个项目里真的跑过任务，它就实际属于
--   那个项目。这与 rbac.ts 里 highestRoleOverAgent 的理由是同一条 ——
--   实际在哪跑就是实际属于哪，是最不容易骗人的判据。显式登记过的不动。
--
-- Backfill project membership for agents that have actually run in a project.
-- Dispatch now requires membership (a hard precondition, not a preference),
-- but upgrading does not conjure membership rows — so on existing deployments
-- every previously-working agent would silently stop being dispatched, with
-- tasks sitting quietly in `ready`. Evidence comes from agent_runs: where an
-- agent has actually run is where it actually belongs.

-- ★ 角色给 executor：内置角色里唯一一个 Agent 能担任的「干活」角色
--   （见 domain 的 assignableBy —— 带 humanOnly 权限的角色不能给 Agent）。
--   给最低的那一档，管理员之后可以按需调整；反过来补高了就是凭空提权。
--   Role is `executor`: the only builtin working role an agent may hold, and
--   the lowest one. Granting more here would be inventing privilege.
INSERT INTO "project_members" ("project_id", "org_id", "actor_type", "actor_id", "role")
SELECT DISTINCT
  r."project_id",
  r."org_id",
  -- ★ 显式转型：actor_type 是枚举，裸字面量在 INSERT … SELECT 里推不成它
  'agent'::"actor_type",
  r."agent_id",
  'executor'
FROM "agent_runs" r
-- ★ 角色是组织级的行，project_members 对它有外键。组织缺这一行时跳过，
--   否则整条迁移会以一句外键冲突失败 —— 而它本来只是想补几行成员关系。
WHERE EXISTS (
  SELECT 1 FROM "roles" ro
  WHERE ro."org_id" = r."org_id" AND ro."key" = 'executor'
)
ON CONFLICT ("project_id", "actor_type", "actor_id") DO NOTHING;
