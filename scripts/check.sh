#!/bin/bash
set -euo pipefail

export UV_CACHE_DIR="${UV_CACHE_DIR:-.uv-cache}"

cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -q
pnpm -C apps/web check
pnpm -C apps/web test
pnpm -C apps/web build
uv run ruff check apps tests
uv run ruff format --check apps tests
uv run pytest -q
