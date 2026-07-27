import argparse
import asyncio
import json
import os
import socket
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.collector_py import channel, operations
from apps.collector_py.status import LOGIN_SCREENSHOT, write_status
from apps.scraper_py.scraper import (
    SESSION_DIR,
    SHOP_URL,
    TARGET_SHOPS,
    click_with_pacing,
    human_pause,
    switch_shop,
    wait_network_quiet,
)

AVAILABLE_MODULES = ("operations", "channel")
CHROMIUM_SINGLETON_NAMES = ("SingletonLock", "SingletonSocket", "SingletonCookie")


def process_is_running(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def clear_stale_chromium_singletons(session_dir=SESSION_DIR):
    lock_path = Path(session_dir) / "SingletonLock"
    if not lock_path.is_symlink():
        return False
    try:
        lock_target = os.readlink(lock_path)
        lock_host, raw_pid = lock_target.rsplit("-", 1)
        lock_pid = int(raw_pid)
    except (OSError, ValueError):
        lock_host, lock_pid = "", -1
    if lock_host == socket.gethostname() and process_is_running(lock_pid):
        return False
    for name in CHROMIUM_SINGLETON_NAMES:
        path = Path(session_dir) / name
        if path.is_symlink():
            path.unlink(missing_ok=True)
    print(f"已清理旧 Chromium 配置锁: {lock_target}", flush=True)
    return True


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


def date_range_from_request(url, post_data):
    date_range = date_range_from_fields(parse_qs(urlparse(url).query))
    if date_range or not post_data:
        return date_range
    try:
        payload = json.loads(post_data)
    except json.JSONDecodeError:
        return date_range_from_fields(parse_qs(post_data))
    pending = [payload]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            date_range = date_range_from_fields({key: [item] for key, item in value.items()})
            if date_range:
                return date_range
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return None


async def wait_for_login(page, timeout_minutes):
    markers = ("扫码登录", "打开 抖店App 扫码登录", "商家入口")
    marker_visible = any([await page.get_by_text(marker, exact=False).count() for marker in markers])
    if "login" not in page.url.lower() and not marker_visible:
        return
    LOGIN_SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    await page.screenshot(path=str(LOGIN_SCREENSHOT), full_page=True)
    write_status(state="login_required", message=f"检测到登录页，请在 {timeout_minutes} 分钟内扫码登录", login_screenshot=str(LOGIN_SCREENSHOT))
    print(f"检测到登录页，请在 {timeout_minutes} 分钟内手动完成登录。", flush=True)
    deadline = asyncio.get_event_loop().time() + timeout_minutes * 60
    last_screenshot = asyncio.get_event_loop().time()
    while asyncio.get_event_loop().time() < deadline:
        for marker in ("近1天", "经营概况"):
            try:
                await page.get_by_text(marker, exact=False).first.wait_for(state="visible", timeout=2000)
                write_status(state="running", message="登录完成，继续采集")
                await human_pause(6.0, 12.0)
                return
            except Exception:
                continue
        if asyncio.get_event_loop().time() - last_screenshot >= 30:
            try:
                await page.screenshot(path=str(LOGIN_SCREENSHOT), full_page=True)
                last_screenshot = asyncio.get_event_loop().time()
            except Exception:
                pass
        await asyncio.sleep(2)
    raise TimeoutError(f"登录超时：{timeout_minutes} 分钟内未完成登录")


async def choose_near_day(page):
    date_ranges = set()
    core_urls = set()

    def capture(response):
        if response.status != 200 or "core_index_v3" not in response.url:
            return
        core_urls.add(response.url)
        date_range = date_range_from_request(response.url, response.request.post_data)
        if date_range:
            date_ranges.add(date_range)

    page.on("response", capture)
    try:
        await click_with_pacing(page.get_by_text("近1天", exact=True), "近1天")
        await wait_network_quiet(page, timeout=45000)
        await human_pause(8.0, 14.0)
    finally:
        page.remove_listener("response", capture)
    if len(date_ranges) != 1:
        raise RuntimeError(f"未能确认“近1天”的实际数据日期: {sorted(date_ranges)!r}; 接口: {sorted(core_urls)!r}")
    result = date_ranges.pop()
    print(f"近1天实际数据日期: {result[0]} 至 {result[1]}", flush=True)
    return result


def module_state(requested):
    return {name: {"requested": name in requested, "success_count": 0, "error_count": 0, "errors": []} for name in AVAILABLE_MODULES}


async def run(args):
    shops = args.shop or list(TARGET_SHOPS)
    requested = tuple(dict.fromkeys(args.module or AVAILABLE_MODULES))
    result = {"operations": [], "channel": [], "modules": module_state(requested), "requested_modules": list(requested)}
    async with async_playwright() as playwright:
        clear_stale_chromium_singletons()
        options = {"user_data_dir": str(SESSION_DIR), "headless": False, "slow_mo": args.slow_mo, "viewport": {"width": 1440, "height": 1000}}
        chromium_path = os.getenv("CHROMIUM_EXECUTABLE_PATH")
        if chromium_path:
            options["executable_path"] = chromium_path
        context = await playwright.chromium.launch_persistent_context(**options)
        try:
            context.set_default_timeout(60000)
            page = context.pages[0] if context.pages else await context.new_page()
            capture = channel.ResponseCapture() if "channel" in requested else None
            if capture:
                page.on("response", capture.handle_response)
            print("打开抖音电商罗盘店铺页...", flush=True)
            await page.goto(SHOP_URL, wait_until="domcontentloaded", timeout=90000)
            await wait_network_quiet(page, timeout=45000)
            await human_pause(5.0, 10.0)
            await wait_for_login(page, args.login_timeout_minutes)
            if "shop" not in page.url:
                await page.goto(SHOP_URL, wait_until="domcontentloaded", timeout=90000)
                await wait_network_quiet(page, timeout=45000)
                await human_pause(5.0, 10.0)

            for shop_name in shops:
                print(f"\n准备切换店铺: {shop_name}", flush=True)
                if capture:
                    capture.start_shop(shop_name)
                data_range = None
                try:
                    await switch_shop(page, shop_name)
                    data_range = await choose_near_day(page)
                except Exception as exc:
                    for name in requested:
                        result["modules"][name]["error_count"] += 1
                        result["modules"][name]["errors"].append({"shop_name": shop_name, "error": repr(exc)})
                    if capture:
                        await capture.finish_shop()
                    continue

                if "operations" in requested:
                    try:
                        item = await operations.collect(page, shop_name, data_range)
                        result["operations"].append(item)
                        result["modules"]["operations"]["success_count"] += 1
                        print(f"{shop_name} 经营数据已读取，指标数: {len(item['metrics'])}", flush=True)
                    except Exception as exc:
                        result["modules"]["operations"]["error_count"] += 1
                        result["modules"]["operations"]["errors"].append({"shop_name": shop_name, "error": repr(exc)})
                        print(f"{shop_name} 经营模块失败，继续采集其他模块: {exc!r}", flush=True)

                if "channel" in requested:
                    try:
                        await channel.load(page)
                    except Exception as exc:
                        result["modules"]["channel"]["error_count"] += 1
                        result["modules"]["channel"]["errors"].append({"shop_name": shop_name, "error": repr(exc)})
                        print(f"{shop_name} 渠道页面加载失败，保留已捕获响应: {exc!r}", flush=True)
                    responses = await capture.finish_shop()
                    if responses:
                        result["channel"].append({"shop_name": shop_name, "data_start": data_range[0], "data_end": data_range[1], "responses": responses})
                        result["modules"]["channel"]["success_count"] += 1
                    print(f"{shop_name} 渠道接口已捕获: {len(responses)} 条", flush=True)
                await human_pause(8.0, 14.0)

            if args.keep_open:
                await asyncio.sleep(60)
        finally:
            try:
                await asyncio.wait_for(context.close(), timeout=30)
            except Exception as exc:
                print(f"关闭 Chromium 上下文失败: {exc!r}", flush=True)
    return result


def save_run(result, output_dir=None):
    captured_at = datetime.now()
    outputs = {}
    if result["operations"]:
        json_path, csv_path = operations.save(result["operations"], captured_at, output_dir)
        outputs["operations"] = {"json": str(json_path), "csv": str(csv_path)}
    if result["channel"]:
        outputs["channel"] = {"json": str(channel.save(result["channel"], captured_at))}
    return outputs


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="罗盘独立采集服务：共享登录会话，按模块采集近1天数据")
    parser.add_argument("--module", action="append", choices=AVAILABLE_MODULES, help="采集模块，可重复；默认全部")
    parser.add_argument("--shop", action="append", help="指定店铺名，可重复；默认全部目标店铺")
    parser.add_argument("--output-dir", help="经营模块输出目录；默认 output/daily/<日期>")
    parser.add_argument("--login-timeout-minutes", type=int, default=10)
    parser.add_argument("--slow-mo", type=int, default=700)
    parser.add_argument("--keep-open", action="store_true")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    result = asyncio.run(run(args))
    outputs = save_run(result, args.output_dir)
    print(json.dumps({"outputs": outputs, "modules": result["modules"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
