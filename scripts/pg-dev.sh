#!/usr/bin/env bash
# 本地开发用的 Postgres。用于无 Docker daemon 的环境（如某些容器 / CI）。
# 正常开发环境请优先用 `docker compose up -d`。
set -euo pipefail

export PATH="$PATH:/usr/lib/postgresql/16/bin"
PGDATA="${APOS_PGDATA:-/var/lib/apos-pgdata}"
PORT="${APOS_PGPORT:-5433}"

case "${1:-start}" in
  start)
    if [ ! -d "$PGDATA/base" ]; then
      id -u apospg >/dev/null 2>&1 || useradd -m apospg
      rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown apospg "$PGDATA"
      runuser -u apospg -- initdb -D "$PGDATA" -U apos --auth=trust >/dev/null
    fi
    if pg_isready -h /tmp -p "$PORT" >/dev/null 2>&1; then
      echo "already running on $PORT"
      exit 0
    fi
    runuser -u apospg -- pg_ctl -D "$PGDATA" -o "-p $PORT -k /tmp" -l "$PGDATA/log" start
    until pg_isready -h /tmp -p "$PORT" >/dev/null 2>&1; do sleep 0.3; done
    # ★ 开发库与测试库必须分开：测试在 beforeEach 里 TRUNCATE 全表，
    #   共用一个库的话，跑一次测试就把正在调试的看板数据清空了
    for dbname in apos apos_test; do
      psql -h /tmp -p "$PORT" -U apos -d postgres -tc \
        "SELECT 1 FROM pg_database WHERE datname='$dbname'" | grep -q 1 ||
        psql -h /tmp -p "$PORT" -U apos -d postgres -c "CREATE DATABASE $dbname;"
    done
    echo "postgres ready:"
    echo "  开发  postgres://apos@localhost:$PORT/apos"
    echo "  测试  postgres://apos@localhost:$PORT/apos_test"
    echo
    echo "首次使用两个库都要建表："
    echo "  DATABASE_URL=postgres://apos@localhost:$PORT/apos       pnpm db:migrate"
    echo "  DATABASE_URL=postgres://apos@localhost:$PORT/apos_test  pnpm db:migrate"
    ;;
  stop)
    runuser -u apospg -- pg_ctl -D "$PGDATA" stop
    ;;
  *)
    echo "usage: $0 [start|stop]" >&2
    exit 1
    ;;
esac
