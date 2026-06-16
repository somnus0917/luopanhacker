#!/bin/bash
set -e

cd /app

echo "========================================"
echo "  Starting Daily Compass Scraper        "
echo "========================================"
echo ""
echo "  noVNC Web Desktop: http://YOUR_SERVER_IP:6080"
echo "  Streamlit Dashboard: http://YOUR_SERVER_IP:8501"
echo ""
echo "  If login is required, please open noVNC"
echo "  and scan the QR code in the browser."
echo "========================================"
echo ""

# 运行抓取脚本
PYTHON_BIN="${PYTHON_BIN:-/usr/local/bin/python}"
"$PYTHON_BIN" daily_compass.py "$@"

echo ""
echo "========================================"
echo "  Scraping completed!"
echo "  Check dashboard at: http://YOUR_SERVER_IP:8501"
echo "========================================"
