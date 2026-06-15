#!/bin/bash
set -euo pipefail

cd /app

echo "[$(date '+%Y-%m-%d %H:%M:%S')] start scheduled compass scrape"

PYTHONUNBUFFERED=1 python scheduler_run.py \
  --login-timeout-minutes 30

echo "[$(date '+%Y-%m-%d %H:%M:%S')] finished scheduled compass scrape"
