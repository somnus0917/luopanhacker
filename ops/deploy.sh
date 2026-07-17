#!/usr/bin/env bash
# Production deploy entry point.  Keep runtime data outside this Git worktree.
set -Eeuo pipefail

APP_DIR="${LUOPAN_APP_DIR:-/home/ubuntu/luopan-app}"
DATA_DIR="${LUOPAN_DATA_DIR:-/home/ubuntu/luopan-data}"
ENV_FILE="${LUOPAN_DEPLOY_ENV:-${DATA_DIR}/deploy.env}"
LOCK_FILE="${DATA_DIR}/deploy.lock"
DEPLOY_REF="${1:-}"

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

# GitHub's HTTPS endpoint can occasionally terminate a long-lived TLS stream.
# Retry a bounded number of times and prefer HTTP/1.1 for this small server.
fetch_main() {
  local attempt
  for attempt in 1 2 3; do
    if GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 fetch --prune origin main; then
      return 0
    fi
    if [[ "${attempt}" -lt 3 ]]; then
      echo "Fetch attempt ${attempt} failed; retrying shortly..." >&2
      sleep $((attempt * 3))
    fi
  done
  echo "Unable to fetch origin/main after 3 attempts." >&2
  return 1
}

if [[ -n "${DEPLOY_REF}" ]]; then
  if [[ ! "${DEPLOY_REF}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Deployment revision must be a full lowercase Git SHA." >&2
    exit 2
  fi

  # GitHub Actions supplies the SHA it just validated. Download that immutable
  # source archive directly, avoiding a fragile server-side Git HTTPS session.
  RELEASE_DIR="$(mktemp -d "${DATA_DIR}/release.XXXXXX")"
  cleanup_release() { rm -rf "${RELEASE_DIR}"; }
  trap cleanup_release EXIT
  curl --fail --location --retry 3 --retry-delay 3 --connect-timeout 15 \
    --max-time 180 \
    "https://codeload.github.com/somnus0917/luopanhacker/tar.gz/${DEPLOY_REF}" \
    | tar -xzf - --strip-components=1 -C "${RELEASE_DIR}"
  rsync -a --delete --exclude='.git' --exclude='.deploy-revision' \
    "${RELEASE_DIR}/" "${APP_DIR}/"
  printf '%s\n' "${DEPLOY_REF}" > "${APP_DIR}/.deploy-revision"
else
  fetch_main
  git reset --hard origin/main
  git clean -ffd
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'NOVNC_URL=http://127.0.0.1:6080\n' > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

LUOPAN_DATA_DIR="${DATA_DIR}" \
  docker compose --env-file "${ENV_FILE}" --project-name luopan up -d --build --remove-orphans

docker compose --env-file "${ENV_FILE}" --project-name luopan ps
if [[ -n "${DEPLOY_REF}" ]]; then
  echo "Deployed source revision: ${DEPLOY_REF}"
else
  git rev-parse --short HEAD
fi
