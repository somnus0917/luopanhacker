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
curl -LsSf https://astral.sh/uv/install.sh | sh
uv sync --locked
uv run python -m playwright install chromium
```

项目的 Python 依赖由 `pyproject.toml` 和提交到 Git 的 `uv.lock` 统一管理。不要再使用 `pip install -r requirements.txt`；新增或升级依赖时运行 `uv add <包名>` 或 `uv lock`，并一并提交更新后的锁文件。

### 每日运行

```bash
./scripts/run_daily.sh
```

脚本会打开有头浏览器。如果出现登录页，请手动扫码登录；登录态会保存在 `session/`，后续通常可以复用。

默认抓取两家店铺：

- 华硕凡飞笔记本电脑专卖店
- acer宏碁凡飞专卖店

也可以只抓某一家：

```bash
./scripts/run_daily.sh --shop "华硕凡飞笔记本电脑专卖店"
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
./scripts/run_dashboard.sh
```

看板默认地址：

```text
http://127.0.0.1:8501
```

首次访问需要登录：
- 用户名：`admin`
- 密码：`admin123`

登录后可以在侧边栏修改密码和管理用户。

当前生产看板由 Rust API 直接提供登录、静态文件和业务 API，并优先读取 SQLite；Rust worker 采集成功后会同步 SQLite，新跑出的每日数据会自动进入看板。前端源码位于 `apps/web/src/main.ts`，运行时静态产物仍提交在 `web/static/`。

部署后可以用一条命令检查核心状态：

```bash
docker exec -it douyin-compass luopan-worker-rs doctor
```

前端本地开发可以启动 Rust API 和 Vite：

```bash
cd apps/web
pnpm install
pnpm dev
```

## 订单数据

订单明细上传、预览、确认写入和撤销都在当前数据看板中完成。Excel 解析仍由 Python 完成，确认写入与撤销默认优先走 Rust API。

## 结算数据

抖音结算导出的 `DL*.csv` 可以直接在“结算看板”上传，上传时填写店铺名称；也可以放到 `output/settlement/` 后由 Rust API 自动读取。金额按 CSV 原始元单位展示，页面支持按店铺筛选。当前历史文件名映射：

- `*3441.csv`：惠普办公设备旗舰店
- `*5137.csv`：HYPEX极度未知凡飞店

```bash
mkdir -p output/settlement
cp DL*.csv output/settlement/
docker exec -it douyin-compass luopan-worker-rs settlement-json
docker exec -it douyin-compass luopan-worker-rs settlement-json --shop "惠普办公设备旗舰店"
```

旧的独立 HTML/Streamlit 入口已归档到 `legacy/`，不再作为生产路径。

## 低频策略

脚本默认使用可见浏览器、人工登录、动作慢速、点击前后随机等待，并且每家店铺之间预留额外等待。它不是高速采集器，也不绕过平台风控；如果页面加载慢，宁愿多等一会。

可选参数：

```bash
./scripts/run_daily.sh --login-timeout-minutes 15 --keep-open
```

`--keep-open` 会在完成后保留浏览器 60 秒，方便人工检查。
