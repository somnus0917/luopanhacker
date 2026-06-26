import argparse
import asyncio
import csv
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright

from scraper import (
    AFTER_CLICK_DELAY_RANGE,
    BROWSERS_DIR,
    SESSION_DIR,
    SHOP_URL,
    TARGET_SHOPS,
    click_with_pacing,
    human_pause,
    switch_shop,
    wait_network_quiet,
)
from task_status import LOGIN_SCREENSHOT, write_status


OUTPUT_ROOT = Path(__file__).parent / "output" / "daily"
METRIC_LABELS = (
    "成交金额",
    "用户支付金额",
    "平台补贴金额",
    "达人补贴金额",
    "结算金额",
    "7日结算金额",
    "14日结算金额",
    "成交订单数",
    "成交件数",
    "件单价",
    "商品曝光人数",
    "商品点击人数",
    "商品曝光次数",
    "商品点击次数",
    "客单价",
    "成交人数",
    "退款金额（退款时间）",
    "退款金额（支付时间）",
    "退款率（支付时间）",
    "成交退款金额（支付时间）",
    "成交退款金额（退款时间）",
    "退款订单数（退款时间）",
    "退款订单数（支付时间）",
    "商品曝光-点击转化率（人数）",
    "商品点击-成交转化率（人数）",
    "商品曝光-成交转化率（人数）",
    "商品曝光-点击转化率（次数）",
    "商品点击-成交转化率（次数）",
    "商品曝光-成交转化率（次数）",
    "千次曝光用户支付金额",
    "支出金额",
    "投放消耗（店铺被投）",
    "达人佣金（财务已结算）",
    "平台佣金（财务已结算）",
    "商家体验分",
)
BREAK_LABELS = set(METRIC_LABELS) | {
    "较上期",
    "较上周期",
    "昨日",
    "同行基准",
    "同行标杆",
    "同行顶尖",
    "同行中间值",
    "数据趋势",
    "载体分布",
    "收支概况",
    "经营诊断",
    "构成",
    "配置",
    "全店效率",
    "效率",
}
JOIN_UNITS = {"万", "分"}


def compact_lines(text):
    return [" ".join(line.split()) for line in text.splitlines() if line.strip()]


def section_bounds(lines, start_label, end_labels):
    start = 0
    for index, line in enumerate(lines):
        if line == start_label:
            start = index + 1
            break

    end = len(lines)
    for index in range(start, len(lines)):
        if lines[index] in end_labels:
            end = index
            break
    return start, end


def join_value(lines, index, end):
    if index >= end:
        return None

    value = lines[index]
    if value in BREAK_LABELS:
        return None

    if value == "¥":
        parts = [value]
        cursor = index + 1
        while cursor < min(index + 7, end):
            token = lines[cursor]
            if token in BREAK_LABELS or token == "-" or token.endswith("%"):
                break
            if token == "." or re.match(r"^[\d,]+$", token):
                parts.append(token)
                cursor += 1
                continue
            if token in JOIN_UNITS:
                parts.append(token)
                break
            if re.match(r"^[\d,.]+万?$", token):
                parts.append(token)
                break
            break
        return "".join(parts)

    if re.match(r"^[\d,]+$", value) and index + 2 < end and lines[index + 1] == ".":
        decimal = lines[index + 2]
        if re.match(r"^\d+$", decimal):
            return f"{value}.{decimal}"

    if re.match(r"^[\d,.]+$", value) and index + 1 < end and lines[index + 1] in JOIN_UNITS:
        return f"{value}{lines[index + 1]}"

    if index + 1 < end and lines[index + 1] in JOIN_UNITS:
        return f"{value}{lines[index + 1]}"

    return value


def value_after(lines, label, start=0, end=None):
    end = end or len(lines)
    for index in range(start, end):
        if lines[index] == label:
            return join_value(lines, index + 1, end)
    return None


def date_range_from_url(url):
    query = parse_qs(urlparse(url).query)
    return date_range_from_fields(query)


def date_range_from_fields(fields):
    if str(fields.get("date_type", [None])[0]) != "20":
        return None

    begin_date = str(fields.get("begin_date", [""])[0]).split()[0]
    end_date = str(fields.get("end_date", [""])[0]).split()[0]
    if not begin_date or not end_date:
        return None

    try:
        start = datetime.strptime(begin_date.replace("/", "-"), "%Y-%m-%d").strftime("%Y/%m/%d")
        end = datetime.strptime(end_date.replace("/", "-"), "%Y-%m-%d").strftime("%Y/%m/%d")
    except ValueError:
        return None
    return start, end


