#!/bin/bash
set -e

echo "========================================"
echo "  Douyin Compass Dashboard - Starting  "
echo "========================================"

# 管理员密码由 Flask 用于首次初始化。拒绝已知默认值和短密码，避免服务在
# 未显式完成生产配置时对外启动。
admin_password="${ADMIN_PASSWORD:-}"
if [ -z "$admin_password" ]; then
    echo "ERROR: ADMIN_PASSWORD must be set before starting the service." >&2
    exit 1
fi
if [ "$admin_password" = "admin123" ]; then
    echo "ERROR: ADMIN_PASSWORD must not use the default value." >&2
    exit 1
fi
if [ "${#admin_password}" -lt 12 ]; then
    echo "ERROR: ADMIN_PASSWORD must be at least 12 characters long." >&2
    exit 1
fi

# 创建必要目录
mkdir -p /app/output/daily /app/session /app/logs /app/config /app/state

# 启动 supervisor（管理所有服务）
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
