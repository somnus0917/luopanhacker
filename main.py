import argparse
import asyncio

from db import init_db, insert, query_all
from dashboard import build_dashboard
from scraper import scrape_once


async def run_once(shops=None):
    captured = await scrape_once(shops)
    conn = init_db()
    try:
        for item in captured:
            insert(
                conn,
                item["url"],
                item["body_preview"],
                item.get("body"),
                item.get("shop_id"),
                item.get("shop_name"),
            )
    finally:
        conn.close()

    print(f"已存 {len(captured)} 条")


def show():
    conn = init_db()
    try:
        rows = query_all(conn)
    finally:
        conn.close()

    for row in rows:
        id_, captured_at, url, body_preview = row
        print(f"[{id_}] {captured_at}")
        print(f"URL: {url}")
        print(f"BODY: {body_preview}")
        print("-" * 80)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["once", "show", "dashboard"])
    parser.add_argument("--shop", action="append", help="指定要抓取的店铺名，可重复传入")
    args = parser.parse_args()

    if args.command == "once":
        asyncio.run(run_once(args.shop))
    elif args.command == "show":
        show()
    else:
        path, records, shops = build_dashboard()
        print(f"已生成 {path}，包含 {shops} 个店铺、{records} 条店铺日期记录")


if __name__ == "__main__":
    main()
