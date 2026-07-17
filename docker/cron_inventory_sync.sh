#!/bin/bash
set -euo pipefail

cd /app

SECRET_FILE="/app/config/wdt.env"
if [[ ! -r "$SECRET_FILE" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] inventory sync skipped: missing $SECRET_FILE" >&2
  exit 1
fi

# Keep credentials outside the image and repository. `set -a` exports only the
# variables supplied by the protected host-mounted file to this process.
set -a
source "$SECRET_FILE"
set +a

: "${WDT_SID:?WDT_SID is required}"
: "${WDT_APPKEY:?WDT_APPKEY is required}"
: "${WDT_APPSECRET:?WDT_APPSECRET is required}"

exec /app/scripts/run_inventory_sync.sh
