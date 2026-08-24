#!/usr/bin/env bash
# 本地开发环境一键就绪：Postgres → 迁移 → 种子数据 → API → Vite。
# 每一步都是幂等的，可以反复跑。
#
# 可覆盖：APOS_PGPORT(5433) APOS_API_PORT(3000) APOS_WEB_PORT(5173) APOS_LOG_DIR
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { echo "✗ $*" >&2; exit 1; }

# Node 22's dotenv parser treats the file as data; unlike `source .env`, values
# cannot execute shell commands. Existing exported variables keep precedence.
load_dotenv() {
  [ -f "$ROOT/.env" ] || die "缺少 .env。先运行 cp .env.example .env 并填写本机配置"
  while IFS= read -r -d '' entry; do
    key="${entry%%=*}"
    if [ "${!key+x}" != "x" ]; then
      export "$entry"
    fi
  done < <(node "$ROOT/scripts/export-dotenv.mjs" "$ROOT/.env")
}

normalize_path() {
  ROOT="$ROOT" VALUE="$1" node -e \
    "const p=require('node:path'); process.stdout.write(p.resolve(process.env.ROOT, process.env.VALUE))"
}

validate_dev_env() {
  [ -n "${APOS_SECRET_KEY:-}" ] || die ".env 必须设置 APOS_SECRET_KEY，避免 Agent 凭证明文入库"
  [ -n "${AGENT_WORKSPACE_ROOT:-}" ] || die ".env 必须设置 AGENT_WORKSPACE_ROOT"
  [ -n "${APOS_LOCAL_MOUNT_ROOTS:-}" ] || die ".env 必须设置 APOS_LOCAL_MOUNT_ROOTS"

  AGENT_WORKSPACE_ROOT="$(normalize_path "$AGENT_WORKSPACE_ROOT")"
  [ "$AGENT_WORKSPACE_ROOT" != "/" ] || die "AGENT_WORKSPACE_ROOT 不能是根目录 /"
  export AGENT_WORKSPACE_ROOT

  APOS_LOCAL_MOUNT_ROOTS="$({
    ROOT="$ROOT" VALUE="$APOS_LOCAL_MOUNT_ROOTS" node -e '
      const p = require("node:path");
      const roots = process.env.VALUE.split(p.delimiter).filter(Boolean).map((x) => p.resolve(process.env.ROOT, x));
      if (roots.length === 0 || roots.includes(p.parse(process.env.ROOT).root)) process.exit(2);
      process.stdout.write([...new Set(roots)].join(p.delimiter));
    '
  })" || die "APOS_LOCAL_MOUNT_ROOTS 必须包含至少一个非根目录路径"
  export APOS_LOCAL_MOUNT_ROOTS

  echo "配置  凭证加密：已启用"
  echo "配置  Agent 工作区：$AGENT_WORKSPACE_ROOT"
  echo "配置  本机挂载白名单：$APOS_LOCAL_MOUNT_ROOTS"
}

load_dotenv
validate_dev_env

PGPORT="${APOS_PGPORT:-5433}"
API_PORT="${APOS_API_PORT:-3000}"
WEB_PORT="${APOS_WEB_PORT:-5173}"
DEV_URL="postgres://apos:apos@localhost:$PGPORT/apos"
TEST_URL="postgres://apos:apos@localhost:$PGPORT/apos_test"
LOG_DIR="${APOS_LOG_DIR:-/tmp/apos-dev}"
mkdir -p "$LOG_DIR"

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# ── Postgres ──────────────────────────────────────────────────────────
# ★ 优先 Docker Compose：那是 CONTRIBUTING 里的主路径，也是唯一跨平台的。
#   pg-dev.sh 只在 Linux 上成立（useradd / runuser / /usr/lib/postgresql），
#   在 macOS 上必然失败 —— 以前这个脚本无条件走它，于是 macOS 上一次都跑不起来。
COMPOSE=""
if docker info >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v pg_isready >/dev/null 2>&1; then
  echo "没有 Docker daemon，改用 scripts/pg-dev.sh（仅 Linux）…"
  bash scripts/pg-dev.sh >/dev/null 2>&1 || die "pg-dev.sh 起不来"
else
  die "既没有 Docker daemon，也没有 pg_isready。请先启动 Docker，或安装本地 Postgres。"
fi

if [ -n "$COMPOSE" ]; then
  # ★ 用 ${} 包起来：macOS 自带 bash 3.2 不认多字节边界，
  #   `$PGPORT）` 会把全角括号吃进变量名，配 set -u 直接报 unbound variable
  # ★ 必须点名 postgres redis。compose 文件里还有 api / worker，
  #   不带服务名的 `up -d` 会连它们一起起来 —— 那是完整产品，
  #   与这个脚本随后在宿主机上跑的 API 抢同一个数据库上的调度循环
  echo "启动 Postgres / Redis（端口 ${PGPORT}）…"
  APOS_PGPORT="$PGPORT" $COMPOSE up -d postgres redis >/dev/null 2>&1 ||
    die "docker compose up 失败"

  # ★ 在容器里探活，不依赖宿主机装没装 psql 客户端 ——
  #   macOS 上默认是没有的，而以前这里直接调宿主的 pg_isready
  for _ in $(seq 1 60); do
    $COMPOSE exec -T postgres pg_isready -U apos >/dev/null 2>&1 && break
    sleep 1
  done
  $COMPOSE exec -T postgres pg_isready -U apos >/dev/null 2>&1 ||
    die "Postgres 起不来：$COMPOSE logs postgres"

  # ★ 开发库与测试库必须分开：测试在 beforeEach 里 TRUNCATE 全表，
  #   共用一个库的话，跑一次测试就把正在调试的看板数据清空了
  $COMPOSE exec -T postgres psql -U apos -d postgres \
    -c "CREATE DATABASE apos_test" >/dev/null 2>&1 || true
