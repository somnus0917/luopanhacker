import asyncio
import json
import os
import random
from pathlib import Path


HOME_URL = "https://compass.jinritemai.com/"
OVERVIEW_URL = "https://compass.jinritemai.com/overview"
SHOP_URL = "https://compass.jinritemai.com/shop"
SESSION_DIR = Path(__file__).parent / "session"
BROWSERS_DIR = Path(__file__).parent / ".playwright-browsers"
TARGET_SHOPS = (
    "华硕凡飞笔记本电脑专卖店",
    "acer宏碁凡飞专卖店",
)
IGNORE_URL_PARTS = (
    "mon.zijieapi.com",
    "mcs.zijieapi.com",
    "log",
    "collect",
    "slardar",
    "tea",
    "applog",
    "captcha",
)
BUSINESS_URL_PARTS = (
    "compass",
    "ecom",
    "jinritemai",
    "douyin",
    "shop",
    "data",
    "metric",
    "overview",
    "dashboard",
    "trade",
    "order",
    "gmv",
    "flow",
    "visitor",
)
CORE_NEAR_DAY_URL_PARTS = (
    "core_index_v3",
    "core_trend_v3",
    "content_detail_v3",
)
VIEW_SWITCH_TEXTS = (
    "切换数据视角",
    "切换组织/店铺",
)
SHOP_NAME_KEYWORDS = ("店", "专卖店", "旗舰店")
ACTION_DELAY_RANGE = (2.5, 6.5)
AFTER_CLICK_DELAY_RANGE = (5.0, 10.0)
CAPTURE_TIMEOUT_SECONDS = 70

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(BROWSERS_DIR))

from playwright.async_api import async_playwright


async def human_pause(min_seconds=None, max_seconds=None):
    low, high = min_seconds or ACTION_DELAY_RANGE[0], max_seconds or ACTION_DELAY_RANGE[1]
    await asyncio.sleep(random.uniform(low, high))


async def wait_network_quiet(page, timeout=30000):
    try:
        await page.wait_for_load_state("networkidle", timeout=timeout)
    except Exception:
        pass


async def click_with_pacing(locator, label):
    target = locator.first
    await target.wait_for(state="visible", timeout=30000)
    await human_pause()
    await target.hover()
    await human_pause(0.5, 1.4)
    await target.click(timeout=10000)
    print(f"已点击: {label}")
    await human_pause(*AFTER_CLICK_DELAY_RANGE)


async def wait_shop_modal(page, timeout=15000):
    modal = page.locator('[role="dialog"]').filter(
        has=page.get_by_text("请选择店铺", exact=True)
    )
    try:
        await modal.first.wait_for(state="visible", timeout=timeout)
        return True
    except Exception:
        return False


async def click_point_with_pacing(page, x, y, label):
    await human_pause()
    await page.mouse.move(x, y, steps=random.randint(8, 18))
    await human_pause(0.5, 1.4)
    await page.mouse.click(x, y)
    print(f"已点击: {label}")
    await human_pause(*AFTER_CLICK_DELAY_RANGE)


async def click_header_shop(page, shop_name):
    if not shop_name or not any(keyword in shop_name for keyword in SHOP_NAME_KEYWORDS):
        print(f"跳过不可信的店铺名候选: {shop_name!r}")
        return False

    candidates = await page.locator("body *").evaluate_all(
        """
        (els, shopName) => els
            .map((el) => {
                const rect = el.getBoundingClientRect();
                const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
                return {
                    kind: 'shop_text',
                    text,
                    x: rect.x,
                    y: rect.y,
                    w: rect.width,
                    h: rect.height,
                    area: rect.width * rect.height,
                };
            })
            .filter((item) =>
                (item.text === shopName || item.text.includes(shopName)) &&
                item.y >= 0 &&
                item.y < 90 &&
                item.x > window.innerWidth * 0.45 &&
                item.w >= 80 &&
                item.h >= 16 &&
                item.w <= 520
            )
            .sort((a, b) => b.area - a.area)
            .slice(0, 3)
        """,
        shop_name,
    )

    if not candidates:
        print(f"未找到顶部店铺名区域: {shop_name}")
        return False

    for box in candidates:
        print(
            "顶部店铺候选:",
            {
                "text": box["text"],
                "x": round(box["x"]),
                "y": round(box["y"]),
                "w": round(box["w"]),
                "h": round(box["h"]),
            },
        )
        x = box["x"] + min(max(box["w"] * 0.7, 32), box["w"] - 8)
        y = box["y"] + box["h"] / 2
        await click_point_with_pacing(page, x, y, f"顶部店铺名 {shop_name}")
        if await wait_shop_modal(page, timeout=3000):
            return True
        if await visible_view_switch_entry(page):
            return True

    return False


