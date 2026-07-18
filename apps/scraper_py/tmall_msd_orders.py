import argparse
import asyncio
import csv
import json
import os
import random
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.scraper_py.scraper import BROWSERS_DIR, human_pause, wait_network_quiet  # noqa: E402


ORDER_PAGE_URL = (
    "https://msd.tmall.com/web_scm_tmall_com/pages/csklzy/"
    "fulfillment_order_manage_config?locale=zh_CN"
)
DETAIL_URL = "https://order.cbbs.tmall.com/portal/v1/order/detail"
ITEMS_DETAIL_URL = "https://order.cbbs.tmall.com/portal/v1/order/items/detail"
ORDER_LIST_API_URL = "https://order.cbbs.tmall.com/portal/v1/order/orders"

OUTPUT_ROOT = APP_DIR / "output" / "orders"
SESSION_DIR = APP_DIR / "session" / "tmall_msd_orders"

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(BROWSERS_DIR))


def log(message):
    stamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_money(value):
    if value in (None, ""):
        return ""
    if isinstance(value, (int, float)):
        return round(value / 100, 2)
    text = clean(value)
    if not text:
        return ""
    if re.fullmatch(r"-?\d+", text):
        return round(int(text) / 100, 2)
    return text


def yesterday():
    return (datetime.now().date() - timedelta(days=1)).strftime("%Y-%m-%d")


def parse_day_range(day):
    start = datetime.strptime(day, "%Y-%m-%d")
    end = start + timedelta(days=1)
    return (
        start.strftime("%Y-%m-%d 00:00:00"),
        end.strftime("%Y-%m-%d 00:00:00"),
    )


