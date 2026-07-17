"""Import marketplace order exports into a privacy-safe daily dashboard snapshot.

The input workbooks are read locally.  Only per-day, per-shop aggregates are
written to the output JSON; buyer details, addresses and order identifiers are
never persisted in the dashboard snapshot.
"""

import argparse
import json
import os
from datetime import datetime
from pathlib import Path

import pandas as pd


APP_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = APP_DIR / "output" / "external_orders" / "orders_daily.json"
CLOSED_STATUS_WORDS = ("关闭", "取消", "作废", "退款")

SOURCE_CONFIGS = (
    {
        "match": "喵速达",
        "key": "miaosuda",
        "label": "订单明细 · 喵速达",
        "status_columns": ("订单状态", "状态"),
        "shop_columns": ("店铺名称",),
        "quantity_columns": ("商品数量", "订货数量", "实发数量"),
        "order_id_columns": ("外部订单号", "交易订单号", "系统单号"),
    },
    {
        "match": "天猫国际",
        "key": "tmall_global",
        "label": "订单明细 · 天猫国际",
        "status_columns": ("订单状态", "状态"),
        "shop_columns": ("店铺名称",),
        "quantity_columns": ("商品数量", "订货数量", "实发数量"),
        "order_id_columns": ("外部订单号", "交易订单号", "系统单号"),
    },
    {
        "match": "天猫优品",
        "key": "tmall_youpin",
        "label": "订单明细 · 天猫优品",
        "status_columns": ("状态", "订单状态"),
        "shop_columns": ("分销商店铺名称", "店铺名称"),
        "quantity_columns": ("订货数量", "商品数量", "实发数量"),
        "order_id_columns": ("外部订单号", "交易订单号", "系统单号"),
    },
)


def first_available(columns, candidates, label):
    for name in candidates:
        if name in columns:
            return name
    raise ValueError(f"缺少{label}列，可用列：{', '.join(map(str, columns))}")


def source_config(path):
    for config in SOURCE_CONFIGS:
        if config["match"] in path.name:
            return config
    raise ValueError(f"无法识别订单来源文件：{path.name}")


def parse_workbook_orders(path):
    """Return de-duplicated order rows for one workbook.

    Order identifiers are returned only in memory so the import ledger can
    calculate an irreversible de-duplication digest.  They are never written
    to the dashboard snapshot or returned by the web API.
    """
    config = source_config(path)
    frame = pd.read_excel(path)
    columns = frame.columns
    status_col = first_available(columns, config["status_columns"], "订单状态")
    shop_col = first_available(columns, config["shop_columns"], "店铺")
    quantity_col = first_available(columns, config["quantity_columns"], "商品数量")
    order_id_col = first_available(columns, config["order_id_columns"], "订单号")
    for required in ("支付时间", "订单金额"):
        if required not in columns:
            raise ValueError(f"{path.name} 缺少{required}列")

    orders = pd.DataFrame(
        {
            "paid_at": pd.to_datetime(frame["支付时间"], errors="coerce"),
            "status": frame[status_col].fillna("").astype(str),
            "shop": frame[shop_col].fillna("").astype(str).str.strip(),
            "order_id": frame[order_id_col].fillna("").astype(str).str.strip(),
            "amount_yuan": pd.to_numeric(frame["订单金额"], errors="coerce").fillna(0),
            "quantity": pd.to_numeric(frame[quantity_col], errors="coerce").fillna(0),
        }
    )
    orders["order_id"] = orders["order_id"].mask(orders["order_id"] == "", "row-" + orders.index.astype(str))
    closed = orders["status"].str.contains("|".join(CLOSED_STATUS_WORDS), regex=True)
    accepted = orders.loc[orders["paid_at"].notna() & orders["shop"].ne("") & ~closed].copy()

    # A single order may have multiple product rows.  Amount is order-level in
    # these exports, so retain it once while adding the item quantities.
    accepted["date"] = accepted["paid_at"].dt.strftime("%Y-%m-%d")
    deduplicated = (
        accepted.sort_values("paid_at")
        .groupby(["date", "shop", "order_id"], as_index=False)
        .agg(amount_yuan=("amount_yuan", "first"), quantity=("quantity", "sum"))
    )
    summary = (
        deduplicated.groupby(["date", "shop"], as_index=False)
        .agg(order_amount_yuan=("amount_yuan", "sum"), order_count=("order_id", "nunique"), item_count=("quantity", "sum"))
    )

    orders = []
    for row in deduplicated.to_dict("records"):
        orders.append(
            {
                "date": row["date"],
                "shop_name": row["shop"],
                "order_id": str(row["order_id"]),
                "amount_cent": round(float(row["amount_yuan"]) * 100, 2),
                "quantity": int(row["quantity"]),
                "source_key": config["key"],
                "source_label": config["label"],
                "source_file": path.name,
            }
        )

    return orders, {
        "source_key": config["key"],
        "source_label": config["label"],
        "source_file": path.name,
        "input_rows": int(len(frame)),
        "accepted_order_rows": int(len(accepted)),
        "accepted_orders": int(len(orders)),
        "daily_records": int(len(summary)),
    }


def daily_records_from_orders(orders):
    """Aggregate in-memory order rows into the public daily dashboard shape."""
    summary = {}
    for order in orders:
        key = (order["date"], order["shop_name"], order["source_key"])
        item = summary.setdefault(
            key,
            {
                "shop_id": f"external:{order['source_key']}:{order['shop_name']}",
                "shop_name": order["shop_name"],
                "date": order["date"],
                "metrics": {"income_amt": 0, "pay_amt": 0, "pay_cnt": 0, "pay_item_cnt": 0},
                "content": {},
                "trend": {},
                "source": "external_orders",
                "source_key": order["source_key"],
                "source_label": order["source_label"],
                "source_file": order.get("source_file", ""),
            },
        )
        metrics = item["metrics"]
        metrics["income_amt"] += order["amount_cent"]
        metrics["pay_amt"] += order["amount_cent"]
        metrics["pay_cnt"] += 1
        metrics["pay_item_cnt"] += order["quantity"]
    return sorted(summary.values(), key=lambda item: (item["date"], item["shop_name"], item["source_key"]))


def parse_workbook(path):
    orders, metadata = parse_workbook_orders(path)
    return daily_records_from_orders(orders), metadata


def write_snapshot(records, imports, output_path):
    payload = {
        "schema_version": 1,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "imports": imports,
        "records": sorted(records, key=lambda item: (item["date"], item["shop_name"])),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, output_path)


def parse_args():
    parser = argparse.ArgumentParser(description="汇总外部平台订单明细到经营看板")
    parser.add_argument("files", nargs="+", type=Path, help="订单明细 .xlsx 文件")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="聚合快照输出路径")
    return parser.parse_args()


def main():
    args = parse_args()
    records, imports = [], []
    for path in args.files:
        if not path.exists():
            raise FileNotFoundError(path)
        source_records, metadata = parse_workbook(path)
        records.extend(source_records)
        imports.append(metadata)
    write_snapshot(records, imports, args.output)
    print(f"已写入 {args.output}，包含 {len(records)} 条店铺日汇总")


if __name__ == "__main__":
    main()