def date_range_from_post_data(post_data):
    if not post_data:
        return None
    try:
        payload = json.loads(post_data)
    except json.JSONDecodeError:
        return date_range_from_fields(parse_qs(post_data))

    pending = [payload]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            date_range = date_range_from_fields(
                {key: [item] for key, item in value.items()}
            )
            if date_range:
                return date_range
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return None


async def wait_for_manual_login(page, timeout_minutes):
    login_markers = (
        "扫码登录",
        "打开 抖店App 扫码登录",
        "商家入口",
    )

    marker_visible = False
    for marker in login_markers:
        if await page.get_by_text(marker, exact=False).count():
            marker_visible = True
            break

    if "login" not in page.url.lower() and not marker_visible:
        return

    LOGIN_SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    await page.screenshot(path=str(LOGIN_SCREENSHOT), full_page=True)

    write_status(
        state="login_required",
        message=f"检测到登录页，请在 {timeout_minutes} 分钟内扫码登录",
        login_screenshot=str(LOGIN_SCREENSHOT),
    )

    print(f"检测到登录页，请在 {timeout_minutes} 分钟内手动完成登录。")

    # 等待登录完成：检查明确的可见业务元素
    business_markers = ("近1天", "经营概况")
    deadline = asyncio.get_event_loop().time() + timeout_minutes * 60
    screenshot_interval = 30  # 每 30 秒刷新一次截图
    last_screenshot_time = asyncio.get_event_loop().time()

    while asyncio.get_event_loop().time() < deadline:
        # 检查是否出现可见的业务页面元素
        for marker in business_markers:
            try:
                locator = page.get_by_text(marker, exact=False).first
                await locator.wait_for(state="visible", timeout=2000)
                write_status(
                    state="running",
                    message="登录完成，继续采集",
                )
                await human_pause(6.0, 12.0)
                return
            except Exception:
                continue

        # 定期刷新截图
        now = asyncio.get_event_loop().time()
        if now - last_screenshot_time >= screenshot_interval:
            try:
                await page.screenshot(path=str(LOGIN_SCREENSHOT), full_page=True)
                last_screenshot_time = now
            except Exception:
                pass

        await asyncio.sleep(2)

    # 超时
    raise TimeoutError(f"登录超时：{timeout_minutes} 分钟内未完成登录")


async def choose_near_day(page):
    date_ranges = set()
    core_urls = set()

    def capture_date_range(response):
        if response.status != 200 or "core_index_v3" not in response.url:
            return
        core_urls.add(response.url)
        date_range = date_range_from_url(response.url)
        if not date_range:
            date_range = date_range_from_post_data(response.request.post_data)
        if date_range:
            date_ranges.add(date_range)

    page.on("response", capture_date_range)
    try:
        await click_with_pacing(page.get_by_text("近1天", exact=True), "近1天")
        await wait_network_quiet(page, timeout=45000)
        await human_pause(8.0, 14.0)
    finally:
        page.remove_listener("response", capture_date_range)

    if len(date_ranges) != 1:
        raise RuntimeError(
            "未能确认“近1天”的实际数据日期: "
            f"{sorted(date_ranges)!r}; 接口: {sorted(core_urls)!r}"
        )
    date_range = date_ranges.pop()
    print(f"近1天实际数据日期: {date_range[0]} 至 {date_range[1]}")
    return date_range


async def load_lazy_metric_sections(page):
    for _ in range(2):
        await page.evaluate("window.scrollBy({ top: 900, behavior: 'smooth' })")
        await human_pause(2.5, 4.5)
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
    await human_pause(1.5, 3.0)


async def extract_visible_summary(page, shop_name, data_range):
    await load_lazy_metric_sections(page)
    text = await page.locator("body").inner_text(timeout=30000)
    lines = compact_lines(text)
    overview_start, overview_end = section_bounds(lines, "经营概况", {"数据趋势"})
    traffic_start, traffic_end = section_bounds(lines, "全店流量", {"收支概况", "经营诊断", "配置"})
    finance_start, finance_end = section_bounds(lines, "收支概况", {"商家体验分"})
    score_start, score_end = section_bounds(lines, "商家体验分", {"经营诊断"})
    data_start, data_end = data_range

    metrics = {}
    for label in METRIC_LABELS:
        if label in {"支出金额", "投放消耗（店铺被投）", "达人佣金（财务已结算）", "平台佣金（财务已结算）"}:
            value = value_after(lines, label, finance_start, finance_end)
        elif label == "商家体验分":
            value = value_after(lines, label, 0, len(lines))
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
        "data_start": data_start,
        "data_end": data_end,
        "metrics": metrics,
        "raw_text": text,
    }


