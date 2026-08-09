# syntax=docker/dockerfile:1
#
# APOS 单机部署镜像。api 与 worker 共用这一个镜像，靠 PROCESS_ROLE 区分角色
# （docs/tech/01-architecture.md §3.1）。
#
# ★ 后端直接跑 TypeScript 源码（tsx），不做 tsc 产物。
#   原因是这个仓库的 workspace 包全部以 `"main": "./src/index.ts"` 对外暴露，
#   要产出 dist 得把 5 个包的入口、exports、以及互相之间的引用一起改掉 ——
#   那是一次牵连很广的重构，而单机部署的收益只是省下一点冷启动时间。
#   tsx 底层是 esbuild，加载时剥类型，运行时开销可忽略。

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
# 源码里有中文日志与界面文案，容器默认 POSIX locale 下会输出成问号
ENV LANG=C.UTF-8

# ── 依赖层 ────────────────────────────────────────────────────────────
# 只先拷 manifest：源码一改就失效的层放到后面，依赖层才能真正被缓存住
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json        apps/api/
COPY apps/web/package.json        apps/web/
COPY packages/contracts/package.json      packages/contracts/
COPY packages/domain/package.json         packages/domain/
COPY packages/db/package.json             packages/db/
COPY packages/integrations/package.json   packages/integrations/
COPY packages/agent-runtimes/package.json packages/agent-runtimes/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ── 前端构建 ──────────────────────────────────────────────────────────
FROM deps AS web-build
COPY . .
RUN pnpm --filter @apos/web build

# ── 运行时 ────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules      ./apps/api/node_modules
COPY --from=deps /app/apps/web/node_modules      ./apps/web/node_modules
COPY --from=deps /app/packages/contracts/node_modules      ./packages/contracts/node_modules
COPY --from=deps /app/packages/domain/node_modules         ./packages/domain/node_modules
COPY --from=deps /app/packages/db/node_modules             ./packages/db/node_modules
COPY --from=deps /app/packages/integrations/node_modules   ./packages/integrations/node_modules
COPY --from=deps /app/packages/agent-runtimes/node_modules ./packages/agent-runtimes/node_modules

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api      ./apps/api
COPY packages      ./packages
# 前端只要产物，不要源码
COPY --from=web-build /app/apps/web/dist ./apps/web/dist

# API 进程直接托管前端（见 apps/api/src/http/web-app.ts：同源才有 SSE）
ENV APOS_WEB_DIST=/app/apps/web/dist
ENV PORT=3000
EXPOSE 3000

# ★ 用 node 用户而不是 root。这个进程会按计划去调 Agent 运行时，
#   以 root 跑等于把容器逃逸的后果放大一档
USER node

# ★ 工作目录必须是 apps/api，不能是 /app。
#   `--import tsx` 是按**当前工作目录**解析的，而 pnpm 把 tsx 装在
#   apps/api/node_modules 下（它是 @apos/api 的依赖，不是根依赖）——
#   在 /app 下启动会报 `Cannot find package 'tsx' imported from /app/`。
#   workspace 里的 @apos/* 同理，也要从 apps/api 往上找才命中。
WORKDIR /app/apps/api

# ★ exec 形式的 CMD：保证 node 是 init 的直接子进程、能收到 SIGTERM
#   （main.ts 里有优雅退出）。shell 形式会多一层 sh 把信号吃掉
CMD ["node", "--import", "tsx", "src/main.ts"]