async def extract_shop_name(page):
    try:
        text = await page.locator("body").inner_text(timeout=5000)
    except Exception:
        return None

    lines = [" ".join(line.split()) for line in text.splitlines()]
    lines = [line for line in lines if line]

    for shop_name in TARGET_SHOPS:
        if shop_name in text:
            return shop_name

    for line in lines:
        if "7日店铺排行" in line:
            name = line.split("7日店铺排行", 1)[0].strip()
            if name and any(keyword in name for keyword in SHOP_NAME_KEYWORDS):
                return name

    skip_words = (
        "首页",
        "交易",
        "直播",
        "短视频",
        "商品卡",
        "搜索",
        "达人",
        "商品",
        "营销",
        "体验",
        "人群",
        "市场",
        "数据工厂",
        "返回旧版",
    )
    for line in lines[:30]:
        if line in skip_words:
            continue
        if any(keyword in line for keyword in SHOP_NAME_KEYWORDS):
            if "抖音电商" not in line and "罗盘" not in line:
                return line
    return None


async def ensure_shop_modal(page):
    if await wait_shop_modal(page, timeout=1000):
        return

    async def click_visible_switch_entry():
        for text in VIEW_SWITCH_TEXTS:
            switch_entry = page.get_by_text(text, exact=False)
            if await switch_entry.count():
                await click_with_pacing(switch_entry, text)
                if await wait_shop_modal(page):
                    return True
        return False

    if await click_visible_switch_entry():
        return

    current_shop = await extract_shop_name(page)
    if current_shop:
        clicked = await click_header_shop(page, current_shop)
        if clicked and await click_visible_switch_entry():
            return
        if await wait_shop_modal(page, timeout=5000):
            return

    raise RuntimeError("未找到店铺切换入口，请确认“切换数据视角”入口可见")


async def visible_view_switch_entry(page):
    for text in VIEW_SWITCH_TEXTS:
        switch_entry = page.get_by_text(text, exact=False)
        if await switch_entry.count():
            try:
                await switch_entry.first.wait_for(state="visible", timeout=1000)
                return True
            except Exception:
                pass
    return False


async def switch_shop(page, shop_name):
    await ensure_shop_modal(page)
    modal = page.locator('[role="dialog"]').filter(
        has=page.get_by_text("请选择店铺", exact=True)
    ).first
    await modal.wait_for(state="visible", timeout=30000)
    await human_pause(2.0, 4.0)

    target = modal.get_by_text(shop_name, exact=True)
    if await target.count() != 1:
        raise RuntimeError(f"弹窗中未唯一匹配目标店铺: {shop_name}")

    await click_with_pacing(target, shop_name)
    await page.wait_for_load_state("domcontentloaded", timeout=30000)
    await wait_network_quiet(page)
    await human_pause(3.0, 6.0)
    print(f"已切换店铺: {shop_name}")


def has_near_day_core_urls(items):
    near_day_urls = [item["url"] for item in items if "date_type=20" in item["url"]]
    return all(any(part in url for url in near_day_urls) for part in CORE_NEAR_DAY_URL_PARTS)


async def wait_for_near_day_capture(items):
    deadline = asyncio.get_running_loop().time() + CAPTURE_TIMEOUT_SECONDS
    while asyncio.get_running_loop().time() < deadline:
        if has_near_day_core_urls(items):
            return True
        await human_pause(2.0, 4.0)
    return False


