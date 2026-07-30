import asyncio
import json
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from apps.scraper_py.scraper import SHOP_URL, human_pause, wait_network_quiet

APP_DIR = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = APP_DIR / "output" / "channel"
MAX_RESPONSES = 240
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BODY_BYTES = 48 * 1024 * 1024
SENSITIVE_KEY_PARTS = (
    "token",
    "verify",
    "bogus",
    "cookie",
    "secret",
    "password",
    "signature",
)
ENDPOINTS = (
    "/compass_api/shop/common/flow/",
    "/compass_api/shop/common/homepage/product_list",
    "/compass_api/shop/common/homepage/search/",
    "/compass_api/shop/common/homepage/search_shop_rank",
    "/compass_api/shop/common/homepage/search_industry_rank",
    "/compass_api/shop/product_card/channel_product/channel_product_card_list",
    "/compass_api/shop/mall/dd_search/search_analysis/weekly_report_summary",
)


def is_business_response(url):
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    trusted_host = hostname == "jinritemai.com" or hostname.endswith(".jinritemai.com")
    return trusted_host and any(parsed.path.startswith(prefix) for prefix in ENDPOINTS)


def sanitized_url(url):
    parsed = urlparse(url)
    query = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.lower()
        if (
            "token" in lowered
            or "verify" in lowered
            or "bogus" in lowered
            or lowered in {"fp", "_lid"}
        ):
            continue
        query.append((key, value))
    return urlunparse(
        (parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(query), "")
    )


def sensitive_key(key):
    lowered = str(key).lower()
    return lowered in {"fp", "_lid"} or any(
        part in lowered for part in SENSITIVE_KEY_PARTS
    )


def sanitized_payload(value):
    if isinstance(value, dict):
        return {
            key: sanitized_payload(item)
            for key, item in value.items()
            if not sensitive_key(key)
        }
    if isinstance(value, list):
        return [sanitized_payload(item) for item in value]
    return value


def sanitized_post_data(raw):
    if not raw:
        return None
    try:
        return json.dumps(
            sanitized_payload(json.loads(raw)),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except json.JSONDecodeError:
        fields = [
            (key, value)
            for key, value in parse_qsl(raw, keep_blank_values=True)
            if not sensitive_key(key)
        ]
        return urlencode(fields) if fields else None


class ResponseCapture:
    def __init__(self):
        self.enabled = False
        self.shop_name = None
        self.items = []
        self.seen = set()
        self.tasks = set()
        self.body_bytes = 0

    def start_shop(self, shop_name):
        self.enabled = True
        self.shop_name = shop_name
        self.items = []
        self.seen = set()
        self.body_bytes = 0

    async def finish_shop(self):
        self.enabled = False
        if self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)
        return list(self.items)

    def handle_response(self, response):
        if not self.enabled or not is_business_response(response.url):
            return
        task = asyncio.create_task(self._capture(response, self.shop_name))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _capture(self, response, shop_name):
        if response.status != 200 or len(self.items) >= MAX_RESPONSES:
            return
        if "json" not in response.headers.get("content-type", "").lower():
            return
        post_data = response.request.post_data or ""
        key = (response.request.method, response.url, post_data)
        if key in self.seen:
            return
        self.seen.add(key)
        try:
            body_text = await response.text()
            body_size = len(body_text.encode("utf-8"))
            if (
                body_size > MAX_BODY_BYTES
                or self.body_bytes + body_size > MAX_TOTAL_BODY_BYTES
            ):
                print(
                    f"渠道响应过大，已跳过: {urlparse(response.url).path}", flush=True
                )
                return
            body = json.loads(body_text)
        except Exception:
            return
        self.body_bytes += body_size
        self.items.append(
            {
                "captured_at": datetime.now().isoformat(timespec="seconds"),
                "shop_name": shop_name,
                "method": response.request.method,
                "url": sanitized_url(response.url),
                "endpoint": urlparse(response.url).path,
                "post_data": sanitized_post_data(post_data),
                "body": body,
            }
        )


async def load(page):
    previous_height = 0
    stable_rounds = 0
    for _ in range(14):
        height = await page.evaluate("document.body.scrollHeight")
        await page.evaluate("window.scrollBy({ top: 900, behavior: 'smooth' })")
        await human_pause(1.0, 2.0)
        if height == previous_height:
            stable_rounds += 1
            if stable_rounds >= 2:
                break
        else:
            stable_rounds = 0
        previous_height = height

    tablists = page.locator('[role="tablist"]')
    date_tablists = []
    for index in range(await tablists.count()):
        tablist = tablists.nth(index)
        try:
            if not await tablist.is_visible():
                continue
            text = await tablist.inner_text(timeout=3000)
        except Exception:
            continue
        if "实时" in text and "近1天" in text and "近7天" in text:
            date_tablists.append(tablist)

    for module_index, tablist in enumerate(date_tablists[1:], start=1):
        candidates = tablist.get_by_role("tab", name="近1天", exact=True)
        targets = [
            candidates.nth(index)
            for index in range(await candidates.count())
            if await candidates.nth(index).is_visible()
        ]
        if len(targets) != 1:
            print(f"渠道模块 {module_index} 未唯一匹配近1天，跳过", flush=True)
            continue
        try:
            await targets[0].scroll_into_view_if_needed()
            await human_pause(1.0, 2.0)
            await targets[0].click(timeout=10000)
            await wait_network_quiet(page, timeout=30000)
            await human_pause(2.0, 4.0)
            print(f"渠道模块 {module_index} 已切换近1天", flush=True)
        except Exception as exc:
            print(
                f"渠道模块 {module_index} 切换近1天失败，保留其他数据: {exc!r}",
                flush=True,
            )
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
    await human_pause(1.5, 3.0)


def save(results, captured_at=None):
    captured = captured_at or datetime.now()
    day = next((item.get("data_end") for item in results if item.get("data_end")), None)
    day_slug = (day or captured.strftime("%Y/%m/%d")).replace("/", "-")
    stamp = captured.strftime("%Y%m%d_%H%M%S")
    directory = OUTPUT_ROOT / day_slug
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"compass_channel_{day_slug}_{stamp}.json"
    path.write_text(
        json.dumps(
            {
                "captured_at": captured.isoformat(timespec="seconds"),
                "source": SHOP_URL,
                "results": results,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
