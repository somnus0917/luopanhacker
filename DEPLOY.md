# Douyin Compass Dashboard - Docker 部署指南

## 快速开始

### 1. 构建 Docker 镜像

```bash
docker-compose build
```

### 2. 启动服务

```bash
docker-compose up -d
```

### 3. 访问服务

- **noVNC 网页远程桌面**: `http://YOUR_SERVER_IP:6080`
- **Streamlit 看板**: `http://YOUR_SERVER_IP:8501`

## 首次使用

### 1. 登录抖音电商罗盘

1. 打开 noVNC 网页远程桌面: `http://YOUR_SERVER_IP:6080`
2. 在终端中运行抓取脚本:
   ```bash
   docker exec -it douyin-compass bash
   ./docker/run_daily.sh
   ```
3. 当浏览器打开登录页面时，在 noVNC 中手动扫码登录
4. 登录状态会保存在 `session/` 目录，后续可复用

### 2. 手动执行抓取

```bash
# 进入容器
docker exec -it douyin-compass bash

# 执行抓取
./docker/run_daily.sh

# 或指定店铺
./docker/run_daily.sh --shop "华硕凡飞笔记本电脑专卖店"
```

### 3. 查看查看板

打开浏览器访问: `http://YOUR_SERVER_IP:8501`

## 定时任务

### 自动定时采集

系统已配置定时任务：

- **触发时间**：每天早上 9:00
- **随机延迟**：任务内部随机等待 0-60 分钟，避免固定时间访问
- **登录检测**：如果登录失效，会生成截图并等待用户扫码
- **防重复**：使用锁文件避免同一时间启动多个任务

### 登录失效处理

当登录态失效时：

1. 系统会自动截图保存到 `output/login.png`
2. Streamlit 看板会显示登录截图
3. 看板提供 noVNC 远程浏览器入口
4. 用户通过 noVNC 扫码登录后，任务会自动继续

### 手动执行

```bash
# 进入容器
docker exec -it douyin-compass bash

# 手动执行采集（带随机延迟）
python scheduler_run.py --login-timeout-minutes 30

# 或直接执行（无随机延迟）
./docker/run_daily.sh
```

## 数据持久化

以下目录会挂载到宿主机，确保数据持久化：

- `./output` - 抓取的数据输出
  - `output/daily/` - 每日采集的 JSON 和 CSV
  - `output/task_status.json` - 任务状态文件
  - `output/login.png` - 登录页面截图
- `./session` - 浏览器会话（登录状态）
- `./logs` - 日志文件

## 常用命令

```bash
# 查看日志
docker-compose logs -f

# 重启服务
docker-compose restart

# 停止服务
docker-compose down

# 查看容器状态
docker-compose ps

# 进入容器
docker exec -it douyin-compass bash

# 查看抓取日志
tail -f logs/cron.log
```

## 配置修改

### 修改定时任务

编辑 `docker/crontab` 文件，然后重新构建镜像：

```bash
docker-compose build
docker-compose up -d
```

### 修改抓取店铺

编辑 `scraper.py` 中的 `TARGET_SHOPS` 变量：

```python
TARGET_SHOPS = (
    "华硕凡飞笔记本电脑专卖店",
    "acer宏碁凡飞专卖店",
)
```

## 故障排查

### 1. 浏览器无法启动

检查日志：
```bash
docker exec -it douyin-compass bash
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
- 访问 Streamlit 看板
- 查看"采集状态"区域
- 如果显示"login_required"，会展示登录截图
- 点击"打开远程浏览器 noVNC"按钮进行登录

### 3. 看板无数据

确保已经执行过抓取：
```bash
docker exec -it douyin-compass bash
./docker/run_daily.sh
```

### 4. 定时任务未执行

检查 cron 日志：
```bash
docker exec -it douyin-compass bash
cat /app/logs/cron.log
```

检查任务状态：
```bash
cat /app/output/task_status.json
```

## 安全建议

1. **修改默认端口**: 修改 `docker-compose.yml` 中的端口映射
2. **添加认证**: 为 noVNC 和 Streamlit 添加密码认证
3. **防火墙设置**: 只允许可信 IP 访问
4. **HTTPS**: 使用 Nginx 反向代理并配置 SSL

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
docker-compose build
docker-compose up -d
```
