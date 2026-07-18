#!/bin/bash
set -euo pipefail

cargo test -q
pnpm -C apps/web check
pnpm -C apps/web build
uv run pytest -q
