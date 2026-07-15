#!/usr/bin/env bash
set -euo pipefail

REPO_ARCHIVE_URL="${REPO_ARCHIVE_URL:-https://codeload.github.com/somnus0917/luopanhacker/tar.gz/refs/heads/main}"
APP_DIR="${APP_DIR:-/home/ubuntu/luopanhacker}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

curl -fsSL "$REPO_ARCHIVE_URL" -o "$tmp_dir/main.tar.gz"
tar -xzf "$tmp_dir/main.tar.gz" -C "$tmp_dir"

archive_root="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "$archive_root" ]]; then
  echo "未找到 GitHub 源码包目录" >&2
  exit 1
fi

rsync -a \
  --exclude=.git \
  --exclude=.env \
  --exclude=output \
  --exclude=session \
  --exclude=logs \
  --exclude=config \
  "$archive_root/" "$APP_DIR/"

cd "$APP_DIR"
python3 -m py_compile web_app.py dashboard.py scheduler_run.py scraper.py
bash -n docker/cron_scrape.sh
docker compose up -d --build compass-dashboard
