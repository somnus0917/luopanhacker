#!/usr/bin/env bash
# Production deploy entry point.  Keep runtime data outside this Git worktree.
set -Eeuo pipefail

APP_DIR="${LUOPAN_APP_DIR:-/home/ubuntu/luopan-app}"
DATA_DIR="${LUOPAN_DATA_DIR:-/home/ubuntu/luopan-data}"
ENV_FILE="${LUOPAN_DEPLOY_ENV:-${DATA_DIR}/deploy.env}"
LOCK_FILE="${DATA_DIR}/deploy.lock"
DEPLOY_REF="${1:-}"
DEPLOY_IMAGE=false
RELEASE_DIR=""
REGISTRY_CONFIG_DIR=""

if [[ "${DEPLOY_REF}" == "--image" ]]; then
  DEPLOY_IMAGE=true
  DEPLOY_REF="${2:-}"
fi

cleanup() {
  [[ -z "${RELEASE_DIR}" ]] || rm -rf "${RELEASE_DIR}"
  [[ -z "${REGISTRY_CONFIG_DIR}" ]] || rm -rf "${REGISTRY_CONFIG_DIR}"
}
trap cleanup EXIT

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
  curl --fail --location --retry 3 --retry-delay 3 --connect-timeout 15 \
    --max-time 180 \
    "https://codeload.github.com/somnus0917/luopanhacker/tar.gz/${DEPLOY_REF}" \
    | tar -xzf - --strip-components=1 -C "${RELEASE_DIR}"
  # Runtime mounts may still have legacy directories in the worktree from
  # earlier deployments. Preserve them: container-owned SQLite, Chromium
  # profiles, and logs must never be considered stale release files.
  rsync -a --delete \
    --exclude='.git' \
    --exclude='.deploy-revision' \
    --exclude='config/' \
    --exclude='logs/' \
    --exclude='output/' \
    --exclude='session/' \
    --exclude='state/' \
    "${RELEASE_DIR}/" "${APP_DIR}/"
  printf '%s\n' "${DEPLOY_REF}" > "${APP_DIR}/.deploy-revision"

  # Bootstrap the deployment key gateway from the immutable source archive.
  # The first image rollout on older hosts still enters through `deploy <SHA>`;
  # installing this tightly scoped wrapper lets every later rollout use
  # `deploy-image <SHA>` without granting a shell to the deployment key.
  if [[ "${DEPLOY_IMAGE}" = "false" && -x "${APP_DIR}/ops/ssh-deploy-wrapper.sh" && -d "${DATA_DIR}/bin" ]]; then
    install -o "$(id -un)" -g "$(id -gn)" -m 755 \
      "${APP_DIR}/ops/ssh-deploy-wrapper.sh" "${DATA_DIR}/bin/github-deploy"
  fi
else
  fetch_main
  git reset --hard origin/main
  git clean -ffd
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'NOVNC_URL=http://127.0.0.1:6080\n' > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

admin_password="$(awk -F= '$1 == "ADMIN_PASSWORD" { print substr($0, index($0, "=") + 1); exit }' "${ENV_FILE}")"
if [[ -z "${admin_password}" ]]; then
  echo "ADMIN_PASSWORD is missing or empty in ${ENV_FILE}." >&2
  echo "Set a password of at least 12 characters before deploying." >&2
  exit 2
fi
unset admin_password

if [[ "${DEPLOY_IMAGE}" = "true" ]]; then
  # The workflow sends its short-lived GitHub token on stdin. Keep Docker's
  # registry credentials in a temporary directory so the production host never
  # stores that token; the already-pulled immutable image remains local.
  IFS= read -r -t 30 registry_token || {
    echo "Missing short-lived registry token for image deployment." >&2
    exit 2
  }
  [[ -n "${registry_token}" ]] || {
    echo "Registry token is empty." >&2
    exit 2
  }
  image_repository="${LUOPAN_IMAGE_REPOSITORY:-ghcr.io/somnus0917/luopanhacker}"
  registry_username="${LUOPAN_REGISTRY_USERNAME:-somnus0917}"
  release_image="${image_repository}:${DEPLOY_REF}"
  REGISTRY_CONFIG_DIR="$(mktemp -d "${DATA_DIR}/docker-config.XXXXXX")"
  printf '%s\n' "${registry_token}" | docker --config "${REGISTRY_CONFIG_DIR}" login \
    "${image_repository%%/*}" --username "${registry_username}" --password-stdin
  unset registry_token
  docker --config "${REGISTRY_CONFIG_DIR}" pull "${release_image}"
  LUOPAN_IMAGE="${release_image}" \
    LUOPAN_DATA_DIR="${DATA_DIR}" \
    docker compose --env-file "${ENV_FILE}" --project-name luopan up -d --no-build --remove-orphans