async def collect_shop(page, shop_name):
    print(f"\n准备切换店铺: {shop_name}")
    await switch_shop(page, shop_name)
    data_range = await choose_near_day(page)
    summary = await extract_visible_summary(page, shop_name, data_range)
    print(f"{shop_name} 近1天数据已读取，指标数: {len(summary['metrics'])}")
    await human_pause(8.0, 14.0)
    return summary


def output_paths(results, output_dir=None):
    captured_at = datetime.now()
    day = next((item.get("data_end") for item in results if item.get("data_end")), None)
    day_slug = (day or captured_at.strftime("%Y/%m/%d")).replace("/", "-")
    stamp = captured_at.strftime("%Y%m%d_%H%M%S")
    directory = Path(output_dir) if output_dir else OUTPUT_ROOT / day_slug
    directory.mkdir(parents=True, exist_ok=True)
    return (
        directory / f"compass_daily_{day_slug}_{stamp}.json",
        directory / f"compass_daily_{day_slug}_{stamp}.csv",
        captured_at.isoformat(timespec="seconds"),
    )


def save_results(results, output_dir=None):
    json_path, csv_path, captured_at = output_paths(results, output_dir)
    payload = {
        "captured_at": captured_at,
        "source": SHOP_URL,
        "pace": {
            "action_delay_seconds": list(AFTER_CLICK_DELAY_RANGE),
            "mode": "headed browser, manual login, low-frequency clicks",
        },
        "results": results,
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    with csv_path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=["captured_at", "data_start", "data_end", "shop_name", "metric", "value"],
        )
        writer.writeheader()
        for item in results:
            for metric, value in item["metrics"].items():
                writer.writerow(
                    {
                        "captured_at": captured_at,
                        "data_start": item.get("data_start") or "",
                        "data_end": item.get("data_end") or "",
                        "shop_name": item["shop_name"],
                        "metric": metric,
                        "value": value,
                    }
                )
    return json_path, csv_path


async def run(args):
    shops = args.shop or list(TARGET_SHOPS)
    results = []

    async with async_playwright() as playwright:
        browser_options = {
            "user_data_dir": str(SESSION_DIR),
            "headless": False,
            "slow_mo": args.slow_mo,
            "viewport": {"width": 1440, "height": 1000},
        }
        chromium_path = os.getenv("CHROMIUM_EXECUTABLE_PATH")
        if chromium_path:
            browser_options["executable_path"] = chromium_path
        context = await playwright.chromium.launch_persistent_context(**browser_options)
        context.set_default_timeout(60000)
        page = context.pages[0] if context.pages else await context.new_page()

        print("打开抖音电商罗盘店铺页...")
        await page.goto(SHOP_URL, wait_until="domcontentloaded", timeout=90000)
        await wait_network_quiet(page, timeout=45000)
        await human_pause(5.0, 10.0)
        await wait_for_manual_login(page, args.login_timeout_minutes)

        if "shop" not in page.url:
            await page.goto(SHOP_URL, wait_until="domcontentloaded", timeout=90000)
            await wait_network_quiet(page, timeout=45000)
            await human_pause(5.0, 10.0)

        for shop_name in shops:
            results.append(await collect_shop(page, shop_name))

        if args.keep_open:
            print("保留浏览器窗口 60 秒，方便人工检查。")
            await asyncio.sleep(60)

        await context.close()

    return results


def parse_args():
    parser = argparse.ArgumentParser(description="低频抓取抖音电商罗盘两家店铺的近1天可见数据")
    parser.add_argument("--shop", action="append", help="指定店铺名，可重复传入；默认抓取两家目标店铺")
    parser.add_argument("--output-dir", help="指定输出目录；默认写入 luopan_demo/output/daily/<日期>/")
    parser.add_argument("--login-timeout-minutes", type=int, default=10, help="等待人工扫码登录的分钟数")
    parser.add_argument("--slow-mo", type=int, default=700, help="Playwright 每个动作的基础慢速毫秒数")
    parser.add_argument("--keep-open", action="store_true", help="抓取后保留浏览器 60 秒用于人工检查")
    return parser.parse_args()


def main():
    args = parse_args()
    results = asyncio.run(run(args))
    json_path, csv_path = save_results(results, args.output_dir)
    print("\n完成。")
    print(f"JSON: {json_path}")
    print(f"CSV:  {csv_path}")
    print("Dashboard: ./run_dashboard.sh")


if __name__ == "__main__":
    main()
