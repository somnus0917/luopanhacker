#!/usr/bin/env bash
# Full persistent-data backup with daily and weekly retention.
set -Eeuo pipefail

APP_DIR="${LUOPAN_APP_DIR:-/home/ubuntu/luopan-app}"
DATA_DIR="${LUOPAN_DATA_DIR:-/home/ubuntu/luopan-data}"
BACKUP_ROOT="${LUOPAN_BACKUP_DIR:-/home/ubuntu/luopan-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DAILY_DIR="${BACKUP_ROOT}/daily"
WEEKLY_DIR="${BACKUP_ROOT}/weekly"
ARCHIVE="${DAILY_DIR}/luopan-data-${STAMP}.tar.gz"
TEMP_ARCHIVE="${ARCHIVE}.partial"

mkdir -p "${DAILY_DIR}" "${WEEKLY_DIR}" "${DATA_DIR}/state"
if [[ -s "${APP_DIR}/.deploy-revision" ]]; then
  head -n 1 "${APP_DIR}/.deploy-revision" > "${DATA_DIR}/state/deployed_commit.txt"
else
  git -C "${APP_DIR}" rev-parse HEAD > "${DATA_DIR}/state/deployed_commit.txt"
fi
date --iso-8601=seconds > "${DATA_DIR}/state/last_backup_requested_at.txt"

# Chromium writes parts of the session as root.  sudo is intentionally
# non-interactive; the migration provisions this narrow requirement first.
sudo -n tar --xattrs --acls --numeric-owner -C "${DATA_DIR}" -czf "${TEMP_ARCHIVE}" \
  config output session logs state
sudo -n chown "$(id -u):$(id -g)" "${TEMP_ARCHIVE}"
mv "${TEMP_ARCHIVE}" "${ARCHIVE}"

if [[ "$(date +%u)" == "7" ]]; then
  cp -f "${ARCHIVE}" "${WEEKLY_DIR}/$(basename "${ARCHIVE}")"
fi

find "${DAILY_DIR}" -type f -name 'luopan-data-*.tar.gz' -mtime +30 -delete
find "${WEEKLY_DIR}" -type f -name 'luopan-data-*.tar.gz' -mtime +84 -delete
echo "${ARCHIVE}"
