# Douyin Compass Dashboard - Docker 部署指南

## 快速开始

### 1. 配置管理员密码并构建 Docker 镜像

在项目根目录复制环境示例，设置不少于 12 位且不等于 `admin123` 的密码：

```bash
cp .env.example .env
ADMIN_PASSWORD="请替换为强密码"
```

容器启动会拒绝空密码、默认密码和少于 12 位的密码。

然后构建镜像：

```bash
docker compose build
```

### 2. 启动服务

```bash
docker compose up -d
```

### 3. 访问服务

- **noVNC 网页远程桌面**: 通过受访问控制的 HTTPS 反向代理访问，例如 `https://YOUR_DOMAIN/novnc/`。默认端口只绑定宿主机 `127.0.0.1`，不应直接暴露。
- **数据看板**: 生产环境通过 HTTPS 反向代理访问，例如 `https://YOUR_DOMAIN`

Compose 默认只在宿主机 `127.0.0.1` 映射这两个端口，不依赖预先存在的外部 Docker 网络。正式部署脚本会在共享 `proxy` 网络存在时自动把容器接入该网络，供 Caddy 等容器反向代理使用。只有配置了防火墙或额外认证时才应设置 `LUOPAN_HOST_BIND=0.0.0.0`。

## GitHub CI/CD 生产发布

生产发布分为三个独立阶段：CI 按变更范围并行校验 Rust、前端、Python 和部署配置；`Release image` 在 CI 通过后构建一次不可变 GHCR 镜像（标签为完整 Git SHA）；`Deploy production` 仅在服务器拉取该镜像、重启容器、同步 SQLite 派生数据并执行健康检查。生产服务器不再编译源码。

首次启用前，请确认 GitHub Actions 对仓库 Packages 有写入权限，并让 GHCR 包继承该仓库的 Actions 访问权限。部署工作流把短期 `GITHUB_TOKEN` 经受限 SSH 通道传给服务器仅用于本次拉取，服务器不会持久化该凭据。若 GHCR 包设为私有，这项仓库权限是必须的。

本地开发与手动运维仍可使用 `docker compose build` / `docker compose up -d`；它们继续构建本地镜像，不经过 GHCR。

## 首次使用

### 1. 登录抖音电商罗盘

1. 通过受访问控制的 HTTPS 反向代理打开 noVNC，例如 `https://YOUR_DOMAIN/novnc/`
2. 在终端中运行抓取脚本:
   ```bash
   docker exec -it douyin-compass-collector bash
   ./docker/run_daily.sh
   ```
3. 当浏览器打开登录页面时，在 noVNC 中手动扫码登录
4. 登录状态会保存在 `session/` 目录，后续可复用

### 2. 手动执行抓取

```bash
# 进入容器
docker exec -it douyin-compass-collector bash

# 执行抓取
./docker/run_daily.sh

# 或指定店铺
./docker/run_daily.sh --shop "店铺 A"
```

### 3. 查看查看板

打开浏览器访问生产反向代理地址，例如：`https://YOUR_DOMAIN`

## 定时任务

## 备份与恢复演练

`ops/backup.sh` 会先通过 SQLite 在线备份 API 生成一致性快照，再打包配置、采集结果、浏览器会话、日志和状态目录；归档写入完成后会立即执行完整性校验。

```bash
LUOPAN_APP_DIR=/home/ubuntu/luopan-app \
LUOPAN_DATA_DIR=/home/ubuntu/luopan-data \
./ops/backup.sh
```

若配置 `LUOPAN_BACKUP_SYNC_TARGET=user@backup-host:/srv/luopan/`，归档会在本地校验后同步到异机或对象存储挂载点。应定期在隔离目录解压归档，并用 `sqlite3 state/luopan.db 'PRAGMA integrity_check'` 验证恢复结果。

### 自动定时采集

系统已配置定时任务：

- **触发时间**：每天早上 9:00
- **随机延迟**：任务内部随机等待 0-60 分钟，避免固定时间访问
- **登录检测**：如果登录失效，会生成截图并等待用户扫码
- **防重复**：使用锁文件避免同一时间启动多个任务

### 登录失效处理

当登录态失效时：

1. 系统会自动截图保存到 `output/collection/login.png`
2. 数据看板会显示采集状态和远程浏览器入口
3. 看板提供 noVNC 远程浏览器入口
4. 用户通过 noVNC 扫码登录后，任务会自动继续

### 手动执行

```bash
# 进入容器
docker exec -it douyin-compass-collector bash

# 手动执行采集（带随机延迟）
python apps/collector_py/scheduler.py --login-timeout-minutes 30

# 或直接执行（无随机延迟）
./docker/run_daily.sh
```

## 数据持久化

以下目录会挂载到宿主机，确保数据持久化：

- `./output` - 抓取的数据输出
  - `output/daily/` - 每日采集的 JSON 和 CSV
  - `output/settlement/` - 抖音结算导出的 `DL*.csv`
  - `output/channel/` - 流量、商品和搜索模块的原始白名单响应
  - `output/collection/status.json` - 统一采集状态文件
  - `output/collection/progress.log` - 采集终端日志
  - `output/collection/login.png` - 登录页面截图
- `./session` - 浏览器会话（登录状态）
- `./logs` - 日志文件

## 常用命令

```bash
# 查看日志
docker compose logs -f

# 重启服务
docker compose restart

# 停止服务
docker compose down

# 查看容器状态
docker compose ps

# 进入容器
docker exec -it douyin-compass-collector bash

# 查看抓取日志
tail -f logs/cron.log
```

## 配置修改

### 修改定时任务

编辑 `docker/crontab` 文件，然后重新构建镜像：

