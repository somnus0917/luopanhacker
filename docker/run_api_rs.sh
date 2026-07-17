#!/bin/bash
set -euo pipefail

if [[ "${LUOPAN_API_RS_ENABLED:-true}" != "true" ]]; then
  echo "luopan-api-rs disabled; set LUOPAN_API_RS_ENABLED=true to start it"
  exec sleep infinity
fi

exec luopan-api-rs
