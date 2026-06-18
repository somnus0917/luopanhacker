#!/bin/bash
set -euo pipefail

cd /app

echo "[$(date '+%Y-%m-%d %H:%M:%S')] start scheduled compass scrape"

PYTHON_BIN="${PYTHON_BIN:-/usr/local/bin/python}"
export CHROMIUM_EXECUTABLE_PATH="${CHROMIUM_EXECUTABLE_PATH:-/usr/bin/chromium}"
export DISPLAY="${DISPLAY:-:99}"

PYTHONUNBUFFERED=1 "$PYTHON_BIN" scheduler_run.py \
  --login-timeout-minutes 30

echo "[$(date '+%Y-%m-%d %H:%M:%S')] finished scheduled compass scrape"
