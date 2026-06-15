import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright


SHOP_URL = "https://compass.jinritemai.com/shop"
SESSION_DIR = Path(__file__).parent / "session"
BROWSERS_DIR = Path(__file__).parent / ".playwright-browsers"

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(BROWSERS_DIR))


async def main():
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=str(SESSION_DIR),
            headless=False,
            slow_mo=400,
        )
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(SHOP_URL, wait_until="domcontentloaded")
        try:
            await page.wait_for_load_state("networkidle", timeout=30000)
        except Exception:
            pass
        await page.wait_for_timeout(3000)

        print(f"TITLE: {await page.title()}")
        print(f"URL: {page.url}")

        lines = await page.locator("body").inner_text(timeout=10000)
        print("BODY_LINES:")
        for line in [item.strip() for item in lines.splitlines() if item.strip()][:80]:
            print(line)

        items = await page.locator("a, button, [role=button], [class*=shop], [class*=Shop]").evaluate_all(
            """
            els => els.slice(0, 180).map((el, index) => {
                const rect = el.getBoundingClientRect();
                return {
                    index,
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role') || '',
                    cls: el.className || '',
                    text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' '),
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                    visible: !!(rect.width || rect.height || el.getClientRects().length),
                };
            })
            """
        )
        print("ELEMENTS:")
        for item in items:
            if item["visible"] and (item["text"] or item["y"] < 160):
                print(item)

        top_items = await page.locator("body *").evaluate_all(
            """
            els => els.map((el, index) => {
                const rect = el.getBoundingClientRect();
                return {
                    index,
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role') || '',
                    aria: el.getAttribute('aria-label') || '',
                    href: el.getAttribute('href') || '',
                    cls: el.className || '',
                    text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                    cursor: getComputedStyle(el).cursor,
                    pointer: getComputedStyle(el).pointerEvents,
                    visible: !!(rect.width || rect.height || el.getClientRects().length),
                };
            }).filter(item =>
                item.visible &&
                item.y >= 0 &&
                item.y < 90 &&
                item.w > 0 &&
                item.h > 0 &&
                (
                    item.cursor === 'pointer' ||
                    item.text.includes('acer宏碁凡飞专卖店') ||
                    String(item.cls).includes('header') ||
                    String(item.cls).includes('Header')
                )
            )
            """
        )
        print("TOP_ELEMENTS:")
        for item in top_items:
            print(item)

        await context.close()


if __name__ == "__main__":
    asyncio.run(main())
