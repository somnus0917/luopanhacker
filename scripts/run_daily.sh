#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -n "${PYTHON:-}" ]]; then
  PY="$PYTHON"
elif command -v uv >/dev/null 2>&1; then
  exec env PYTHONUNBUFFERED=1 uv run --locked python apps/collector_py/compass.py "$@"
elif [[ -x ".venv/bin/python" ]]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

PYTHONUNBUFFERED=1 "$PY" apps/collector_py/compass.py "$@"
