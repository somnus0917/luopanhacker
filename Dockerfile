ARG RUST_IMAGE=rust:1.95-slim
ARG PYTHON_IMAGE=python:3.11-slim
ARG NODE_IMAGE=node:20-slim

FROM ${NODE_IMAGE} AS web-builder

WORKDIR /src/apps/web

COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN corepack enable && \
    corepack prepare pnpm@10.24.0 --activate && \
    pnpm install --frozen-lockfile

COPY apps/web ./
RUN pnpm build && \
    test -s /src/web/static/app.js && \
    test -s /src/web/static/style.css

FROM ${RUST_IMAGE} AS rust-builder

WORKDIR /src

# Build only the Rust control-plane binaries. The Python Playwright code remains
# the production scraper runtime.
COPY docker/cargo-config.toml /usr/local/cargo/config.toml
COPY Cargo.toml Cargo.lock ./
COPY apps ./apps
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p luopan-api-rs -p luopan-worker-rs && \
    mkdir -p /artifacts && \
    cp /src/target/release/luopan-api-rs /artifacts/ && \
    cp /src/target/release/luopan-worker-rs /artifacts/


FROM ${PYTHON_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive

# 腾讯云服务器访问官方 Debian 源可能较慢，构建时改用腾讯云镜像源。
RUN sed -i \
    -e 's|http://deb.debian.org/debian|http://mirrors.cloud.tencent.com/debian|g' \
    -e 's|http://deb.debian.org/debian-security|http://mirrors.cloud.tencent.com/debian-security|g' \
    /etc/apt/sources.list.d/debian.sources

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    chromium \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
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

# Install the pinned official uv binary without relying on a second container
# registry. This endpoint is also used by the host installation.
RUN curl -LsSf https://astral.sh/uv/0.11.29/install.sh | \
    env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

WORKDIR /app

# 设置环境变量（必须在安装 Playwright 浏览器之前）
ENV DISPLAY=:99
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_PYTHON_DOWNLOADS=0
ENV PATH="/app/.venv/bin:${PATH}"

# Lockfile-first dependency installation. `uv.lock` is committed, so a Docker
# build cannot silently resolve a different dependency graph.
COPY pyproject.toml uv.lock ./
RUN uv venv --python /usr/local/bin/python3 && \
    uv export --locked --no-dev --no-emit-project \
      --output-file /tmp/requirements.txt && \
    uv pip install --python /app/.venv/bin/python --require-hashes \
      --default-index https://mirrors.cloud.tencent.com/pypi/simple \
      --requirement /tmp/requirements.txt && \
    rm -f /tmp/requirements.txt

# 复制应用代码
COPY . .

# Build the dashboard from the TypeScript source in every image build. This
# prevents a stale committed web/static bundle from reaching production.
COPY --from=web-builder /src/web/static /app/web/static

# Rust control-plane binaries. Python remains only for browser automation.
COPY --from=rust-builder /artifacts/luopan-worker-rs /usr/local/bin/luopan-worker-rs
COPY --from=rust-builder /artifacts/luopan-api-rs /usr/local/bin/luopan-api-rs

# 创建必要目录
RUN mkdir -p /app/output/daily /app/output/channel /app/output/collection /app/session /app/logs /app/config /app/state

# 复制并设置 crontab
COPY docker/crontab /etc/cron.d/compass-cron
RUN chmod 0644 /etc/cron.d/compass-cron && \
    crontab /etc/cron.d/compass-cron

# 创建 supervisor 配置
COPY docker/supervisord-api.conf /etc/supervisor/conf.d/supervisord-api.conf
COPY docker/supervisord-collector.conf /etc/supervisor/conf.d/supervisord-collector.conf

# 创建启动脚本
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh

# 暴露端口
# 6080: noVNC 网页远程桌面
# 8501: Rust dashboard API and static frontend
# 5900: VNC 直连（可选）
EXPOSE 6080 8501 5900

# 数据卷
VOLUME ["/app/output", "/app/session"]

CMD ["/start.sh"]
