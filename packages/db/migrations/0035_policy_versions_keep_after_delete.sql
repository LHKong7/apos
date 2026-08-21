-- 规则的变更历史不再挂外键：规则删得掉，「谁把它改成什么样、最后又删了它」删不得。
-- 挂着外键时，任何一条经手过保存的规则都删不掉（policy_versions 里已经有行了），
-- 报的还是一句数据库层的外键报错。见 schema/core.ts 上 policyVersions 的说明。
--
-- The change history no longer carries a foreign key: a rule can be deleted, the
-- record of how it changed cannot. With the key in place every rule that had ever
-- been saved was undeletable, failing with a raw foreign-key error.
ALTER TABLE "policy_versions" DROP CONSTRAINT "policy_versions_policy_id_policies_id_fk";
