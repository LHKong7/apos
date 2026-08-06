#!/usr/bin/env bash
# 本地开发环境一键就绪：Postgres → 迁移 → API → Vite。
# 每一步都是幂等的，可以反复跑。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${APOS_PGPORT:-5433}"
DEV_URL="postgres://apos@localhost:$PORT/apos"
TEST_URL="postgres://apos@localhost:$PORT/apos_test"
LOG_DIR="${APOS_LOG_DIR:-/tmp/apos-dev}"
mkdir -p "$LOG_DIR"

# ── Postgres ──────────────────────────────────────────────────────────
if ! pg_isready -h localhost -p "$PORT" >/dev/null 2>&1; then
  echo "启动 Postgres…"
  bash scripts/pg-dev.sh >/dev/null 2>&1
fi
pg_isready -h localhost -p "$PORT" >/dev/null 2>&1 || { echo "Postgres 起不来，看 pg-dev.sh 的日志"; exit 1; }

# 建表（两个库都要，测试会 TRUNCATE 全表，不能和开发库共用）
for url in "$DEV_URL" "$TEST_URL"; do
  DATABASE_URL="$url" pnpm db:migrate >/dev/null 2>&1
done

# ── API ───────────────────────────────────────────────────────────────
# pkill 匹配的是实际命令行（tsx 的 cli.mjs），不是 package.json 里的脚本名
pkill -f "cli.mjs src/main.ts" >/dev/null 2>&1
sleep 1
DATABASE_URL="$DEV_URL" PORT=3000 nohup pnpm --filter @apos/api start > "$LOG_DIR/api.log" 2>&1 &

for _ in $(seq 1 40); do
  curl -s -m 1 localhost:3000/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s -m 1 localhost:3000/health >/dev/null 2>&1 || { echo "API 起不来："; tail -5 "$LOG_DIR/api.log"; exit 1; }

# ── Vite ──────────────────────────────────────────────────────────────
if ! curl -s -m 1 localhost:5173/ >/dev/null 2>&1; then
  nohup pnpm --filter @apos/web dev > "$LOG_DIR/web.log" 2>&1 &
  for _ in $(seq 1 30); do
    curl -s -m 1 localhost:5173/ >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

echo "就绪  API :3000   Web :5173   日志 $LOG_DIR"
curl -s localhost:3000/api/v1/projects |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).projects[0];if(p)console.log('项目  '+p.name+'  http://localhost:5173/projects/'+p.id+'/board')})"
