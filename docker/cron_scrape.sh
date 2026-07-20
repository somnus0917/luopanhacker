#!/bin/bash
set -euo pipefail

cd /app

mkdir -p /app/output/collection
exec > >(tee -a /app/output/collection/progress.log) 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] start scheduled compass scrape"

PYTHON_BIN="${PYTHON_BIN:-/usr/local/bin/python}"
export CHROMIUM_EXECUTABLE_PATH="${CHROMIUM_EXECUTABLE_PATH:-/usr/bin/chromium}"
export DISPLAY="${DISPLAY:-:99}"

USED_RUST_WORKER=false
if [[ "${SCHEDULED_SCRAPE_RUST_WORKER:-true}" == "true" ]] && command -v luopan-worker-rs >/dev/null 2>&1; then
  USED_RUST_WORKER=true
  PYTHONUNBUFFERED=1 luopan-worker-rs compass-collect \
    --login-timeout-minutes 30
else
  PYTHONUNBUFFERED=1 "$PYTHON_BIN" apps/collector_py/scheduler.py \
    --login-timeout-minutes 30
fi

if [[ "$USED_RUST_WORKER" != "true" ]] && [[ "${STORAGE_SYNC_AFTER_SCRAPE:-false}" == "true" ]] && command -v luopan-worker-rs >/dev/null 2>&1; then
  luopan-worker-rs storage-sync
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] finished scheduled compass scrape"