async def capture_near_day(page, state):
    state["items"] = []
    state["seen_urls"] = set()
    state["enabled"] = True

    await click_with_pacing(page.get_by_text("近1天", exact=True), "近1天")
    if await wait_for_near_day_capture(state["items"]):
        state["enabled"] = False
        return

    print("近1天未触发完整核心接口，低频重试一次...")
    state["enabled"] = False
    await human_pause(4.0, 7.0)
    await click_with_pacing(page.get_by_text("实时", exact=True), "实时")
    await human_pause(4.0, 7.0)

    state["items"] = []
    state["seen_urls"] = set()
    state["enabled"] = True
    await click_with_pacing(page.get_by_text("近1天", exact=True), "近1天")
    await wait_for_near_day_capture(state["items"])
    state["enabled"] = False


async def scrape_once(target_shops=None):
    captured = []
    target_shops = target_shops or TARGET_SHOPS
    state = {
        "enabled": False,
        "items": [],
        "seen_urls": set(),
        "shop_id": None,
        "shop_name": None,
    }

    async with async_playwright() as p:
        browser_options = {
            "user_data_dir": str(SESSION_DIR),
            "headless": False,
            "slow_mo": random.randint(250, 650),
        }
        chromium_path = os.getenv("CHROMIUM_EXECUTABLE_PATH")
        if chromium_path:
            browser_options["executable_path"] = chromium_path
        context = await p.chromium.launch_persistent_context(**browser_options)
        context.set_default_timeout(45000)
        page = context.pages[0] if context.pages else await context.new_page()

        async def handle_response(response):
            url = response.url
            headers = response.headers
            content_type = headers.get("content-type", "")

            if response.status != 200:
                return
            if "json" not in content_type.lower():
                return
            if any(part in url.lower() for part in IGNORE_URL_PARTS):
                return
            if not any(part in url.lower() for part in BUSINESS_URL_PARTS):
                return
            if url in state["seen_urls"]:
                return
            if not state["enabled"] and "/business_api/home/unify_track" not in url:
                return

            body = None
            try:
                body = await response.json()
                body_text = json.dumps(body, ensure_ascii=False)
            except Exception:
                try:
                    body_text = await response.text()
                except Exception as exc:
                    print(f"\n跳过响应 body 读取失败: {url}")
                    print(f"原因: {exc}")
                    return

            if "/business_api/home/unify_track" in url:
                data = body.get("data", {}) if isinstance(body, dict) else {}
                state["shop_id"] = str(data.get("shop_id") or "") or state["shop_id"]

            if not state["enabled"]:
                return

            state["seen_urls"].add(url)

            body_preview = body_text[:500]
            print(f"\nURL: {url}")
            print(f"BODY: {body_preview}")
            state["items"].append(
                {
                    "url": url,
                    "body_preview": body_preview,
                    "body": body_text,
                    "shop_id": state["shop_id"],
                    "shop_name": state["shop_name"],
                }
            )

        context.on("response", handle_response)

        await page.goto(HOME_URL, wait_until="domcontentloaded")
        await wait_network_quiet(page)
        await human_pause(2.0, 4.5)

        login_button = page.get_by_role("button", name="登录")
        if await login_button.count():
            await click_with_pacing(login_button, "登录")
            async with context.expect_page() as page_info:
                await click_with_pacing(page.get_by_role("link", name="商家入口"), "商家入口")
            page = await page_info.value
            await page.wait_for_load_state("domcontentloaded", timeout=30000)
            await human_pause(2.0, 4.5)

        if "login" in page.url.lower():
            print("检测到登录页，请在 120 秒内手动扫码登录...")
            await page.wait_for_url(lambda url: "login" not in url.lower(), timeout=120000)
            await human_pause(2.0, 5.0)

        if page.url.rstrip("/") == HOME_URL.rstrip("/"):
            await human_pause()
            await page.goto(SHOP_URL, wait_until="domcontentloaded")

        await wait_network_quiet(page)
        await human_pause(2.5, 5.0)
        print(f"当前页面: {await page.title()}")
        print(f"当前 URL: {page.url}")

        for shop_name in target_shops:
            state["shop_id"] = None
            state["shop_name"] = shop_name
            await switch_shop(page, shop_name)
            await capture_near_day(page, state)
            captured.extend(state["items"])
            print(f"{shop_name} 已捕获 {len(state['items'])} 条")
            await human_pause(5.0, 9.0)

        await context.close()

    return captured
