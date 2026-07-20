#!/usr/bin/env bash
set -euo pipefail

# Resolve the repository root so every relative path below works whether this
# script is launched from cron, an interactive shell, or another directory.
cd "$(dirname "$0")/.."

if [[ -n "${PYTHON:-}" ]]; then
  "$PYTHON" apps/inventory_py/inventory_sync.py "$@"
elif command -v uv >/dev/null 2>&1; then
  uv run --locked python apps/inventory_py/inventory_sync.py "$@"
elif [[ -x ".venv/bin/python" ]]; then
  .venv/bin/python apps/inventory_py/inventory_sync.py "$@"
else
  python3 apps/inventory_py/inventory_sync.py "$@"
fi

# Keep the SQLite-backed API in step with the freshly written JSON snapshot.
# Development environments without the production worker still get a usable
# JSON snapshot and simply skip this import.
if command -v luopan-worker-rs >/dev/null 2>&1; then
  luopan-worker-rs storage-sync
fi
