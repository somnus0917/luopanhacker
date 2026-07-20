#!/bin/bash
set -e

echo "========================================"
echo "  Douyin Compass Dashboard - Starting  "
echo "========================================"

service_role="${LUOPAN_SERVICE_ROLE:-api}"
if [ "$service_role" = "api" ]; then
    # 管理员密码只属于 API 服务；采集容器不处理登录账户。
    admin_password="${ADMIN_PASSWORD:-}"
    if [ -z "$admin_password" ] || [ "$admin_password" = "admin123" ] || [ "${#admin_password}" -lt 12 ]; then
        echo "ERROR: API service requires a non-default ADMIN_PASSWORD of at least 12 characters." >&2
        exit 1
    fi
fi

# 创建必要目录
mkdir -p /app/output/daily /app/output/channel /app/output/collection /app/session /app/logs /app/config /app/state

# cron does not replay a scheduled job that was missed while the container was
# stopped. Refresh a stale inventory snapshot before starting the dashboard;
# failures are logged but do not prevent the rest of the service from starting.
if [ "$service_role" = "api" ]; then
    bash /app/docker/inventory_sync_catchup.sh >> /app/logs/inventory_sync.log 2>&1 || true
    exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord-api.conf
fi

if [ "$service_role" = "collector" ]; then
    # Preserve the latest pre-split operator context on the first deployment.
    [ -f /app/output/task_status.json ] && [ ! -f /app/output/collection/status.json ] && \
        cp -p /app/output/task_status.json /app/output/collection/status.json
    [ -f /app/output/progress.log ] && [ ! -f /app/output/collection/progress.log ] && \
        cp -p /app/output/progress.log /app/output/collection/progress.log
    [ -f /app/output/login.png ] && [ ! -f /app/output/collection/login.png ] && \
        cp -p /app/output/login.png /app/output/collection/login.png
    exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord-collector.conf
fi

echo "ERROR: unknown LUOPAN_SERVICE_ROLE=$service_role" >&2
exit 1
