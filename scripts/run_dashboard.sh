#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if command -v luopan-api-rs >/dev/null 2>&1; then
  exec env LUOPAN_ENV=development SESSION_COOKIE_SECURE=false LUOPAN_API_RS_HOST=127.0.0.1 LUOPAN_API_RS_PORT=8501 luopan-api-rs
fi

exec env LUOPAN_ENV=development SESSION_COOKIE_SECURE=false LUOPAN_API_RS_HOST=127.0.0.1 LUOPAN_API_RS_PORT=8501 \
  cargo run -q -p luopan-api-rs
