# Douyin Compass Daily Runner

这个目录用于低频获取抖音电商罗盘店铺页的"近1天"可见数据。

## 快速部署（Docker）

### 1. 构建并启动服务

```bash
docker-compose build
docker-compose up -d
```

### 2. 首次登录

1. 打开数据看板: `http://YOUR_SERVER_IP:8501`
2. 使用默认管理员账户登录：
   - 用户名：`admin`
   - 密码：`admin123`
3. **首次登录后请立即修改默认密码**（在侧边栏"修改密码"）
4. 如需添加其他用户，管理员可在侧边栏"用户管理"中添加

### 3. 访问服务

- **数据看板**: `http://YOUR_SERVER_IP:8501`（需要登录）
- **noVNC 远程桌面**: `http://YOUR_SERVER_IP:6080`（用于扫码登录抖音）

### 4. 定时任务

- 每天 9:00 自动触发采集任务
- 任务内部随机等待 0-60 分钟，避免固定时间访问
- 如果登录失效，看板会显示登录截图和 noVNC 入口
- 登录完成后任务会自动继续执行

详细部署说明请参考 [DEPLOY.md](./DEPLOY.md)

---

## 本地运行

### 首次准备

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m playwright install chromium
```

### 每日运行

```bash
./run_daily.sh
```

脚本会打开有头浏览器。如果出现登录页，请手动扫码登录；登录态会保存在 `session/`，后续通常可以复用。

默认抓取两家店铺：

- 华硕凡飞笔记本电脑专卖店
- acer宏碁凡飞专卖店

也可以只抓某一家：

```bash
./run_daily.sh --shop "华硕凡飞笔记本电脑专卖店"
```

## 输出

结果会写到：

```text
output/daily/<数据日期>/
```

每次运行会生成一份 JSON 和一份 CSV，例如：

```text
output/daily/2026-06-11/compass_daily_2026-06-11_143000.json
output/daily/2026-06-11/compass_daily_2026-06-11_143000.csv
```

脚本完成后可以启动数据看板：

```bash
./run_dashboard.sh
```

看板默认地址：

```text
http://127.0.0.1:8501
```

首次访问需要登录：
- 用户名：`admin`
- 密码：`admin123`

登录后可以在侧边栏修改密码和管理用户。

网页看板会直接读取 `output/daily/**/*.json`，新跑出的每日数据会自动进入看板。

## 订单数据看板

订单采集结果继续保存在 `output/orders/` 目录，可在后续版本接入独立订单页面。

也可以继续生成独立 HTML：

```bash
./run_order_dashboard.sh
```

订单看板支持：
- 按店铺、品牌、订单状态筛选
- 搜索订单号/商品关键词
- 导出 CSV
- 订单状态统计

## 低频策略

脚本默认使用可见浏览器、人工登录、动作慢速、点击前后随机等待，并且每家店铺之间预留额外等待。它不是高速采集器，也不绕过平台风控；如果页面加载慢，宁愿多等一会。

可选参数：

```bash
./run_daily.sh --login-timeout-minutes 15 --keep-open
```

`--keep-open` 会在完成后保留浏览器 60 秒，方便人工检查。
