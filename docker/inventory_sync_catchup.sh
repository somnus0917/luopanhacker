#!/bin/bash
set -euo pipefail

SNAPSHOT_PATH="/app/output/inventory/inventory_snapshot.json"
SECRET_FILE="/app/config/wdt.env"

if [[ ! -r "$SECRET_FILE" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] inventory catch-up skipped: missing $SECRET_FILE"
  exit 0
fi

# Before the 03:00 daily run, yesterday is the newest expected snapshot. After
# 03:00, require today's snapshot so a container that was offline at cron time
# catches up immediately when it starts again.
expected_date="$(date +%F)"
if [[ "$(date +%H%M)" < "0300" ]]; then
  expected_date="$(date -d yesterday +%F)"
fi

last_date=""
if [[ -r "$SNAPSHOT_PATH" ]]; then
  last_date="$(python3 - "$SNAPSHOT_PATH" <<'PY'
import json
import sys

try:
    value = json.load(open(sys.argv[1], encoding="utf-8")).get("captured_at", "")
    print(str(value)[:10])
except (OSError, ValueError, AttributeError):
    print("")
PY
)"
fi

if [[ -n "$last_date" && ( "$last_date" == "$expected_date" || "$last_date" > "$expected_date" ) ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] inventory catch-up not needed: snapshot=$last_date"
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] inventory catch-up starting: snapshot=${last_date:-missing}, expected=$expected_date"
/app/docker/cron_inventory_sync.sh
