#!/usr/bin/env bash
# 以干净环境运行 pm2，避免 omp web 等会话变量（PORT、OMP_WEB_*、NODE_ENV）注入 pm2 daemon/子进程。
# 用法：scripts/pm2.sh start ecosystem.config.cjs | restart all | status | logs | stop all
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_BIN_DIR="$(dirname "$(command -v node)")"
exec env -i \
  HOME="$HOME" \
  USER="$USER" \
  LANG="${LANG:-C.UTF-8}" \
  PATH="$HOME/.local/bin:$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin" \
  pm2 "$@"
