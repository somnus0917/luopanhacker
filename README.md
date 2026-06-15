# Douyin Compass Daily Runner

这个目录用于低频获取抖音电商罗盘店铺页的“近1天”可见数据。

## 首次准备

```bash
cd /Users/somnus/Documents/luopanhacker/luopan_demo
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m playwright install chromium
```

## 每日运行

```bash
cd /Users/somnus/Documents/luopanhacker/luopan_demo
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

脚本完成后可以启动 Streamlit 看板：

```bash
./run_dashboard.sh
```

看板默认地址：

```text
http://127.0.0.1:8501
```

Streamlit 会直接读取 `output/daily/**/*.json`，新跑出的每日数据会自动进入看板。

## 低频策略

脚本默认使用可见浏览器、人工登录、动作慢速、点击前后随机等待，并且每家店铺之间预留额外等待。它不是高速采集器，也不绕过平台风控；如果页面加载慢，宁愿多等一会。

可选参数：

```bash
./run_daily.sh --login-timeout-minutes 15 --keep-open
```

`--keep-open` 会在完成后保留浏览器 60 秒，方便人工检查。
