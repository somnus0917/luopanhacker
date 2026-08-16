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
SQLITE_DB="${DATA_DIR}/state/luopan.db"
SQLITE_SNAPSHOT="${DATA_DIR}/state/.luopan-backup-${STAMP}.db"
BACKUP_SYNC_TARGET="${LUOPAN_BACKUP_SYNC_TARGET:-}"

mkdir -p "${DAILY_DIR}" "${WEEKLY_DIR}" "${DATA_DIR}/state"
if [[ -s "${APP_DIR}/.deploy-revision" ]]; then
  head -n 1 "${APP_DIR}/.deploy-revision" > "${DATA_DIR}/state/deployed_commit.txt"
else
  git -C "${APP_DIR}" rev-parse HEAD > "${DATA_DIR}/state/deployed_commit.txt"
fi
date --iso-8601=seconds > "${DATA_DIR}/state/last_backup_requested_at.txt"

cleanup() {
  rm -f "${SQLITE_SNAPSHOT}" "${TEMP_ARCHIVE}"
}
trap cleanup EXIT

if [[ -f "${SQLITE_DB}" ]]; then
  # sqlite3.Connection.backup uses SQLite's online backup API, producing a
  # consistent snapshot without copying a live WAL database file directly.
  python3 -c '
import sqlite3
import sys

source_path, snapshot_path = sys.argv[1:]
with sqlite3.connect(source_path) as source, sqlite3.connect(snapshot_path) as snapshot:
    source.backup(snapshot)

    result =snapshot.execute("PRAGMA quick_check").fetchall()
    if result != [("ok",)]:
        raise RuntimeError(
            f"SQLite quick_check failed for {snapshot_path}:{result}"
        )
' "${SQLITE_DB}" "${SQLITE_SNAPSHOT}"
fi

# Chromium writes parts of the session as root.  sudo is intentionally
# non-interactive; the migration provisions this narrow requirement first.
tar_args=(--xattrs --acls --numeric-owner -C "${DATA_DIR}" -czf "${TEMP_ARCHIVE}")
# Exclude volatile Chromium cache (Service Worker CacheStorage can reach
# hundreds of MB and churns daily).  Login state is kept: Cookies, Local
# Storage, IndexedDB, Login Data and the Service Worker registration
# database are all outside these patterns.
cache_excludes=(
  --exclude='session/Default/Service Worker/CacheStorage'
  --exclude='session/Default/Service Worker/ScriptCache'
  --exclude='session/Default/Cache'
  --exclude='session/Default/Code Cache'
  --exclude='session/Default/GPUCache'
  --exclude='session/Default/DawnWebGPUCache'
  --exclude='session/Default/DawnGraphiteCache'
  --exclude='session/GraphiteDawnCache'
  --exclude='session/GPUPersistentCache'
  --exclude='session/BrowserMetrics*'
)
tar_args+=("${cache_excludes[@]}")
if [[ -f "${SQLITE_SNAPSHOT}" ]]; then
  tar_args+=(
    --exclude='state/luopan.db'
    --exclude='state/luopan.db-wal'
    --exclude='state/luopan.db-shm'
    --transform="s|state/.luopan-backup-${STAMP}.db|state/luopan.db|"
  )
fi
# Chromium writes parts of the session as root. sudo remains intentionally
# non-interactive; the deployment provisions this narrow requirement first.
sudo -n tar "${tar_args[@]}" config output session logs state
sudo -n chown "$(id -u):$(id -g)" "${TEMP_ARCHIVE}"
mv "${TEMP_ARCHIVE}" "${ARCHIVE}"
chmod 600 "${ARCHIVE}"
tar -tzf "${ARCHIVE}" >/dev/null

if [[ "$(date +%u)" == "7" ]]; then
  cp -f "${ARCHIVE}" "${WEEKLY_DIR}/$(basename "${ARCHIVE}")"
fi

# Daily retention: 14 days; weekly snapshots (Sundays) keep 84 days (~12 weeks).
find "${DAILY_DIR}" -type f -name 'luopan-data-*.tar.gz' -mtime +14 -delete
find "${WEEKLY_DIR}" -type f -name 'luopan-data-*.tar.gz' -mtime +84 -delete
if [[ -n "${BACKUP_SYNC_TARGET}" ]]; then
  rsync -a --protect-args "${ARCHIVE}" "${BACKUP_SYNC_TARGET}"
fi
echo "${ARCHIVE}"
