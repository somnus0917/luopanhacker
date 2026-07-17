#!/usr/bin/env bash
# Production deploy entry point.  Keep runtime data outside this Git worktree.
set -Eeuo pipefail

APP_DIR="${LUOPAN_APP_DIR:-/home/ubuntu/luopan-app}"
DATA_DIR="${LUOPAN_DATA_DIR:-/home/ubuntu/luopan-data}"
ENV_FILE="${LUOPAN_DEPLOY_ENV:-${DATA_DIR}/deploy.env}"
LOCK_FILE="${DATA_DIR}/deploy.lock"

mkdir -p "${DATA_DIR}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "A deployment is already running." >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "Clean application repository is missing: ${APP_DIR}" >&2
  exit 1
fi

cd "${APP_DIR}"
git fetch --prune origin main
git reset --hard origin/main
git clean -ffd

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'NOVNC_URL=http://127.0.0.1:6080\n' > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

LUOPAN_DATA_DIR="${DATA_DIR}" \
  docker compose --env-file "${ENV_FILE}" --project-name luopan up -d --build --remove-orphans

docker compose --env-file "${ENV_FILE}" --project-name luopan ps
git rev-parse --short HEAD
