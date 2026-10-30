#!/usr/bin/env bash
# 前端 release：nuxt generate → 原子发布 → 重启 huobao-backend（生产模式托管 UI+API 于 :5679）
#
# 用法：scripts/release.sh
# 目录：$HUOBAO_RELEASES（默认 ~/huobao-releases）/ <UTC 时间戳> /，`current` 软链指向当前版本。
#       FRONTEND_DIST=$HUOBAO_RELEASES/current 由 ecosystem.config.cjs 注入。
# 回滚：ln -sfn $HUOBAO_RELEASES/<旧时间戳> $HUOBAO_RELEASES/current.new && mv -Tf … current
#       && scripts/pm2.sh restart huobao-backend
set -euo pipefail
cd "$(dirname "$0")/.."

REL_ROOT="${HUOBAO_RELEASES:-$HOME/huobao-releases}"
KEEP="${HUOBAO_RELEASES_KEEP:-5}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$REL_ROOT/$TS"
PORT=5679

mkdir -p "$REL_ROOT"

if [ ! -d frontend/node_modules ]; then
  echo "==> frontend: npm ci（node_modules 缺失）"
  ( cd frontend && npm ci --no-audit --no-fund )
fi

echo "==> frontend: nuxt generate"
( cd frontend && npm run generate )

echo "==> publish -> $DEST"
mkdir -p "$DEST"
cp -a frontend/.output/public/. "$DEST/"

echo "==> activate $REL_ROOT/current -> $TS"
ln -sfn "$DEST" "$REL_ROOT/current.new"
mv -Tf "$REL_ROOT/current.new" "$REL_ROOT/current"

echo "==> restart huobao-backend"
scripts/pm2.sh restart huobao-backend

echo "==> prune（保留最近 $KEEP 个）"
# shellcheck disable=SC2012
ls -1d "$REL_ROOT"/[0-9]*T*Z 2>/dev/null | sort | head -n "-$KEEP" | xargs -r rm -rf

echo "==> smoke"
# pm2 restart 后进程要重新监听，先等 health 起来再打点（curl 连接失败会 exit 7，被 set -e 吃掉）
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/health" || echo 000)" = 200 ] && break
  sleep 1
done

fail=0
check() { # name url expected
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$2" || echo 000)"
  printf '  %-28s %s\n' "$1" "$code"
  [ "$code" = "$3" ] || fail=1
}
# 后端直连（Caddy 剥掉 /huobao 后看到的就是这些路径）
check backend/health "http://127.0.0.1:$PORT/api/v1/health" 200
check backend/index "http://127.0.0.1:$PORT/" 200
# 生产入口（Caddy :80 → handle_path /huobao/* → :5679，LAN 免鉴权）
check edge/huobao/ "http://127.0.0.1/huobao/" 200
check edge/huobao/api "http://127.0.0.1/huobao/api/v1/health" 200
check edge/huobao/deeplink "http://127.0.0.1/huobao/drama/1" 200
# 发布产物必须以 /huobao/ 为基址（改了 baseURL 才会命中）
ASSET="$(grep -o '/huobao/_nuxt/[^"]*\.js' "$REL_ROOT/current/index.html" | head -1 || true)"
[ -n "$ASSET" ] || { echo "  index.html 未以 /huobao/ 为基址" >&2; fail=1; }
[ -n "$ASSET" ] && check "edge$ASSET" "http://127.0.0.1$ASSET" 200

if [ "$fail" = 0 ]; then
  echo "OK $TS"
else
  echo "SMOKE FAILED — 回滚: repoint $REL_ROOT/current + scripts/pm2.sh restart huobao-backend" >&2
  exit 1
fi
