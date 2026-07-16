#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -n "${PYTHON:-}" ]]; then
  PY="$PYTHON"
elif [[ -x ".venv/bin/python" ]]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

# Credentials remain environment variables or secret-manager values. They are
# never accepted as command-line arguments and are never written to disk.
exec "$PY" inventory_sync.py "$@"
