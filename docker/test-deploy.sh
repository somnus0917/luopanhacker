#!/bin/bash
# Docker 部署验证脚本

echo "========================================"
echo "  Douyin Compass - Deployment Test      "
echo "========================================"
echo ""

# 检查 Docker 是否安装
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed"
    exit 1
fi
echo "✅ Docker is installed"

# 检查 Docker Compose 是否安装
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed"
    exit 1
fi
echo "✅ Docker Compose is installed"

# 检查必要文件是否存在
required_files=(
    "Dockerfile"
    "docker-compose.yml"
    "docker/start.sh"
    "docker/supervisord.conf"
    "pyproject.toml"
    "uv.lock"
    "apps/scraper_py/daily_compass.py"
    "apps/dashboard_py/web_app.py"
)

for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        echo "❌ Missing file: $file"
        exit 1
    fi
done
echo "✅ All required files exist"

# 创建必要目录
mkdir -p output/daily session logs
echo "✅ Created necessary directories"

echo ""
echo "========================================"
echo "  All checks passed!                   "
echo "========================================"
echo ""
echo "To deploy, run:"
echo "  docker-compose build"
echo "  docker-compose up -d"
echo ""
echo "Then access:"
echo "  noVNC: http://YOUR_SERVER_IP:6080"
echo "  Dashboard: http://YOUR_SERVER_IP:8501"
echo "========================================"
