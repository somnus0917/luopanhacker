#!/bin/bash
set -euo pipefail

cd /app

STATUS_PATH="/app/output/collection/status.json"
if [[ ! -r "$STATUS_PATH" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] compass retry skipped: no collection status"
  exit 0
fi

mapfile -t MODULES < <(python3 - "$STATUS_PATH" <<'PY'
import json
import sys
from datetime import date

try:
    status = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError):
    raise SystemExit(0)

# Only retry a result produced today, and only when the daily run reported a
# terminal failure. A successful yesterday snapshot is not a retry candidate.
if str(status.get("updated_at", ""))[:10] != date.today().isoformat():
    raise SystemExit(0)
if status.get("state") not in {"failed", "partial_success"}:
    raise SystemExit(0)

allowed = ("operations", "channel", "douyin")
modules = status.get("modules") if isinstance(status.get("modules"), dict) else {}
failed = [name for name in allowed if modules.get(name, {}).get("state") != "success"]
for name in failed or allowed:
    print(name)
PY
)

if [[ "${#MODULES[@]}" -eq 0 ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] compass retry skipped: daily collection succeeded"
  exit 0
fi

mkdir -p /app/output/collection
exec > >(tee -a /app/output/collection/progress.log) 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] retrying failed compass modules: ${MODULES[*]}"

export CHROMIUM_EXECUTABLE_PATH="${CHROMIUM_EXECUTABLE_PATH:-/usr/bin/chromium}"
export DISPLAY="${DISPLAY:-:99}"
export STORAGE_SYNC_AFTER_SCRAPE="${STORAGE_SYNC_AFTER_SCRAPE:-true}"
RANDOM_DELAY_SECONDS="$((RANDOM % 301 + 120))"

if command -v luopan-worker-rs >/dev/null 2>&1; then
  args=(compass-collect --random-delay-seconds "$RANDOM_DELAY_SECONDS" --login-timeout-minutes 30)
  for module in "${MODULES[@]}"; do args+=(--module "$module"); done
  exec env PYTHONUNBUFFERED=1 luopan-worker-rs "${args[@]}"
fi

args=(apps/collector_py/scheduler.py --random-delay-seconds "$RANDOM_DELAY_SECONDS" --login-timeout-minutes 30)
for module in "${MODULES[@]}"; do args+=(--module "$module"); done
exec env PYTHONUNBUFFERED=1 python3 "${args[@]}"
