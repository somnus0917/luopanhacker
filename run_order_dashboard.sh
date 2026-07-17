#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -n "${PYTHON:-}" ]]; then
  PY="$PYTHON"
elif command -v uv >/dev/null 2>&1; then
  exec uv run --locked python order_dashboard.py
elif [[ -x ".venv/bin/python" ]]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

"$PY" order_dashboard.py
