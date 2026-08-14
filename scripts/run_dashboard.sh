#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Local development keeps runtime settings in the repository-root .env file.
# Parse it instead of sourcing it: Compose-compatible values may contain spaces
# (for example, worker commands) and must not be treated as shell code.
# Docker production deployments load their separate deploy.env via Compose.
load_dotenv() {
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ ${#value} -ge 2 ]] && \
        { [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] || \
          [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; }; then
        value="${value:1:-1}"
      fi
      export "${key}=${value}"
    else
      echo "Ignoring malformed .env line: ${line%%=*}" >&2
    fi
  done < .env
}

[[ -f .env ]] && load_dotenv

# .env is also used by Docker, where the database lives beneath /app.  Keep
# local dashboard data inside this checkout instead of trying to create a
# container-only path on the host.
export LUOPAN_STORAGE_DB="$PWD/state/luopan.db"

if command -v luopan-api-rs >/dev/null 2>&1; then
  exec env LUOPAN_ENV=development SESSION_COOKIE_SECURE=false LUOPAN_API_RS_HOST=127.0.0.1 LUOPAN_API_RS_PORT=8501 luopan-api-rs
fi

exec env LUOPAN_ENV=development SESSION_COOKIE_SECURE=false LUOPAN_API_RS_HOST=127.0.0.1 LUOPAN_API_RS_PORT=8501 \
  cargo run -q -p luopan-api-rs
