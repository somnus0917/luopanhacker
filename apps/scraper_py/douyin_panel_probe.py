"""Low-frequency, read-only probe for the Douyin panel data sources.

The probe deliberately mirrors the established Compass collector: it opens a
headed persistent browser, waits for page activity to settle, and uses the
same randomized pauses around every click.  It does not export data from the
Compass UI or alter data in the shop; it records only the sanitized endpoint
list and verifies that the ``近1天`` selection resolves to yesterday.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import BrowserContext, Page, Response, async_playwright

from apps.collector_py.compass import (
    clear_stale_chromium_singletons,
    date_range_from_request,
)
from apps.collector_py.channel import sanitized_url
from apps.scraper_py.scraper import (
    SESSION_DIR,
    click_with_pacing,
    human_pause,
    wait_network_quiet,
)

APP_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = APP_DIR / "output" / "probe"
PAGE_SETTLE_TIMEOUT_MS = 15000

PANEL_SPECS = {
    "live": {
        "label": "直播",
        "url": "https://compass.jinritemai.com/shop/live-overview",
        # The linked page defaults to a live-room list.  Its overview tab is
        # the authoritative aggregate view for our dashboard.
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


def expected_yesterday(today: date | None = None) -> tuple[str, str]:
    """Return Compass's date formatting for the completed previous day."""
    value = (today or date.today()) - timedelta(days=1)
    formatted = value.strftime("%Y/%m/%d")
    return formatted, formatted


def assert_yesterday(
    ranges: set[tuple[str, str]], *, today: date | None = None
) -> tuple[str, str]:
    """Fail closed unless the post-click Compass requests resolve to yesterday."""
    expected = expected_yesterday(today)
    if ranges != {expected}:
        raise RuntimeError(
            f"“近1天”返回日期与昨天不一致：实际 {sorted(ranges)!r}，预期 {expected!r}"
        )
    return expected


def trusted_compass_response(response: Response) -> bool:
    parsed = urlparse(response.url)
    hostname = (parsed.hostname or "").lower()
    return (
        response.status == 200
        and (hostname == "jinritemai.com" or hostname.endswith(".jinritemai.com"))
        and parsed.path.startswith("/compass_api/")
    )


class NearDayProbeCapture:
    """Record only metadata for requests caused by one ``近1天`` selection."""

    def __init__(self) -> None:
        self.enabled = False
        self.endpoints: set[str] = set()
        self.date_ranges: set[tuple[str, str]] = set()

    def start(self) -> None:
        self.enabled = True
        self.endpoints.clear()
        self.date_ranges.clear()

    def stop(self) -> None:
        self.enabled = False

    def handle(self, response: Response) -> None:
        if not self.enabled or not trusted_compass_response(response):
            return
        self.endpoints.add(sanitized_url(response.url))
        request = response.request
        value = date_range_from_request(
            response.url, request.post_data or "", required_date_type="20"
        )
        if value:
            self.date_ranges.add(value)


async def probe_panel(
    page: Page, panel: str, today: date | None = None
) -> dict[str, object]:
    spec = PANEL_SPECS[panel]
    await page.goto(str(spec["url"]), wait_until="domcontentloaded", timeout=90000)
    # Short-video and product-card pages keep background telemetry active.
    # A bounded settle window preserves the human-paced workflow without
    # waiting indefinitely for a network-idle state that may never arrive.
    await wait_network_quiet(page, timeout=PAGE_SETTLE_TIMEOUT_MS)
    await human_pause(5.0, 10.0, reason=f"等待{spec['label']}页面稳定")

    before_near_day = spec["before_near_day"]
    if before_near_day:
        await click_with_pacing(
            page.get_by_text(str(before_near_day), exact=True),
            f"{spec['label']} {before_near_day}",
        )
        await wait_network_quiet(page, timeout=PAGE_SETTLE_TIMEOUT_MS)

    capture = NearDayProbeCapture()
    page.on("response", capture.handle)
    try:
        capture.start()
        await click_with_pacing(
            page.get_by_text("近1天", exact=True), f"{spec['label']} 近1天"
        )
        await wait_network_quiet(page, timeout=PAGE_SETTLE_TIMEOUT_MS)
        data_range = assert_yesterday(capture.date_ranges, today=today)
    finally:
        capture.stop()
        page.remove_listener("response", capture.handle)

    return {
        "panel": panel,
        "label": spec["label"],
        "data_start": data_range[0],
        "data_end": data_range[1],
        "endpoint_count": len(capture.endpoints),
        "endpoints": sorted(capture.endpoints),
    }


async def run_probe(
    args: argparse.Namespace, *, today: date | None = None
) -> list[dict[str, object]]:
    selected_panels = args.panel or list(PANEL_SPECS)
    clear_stale_chromium_singletons()
    options: dict[str, object] = {
        "user_data_dir": str(SESSION_DIR),
        "headless": False,
        "slow_mo": args.slow_mo,
        "viewport": {"width": 1440, "height": 1000},
    }
    chromium_path = os.getenv("CHROMIUM_EXECUTABLE_PATH")
    if chromium_path:
        options["executable_path"] = chromium_path

    async with async_playwright() as playwright:
        context: BrowserContext = await playwright.chromium.launch_persistent_context(
            **options
        )
        try:
            context.set_default_timeout(60000)
            page = context.pages[0] if context.pages else await context.new_page()
            results = []
            for panel in selected_panels:
                results.append(await probe_panel(page, panel, today=today))
                await human_pause(
                    8.0, 14.0, reason=f"等待{PANEL_SPECS[panel]['label']}采集间隔"
                )
            if args.keep_open:
                await asyncio.sleep(60)
            return results
        finally:
            try:
                await asyncio.wait_for(context.close(), timeout=30)
            except Exception as exc:
                print(f"关闭试抓浏览器失败: {exc!r}", flush=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="试抓抖音直播、短视频与商品卡昨日接口")
    parser.add_argument("--panel", action="append", choices=tuple(PANEL_SPECS))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--slow-mo", type=int, default=700)
    parser.add_argument("--keep-open", action="store_true")
    return parser.parse_args(argv)


def save_result(results: list[dict[str, object]], output_dir: str) -> Path:
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output = directory / f"douyin_panel_probe_{stamp}.json"
    output.write_text(
        json.dumps(
            {
                "captured_at": datetime.now().isoformat(timespec="seconds"),
                "results": results,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return output


def main() -> None:
    args = parse_args()
    results = asyncio.run(run_probe(args))
    output = save_result(results, args.output_dir)
    print(json.dumps({"output": str(output), "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
