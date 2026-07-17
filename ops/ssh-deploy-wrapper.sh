#!/usr/bin/env bash
# Stable entry point for the restricted GitHub Actions SSH key.
set -Eeuo pipefail
exec /home/ubuntu/luopan-app/ops/deploy.sh
