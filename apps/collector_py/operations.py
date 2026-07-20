import csv
import json
import re
from datetime import datetime
from pathlib import Path

from apps.scraper_py.scraper import AFTER_CLICK_DELAY_RANGE, SHOP_URL, human_pause

APP_DIR = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = APP_DIR / "output" / "daily"
METRIC_LABELS = (
    "成交金额", "用户支付金额", "平台补贴金额", "达人补贴金额", "结算金额",
    "7日结算金额", "14日结算金额", "成交订单数", "成交件数", "件单价",
    "商品曝光人数", "商品点击人数", "商品曝光次数", "商品点击次数", "客单价",
    "成交人数", "退款金额（退款时间）", "退款金额（支付时间）", "退款率（支付时间）",
    "成交退款金额（支付时间）", "成交退款金额（退款时间）", "退款订单数（退款时间）",
    "退款订单数（支付时间）", "商品曝光-点击转化率（人数）", "商品点击-成交转化率（人数）",
    "商品曝光-成交转化率（人数）", "商品曝光-点击转化率（次数）", "商品点击-成交转化率（次数）",
    "商品曝光-成交转化率（次数）", "千次曝光用户支付金额", "支出金额",
    "投放消耗（店铺被投）", "达人佣金（财务已结算）", "平台佣金（财务已结算）", "商家体验分",
)
BREAK_LABELS = set(METRIC_LABELS) | {
    "较上期", "较上周期", "昨日", "同行基准", "同行标杆", "同行顶尖", "同行中间值",
    "数据趋势", "载体分布", "收支概况", "经营诊断", "构成", "配置", "全店效率", "效率",
}
JOIN_UNITS = {"万", "分"}


def compact_lines(text):
    return [" ".join(line.split()) for line in text.splitlines() if line.strip()]


def section_bounds(lines, start_label, end_labels):
    start = next((index + 1 for index, line in enumerate(lines) if line == start_label), 0)
    end = next((index for index in range(start, len(lines)) if lines[index] in end_labels), len(lines))
    return start, end


def join_value(lines, index, end):
    if index >= end or lines[index] in BREAK_LABELS:
        return None
    value = lines[index]
    if value == "¥":
        parts = [value]
        for token in lines[index + 1 : min(index + 7, end)]:
            if token in BREAK_LABELS or token == "-" or token.endswith("%"):
                break
            if token == "." or re.match(r"^[\d,]+$", token):
                parts.append(token)
                continue
            if token in JOIN_UNITS or re.match(r"^[\d,.]+万?$", token):
                parts.append(token)
            break
        return "".join(parts)
    if re.match(r"^[\d,]+$", value) and index + 2 < end and lines[index + 1] == ".":
        decimal = lines[index + 2]
        if re.match(r"^\d+$", decimal):
            return f"{value}.{decimal}"
    if index + 1 < end and lines[index + 1] in JOIN_UNITS:
        return f"{value}{lines[index + 1]}"
    return value


def value_after(lines, label, start=0, end=None):
    end = end or len(lines)
    for index in range(start, end):
        if lines[index] == label:
            return join_value(lines, index + 1, end)
    return None


async def collect(page, shop_name, data_range):
    for _ in range(2):
        await page.evaluate("window.scrollBy({ top: 900, behavior: 'smooth' })")
        await human_pause(2.5, 4.5)
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
    await human_pause(1.5, 3.0)

    text = await page.locator("body").inner_text(timeout=30000)
    lines = compact_lines(text)
    overview_start, overview_end = section_bounds(lines, "经营概况", {"数据趋势"})
    traffic_start, traffic_end = section_bounds(lines, "全店流量", {"收支概况", "经营诊断", "配置"})
    finance_start, finance_end = section_bounds(lines, "收支概况", {"商家体验分"})
    metrics = {}
    for label in METRIC_LABELS:
        if label in {"支出金额", "投放消耗（店铺被投）", "达人佣金（财务已结算）", "平台佣金（财务已结算）"}:
            value = value_after(lines, label, finance_start, finance_end)
        elif label == "千次曝光用户支付金额":
            value = value_after(lines, label, traffic_start, traffic_end)
        else:
            value = value_after(lines, label, overview_start, overview_end)
        if value is None:
            value = value_after(lines, label, 0, len(lines))
        if value is not None:
            metrics[label] = value
    return {
        "shop_name": shop_name,
        "data_start": data_range[0],
        "data_end": data_range[1],
        "metrics": metrics,
        "raw_text": text,
    }


def save(results, captured_at=None, output_dir=None):
    captured = captured_at or datetime.now()
    day = next((item.get("data_end") for item in results if item.get("data_end")), None)
    day_slug = (day or captured.strftime("%Y/%m/%d")).replace("/", "-")
    stamp = captured.strftime("%Y%m%d_%H%M%S")
    directory = Path(output_dir) if output_dir else OUTPUT_ROOT / day_slug
    directory.mkdir(parents=True, exist_ok=True)
    json_path = directory / f"compass_daily_{day_slug}_{stamp}.json"
    csv_path = directory / f"compass_daily_{day_slug}_{stamp}.csv"
    captured_text = captured.isoformat(timespec="seconds")
    json_path.write_text(json.dumps({
        "captured_at": captured_text,
        "source": SHOP_URL,
        "pace": {"action_delay_seconds": list(AFTER_CLICK_DELAY_RANGE), "mode": "headed browser, low-frequency clicks"},
        "results": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    with csv_path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=["captured_at", "data_start", "data_end", "shop_name", "metric", "value"])
        writer.writeheader()
        for item in results:
            for metric, value in item["metrics"].items():
                writer.writerow({"captured_at": captured_text, "data_start": item.get("data_start") or "", "data_end": item.get("data_end") or "", "shop_name": item["shop_name"], "metric": metric, "value": value})
    return json_path, csv_path
