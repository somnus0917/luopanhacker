#!/bin/bash
set -euo pipefail

export UV_CACHE_DIR="${UV_CACHE_DIR:-.uv-cache}"

cargo test -q
pnpm -C apps/web check
pnpm -C apps/web build
uv run pytest -q
