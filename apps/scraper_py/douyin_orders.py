import argparse
import asyncio
import csv
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.scraper_py.scraper import BROWSERS_DIR, human_pause, wait_network_quiet


ORDER_LIST_URL = "https://fxg.jinritemai.com/ffa/morder/order/list"
OUTPUT_ROOT = APP_DIR / "output" / "orders"
DEFAULT_STORAGE_STATE = OUTPUT_ROOT / "playwright_storage_state.json"
TARGET_SHOPS = (
    "华硕凡飞笔记本电脑专卖店",
    "acer宏碁凡飞专卖店",
)
SHOP_NAME_KEYWORDS = ("店", "专卖店", "旗舰店")

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(BROWSERS_DIR))


def log(message):
    stamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def clean(value):
    return re.sub(r"\s+", " ", value or "").strip()


def yesterday():
    day = datetime.now().date() - timedelta(days=1)
    return day.strftime("%Y-%m-%d")


def path_slug(value):
    slug = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", value or "", flags=re.UNICODE)
    return slug.strip("._") or "unknown_shop"


def write_status(output_dir, **kwargs):
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = dict(kwargs)
    payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
    (output_dir / "task_status.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


async def click_with_pacing(locator, label, after_min=4.0, after_max=8.0):
    target = locator.first
    log(f"等待元素可见: {label}")
    await target.wait_for(state="visible", timeout=60000)
    await human_pause(2.0, 4.0)
    try:
        await target.hover()
        await human_pause(0.8, 1.6)
        await target.click(timeout=15000)
    except PlaywrightTimeoutError as exc:
        log(f"点击前遇到遮挡或超时: {label}，尝试关闭浮层后重试。原因: {exc}")
        if not await dismiss_blocking_overlays(target.page):
            raise
        await human_pause(1.0, 2.0)
        await target.hover()
        await human_pause(0.8, 1.6)
        await target.click(timeout=15000)
    log(f"已点击: {label}")
    await human_pause(after_min, after_max)


async def click_point_with_pacing(page, x, y, label, after_min=4.0, after_max=8.0):
    await human_pause(2.0, 4.0)
    await page.mouse.move(x, y, steps=14)
    await human_pause(0.8, 1.6)
    await page.mouse.click(x, y)
    log(f"已点击: {label}")
    await human_pause(after_min, after_max)


async def wait_for_manual_login(page, output_dir, timeout_minutes):
    marker_visible = False
    for marker in ("扫码登录", "打开 抖店App 扫码登录", "登录"):
        if await page.get_by_text(marker, exact=False).count():
            marker_visible = True
            break
    if "login" not in page.url.lower() and not marker_visible:
        return

    screenshot = output_dir / "login.png"
    await page.screenshot(path=str(screenshot), full_page=True)
    write_status(
        output_dir,
        state="login_required",
        message=f"检测到登录页，请在 {timeout_minutes} 分钟内扫码登录",
        login_screenshot=str(screenshot),
    )
    log(f"检测到登录页，请在 {timeout_minutes} 分钟内手动扫码登录。截图: {screenshot}")

    deadline = asyncio.get_event_loop().time() + timeout_minutes * 60
    while asyncio.get_event_loop().time() < deadline:
        for marker in ("订单管理", "下单时间", "查询"):
            try:
                await page.get_by_text(marker, exact=False).first.wait_for(
                    state="visible",
                    timeout=2000,
                )
                write_status(output_dir, state="running", message="登录完成，继续采集")
                log("登录完成，继续采集")
                await human_pause(5.0, 10.0)
                return
            except Exception:
                pass
        await asyncio.sleep(2)
    raise TimeoutError(f"登录超时：{timeout_minutes} 分钟内未完成登录")


async def dismiss_blocking_overlays(page):
    for text in ("我已知悉",):
        locator = page.get_by_text(text, exact=True)
        if not await locator.count():
            continue
        try:
            await locator.first.wait_for(state="visible", timeout=2000)
            await human_pause(0.8, 1.6)
            await locator.first.click(timeout=5000, force=True)
            log(f"已关闭浮层: {text}")
            await human_pause(1.5, 3.0)
            return True
        except Exception as exc:
            log(f"关闭浮层失败: {text}，原因: {exc}")
    return False


async def find_order_time_quick_select_index(page):
    return await page.locator("div.auxo-select").evaluate_all(
        """
        (els) => {
            const items = els.map((el, i) => {
                const rect = el.getBoundingClientRect();
                const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
                return { i, text, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
            }).filter((item) => item.w > 0 && item.h > 0);
            const label = items.find((item) => item.text === '下单时间');
            if (!label) return -1;
            const candidates = items.filter((item) =>
                (item.text === '请选择' || item.text === '昨日') &&
                item.x > label.x + 300 &&
                Math.abs(item.y - label.y) < 12 &&
                item.w <= 140
            ).sort((a, b) => b.x - a.x);
            return candidates.length ? candidates[0].i : -1;
        }
        """
    )


async def choose_yesterday(page):
    log("定位“下单时间”筛选项")
    await page.get_by_text("下单时间", exact=False).first.wait_for(
        state="visible",
        timeout=60000,
    )
    index = await find_order_time_quick_select_index(page)
    if index < 0:
        raise RuntimeError("未找到“下单时间”右侧的快捷日期下拉框")
    select_texts = await page.locator("div.auxo-select").evaluate_all(
        """
        (els) => els.map((el, i) => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
            return { i, text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
        }).filter((item) => item.w > 0 && item.h > 0)
        """
    )
    candidate = next((item for item in select_texts if item["i"] == index), None)
    log(f"下单时间快捷日期下拉框索引: {index}，候选: {candidate}")
    if candidate and candidate.get("text") == "昨日":
        log("下单时间快捷日期已是“昨日”，跳过重复选择")
        return

    await click_with_pacing(
        page.locator("div.auxo-select").nth(index),
        "下单时间快捷日期下拉框",
        after_min=2.0,
        after_max=4.0,
    )
    await click_with_pacing(
        page.locator(".auxo-select-dropdown:visible .auxo-select-item-option").filter(
            has_text="昨日",
        ),
        "昨日",
        after_min=4.0,
        after_max=7.0,
    )
    selected = await page.locator("div.auxo-select").nth(index).inner_text()
    log(f"下单时间快捷日期当前值: {clean(selected)}")


async def extract_header_shop_candidates(page, target_shop=None):
    return await page.locator("body *").evaluate_all(
        """
        (els, payload) => {
            const targetShop = payload.targetShop || '';
            const knownShops = payload.knownShops || [];
            return els.map((el) => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
            return {
                text,
                x: rect.x,
                y: rect.y,
                w: rect.width,
                h: rect.height,
                area: rect.width * rect.height,
                cursor: getComputedStyle(el).cursor,
            };
        }).filter((item) =>
            item.text &&
            item.text.length <= 90 &&
            item.y >= 0 &&
            item.y < 120 &&
            item.x > window.innerWidth * 0.45 &&
            item.w >= 80 &&
            item.w <= 520 &&
            item.h >= 16 &&
            item.h <= 80 &&
            (
                (targetShop && item.text.includes(targetShop)) ||
                knownShops.some((shop) => item.text.includes(shop)) ||
                item.text.includes('专卖店') ||
                item.text.includes('旗舰店') ||
                item.text.endsWith('店')
            )
        ).sort((a, b) => {
            const aExact = targetShop && a.text.includes(targetShop) ? 1 : 0;
            const bExact = targetShop && b.text.includes(targetShop) ? 1 : 0;
            return bExact - aExact || b.area - a.area;
        }).slice(0, 5)
        }
        """,
        {"targetShop": target_shop or "", "knownShops": list(TARGET_SHOPS)},
    )


async def current_header_shop_name(page):
    candidates = await extract_header_shop_candidates(page)
    for item in candidates:
        text = clean(item["text"])
        if any(keyword in text for keyword in SHOP_NAME_KEYWORDS):
            return text
    return ""


async def open_shop_switch_modal(page):
    if await page.get_by_text("请选择店铺", exact=True).count():
        return

    candidates = await extract_header_shop_candidates(page)
    if not candidates:
        raise RuntimeError("未找到右上角店铺名区域，无法打开切换店铺入口")
    header = candidates[0]
    log(
        "右上角店铺名候选: "
        f"text={header['text']!r}, "
        f"x={round(header['x'])}, y={round(header['y'])}, "
        f"w={round(header['w'])}, h={round(header['h'])}"
    )

    x = header["x"] + min(max(header["w"] * 0.7, 40), header["w"] - 8)
    y = header["y"] + header["h"] / 2
    await page.mouse.move(x, y, steps=14)
    log("已移动到右上角店铺名，等待店铺信息浮层")
    await human_pause(2.0, 4.0)

    switch_entry = page.get_by_text("切换组织/店铺", exact=True)
    if not await switch_entry.count():
        await click_point_with_pacing(page, x, y, "右上角店铺名", after_min=2.0, after_max=4.0)
    await click_with_pacing(
        page.get_by_text("切换组织/店铺", exact=True),
        "切换组织/店铺",
        after_min=4.0,
        after_max=7.0,
    )
    await page.get_by_text("请选择店铺", exact=True).wait_for(state="visible", timeout=60000)
    log("店铺选择弹窗已打开")


async def switch_shop(page, shop_name):
    if not shop_name or not any(keyword in shop_name for keyword in SHOP_NAME_KEYWORDS):
        raise ValueError(f"不可信的店铺名: {shop_name!r}")

    current = await current_header_shop_name(page)
    log(f"当前右上角店铺: {current or '未识别'}；目标店铺: {shop_name}")
    if current and shop_name in current:
        log(f"已在目标店铺，无需切换: {shop_name}")
        return

    await open_shop_switch_modal(page)
    await human_pause(2.0, 4.0)

    target = page.get_by_text(shop_name, exact=True)
    if not await target.count():
        raise RuntimeError(f"店铺选择弹窗中未找到目标店铺: {shop_name}")
    await click_with_pacing(target, shop_name, after_min=8.0, after_max=14.0)
    await wait_network_quiet(page, timeout=45000)
    await human_pause(4.0, 8.0)

    current = await current_header_shop_name(page)
    log(f"切换后右上角店铺: {current or '未识别'}")
    if current and shop_name not in current:
        log(f"警告: 切换后未确认目标店铺名，页面识别值为: {current}")
    await dismiss_blocking_overlays(page)


async def click_query(page):
    log("准备点击查询按钮")
    await click_with_pacing(
        page.locator("button").filter(has_text=re.compile(r"^查询$")),
        "查询",
        after_min=10.0,
        after_max=15.0,
    )
    await wait_network_quiet(page, timeout=45000)
    log("查询后网络已等待稳定")


def parse_total_count(total_text):
    match = re.search(r"共\s*(\d+)\s*条", total_text or "")
    return int(match.group(1)) if match else None


async def set_page_size(page, page_size):
    await dismiss_blocking_overlays(page)
    total_text = await extract_total_text(page)
    if total_text:
        log(f"当前结果总数提示: {total_text}")
    changer = page.locator(".auxo-pagination-options-size-changer").first
    await changer.wait_for(state="visible", timeout=60000)
    await changer.scroll_into_view_if_needed()
    current_size = clean(await changer.inner_text())
    log(f"当前每页条数: {current_size}")
    if current_size.startswith(str(page_size)):
        log(f"每页条数已是 {page_size}，跳过切换")
        return
    await click_with_pacing(changer, "每页条数", after_min=2.0, after_max=4.0)
    option = page.locator(".auxo-select-dropdown:visible .auxo-select-item-option").filter(
        has_text=f"{page_size} 条/页",
    )
    if await option.count():
        await click_with_pacing(option, f"{page_size} 条/页", after_min=10.0, after_max=15.0)
        await wait_network_quiet(page, timeout=45000)
        updated_size = clean(await changer.inner_text())
        log(f"已切换每页条数: {updated_size}")
    else:
        log(f"未找到 {page_size} 条/页选项，保持当前分页大小")


async def extract_total_text(page):
    texts = await page.locator("body *").evaluate_all(
        """
        (els) => els.map((el) => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
            return { text, w: rect.width, h: rect.height };
        }).filter((item) => item.w > 0 && item.h > 0 && /^共\\d+条/.test(item.text)).map((item) => item.text)
        """
    )
    return texts[0] if texts else ""


async def extract_table_rows(page):
    rows = await page.locator("tr").evaluate_all(
        """
        (trs) => trs.map((tr, i) => ({
            i,
            cells: Array.from(tr.querySelectorAll('td,th')).map((td) =>
                (td.innerText || td.textContent || '')
                    .split(/\\n+/)
                    .map((s) => s.trim())
                    .filter(Boolean)
            ),
            text: (tr.innerText || tr.textContent || '').trim().replace(/\\s+/g, ' '),
        })).filter((row) => row.text.includes('订单编号') || row.cells.length >= 6)
        """
    )
    header_rows = [row for row in rows if clean(row.get("text", "")).startswith("订单编号")]
    log(f"表格行数: {len(rows)}，订单头行数: {len(header_rows)}")
    if header_rows:
        log(f"首条订单头: {header_rows[0]['text']}")
        log(f"末条订单头: {header_rows[-1]['text']}")
    return rows


def first_order_no_from_rows(rows):
    for row in rows:
        text = clean(row.get("text", ""))
        match = re.search(r"订单编号\s*(\d+)", text)
        if match:
            return match.group(1)
    return ""


async def next_page_available(page):
    return await page.locator(
        ".auxo-pagination-next:not(.auxo-pagination-disabled) button"
    ).count()


async def click_next_page(page, previous_first_order_no):
    await dismiss_blocking_overlays(page)
    next_button = page.locator(
        ".auxo-pagination-next:not(.auxo-pagination-disabled) button"
    ).first
    await click_with_pacing(next_button, "下一页", after_min=8.0, after_max=14.0)
    if previous_first_order_no:
        try:
            await page.wait_for_function(
                """
                (previousFirstOrderNo) => {
                    const rows = Array.from(document.querySelectorAll('tr'));
                    const row = rows.find((tr) => (tr.innerText || tr.textContent || '').includes('订单编号'));
                    const text = row ? (row.innerText || row.textContent || '') : '';
                    return text && !text.includes(previousFirstOrderNo);
                }
                """,
                previous_first_order_no,
                timeout=45000,
            )
        except Exception:
            log("等待下一页订单变化超时，继续读取当前页面")
    await wait_network_quiet(page, timeout=45000)


async def collect_all_pages(page, expected_total=None):
    all_rows = []
    orders_by_no = {}
    page_no = 1

    while True:
        log(f"读取第 {page_no} 页订单")
        rows = await extract_table_rows(page)
        first_order_no = first_order_no_from_rows(rows)
        page_orders = parse_orders(rows)
        for row in rows:
            row["page_no"] = page_no
        all_rows.extend(rows)
        for order in page_orders:
            order["page_no"] = page_no
            if order["order_no"]:
                orders_by_no[order["order_no"]] = order

        log(
            f"第 {page_no} 页解析 {len(page_orders)} 条，"
            f"累计去重 {len(orders_by_no)} 条"
        )
        if expected_total and len(orders_by_no) >= expected_total:
            log(f"累计订单数已达到页面总数 {expected_total}，停止翻页")
            break
        if not await next_page_available(page):
            log("下一页不可用，停止翻页")
            break

        await click_next_page(page, first_order_no)
        page_no += 1
        await human_pause(5.0, 9.0)

    return all_rows, list(orders_by_no.values())


def parse_product_lines(lines):
    product_name = lines[0] if lines else ""
    sku_parts = []
    merchant_sku_code = ""
    author = ""
    item_order_id = ""
    tags = []
    for line in lines[1:]:
        line = clean(line)
        if line.startswith("商家编码:"):
            merchant_sku_code = line.split(":", 1)[1].strip()
        elif line.startswith("带货达人:"):
            author = line.split(":", 1)[1].strip()
        elif line.startswith("商品单ID:"):
            item_order_id = line.split(":", 1)[1].strip()
        elif not merchant_sku_code and not author and not item_order_id:
            sku_parts.append(line)
        else:
            tags.append(line)
    return product_name, " ".join(sku_parts), merchant_sku_code, author, item_order_id, " ".join(tags)


def parse_orders(rows):
    orders = []
    for index, row in enumerate(rows):
        header = clean(row.get("text"))
        if not header.startswith("订单编号"):
            continue
        detail = rows[index + 1] if index + 1 < len(rows) else {"cells": [], "text": ""}
        cells = detail.get("cells") or []
        match = re.search(r"订单编号\s*(\d+)\s*下单时间\s*([0-9-]+\s+[0-9:]+)\s*(.*)$", header)
        product_name, sku_spec, merchant_sku_code, author, item_order_id, product_tags = parse_product_lines(
            cells[1] if len(cells) > 1 else []
        )
        receiver = cells[6] if len(cells) > 6 else []
        orders.append(
            {
                "order_no": match.group(1) if match else "",
                "order_time": match.group(2) if match else "",
                "header_extra": clean(match.group(3) if match else ""),
                "product_name": product_name,
                "sku_spec": sku_spec,
                "merchant_sku_code": merchant_sku_code,
                "author": author,
                "item_order_id": item_order_id,
                "product_tags": product_tags,
                "price_quantity": clean(" ".join(cells[2])) if len(cells) > 2 else "",
                "aftersale_status": clean(" ".join(cells[3])) if len(cells) > 3 else "",
                "order_status": clean(" ".join(cells[4])) if len(cells) > 4 else "",
                "merchant_income": clean(" ".join(cells[5])) if len(cells) > 5 else "",
                "receiver_name": clean(receiver[0]) if len(receiver) > 0 else "",
                "receiver_phone": clean(receiver[1]) if len(receiver) > 1 else "",
                "receiver_address": clean(" ".join(receiver[2:])) if len(receiver) > 2 else "",
                "operations": clean(" ".join(cells[7])) if len(cells) > 7 else "",
                "raw_header": header,
                "raw_product": clean(detail.get("text")),
            }
        )
    log(f"结构化解析订单数: {len(orders)}")
    return orders


def save_results(output_dir, data_date, shop_name, rows, body_text, orders):
    captured_at = datetime.now().isoformat(timespec="seconds")
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"douyin_orders_{data_date}.json"
    csv_path = output_dir / f"douyin_orders_{data_date}.csv"
    rows_path = output_dir / f"douyin_orders_{data_date}_table_rows.json"
    text_path = output_dir / f"douyin_orders_{data_date}_visible_text.txt"

    rows_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    text_path.write_text(body_text, encoding="utf-8")
    json_path.write_text(
        json.dumps(
            {
                "captured_at": captured_at,
                "source": ORDER_LIST_URL,
                "shop_name": shop_name,
                "date_filter": {"label": "昨日", "date": data_date},
                "orders_count": len(orders),
                "orders": orders,
                "raw_rows_file": str(rows_path),
                "visible_text_file": str(text_path),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    fields = [
        "order_no",
        "order_time",
        "header_extra",
        "product_name",
        "sku_spec",
        "merchant_sku_code",
        "author",
        "item_order_id",
        "product_tags",
        "price_quantity",
        "aftersale_status",
        "order_status",
        "merchant_income",
        "receiver_name",
        "receiver_phone",
        "receiver_address",
        "operations",
    ]
    with csv_path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows({field: order.get(field, "") for field in fields} for order in orders)
    log(f"已写入 JSON: {json_path}")
    log(f"已写入 CSV: {csv_path}")
    log(f"已写入原始表格行: {rows_path}")
    log(f"已写入页面文本: {text_path}")
    return json_path, csv_path, rows_path, text_path


async def collect_shop(page, data_date, base_output_dir, shop_name, page_size):
    shop_output_dir = base_output_dir / path_slug(shop_name)
    write_status(shop_output_dir, state="running", message=f"开始采集 {shop_name} 昨日订单")
    log(f"========== 开始采集店铺: {shop_name} ==========")
    await switch_shop(page, shop_name)
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
    await human_pause(1.5, 3.0)
    await choose_yesterday(page)
    await click_query(page)
    total_text = await extract_total_text(page)
    expected_total = parse_total_count(total_text)
    log(f"解析到页面总数: {expected_total if expected_total is not None else '未知'}")
    await set_page_size(page, page_size)
    rows, orders = await collect_all_pages(page, expected_total)
    if orders:
        log(f"首条结构化订单: {orders[0]['order_no']} {orders[0]['order_time']}")
        log(f"末条结构化订单: {orders[-1]['order_no']} {orders[-1]['order_time']}")
    body_text = await page.locator("body").inner_text(timeout=30000)
    paths = save_results(shop_output_dir, data_date, shop_name, rows, body_text, orders)
    write_status(
        shop_output_dir,
        state="completed",
        message=f"{shop_name} 昨日订单采集完成",
        visible_orders=len(orders),
        json=str(paths[0]),
        csv=str(paths[1]),
    )
    log(f"========== 完成店铺: {shop_name}，订单数: {len(orders)} ==========")
    await human_pause(5.0, 9.0)
    return {
        "shop_name": shop_name,
        "orders_count": len(orders),
        "json": str(paths[0]),
        "csv": str(paths[1]),
        "rows": str(paths[2]),
        "text": str(paths[3]),
    }


async def run(args):
    data_date = args.date or yesterday()
    output_dir = Path(args.output_dir) if args.output_dir else OUTPUT_ROOT / data_date
    shops = args.shop or list(TARGET_SHOPS)
    log(f"数据日期: {data_date}")
    log(f"输出目录: {output_dir}")
    log(f"目标店铺: {shops}")
    write_status(output_dir, state="running", message="开始采集昨日订单", shops=shops)

    storage_state = Path(args.storage_state) if args.storage_state else DEFAULT_STORAGE_STATE
    log(f"登录态文件: {storage_state}，存在: {storage_state.exists()}")
    async with async_playwright() as playwright:
        browser_options = {
            "headless": args.headless,
            "slow_mo": args.slow_mo,
        }
        chromium_path = os.getenv("CHROMIUM_EXECUTABLE_PATH")
        if chromium_path:
            browser_options["executable_path"] = chromium_path
        log(
            "启动浏览器: "
            f"headless={args.headless}, slow_mo={args.slow_mo}, "
            f"executable_path={browser_options.get('executable_path', 'playwright-default')}"
        )
        browser = await playwright.chromium.launch(**browser_options)
        context_options = {"viewport": {"width": 1440, "height": 1000}}
        if storage_state.exists():
            context_options["storage_state"] = str(storage_state)
            log("将使用已保存的 storage_state")
        else:
            log("未找到 storage_state，可能需要人工扫码登录")
        context = await browser.new_context(**context_options)
        context.set_default_timeout(60000)
        page = await context.new_page()

        log("打开抖店订单管理页...")
        await page.goto(ORDER_LIST_URL, wait_until="domcontentloaded", timeout=90000)
        log(f"页面标题: {await page.title()}")
        log(f"当前 URL: {page.url}")
        await wait_network_quiet(page, timeout=45000)
        log("初始页面网络已等待稳定")
        await human_pause(5.0, 10.0)
        await wait_for_manual_login(page, output_dir, args.login_timeout_minutes)

        if "order/list" not in page.url:
            log(f"当前不在订单列表页，重新跳转: {page.url}")
            await page.goto(ORDER_LIST_URL, wait_until="domcontentloaded", timeout=90000)
            await wait_network_quiet(page, timeout=45000)
            await human_pause(5.0, 10.0)
        log(f"业务页面确认: title={await page.title()} url={page.url}")

        results = []
        for shop_name in shops:
            results.append(await collect_shop(page, data_date, output_dir, shop_name, args.page_size))

        await context.storage_state(path=str(storage_state))
        log(f"已刷新登录态文件: {storage_state}")
        await context.close()
        await browser.close()

    write_status(
        output_dir,
        state="completed",
        message="昨日订单采集完成",
        shops=results,
        total_orders=sum(item["orders_count"] for item in results),
    )
    return results


def parse_args():
    parser = argparse.ArgumentParser(description="低频抓取抖店订单管理页“昨日”订单")
    parser.add_argument("--date", help="数据日期，默认当前日期前一天；用于输出目录和文件名")
    parser.add_argument("--output-dir", help="输出目录，默认 output/orders/<数据日期>/")
    parser.add_argument("--shop", action="append", help="指定店铺名，可重复传入；默认采集两家目标店铺")
    parser.add_argument("--page-size", type=int, default=100, help="每页订单数，默认 100 以减少翻页点击")
    parser.add_argument("--storage-state", help=f"登录态 JSON，默认 {DEFAULT_STORAGE_STATE}")
    parser.add_argument("--login-timeout-minutes", type=int, default=10)
    parser.add_argument("--slow-mo", type=int, default=700)
    parser.add_argument("--headless", action="store_true")
    return parser.parse_args()


def main():
    results = asyncio.run(run(parse_args()))
    log("完成。")
    for item in results:
        log(f"{item['shop_name']} 订单数: {item['orders_count']}")
        log(f"JSON: {item['json']}")
        log(f"CSV:  {item['csv']}")
        log(f"ROWS: {item['rows']}")
        log(f"TEXT: {item['text']}")


if __name__ == "__main__":
    main()