def write_status(output_dir, **kwargs):
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = dict(kwargs)
    payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
    (output_dir / "tmall_msd_status.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


async def paced_click(locator, label, after_min=1.5, after_max=3.5, timeout=30000):
    target = locator.first
    await target.wait_for(state="visible", timeout=timeout)
    await human_pause(0.5, 1.2)
    try:
        await target.scroll_into_view_if_needed(timeout=5000)
    except Exception:
        pass
    try:
        await target.hover(timeout=5000)
        await human_pause(0.2, 0.7)
        await target.click(timeout=timeout)
    except PlaywrightTimeoutError:
        log(f"{label} 常规点击超时，尝试 force 点击")
        await target.click(timeout=timeout, force=True)
    log(f"已点击: {label}")
    await human_pause(after_min, after_max)


async def dismiss_overlays(root):
    for text in ("我已知悉", "知道了", "关闭"):
        locator = root.get_by_text(text, exact=True)
        if not await locator.count():
            continue
        try:
            await locator.first.click(timeout=1500, force=True)
            log(f"已关闭浮层: {text}")
            await human_pause(0.8, 1.8)
            return True
        except Exception:
            pass
    return False


async def find_business_frame(page):
    await page.wait_for_load_state("domcontentloaded", timeout=90000)
    deadline = asyncio.get_event_loop().time() + 90
    last_frame_urls = []
    while asyncio.get_event_loop().time() < deadline:
        for frame in page.frames:
            last_frame_urls.append(frame.url)
            try:
                if await frame.get_by_text("下单时间", exact=False).count():
                    return frame
                if await frame.locator("a[href*='orderId=']").count():
                    return frame
            except Exception:
                continue
        await asyncio.sleep(1)
    raise RuntimeError(f"未找到订单业务 iframe，已看到 frames: {last_frame_urls[-8:]}")


async def try_auto_login(page, username, password):
    if not username or not password:
        return False

    log("检测到登录环境变量，尝试自动填写账号密码")
    roots = [page, *page.frames]
    for root in roots:
        try:
            password_input = root.locator(
                "input[type='password'], input[name*='password'], input[id*='password']"
            ).first
            await password_input.wait_for(state="visible", timeout=2500)
        except Exception:
            continue

        try:
            for text in ("账号登录", "密码登录", "账户登录"):
                entry = root.get_by_text(text, exact=False)
                if await entry.count():
                    try:
                        await entry.first.click(timeout=1500, force=True)
                        await human_pause(0.5, 1.0)
                        break
                    except Exception:
                        pass

            username_candidates = (
                "input[name='fm-login-id']",
                "input#fm-login-id",
                "input[name*='login']",
                "input[name*='user']",
                "input[type='email']",
                "input[type='text']",
            )
            username_input = None
            for selector in username_candidates:
                locator = root.locator(selector).first
                if await locator.count():
                    try:
                        await locator.wait_for(state="visible", timeout=1500)
                        username_input = locator
                        break
                    except Exception:
                        pass
            if not username_input:
                continue

            await username_input.click(timeout=3000, force=True)
            await username_input.fill(username, timeout=5000)
            await human_pause(0.3, 0.8)
            await password_input.click(timeout=3000, force=True)
            await password_input.fill(password, timeout=5000)
            await human_pause(0.5, 1.2)

            for checkbox_selector in ("input[type='checkbox']", ".next-checkbox-input"):
                checkbox = root.locator(checkbox_selector).first
                if await checkbox.count():
                    try:
                        await checkbox.click(timeout=1000, force=True)
                        await human_pause(0.2, 0.5)
                        break
                    except Exception:
                        pass

            login_button = root.locator(
                "button, input[type='submit'], .fm-button, .login-submit"
            ).filter(has_text=re.compile(r"登录|Login|Sign in", re.I))
            if await login_button.count():
                await paced_click(login_button, "登录", after_min=3.0, after_max=5.0)
            else:
                await password_input.press("Enter")
                await human_pause(3.0, 5.0)
            log("已提交登录表单，等待进入订单页面")
            return True
        except Exception as exc:
            log(f"自动登录尝试失败，将继续等待人工登录: {exc}")
            return False
    return False


async def try_enter_default_shop(page):
    roots = [page, *page.frames]
    for root in roots:
        try:
            body_text = await root.locator("body").inner_text(timeout=1500)
        except Exception:
            continue
        if not re.search(r"选择.*(店铺|组织|商家)|请选择.*(店铺|组织|商家)|店铺|组织|商家账号", body_text):
            continue

        log("检测到可能的选择店铺/组织/商家页面，尝试进入默认选项")
        try:
            selectors = (
                "input[type='radio']",
                "input[type='checkbox']",
                ".next-radio input",
                ".next-checkbox input",
            )
            for selector in selectors:
                option = root.locator(selector).first
                if await option.count():
                    try:
                        await option.click(timeout=1500, force=True)
                        await human_pause(0.3, 0.8)
                        break
                    except Exception:
                        pass

            card = root.locator(
                "[role='option'], [role='radio'], .next-card, .ant-card, .auxo-card, li"
            ).filter(has_text=re.compile(r"店|组织|公司|商家"))
            if await card.count():
                try:
                    await card.first.click(timeout=1500, force=True)
                    await human_pause(0.3, 0.8)
                except Exception:
                    pass

            button_info = await root.locator("button, .next-btn, .ant-btn, .auxo-btn").evaluate_all(
                """
                (els) => els.map((el, index) => {
                    const rect = el.getBoundingClientRect();
                    const style = getComputedStyle(el);
                    const text = (el.innerText || el.textContent || el.value || '')
                        .trim()
                        .replace(/\\s+/g, ' ');
                    const bg = style.backgroundColor || '';
                    const color = style.color || '';
                    const blue = /rgb\\((\\s*0|\\s*22|\\s*24|\\s*30|\\s*40|\\s*64|\\s*22),/.test(bg) ||
                        /rgb\\(.*122.*255/.test(bg) ||
                        bg.includes('blue');
                    return {
                        index,
                        text,
                        bg,
                        color,
                        blue,
                        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
                        visible: rect.width > 0 && rect.height > 0 &&
                            style.display !== 'none' &&
                            style.visibility !== 'hidden',
                    };
                }).filter((item) => item.visible && !item.disabled)
                """
            )
            candidates = [
                item
                for item in button_info
                if re.search(r"进入|确定|确认|下一步|开始|商家|Enter|Confirm|OK", item["text"], re.I)
            ]
            if not candidates:
                candidates = [item for item in button_info if item["blue"]]
            if not candidates:
                continue
            candidates.sort(key=lambda item: (not item["blue"], len(item["text"] or "")))
            await paced_click(
                root.locator("button, .next-btn, .ant-btn, .auxo-btn").nth(candidates[0]["index"]),
                f"进入默认店铺/组织/商家: {candidates[0]['text'] or '主按钮'}",
                after_min=3.0,
                after_max=5.0,
            )
            return True
        except Exception as exc:
            log(f"选择默认店铺/组织失败，继续等待: {exc}")
    return False


async def wait_for_manual_login(page, output_dir, timeout_minutes, username="", password=""):
    text = ""
    try:
        text = await page.locator("body").inner_text(timeout=5000)
    except Exception:
        pass
    if not any(marker in text for marker in ("登录", "扫码", "Login", "Sign in")):
        try:
            await find_business_frame(page)
            return
        except Exception:
            pass

    if await try_auto_login(page, username, password):
        deadline = asyncio.get_event_loop().time() + 90
        while asyncio.get_event_loop().time() < deadline:
            await try_enter_default_shop(page)
            try:
                await find_business_frame(page)
                log("自动登录后已进入订单页面")
                write_status(output_dir, state="running", message="自动登录完成，继续采集")
                await human_pause(2.0, 4.0)
                return
            except Exception:
                await asyncio.sleep(2)
        log("自动登录提交后仍未进入订单页面，可能需要滑块/验证码或二次验证")

    screenshot = output_dir / "tmall_msd_login.png"
    await page.screenshot(path=str(screenshot), full_page=True)
    write_status(
        output_dir,
        state="login_required",
        message=f"请在浏览器中完成登录，脚本会等待 {timeout_minutes} 分钟",
        login_screenshot=str(screenshot),
    )
    log(f"可能需要登录，请在浏览器中完成。截图: {screenshot}")

    deadline = asyncio.get_event_loop().time() + timeout_minutes * 60
    while asyncio.get_event_loop().time() < deadline:
        await try_enter_default_shop(page)
        try:
            await find_business_frame(page)
            log("已检测到订单页面，继续采集")
            write_status(output_dir, state="running", message="登录完成，继续采集")
            await human_pause(2.0, 4.0)
            return
        except Exception:
            await asyncio.sleep(2)
    raise TimeoutError(f"登录超时：{timeout_minutes} 分钟内未进入订单页面")


async def set_native_value(locator, value):
    await locator.evaluate(
        """
        (el, value) => {
            el.removeAttribute('readonly');
            el.readOnly = false;
            const descriptor =
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(el, value);
            } else {
                el.value = value;
            }
            el.setAttribute('value', value);
            el.focus();
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            el.blur();
        }
        """,
        value,
    )


async def visible_input_infos(root):
    return await root.locator("input").evaluate_all(
        """
        (inputs) => inputs.map((el, index) => {
            const rect = el.getBoundingClientRect();
            return {
                index,
                value: el.value || '',
                placeholder: el.getAttribute('placeholder') || '',
                readOnly: !!el.readOnly,
                disabled: !!el.disabled,
                cls: el.className || '',
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                visible: rect.width > 0 && rect.height > 0 &&
                    getComputedStyle(el).visibility !== 'hidden' &&
                    getComputedStyle(el).display !== 'none',
            };
        }).filter((item) => item.visible && !item.disabled)
        """
    )


async def first_visible_locator(roots, selector, timeout=2500):
    for root in roots:
        locator = root.locator(selector)
        if not await locator.count():
            continue
        try:
            await locator.first.wait_for(state="visible", timeout=timeout)
            return root, locator
        except Exception:
            continue
    return None, None


async def date_range_input_indices(frame):
    result = await frame.evaluate(
        """
        () => {
            const visible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden';
            };
            const labels = Array.from(document.querySelectorAll('label, span, div'))
                .map((el) => {
                    const rect = el.getBoundingClientRect();
                    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
                    return { el, text, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                })
                .filter((item) =>
                    item.text === '下单时间' &&
                    item.w > 0 &&
                    item.h > 0 &&
                    item.w < 120 &&
                    item.h < 60 &&
                    item.y < 260
                )
                .sort((a, b) => a.y - b.y || a.x - b.x);
            const inputs = Array.from(document.querySelectorAll('input'))
                .map((el, index) => {
                    const rect = el.getBoundingClientRect();
                    return {
                        index,
                        value: el.value || '',
                        placeholder: el.getAttribute('placeholder') || '',
                        readOnly: !!el.readOnly,
                        x: rect.x,
                        y: rect.y,
                        w: rect.width,
                        h: rect.height,
                    };
                })
                .filter((item) => item.w > 0 && item.h > 0 && item.w >= 100 && item.y < 260);

            for (const label of labels) {
                const near = inputs
                    .filter((item) =>
                        item.x > label.x &&
                        Math.abs((item.y + item.h / 2) - (label.y + label.h / 2)) < 45 &&
                        /日期|开始|结束|请选择|\\d{4}-\\d{2}-\\d{2}/.test(
                            `${item.placeholder} ${item.value}`
                        )
                    )
                    .sort((a, b) => a.x - b.x);
                if (near.length >= 2) {
                    return { indices: [near[0].index, near[1].index], label, inputs, near };
                }
            }
            return { indices: [], labels, inputs };
        }
        """
    )
    if result.get("indices"):
        log(f"下单时间输入框定位: {result}")
        return result["indices"]
    raise RuntimeError(f"未找到下单时间输入框: {result}")


async def set_order_time_range(frame, start_time, end_time):
    log(f"设置下单时间: {start_time} ~ {end_time}")
    await frame.get_by_text("下单时间", exact=False).first.wait_for(
        state="visible",
        timeout=60000,
    )
    await dismiss_overlays(frame)

    start_index, end_index = await date_range_input_indices(frame)
    start_input = frame.locator("input").nth(start_index)
    end_input = frame.locator("input").nth(end_index)
    start_handle = await start_input.element_handle()
    end_handle = await end_input.element_handle()
    if not start_handle or not end_handle:
        raise RuntimeError("未能固定下单时间输入框元素")

    # Open the auxo date picker and fill its internal fields. This keeps React state
    # in sync better than writing only the outer display inputs.
    await paced_click(start_input, "下单时间开始输入框", after_min=0.8, after_max=1.6)
    popup_root, popup_inputs = await first_visible_locator(
        (frame, frame.page),
        ".auxo-picker-dropdown:visible input",
        timeout=8000,
    )
    if not popup_inputs:
        popup_root, popup_inputs = frame, frame.locator("input")

    start_date, start_clock = start_time.split(" ")
    end_date, end_clock = end_time.split(" ")
    popup_count = await popup_inputs.count()
    if popup_count >= 4:
        for index, value in enumerate((start_date, start_clock, end_date, end_clock)):
            target = popup_inputs.nth(index)
            await target.click(timeout=5000, force=True)
            await set_native_value(target, value)
            await human_pause(0.2, 0.6)
        ok = popup_root.locator(".auxo-picker-dropdown:visible .auxo-picker-ok button")
        if not await ok.count():
            ok = popup_root.locator(".auxo-picker-dropdown:visible button").filter(
                has_text=re.compile(r"确定|OK", re.I)
            )
        if await ok.count():
            await paced_click(ok, "日期选择确定", after_min=1.0, after_max=2.0)
        else:
            await frame.page.keyboard.press("Enter")
            await human_pause(1.0, 2.0)
    else:
        log("日期弹层输入框数量不足，改用外层输入框写入")
        await set_native_value(start_handle, start_date)
        await set_native_value(end_handle, end_date)
        await frame.page.keyboard.press("Enter")
        await human_pause(1.0, 2.0)

    await frame.page.keyboard.press("Escape")
    await human_pause(0.5, 1.0)
    await set_native_value(start_handle, start_date)
    await set_native_value(end_handle, end_date)
    selected = [
        await start_handle.evaluate("(el) => el.value || ''"),
        await end_handle.evaluate("(el) => el.value || ''"),
    ]
    log(f"下单时间输入框当前值: {selected}")
    if not any(start_time in value or start_date in value for value in selected):
        values = await visible_input_infos(frame)
        log(f"警告: 下单时间可能未成功写入，可见输入快照: {values}")


async def click_query(frame):
    await dismiss_overlays(frame)
    query = frame.locator("button").filter(has_text=re.compile(r"^查询$|^Search$"))
    await paced_click(query, "查询", after_min=5.0, after_max=8.0, timeout=60000)
    try:
        await wait_network_quiet(frame.page, timeout=45000)
    except Exception:
        await human_pause(3.0, 5.0)
    log("查询后等待完成")


def parse_total_count(text):
    if not text:
        return None
    patterns = (
        r"All\(([\d,]+)\)",
        r"共\s*([\d,]+)\s*项",
        r"共\s*([\d,]+)\s*条",
        r"Total\s*([\d,]+)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.I)
        if match:
            return int(match.group(1).replace(",", ""))
    return None


async def extract_total_count(frame):
    texts = await frame.locator("body *").evaluate_all(
        """
        (els) => els.map((el) => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
            return { text, w: rect.width, h: rect.height };
        }).filter((item) => item.w > 0 && item.h > 0 && (
            /All\\([\\d,]+\\)/i.test(item.text) ||
            /共\\s*[\\d,]+\\s*(项|条)/.test(item.text) ||
            /Total\\s*[\\d,]+/i.test(item.text)
        )).map((item) => item.text).slice(0, 20)
        """
    )
    for text in texts:
        total = parse_total_count(text)
        if total is not None:
            log(f"页面总数提示: {text}")
            return total
    return None


async def choose_largest_page_size(frame, requested_size):
    changers = frame.locator(".auxo-pagination-options-size-changer")
    if not await changers.count():
        button_size = await choose_largest_page_size_button(frame, requested_size)
        if button_size:
            return button_size
        log("未找到每页条数控件，跳过分页大小切换")
        return None

    changer = changers.first
    try:
        await changer.scroll_into_view_if_needed(timeout=5000)
    except Exception:
        pass
    current_text = clean(await changer.inner_text(timeout=5000))
    current_match = re.search(r"\d+", current_text)
    current_size = int(current_match.group(0)) if current_match else None
    await paced_click(changer, "每页条数", after_min=0.8, after_max=1.6)

    options = await frame.locator(
        ".auxo-select-dropdown:visible .auxo-select-item-option"
    ).evaluate_all(
        """
        (els) => els.map((el) => {
            const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
            const match = text.match(/\\d+/);
            return match ? { text, size: Number(match[0]) } : null;
        }).filter(Boolean)
        """
    )
    if not options:
        log("未读到每页条数选项，保持当前值")
        await frame.page.keyboard.press("Escape")
        return current_size

    sizes = sorted({item["size"] for item in options})
    eligible_sizes = [size for size in sizes if not requested_size or size <= requested_size]
    target_size = max(eligible_sizes or sizes)
    if current_size and current_size >= target_size:
        log(f"当前每页条数 {current_size} 已不小于目标 {target_size}")
        await frame.page.keyboard.press("Escape")
        return current_size

    option = frame.locator(".auxo-select-dropdown:visible .auxo-select-item-option").filter(
        has_text=re.compile(rf"{target_size}\s*(条|项)?/?\s*(页|page)?", re.I)
    )
    await paced_click(option, f"{target_size} 条/页", after_min=4.0, after_max=7.0)
    try:
        await wait_network_quiet(frame.page, timeout=45000)
    except Exception:
        await human_pause(2.0, 4.0)
    log(f"已尝试切换为每页 {target_size}")
    return target_size


async def choose_largest_page_size_button(frame, requested_size):
    buttons = await frame.locator("button").evaluate_all(
        """
        (els) => els.map((el, index) => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || '').trim();
            const size = /^\\d+$/.test(text) ? Number(text) : null;
            return { index, text, size, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        }).filter((item) => item.size && item.w > 0 && item.h > 0)
        """
    )
    sizes = sorted({item["size"] for item in buttons})
    if not sizes:
        return None
    eligible_sizes = [size for size in sizes if not requested_size or size <= requested_size]
    target_size = max(eligible_sizes or sizes)
    candidate = next(item for item in buttons if item["size"] == target_size)
    await paced_click(
        frame.locator("button").nth(candidate["index"]),
        f"{target_size} 条/页",
        after_min=4.0,
        after_max=7.0,
    )
    try:
        await wait_network_quiet(frame.page, timeout=45000)
    except Exception:
        await human_pause(2.0, 4.0)
    log(f"已通过按钮尝试切换为每页 {target_size}")
    return target_size


async def collect_order_links_on_page(frame):
    return await frame.evaluate(
        """
        async () => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const seen = new Map();
            const collect = () => {
                const anchors = Array.from(document.querySelectorAll('a'));
                for (const a of anchors) {
                    const text = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ');
                    const href = a.href || a.getAttribute('href') || '';
                    const combined = `${text} ${href}`;
                    if (!/SCP\\d+|orderId=\\d+/i.test(combined)) continue;
                    let orderId = '';
                    let ownerId = '';
                    let viewType = '1';
                    try {
                        const url = new URL(href, location.href);
                        orderId = url.searchParams.get('orderId') || '';
                        ownerId = url.searchParams.get('ownerId') || '';
                        viewType = url.searchParams.get('viewType') || viewType;
                    } catch (e) {}
                    const codeMatch = combined.match(/SCP\\d+/);
                    const orderCode = codeMatch ? codeMatch[0] : (orderId ? `SCP${orderId}` : '');
                    if (!orderId && orderCode) orderId = orderCode.replace(/^SCP/, '');
                    if (!orderId) continue;
                    seen.set(`${orderId}:${ownerId}`, { orderId, ownerId, viewType, orderCode, href, text });
                }
            };
            collect();
            const scrollers = Array.from(document.querySelectorAll('div, section, main'))
                .filter((el) => el.scrollHeight > el.clientHeight + 80)
                .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
                .slice(0, 8);
            for (const el of scrollers) {
                const originalTop = el.scrollTop;
                const maxTop = el.scrollHeight - el.clientHeight;
                const step = Math.max(120, Math.floor(el.clientHeight * 0.75));
                for (let top = 0; top <= maxTop; top += step) {
                    el.scrollTop = top;
                    el.dispatchEvent(new Event('scroll', { bubbles: true }));
                    await sleep(120);
                    collect();
                }
                el.scrollTop = originalTop;
            }
            collect();
            return Array.from(seen.values());
        }
        """
    )


async def next_page_enabled(frame):
    return await frame.locator(
        ".auxo-pagination-next:not(.auxo-pagination-disabled) button"
    ).count()


async def click_next_page(frame):
    await dismiss_overlays(frame)
    next_button = frame.locator(
        ".auxo-pagination-next:not(.auxo-pagination-disabled) button"
    )
    await paced_click(next_button, "下一页", after_min=4.0, after_max=7.0, timeout=60000)
    try:
        await wait_network_quiet(frame.page, timeout=45000)
    except Exception:
        await human_pause(2.0, 4.0)


async def collect_order_links(frame, expected_total, max_pages):
    orders = {}
    page_no = 1
    while True:
        links = await collect_order_links_on_page(frame)
        for link in links:
            link["page_no"] = page_no
            orders[(link["orderId"], link.get("ownerId") or "")] = link
        log(f"第 {page_no} 页发现 {len(links)} 个订单链接，累计 {len(orders)}")

        if expected_total and len(orders) >= expected_total:
            log(f"累计订单数已达到页面总数 {expected_total}，停止翻页")
            break
        if max_pages and page_no >= max_pages:
            log(f"已达到最大页数 {max_pages}，停止翻页")
            break
        if not await next_page_enabled(frame):
            log("下一页不可用，停止翻页")
            break
        await click_next_page(frame)
        page_no += 1
        await human_pause(2.0, 4.0)
    return list(orders.values())


async def context_fetch_json(context, url):
    response = await context.request.get(
        url,
        headers={
            "accept": "application/json, text/plain, */*",
            "referer": ORDER_PAGE_URL,
        },
        timeout=60000,
    )
    text = await response.text()
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = None
    return {
        "ok": response.ok,
        "status": response.status,
        "url": response.url,
        "text": text,
        "json": parsed,
    }


def build_order_api_url(base_url, order):
    params = {
        "orderId": order["orderId"],
        "ownerId": order.get("ownerId") or "",
        "viewType": order.get("viewType") or "1",
    }
    return f"{base_url}?{urlencode(params)}"


def build_order_list_api_url(start_time, end_time, page_index, page_size):
    params = {
        "bizStatus": "0",
        "isHistory": "false",
        "isMerchant": "true",
        "orderCodeType": "2",
        "pageIndex": str(page_index),
        "pageSize": str(page_size),
        "partialLoad": "",
        "tradeCreateTimeRange": f"{start_time}/{end_time}",
    }
    return f"{ORDER_LIST_API_URL}?{urlencode(params)}"


def normalize_list_order_link(row, page_no):
    base = row.get("baseInfo") or {}
    unbox = row.get("unBoxInfo") or {}
    order_id = str(base.get("id") or base.get("orderId") or row.get("id") or "")
    order_code = row.get("orderCode") or base.get("orderCode") or (f"SCP{order_id}" if order_id else "")
    return {
        "orderId": order_id,
        "ownerId": base.get("ownerId") or row.get("ownerId") or "",
        "viewType": "1",
        "orderCode": order_code,
        "href": (
            "https://web.scm.tmall.com/pages/csklzy/fulfillment_order_detail_config?"
            + urlencode(
                {
                    "orderId": order_id,
                    "viewType": "1",
                    "ownerId": base.get("ownerId") or row.get("ownerId") or "",
                    "orderCode": order_code,
                }
            )
        ),
        "text": order_code,
        "page_no": page_no,
        "list_trade_create_time": unbox.get("tradeCreateTimeString", ""),
        "list_trade_pay_time": unbox.get("tradePayTimeString", ""),
        "list_amount": unbox.get("orderAmountString") or normalize_money(base.get("orderAmount")),
        "list_discount": unbox.get("discountAmountString") or normalize_money(base.get("discountAmount")),
        "list_order_status": base.get("orderStatus"),
        "list_biz_order_status": base.get("bizOrderStatus"),
        "list_status_desc": unbox.get("statusDesc", ""),
        "list_logistics_order_code": base.get("consignLgOrderCode") or base.get("sourceLgOrderCode") or "",
        "list_buyer_nick": base.get("buyerNick", ""),
    }


async def collect_order_links_from_api(context, start_time, end_time, page_size, max_pages):
    page_index = 1
    total_count = None
    links = []
    raw_pages = []
    seen = set()

    while True:
        url = build_order_list_api_url(start_time, end_time, page_index, page_size)
        response = await context_fetch_json(context, url)
        payload = response.get("json") or {}
        rows = payload.get("data") or []
        if total_count is None:
            total_count = payload.get("totalCount")
            log(f"列表接口总数: {total_count if total_count is not None else '未知'}")
        raw_pages.append(
            {
                "page_index": page_index,
                "url": url,
                "status": response.get("status"),
                "totalCount": payload.get("totalCount"),
                "rows_count": len(rows),
            }
        )
        for row in rows:
            link = normalize_list_order_link(row, page_index)
            key = (link.get("orderId"), link.get("ownerId"))
            if not link.get("orderId") or key in seen:
                continue
            seen.add(key)
            links.append(link)
        log(f"列表接口第 {page_index} 页 {len(rows)} 条，累计 {len(links)}")

        if total_count is not None and len(links) >= int(total_count):
            break
        if not rows:
            break
        if max_pages and page_index >= max_pages:
            log(f"已达到最大页数 {max_pages}，停止列表接口翻页")
            break
        page_index += 1
        await human_pause(0.8, 1.8)
    return links, raw_pages, total_count


def iter_dicts(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from iter_dicts(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_dicts(item)


def first_value(obj, *keys):
    for item in iter_dicts(obj):
        for key in keys:
            if key in item and item[key] not in (None, ""):
                return item[key]
    return ""


def find_item_dicts(payload):
    item_key_markers = {
        "orderItemId",
        "itemId",
        "scItemId",
        "skuId",
        "itemCode",
        "scItemCode",
        "barCode",
    }
    results = []
    seen = set()
    for item in iter_dicts(payload):
        if not item_key_markers.intersection(item.keys()):
            continue
        key = (
            str(item.get("orderItemId") or ""),
            str(item.get("itemId") or ""),
            str(item.get("scItemId") or ""),
            str(item.get("skuId") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        results.append(item)
    return results


def normalize_order(order_link, detail_response, items_response):
    detail_payload = detail_response.get("json") or {}
    items_payload = items_response.get("json") or {}
    order = {
        "order_code": first_value(detail_payload, "orderCode") or order_link.get("orderCode", ""),
        "order_id": str(first_value(detail_payload, "orderId") or order_link.get("orderId", "")),
        "trade_id": str(first_value(detail_payload, "tradeId")),
        "owner_id": order_link.get("ownerId", ""),
        "pay_time": clean(first_value(detail_payload, "payTime", "payTimeStr") or order_link.get("list_trade_pay_time")),
        "create_time": clean(
            first_value(detail_payload, "createTime", "createTimeStr")
            or order_link.get("list_trade_create_time")
        ),
        "amount": normalize_money(
            first_value(detail_payload, "amount", "orderAmount", "actualPaidAmount")
            or order_link.get("list_amount")
        ),
        "discount": normalize_money(
            first_value(detail_payload, "discount", "discountAmount")
            or order_link.get("list_discount")
        ),
        "order_status": clean(first_value(detail_payload, "orderStatus", "status") or order_link.get("list_order_status")),
        "biz_order_status": clean(first_value(detail_payload, "bizOrderStatus") or order_link.get("list_biz_order_status")),
        "status_desc": clean(order_link.get("list_status_desc")),
        "logistics_order_code": clean(
            first_value(
                detail_payload,
                "logisticsOrderCode",
                "logisticsCode",
                "mailNo",
                "expressNo",
            )
            or order_link.get("list_logistics_order_code")
        ),
        "consign_time": clean(first_value(detail_payload, "consignTime", "sendTime")),
        "buyer_nick": clean(first_value(detail_payload, "buyerNick", "buyerNickName") or order_link.get("list_buyer_nick")),
        "detail_status": detail_response.get("status"),
        "items_status": items_response.get("status"),
        "items_count": 0,
    }

    items = []
    for raw in find_item_dicts(items_payload):
        item = {
            "order_code": order["order_code"],
            "order_id": order["order_id"],
            "order_item_id": str(raw.get("orderItemId") or ""),
            "item_id": str(raw.get("itemId") or ""),
            "sc_item_id": str(raw.get("scItemId") or ""),
            "sku_id": str(raw.get("skuId") or ""),
            "item_code": clean(raw.get("itemCode") or raw.get("scItemCode") or ""),
            "sc_item_code": clean(raw.get("scItemCode") or ""),
            "bar_code": clean(raw.get("barCode") or raw.get("barcode") or ""),
            "item_name": clean(raw.get("scItemName") or raw.get("itemName") or raw.get("title") or ""),
            "quantity": raw.get("quantity") or raw.get("itemQuantity") or raw.get("num") or raw.get("itemNum") or "",
            "item_amount": normalize_money(raw.get("itemAmount") or raw.get("amount") or ""),
            "sale_price": normalize_money(raw.get("salePrice") or raw.get("price") or ""),
            "discount": normalize_money(raw.get("discount") or raw.get("discountAmount") or ""),
            "warehouse_code": clean(raw.get("warehouseCode") or raw.get("storeCode") or ""),
            "brand_id": str(raw.get("brandId") or ""),
            "scm_cat_id": str(raw.get("scmCatId") or ""),
            "supplier_id": str(raw.get("supplierId") or ""),
        }
        items.append(item)
    order["items_count"] = len(items)
    return order, items


async def fetch_order_details(context, order_links, concurrency):
    semaphore = asyncio.Semaphore(concurrency)
    raw_records = []
    orders = []
    items = []

    async def fetch_one(index, order_link):
        async with semaphore:
            if not order_link.get("ownerId"):
                log(f"订单 {order_link.get('orderCode')} 缺少 ownerId，仍尝试请求详情")
            detail_url = build_order_api_url(DETAIL_URL, order_link)
            items_url = build_order_api_url(ITEMS_DETAIL_URL, order_link)
            detail_response = await context_fetch_json(context, detail_url)
            await human_pause(0.3, 0.9)
            items_response = await context_fetch_json(context, items_url)
            order, item_rows = normalize_order(order_link, detail_response, items_response)
            log(
                f"[{index + 1}/{len(order_links)}] {order.get('order_code') or order_link.get('orderCode')} "
                f"详情状态 {detail_response.get('status')}，货品 {len(item_rows)}"
            )
            await human_pause(0.4, 1.2)
            return {
                "link": order_link,
                "detail_url": detail_url,
                "items_url": items_url,
                "detail_response": detail_response,
                "items_response": items_response,
                "order": order,
                "items": item_rows,
            }

    tasks = [fetch_one(index, order_link) for index, order_link in enumerate(order_links)]
    for result in await asyncio.gather(*tasks):
        raw_records.append(result)
        orders.append(result["order"])
        items.extend(result["items"])
    return raw_records, orders, items


def save_results(
    output_dir,
    data_date,
    start_time,
    end_time,
    order_links,
    raw_records,
    orders,
    items,
    list_pages=None,
):
    output_dir.mkdir(parents=True, exist_ok=True)
    captured_at = datetime.now().isoformat(timespec="seconds")
    json_path = output_dir / f"tmall_msd_orders_{data_date}.json"
    raw_path = output_dir / f"tmall_msd_orders_{data_date}_raw.json"
    orders_csv = output_dir / f"tmall_msd_orders_{data_date}.csv"
    items_csv = output_dir / f"tmall_msd_order_items_{data_date}.csv"

    payload = {
        "captured_at": captured_at,
        "source": ORDER_PAGE_URL,
        "date_filter": {
            "field": "下单时间",
            "date": data_date,
            "start": start_time,
            "end": end_time,
        },
        "orders_count": len(orders),
        "items_count": len(items),
        "order_links_count": len(order_links),
        "orders": orders,
        "items": items,
        "raw_file": str(raw_path),
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    raw_path.write_text(
        json.dumps(
            {
                "captured_at": captured_at,
                "list_pages": list_pages or [],
                "order_links": order_links,
                "records": raw_records,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    order_fields = [
        "order_code",
        "order_id",
        "trade_id",
        "owner_id",
        "pay_time",
        "create_time",
        "amount",
        "discount",
        "order_status",
        "biz_order_status",
        "status_desc",
        "logistics_order_code",
        "consign_time",
        "buyer_nick",
        "items_count",
    ]
    with orders_csv.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=order_fields)
        writer.writeheader()
        writer.writerows({field: row.get(field, "") for field in order_fields} for row in orders)

    item_fields = [
        "order_code",
        "order_id",
        "order_item_id",
        "item_id",
        "sc_item_id",
        "sku_id",
        "item_code",
        "sc_item_code",
        "bar_code",
        "item_name",
        "quantity",
        "item_amount",
        "sale_price",
        "discount",
        "warehouse_code",
        "brand_id",
        "scm_cat_id",
        "supplier_id",
    ]
    with items_csv.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=item_fields)
        writer.writeheader()
        writer.writerows({field: row.get(field, "") for field in item_fields} for row in items)

    log(f"已写入 JSON: {json_path}")
    log(f"已写入原始响应: {raw_path}")
    log(f"已写入订单 CSV: {orders_csv}")
    log(f"已写入货品 CSV: {items_csv}")
    return {
        "json": str(json_path),
        "raw": str(raw_path),
        "orders_csv": str(orders_csv),
        "items_csv": str(items_csv),
    }


async def run(args):
    data_date = args.date or yesterday()
    start_time, end_time = parse_day_range(data_date)
    output_dir = Path(args.output_dir) if args.output_dir else OUTPUT_ROOT / data_date / "tmall_msd"
    write_status(output_dir, state="running", message="开始采集天猫 MSD 订单", date=data_date)
    log(f"数据日期: {data_date}")
    log(f"下单时间范围: {start_time} ~ {end_time}")
    log(f"输出目录: {output_dir}")

    async with async_playwright() as playwright:
        launch_options = {
            "headless": args.headless,
            "slow_mo": args.slow_mo,
            "viewport": {"width": 1440, "height": 1000},
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        chromium_path = os.getenv("CHROMIUM_EXECUTABLE_PATH")
        if chromium_path:
            launch_options["executable_path"] = chromium_path
        elif args.channel:
            launch_options["channel"] = args.channel

        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=str(Path(args.session_dir) if args.session_dir else SESSION_DIR),
            **launch_options,
        )
        context.set_default_timeout(60000)
        page = context.pages[0] if context.pages else await context.new_page()

        captured_urls = []
        page.on(
            "response",
            lambda response: captured_urls.append(response.url)
            if re.search(r"order|fulfillment|portal|cbbs|query|list", response.url, re.I)
            else None,
        )

        log("打开天猫 MSD 订单管理页...")
        await page.goto(ORDER_PAGE_URL, wait_until="domcontentloaded", timeout=90000)
        try:
            await wait_network_quiet(page, timeout=45000)
        except Exception:
            await human_pause(3.0, 5.0)
        username = os.getenv("TMALL_MSD_USERNAME", "")
        password = os.getenv("TMALL_MSD_PASSWORD", "")
        await wait_for_manual_login(
            page,
            output_dir,
            args.login_timeout_minutes,
            username=username,
            password=password,
        )
        frame = await find_business_frame(page)
        log(f"业务 frame: {frame.url}")

        order_links, list_pages, expected_total = await collect_order_links_from_api(
            context,
            start_time,
            end_time,
            args.page_size,
            args.max_pages,
        )
        if not order_links:
            (output_dir / "tmall_msd_captured_urls.json").write_text(
                json.dumps(sorted(set(captured_urls)), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            raise RuntimeError("没有从页面收集到订单链接，请确认筛选结果和页面登录状态")
        raw_records, orders, items = await fetch_order_details(
            context,
            order_links,
            concurrency=args.detail_concurrency,
        )
        orders.sort(key=lambda item: item.get("pay_time") or "", reverse=True)
        items.sort(key=lambda item: (item.get("order_code") or "", item.get("order_item_id") or ""))
        paths = save_results(
            output_dir,
            data_date,
            start_time,
            end_time,
            order_links,
            raw_records,
            orders,
            items,
            list_pages=list_pages,
        )
        (output_dir / "tmall_msd_captured_urls.json").write_text(
            json.dumps(sorted(set(captured_urls)), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        await context.close()

    write_status(
        output_dir,
        state="completed",
        message="天猫 MSD 订单采集完成",
        orders_count=len(orders),
        items_count=len(items),
        **paths,
    )
    return {"orders": orders, "items": items, "paths": paths}


def parse_args():
    parser = argparse.ArgumentParser(description="按下单时间抓取天猫 MSD 履约订单")
    parser.add_argument("--date", default=yesterday(), help="数据日期，格式 YYYY-MM-DD，默认昨日")
    parser.add_argument("--output-dir", help="输出目录，默认 output/orders/<date>/tmall_msd/")
    parser.add_argument("--session-dir", help=f"浏览器登录态目录，默认 {SESSION_DIR}")
    parser.add_argument("--channel", default="chrome", help="浏览器 channel，默认 chrome；可设为空使用 Playwright Chromium")
    parser.add_argument("--headless", action="store_true", help="无头模式；首次登录不要使用")
    parser.add_argument("--slow-mo", type=int, default=350)
    parser.add_argument("--login-timeout-minutes", type=int, default=15)
    parser.add_argument("--initial-page-size", type=int, default=10, help="结果数超过该值时优先调大每页条数")
    parser.add_argument("--page-size", type=int, default=200, help="列表接口每页订单数，默认 200 以减少翻页")
    parser.add_argument("--max-pages", type=int, default=0, help="最多翻页数，0 表示不限")
    parser.add_argument("--detail-concurrency", type=int, default=2, help="详情接口并发数，建议保持较低")
    return parser.parse_args()


def main():
    result = asyncio.run(run(parse_args()))
    orders = result["orders"]
    items = result["items"]
    log("完成。")
    log(f"订单数: {len(orders)}")
    log(f"货品明细数: {len(items)}")
    for label, path in result["paths"].items():
        log(f"{label}: {path}")


if __name__ == "__main__":
    main()
