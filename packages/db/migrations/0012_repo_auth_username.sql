-- 仓库凭证的 Basic 用户名占位。
--
-- ★ 为空 = 按 remoteUrl 的域名推断（GitHub → x-access-token、
--   GitLab → oauth2、Bitbucket → x-token-auth），推断不出来沿用
--   x-access-token —— 与此前的行为一致，所以现有 GitHub 仓库不受影响。
--
-- ★ 存量数据一律留空（推断），不做任何回填：回填成 x-access-token 的话，
--   那些指向自建 GitLab 的仓库会被永久钉死在一个错的值上，
--   而它们本来能靠推断在下一版被修好。
ALTER TABLE "repositories" ADD COLUMN "auth_username" text;
