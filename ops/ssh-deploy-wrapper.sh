#!/usr/bin/env bash
# Stable entry point for the restricted GitHub Actions SSH key. The gateway
# accepts only a source deployment.
set -Eeuo pipefail

case "${SSH_ORIGINAL_COMMAND:-}" in
  deploy)
    exec /home/ubuntu/luopan-app/ops/deploy.sh
    ;;
  deploy\ *)
    deploy_ref="${SSH_ORIGINAL_COMMAND#deploy }"
    if [[ "${deploy_ref}" =~ ^[0-9a-f]{40}$ ]]; then
      exec /home/ubuntu/luopan-app/ops/deploy.sh "${deploy_ref}"
    fi
    echo "Deployment revision must be a full lowercase Git SHA." >&2
    exit 126
    ;;
  *)
    echo "This deployment key only permits the deploy command." >&2
    exit 126
    ;;
esac