else
  # Local/manual deployments retain the source-build workflow. Production CI/CD
  # uses the immutable image path above and therefore never rebuilds here.
  DEBIAN_MIRROR="${DEBIAN_MIRROR:-}" \
    LUOPAN_DATA_DIR="${DATA_DIR}" \
    docker compose --env-file "${ENV_FILE}" --project-name luopan up -d --build --remove-orphans
fi

for container_name in douyin-compass douyin-compass-collector; do
  if [[ "$(docker inspect --format '{{.State.Running}}' "${container_name}" 2>/dev/null || true)" != "true" ]]; then
    echo "Required container is not running: ${container_name}" >&2
    docker compose --env-file "${ENV_FILE}" --project-name luopan logs --tail=120 >&2
    exit 1
  fi
done

# A new API image can add parsers for snapshots that were already collected.
# Refresh the derived SQLite cache during every release so the UI and the image
# revision cannot drift apart.
docker exec douyin-compass luopan-worker-rs storage-sync >/dev/null

dashboard_port="$(awk -F= '$1 == "LUOPAN_DASHBOARD_PORT" { print substr($0, index($0, "=") + 1); exit }' "${ENV_FILE}")"
dashboard_port="${dashboard_port:-8501}"
dashboard_ready=false
collector_ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:${dashboard_port}/readyz" >/dev/null; then
    dashboard_ready=true
  fi
  if [[ -f "${DATA_DIR}/output/collection/heartbeat.json" ]] && \
     find "${DATA_DIR}/output/collection/heartbeat.json" -mmin -2 -print -quit | grep -q .; then
    if docker exec douyin-compass-collector pgrep -f 'apps.collector_py.service' >/dev/null; then
      collector_ready=true
    fi
  fi
  if [[ "${dashboard_ready}" = "true" && "${collector_ready}" = "true" ]]; then
    break
  fi
  sleep 2
done
if [[ "${dashboard_ready}" != "true" || "${collector_ready}" != "true" ]]; then
  echo "Deployment health check failed: dashboard=${dashboard_ready}, collector=${collector_ready}" >&2
  docker compose --env-file "${ENV_FILE}" --project-name luopan logs --tail=120 >&2
  exit 1
fi

# Production Caddy runs in the shared proxy network. The base Compose file does
# not require that network so local `docker compose up` remains self-contained.
PROXY_NETWORK="${LUOPAN_PROXY_NETWORK:-proxy}"
if docker network inspect "${PROXY_NETWORK}" >/dev/null 2>&1; then
  if ! docker inspect douyin-compass \
    --format '{{json .NetworkSettings.Networks}}' | grep -q "\"${PROXY_NETWORK}\""; then
    docker network connect --alias douyin-compass --alias compass-dashboard \
      "${PROXY_NETWORK}" douyin-compass
  fi
  if ! docker inspect douyin-compass-collector \
    --format '{{json .NetworkSettings.Networks}}' | grep -q "\"${PROXY_NETWORK}\""; then
    docker network connect --alias douyin-compass-collector \
      "${PROXY_NETWORK}" douyin-compass-collector
  fi
fi

docker compose --env-file "${ENV_FILE}" --project-name luopan ps
if [[ -n "${DEPLOY_REF}" ]]; then
  echo "Deployed source revision: ${DEPLOY_REF}"
else
  git rev-parse --short HEAD
fi
