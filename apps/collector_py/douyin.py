"""Read-only Compass collector for the Douyin dashboard panels.

Each panel is selected through the normal UI and records only trusted Compass
JSON responses.  The ``近1天`` request is validated against yesterday before
anything is written, so a delayed default range cannot silently enter storage.
"""

import asyncio
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from apps.collector_py.channel import (
    MAX_BODY_BYTES,
    MAX_RESPONSES,
    MAX_TOTAL_BODY_BYTES,
    sanitized_payload,
    sanitized_post_data,
    sanitized_url,
)
from apps.scraper_py.scraper import click_with_pacing, human_pause, wait_network_quiet

APP_DIR = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = APP_DIR / "output" / "douyin"
PAGE_SETTLE_TIMEOUT_MS = 15000
PANEL_SPECS = {
    "live": {
        "label": "直播",
        "url": "https://compass.jinritemai.com/shop/live-overview",
        # Compass opens the live-room list first; the overview tab is the
        # aggregate panel required by the dashboard.
        "before_near_day": "数据概览",
    },
    "video": {
        "label": "短视频",
        "url": "https://compass.jinritemai.com/shop/video/overview",
        "before_near_day": None,
    },
    "product_card": {
        "label": "商品卡",
        "url": "https://compass.jinritemai.com/shop/merchandise-traffic",
        "before_near_day": None,
    },
}


def expected_yesterday(today=None):
    value = (today or date.today()) - timedelta(days=1)
    formatted = value.strftime("%Y/%m/%d")
    return formatted, formatted


def _date_range_from_fields(fields, required_date_type="20"):
    if str(fields.get("date_type", [None])[0]) != required_date_type:
        return None
    begin = str(fields.get("begin_date", [""])[0]).split()[0]
    end = str(fields.get("end_date", [""])[0]).split()[0]
    if not begin or not end:
        return None
    try:
        return (
            datetime.strptime(begin.replace("/", "-"), "%Y-%m-%d").strftime("%Y/%m/%d"),
            datetime.strptime(end.replace("/", "-"), "%Y-%m-%d").strftime("%Y/%m/%d"),
        )
    except ValueError:
        return None


def date_range_from_request(url, post_data):
    result = _date_range_from_fields(parse_qs(urlparse(url).query))
    if result or not post_data:
        return result
    try:
        pending = [json.loads(post_data)]
    except json.JSONDecodeError:
        return _date_range_from_fields(parse_qs(post_data))
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            result = _date_range_from_fields(
                {key: [item] for key, item in value.items()}
            )
            if result:
                return result
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return None


def trusted_response(response):
    parsed = urlparse(response.url)
    hostname = (parsed.hostname or "").lower()
    return (
        response.status == 200
        and (hostname == "jinritemai.com" or hostname.endswith(".jinritemai.com"))
        and parsed.path.startswith("/compass_api/")
        and "json" in response.headers.get("content-type", "").lower()
    )


class PanelCapture:
    def __init__(self):
        self.enabled = False
        self.items = []
        self.tasks = set()
        self.seen = set()
        self.body_bytes = 0
        self.date_ranges = set()

    def start(self):
        self.enabled = True
        self.items = []
        self.tasks = set()
        self.seen = set()
        self.body_bytes = 0
        self.date_ranges = set()

    async def finish(self):
        self.enabled = False
        if self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)
        return list(self.items)

    def handle_response(self, response):
        if not self.enabled or not trusted_response(response):
            return
        task = asyncio.create_task(self._capture(response))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _capture(self, response):
        if len(self.items) >= MAX_RESPONSES:
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
                return
            body = sanitized_payload(json.loads(body_text))
        except Exception:
            return
        self.body_bytes += body_size
        data_range = date_range_from_request(response.url, post_data)
        if data_range:
            self.date_ranges.add(data_range)
        self.items.append(
            {
                "captured_at": datetime.now().isoformat(timespec="seconds"),
                "method": response.request.method,
                "url": sanitized_url(response.url),
                "endpoint": urlparse(response.url).path,
                "post_data": sanitized_post_data(post_data),
                "body": body,
            }
        )


async def collect_panel(page, panel, *, today=None):
    spec = PANEL_SPECS[panel]
    await page.goto(spec["url"], wait_until="domcontentloaded", timeout=90000)
    await wait_network_quiet(page, timeout=PAGE_SETTLE_TIMEOUT_MS)
    await human_pause(5.0, 10.0, reason=f"等待{spec['label']}页面稳定")
    if spec["before_near_day"]:
        await click_with_pacing(
            page.get_by_text(spec["before_near_day"], exact=True),
            f"{spec['label']} {spec['before_near_day']}",
        )
        await wait_network_quiet(page, timeout=PAGE_SETTLE_TIMEOUT_MS)

    capture = PanelCapture()
    page.on("response", capture.handle_response)
    try:
        capture.start()
        await click_with_pacing(
            page.get_by_text("近1天", exact=True), f"{spec['label']} 近1天"
        )
        await wait_network_quiet(page, timeout=PAGE_SETTLE_TIMEOUT_MS)
        await human_pause(3.0, 6.0, reason=f"等待{spec['label']}昨日数据加载")
        responses = await capture.finish()
    finally:
        page.remove_listener("response", capture.handle_response)
    expected = expected_yesterday(today)
    if capture.date_ranges != {expected}:
        raise RuntimeError(
            f"{spec['label']}“近1天”返回日期不正确: {sorted(capture.date_ranges)!r}; 预期 {expected!r}"
        )
    if not responses:
        raise RuntimeError(f"{spec['label']}未捕获到可信 Compass JSON 响应")
    return {
        "panel": panel,
        "label": spec["label"],
        "data_start": expected[0],
        "data_end": expected[1],
        "responses": responses,
    }


async def collect(page, shop_name, *, today=None):
    panels = []
    errors = []
    for panel in PANEL_SPECS:
        try:
            panels.append(await collect_panel(page, panel, today=today))
        except Exception as exc:
            errors.append({"panel": panel, "error": repr(exc)})
            print(
                f"{shop_name} {PANEL_SPECS[panel]['label']}面板失败: {exc!r}",
                flush=True,
            )
        await human_pause(
            8.0, 14.0, reason=f"等待{PANEL_SPECS[panel]['label']}采集间隔"
        )
    if not panels:
        raise RuntimeError(f"三个抖音面板均采集失败: {errors!r}")
    return {"shop_name": shop_name, "panels": panels, "errors": errors}


def save(results, captured_at=None):
    captured = captured_at or datetime.now()
    data_end = next(
        (
            panel.get("data_end")
            for item in results
            for panel in item.get("panels", [])
            if panel.get("data_end")
        ),
        None,
    )
    day_slug = (data_end or captured.strftime("%Y/%m/%d")).replace("/", "-")
    directory = OUTPUT_ROOT / day_slug
    directory.mkdir(parents=True, exist_ok=True)
    path = (
        directory
        / f"compass_douyin_{day_slug}_{captured.strftime('%Y%m%d_%H%M%S')}.json"
    )
    path.write_text(
        json.dumps(
            {"captured_at": captured.isoformat(timespec="seconds"), "results": results},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