```bash
docker compose build
docker compose up -d
```

### 修改抓取店铺

编辑本地店铺配置（不会提交到仓库）：

```bash
cp config/shops.example.json config/shops.local.json
# 编辑 shops 数组；如需统一或脱敏展示名，也可填写 aliases 映射
```

### Rust 迁移开关

当前镜像会同时构建两个 Rust 二进制：

- `luopan-worker-rs`: 用于采集任务编排、状态写入、SQLite 同步和库存聚合
- `luopan-api-rs`: 生产看板服务，直接提供登录、静态前端和业务 API

Rust 看板 API 默认启动并监听 8501。修改 `.env` 后重启容器：

```bash
docker compose up -d
```

默认值如下：

```bash
LUOPAN_API_RS_HOST=0.0.0.0
LUOPAN_API_RS_PORT=8501
```

`api-rs` 直接提供看板；上传、预览、确认写入和撤销均由 Rust API 处理。Python 仅保留 Playwright 抓取。

手动补采和定时补采也可以通过 Rust worker 进入 Python Playwright 抓取器。默认容器配置已经打开：

```bash
COLLECTION_WORKER_COMMAND=luopan-worker-rs compass-collect
STATUS_UPDATE_COMMAND=luopan-worker-rs status-update
SCHEDULED_SCRAPE_RUST_WORKER=true
```

API 只向共享目录写入采集请求；独立采集服务消费请求并调用 Rust worker。Playwright 仍负责浏览器自动化，但已按经营与渠道模块拆分，单个模块失败不会阻止其他模块保存结果。

Rust SQLite 数据层默认用于 API 优先读取。可以手动把当前 JSON 派生数据同步进 `/app/state/luopan.db`：

```bash
docker exec -it douyin-compass luopan-worker-rs storage-sync
docker exec -it douyin-compass luopan-worker-rs storage-summary
```

每次通过 Rust worker 采集成功后会默认自动同步：

```bash
STORAGE_SYNC_AFTER_SCRAPE=true
LUOPAN_STORAGE_DB=/app/state/luopan.db
```

需要临时禁用数据库优先读路径时设置：

```bash
LUOPAN_API_RS_STORAGE_READS=false
```

数据库汇总接口受登录保护。请登录看板后查看，或使用 worker 的健康检查：

```bash
docker exec -it douyin-compass luopan-worker-rs doctor
```

一条命令做部署健康检查：

```bash
docker exec -it douyin-compass luopan-worker-rs doctor
curl --fail http://127.0.0.1:8501/readyz

# doctor 默认将经营数据源与 SQLite 超过 36 小时未更新视为过期；
# 可通过环境变量调整阈值。
docker exec -e LUOPAN_DOCTOR_MAX_DATA_AGE_HOURS=48 -it douyin-compass \
  luopan-worker-rs doctor
```

订单导入的 Excel 解析、确认写入和撤销均由 Rust API 完成。

结算看板支持网页上传抖音结算 CSV，上传时填写店铺名称；也会读取本地 `output/settlement/` 目录中的 CSV，并支持按店铺筛选。真实历史文件名映射应保存到运行时数据目录，不应提交到仓库。

```bash
mkdir -p output/settlement
cp DL*.csv output/settlement/
docker exec -it douyin-compass luopan-worker-rs settlement-json
docker exec -it douyin-compass luopan-worker-rs settlement-json --shop "店铺 B"
```

看板 API 日志位置：

```bash
tail -f /app/logs/dashboard.log
tail -f /app/logs/dashboard.err
```

## 故障排查

### 1. 浏览器无法启动

检查日志：
```bash
docker exec -it douyin-compass-collector bash
cat /app/logs/xvfb.err
cat /app/logs/x11vnc.err
```

### 2. 登录状态失效

删除 session 目录并重新登录：
```bash
rm -rf session/*
# 然后通过 noVNC 重新登录
```

或者通过看板查看登录截图：
- 访问数据看板
- 查看"采集状态"区域
- 如果显示"login_required"，会展示登录截图
- 点击"打开远程浏览器 noVNC"按钮进行登录

### 3. 看板无数据

确保已经执行过抓取：
```bash
docker exec -it douyin-compass-collector bash
./docker/run_daily.sh
```

### 4. 定时任务未执行

检查 cron 日志：
```bash
docker exec -it douyin-compass-collector bash
cat /app/logs/cron.log
```

检查任务状态：
```bash
cat /app/output/collection/status.json
```

## 安全建议

1. **设置强管理员密码**: 在启动前通过 `.env` 设置不少于 12 位的 `ADMIN_PASSWORD`；容器拒绝默认密码。
2. **限制 noVNC 访问**: 仅允许可信 IP、VPN 或额外的反向代理认证访问。
3. **防火墙设置**: 只允许可信 IP 访问。
4. **HTTPS**: 使用 Nginx 反向代理并配置 SSL。

### 登录系统

系统内置了用户认证功能：

- **管理员账户**: `admin` / 启动前在 `.env` 中设置的 `ADMIN_PASSWORD`
- **首次使用**: 必须先设置强密码；容器不会接受默认密码
- **账户设置**: 所有用户可以修改自己的密码，管理员可以添加/删除用户
- **角色权限**:
  - `admin`: 完整访问权限，可管理用户
  - `viewer`: 只能查看数据，无法管理用户

### Nginx 反向代理示例

```nginx
server {
    listen 80;
    server_name compass.yourdomain.com;

    location / {
        proxy_pass http://localhost:8501;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location /novnc/ {
        proxy_pass http://localhost:6080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## 更新部署

```bash
# 拉取最新代码
git pull

# 重新构建并部署
docker compose build
docker compose up -d
```
