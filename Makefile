.DEFAULT_GOAL := help

.PHONY: help check build dashboard web daily docker-up docker-down deploy

help: ## 显示常用开发、校验与部署命令
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "%-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

check: ## 运行 Rust、前端与 Python 检查
	./scripts/check.sh

build: ## 构建生产前端静态文件
	pnpm -C apps/web build

dashboard: ## 启动本地 Rust 看板 API（127.0.0.1:8501）
	./scripts/run_dashboard.sh

web: ## 启动 Vite 前端开发服务器（127.0.0.1:5173）
	pnpm -C apps/web dev

daily: ## 执行一次日常采集
	./scripts/run_daily.sh

docker-up: ## 构建并启动 Docker 服务
	docker compose up -d --build

docker-down: ## 停止 Docker 服务
	docker compose down

deploy: ## 执行生产部署脚本（需在生产环境运行）
	./ops/deploy.sh
