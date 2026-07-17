#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -n "${PYTHON:-}" ]]; then
  PY="$PYTHON"
elif command -v uv >/dev/null 2>&1; then
  exec env DASHBOARD_HOST=127.0.0.1 DASHBOARD_PORT=8501 uv run --locked python -m apps.dashboard_py.web_app
elif [[ -x ".venv/bin/python" ]]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

DASHBOARD_HOST=127.0.0.1 DASHBOARD_PORT=8501 "$PY" -m apps.dashboard_py.web_app
