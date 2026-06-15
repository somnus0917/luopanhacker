#!/bin/bash
set -e

echo "========================================"
echo "  Douyin Compass Dashboard - Starting  "
echo "========================================"

# 创建必要目录
mkdir -p /app/output/daily /app/session /app/logs

# 启动 supervisor（管理所有服务）
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