fi

# 建表（两个库都要）
for url in "$DEV_URL" "$TEST_URL"; do
  DATABASE_URL="$url" pnpm db:migrate >/dev/null 2>&1 ||
    die "迁移失败：DATABASE_URL=$url pnpm db:migrate"
done

# ── 种子数据 ──────────────────────────────────────────────────────────
# 空库时灌一份演示数据，否则界面上什么都没有，看起来像没跑起来。
#
# ★ 判空必须可靠：seed 是**追加**而不是重置，误判成空就会每跑一次
#   多出一个同名的「订单系统重构」，越跑越乱。
#   所以用各自分支里确定存在的 psql —— Docker 分支用容器内的，
#   pg-dev 分支用宿主的（走到那条分支就说明宿主有客户端）。
count_projects() {
  if [ -n "$COMPOSE" ]; then
    $COMPOSE exec -T postgres psql -U apos -d apos -tAc \
      'select count(*) from projects' 2>/dev/null
  else
    psql -h localhost -p "$PGPORT" -U apos -d apos -tAc \
      'select count(*) from projects' 2>/dev/null
  fi
}
HAS_DATA="$(count_projects | tr -d '[:space:]')"
if [ -z "$HAS_DATA" ]; then
  echo "  （查不到 projects 表，跳过种子数据判断）"
elif [ "$HAS_DATA" = "0" ]; then
  echo "灌入种子数据…"
  DATABASE_URL="$DEV_URL" pnpm --filter @apos/api seed >/dev/null 2>&1 ||
    echo "  （种子数据失败，可稍后手动跑 pnpm --filter @apos/api seed）"
else
  echo "已有 $HAS_DATA 个项目，跳过种子数据"
fi

# ── API ───────────────────────────────────────────────────────────────
# pkill 匹配的是实际命令行（tsx 的 cli.mjs），不是 package.json 里的脚本名
pkill -f "cli.mjs src/main.ts" >/dev/null 2>&1
sleep 1
# ★ 端口被别人占着时要当场说清楚。否则 API 在后台以 EADDRINUSE 退出，
#   而健康检查会连上那个不相干的服务并通过 —— 一路错到很后面才发现
if port_busy "$API_PORT"; then
  die "端口 $API_PORT 已被占用。换一个：APOS_API_PORT=3001 bash scripts/dev-up.sh"
fi
DATABASE_URL="$DEV_URL" PORT="$API_PORT" nohup pnpm --filter @apos/api start \
  > "$LOG_DIR/api.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -s -m 1 "localhost:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s -m 1 "localhost:$API_PORT/health" >/dev/null 2>&1 ||
  { echo "API 起不来："; tail -20 "$LOG_DIR/api.log"; exit 1; }

# ── Vite ──────────────────────────────────────────────────────────────
# ★ API_URL 要传下去：Vite 的 /api 代理默认指向 3000，
#   API 换了端口而代理没跟上，前端会全页 500 而 API 日志上什么都没有
if ! curl -s -m 1 "localhost:$WEB_PORT/" >/dev/null 2>&1; then
  API_URL="http://localhost:$API_PORT" nohup pnpm --filter @apos/web dev \
    > "$LOG_DIR/web.log" 2>&1 &
  for _ in $(seq 1 60); do
    curl -s -m 1 "localhost:$WEB_PORT/" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
curl -s -m 1 "localhost:$WEB_PORT/" >/dev/null 2>&1 ||
  { echo "Vite 起不来："; tail -20 "$LOG_DIR/web.log"; exit 1; }

echo "就绪  API :$API_PORT   Web :$WEB_PORT   Postgres :$PGPORT   日志 $LOG_DIR"

# ── 看板链接 ──────────────────────────────────────────────────────────
# ★★ 要先登录。身份改由 JWT 证明之后（09-security §1.0），
#   匿名 GET /projects 一律 401 —— 而这一步只是锦上添花的收尾输出，
#   拿不到链接不该让整个脚本失败：此刻环境其实已经就绪了。
#   所以下面每一步都容错，任何一步不成就只少打印一行。
ADMIN_EMAIL="${APOS_SUPERADMIN_EMAIL:-}"
ADMIN_PASSWORD="${APOS_SUPERADMIN_PASSWORD:-}"

if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "提示  .env 里没有 APOS_SUPERADMIN_EMAIL / APOS_SUPERADMIN_PASSWORD —— 现在没有账号能登录。"
  echo "      照 .env.example 补上这两行再重跑（系统没有自助注册）。"
else
  TOKEN="$(
    curl -s -m 5 -X POST "localhost:$API_PORT/api/v1/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" |
      node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token??'')}catch{}})" 2>/dev/null
  )"
  if [ -z "$TOKEN" ]; then
    echo "提示  用 $ADMIN_EMAIL 登录失败，跳过看板链接。日志：$LOG_DIR/api.log"
  else
    curl -s -m 5 "localhost:$API_PORT/api/v1/projects" -H "Authorization: Bearer $TOKEN" |
      WEB_PORT="$WEB_PORT" node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const p=JSON.parse(s).projects[0];if(p)console.log('项目  '+p.name+'  http://localhost:'+process.env.WEB_PORT+'/projects/'+p.id+'/board')}catch{}})" 2>/dev/null
    # ★ ${} 不能省：紧跟全角括号时 bash 3.2 会把它的第一个字节吃进变量名，
    #   配 set -u 报 `ADMIN_EMAIL?: unbound variable`（同 §Postgres 那处）
    echo "登录  ${ADMIN_EMAIL}（口令见 .env 的 APOS_SUPERADMIN_PASSWORD）"
  fi
fi
