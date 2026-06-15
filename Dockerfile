FROM python:3.11-slim

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    supervisor \
    cron \
    && rm -rf /var/lib/apt/lists/*

# 安装 Chromium 依赖
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 设置环境变量（必须在安装 Playwright 浏览器之前）
ENV DISPLAY=:99
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 复制依赖文件
COPY requirements.txt .
COPY pyproject.toml .

# 安装 Python 依赖
RUN pip install --no-cache-dir -r requirements.txt

# 安装 Playwright 浏览器
RUN playwright install chromium
RUN playwright install-deps chromium

# 复制应用代码
COPY . .

# 创建必要目录
RUN mkdir -p /app/output/daily /app/session /app/logs

# 复制并设置 crontab
COPY docker/crontab /etc/cron.d/compass-cron
RUN chmod 0644 /etc/cron.d/compass-cron && \
    crontab /etc/cron.d/compass-cron

# 创建 supervisor 配置
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# 创建启动脚本
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh

# 暴露端口
# 6080: noVNC 网页远程桌面
# 8501: Streamlit 看板
# 5900: VNC 直连（可选）
EXPOSE 6080 8501 5900

# 数据卷
VOLUME ["/app/output", "/app/session"]

CMD ["/start.sh"]
