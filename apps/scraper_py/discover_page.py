import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright


ROOT_URL = "https://compass.jinritemai.com/"
APP_DIR = Path(__file__).resolve().parents[2]
SESSION_DIR = APP_DIR / "session"
BROWSERS_DIR = APP_DIR / ".playwright-browsers"

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(BROWSERS_DIR))


async def main():
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=str(SESSION_DIR),
            headless=False,
        )
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(ROOT_URL, wait_until="domcontentloaded")
        await page.wait_for_load_state("networkidle", timeout=30000)

        login_button = page.get_by_role("button", name="登录")
        if await login_button.count():
            await login_button.first.click()
            await page.wait_for_timeout(1000)

        print(f"TITLE: {await page.title()}")
        print(f"URL: {page.url}")

        items = await page.locator("a, button").evaluate_all(
            """
            els => els.slice(0, 120).map((el, index) => ({
                index,
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' '),
                href: el.href || '',
                target: el.target || '',
                visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
            }))
            """
        )
        for item in items:
            if item["text"] or item["href"]:
                print(
                    f'[{item["index"]}] {item["tag"]} visible={item["visible"]} '
                    f'text="{item["text"]}" href="{item["href"]}" target="{item["target"]}"'
                )

        shop_link = page.get_by_role("link", name="商家入口")
        if await shop_link.count():
            try:
                async with context.expect_page(timeout=5000) as page_info:
                    await shop_link.click()
                new_page = await page_info.value
                await new_page.wait_for_load_state("domcontentloaded", timeout=30000)
                try:
                    await new_page.wait_for_load_state("networkidle", timeout=30000)
                except Exception:
                    pass
                await new_page.wait_for_timeout(5000)
                print(f"NEW_PAGE_TITLE: {await new_page.title()}")
                print(f"NEW_PAGE_URL: {new_page.url}")
                new_items = await new_page.locator("a, button").evaluate_all(
                    """
                    els => els.slice(0, 80).map((el, index) => ({
                        index,
                        tag: el.tagName.toLowerCase(),
                        text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' '),
                        href: el.href || '',
                        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
                    }))
                    """
                )
                for item in new_items:
                    if item["text"] or item["href"]:
                        print(
                            f'NEW[{item["index"]}] {item["tag"]} visible={item["visible"]} '
                            f'text="{item["text"]}" href="{item["href"]}"'
                        )
            except Exception as exc:
                print(f"NO_NEW_PAGE: {exc}")
                print(f"AFTER_CLICK_TITLE: {await page.title()}")
                print(f"AFTER_CLICK_URL: {page.url}")

        for index, opened_page in enumerate(context.pages):
            print(f"PAGE[{index}]: {await opened_page.title()} | {opened_page.url}")

        await context.close()


if __name__ == "__main__":
    asyncio.run(main())
