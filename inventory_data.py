"""Read and aggregate the local inventory snapshot for the web dashboard."""

from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


SNAPSHOT_PATH = Path(__file__).parent / "output" / "inventory" / "inventory_snapshot.json"
HISTORY_DIR = SNAPSHOT_PATH.parent / "history"
ACTUAL_TURNOVER_WINDOW_DAYS = 30


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def rounded(value: float) -> float:
    return round(value, 4)


def read_snapshot(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def historical_turnover() -> dict[str, Any]:
    """Calculate actual 30-day turnover only from complete daily close samples."""
    snapshots: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(HISTORY_DIR.glob("????-??-??.json")):
        snapshot = read_snapshot(path)
        if isinstance(snapshot, dict) and isinstance(snapshot.get("inventory"), list):
            snapshots.append((path.stem, snapshot))

    snapshots = snapshots[-ACTUAL_TURNOVER_WINDOW_DAYS:]
    dates = [date for date, _ in snapshots]
    result: dict[str, Any] = {
        "required_days": ACTUAL_TURNOVER_WINDOW_DAYS,
        "available_days": len(dates),
        "dates": dates,
        "ready": False,
        "average_available_num": None,
        "sales_quantity": None,
        "actual_turnover_days": None,
    }
    if len(dates) != ACTUAL_TURNOVER_WINDOW_DAYS:
        return result

    # Do not label a set of sporadic samples as a 30-day operating metric.
    try:
        first = datetime.fromisoformat(dates[0]).date()
        last = datetime.fromisoformat(dates[-1]).date()
    except ValueError:
        return result
    if (last - first).days != ACTUAL_TURNOVER_WINDOW_DAYS - 1:
        return result

    average_available = sum(
        sum(number(row.get("available_num")) for row in snapshot["inventory"])
        for _, snapshot in snapshots
    ) / len(snapshots)
    sales_by_detail_date: dict[tuple[str, str, str], float] = {}
    for _, snapshot in snapshots:
        for row in snapshot.get("sales_7d", []):
            key = (str(row.get("date") or ""), str(row.get("warehouse_no") or ""), str(row.get("spec_no") or ""))
            if all(key):
                # Later close snapshots contain the most mature version of the
                # same business date, avoiding double-counting rolling windows.
                sales_by_detail_date[key] = number(row.get("quantity"))
    sales_quantity = sum(sales_by_detail_date.values())
    result.update({
        "ready": sales_quantity > 0,
        "average_available_num": rounded(average_available),
        "sales_quantity": rounded(sales_quantity),
        "actual_turnover_days": rounded(average_available / (sales_quantity / ACTUAL_TURNOVER_WINDOW_DAYS)) if sales_quantity else None,
    })
    return result


TARGET_COVER_DAYS = 30
SAFETY_STOCK_DAYS = 7


def health_for(available_num: float, sales_7d: float) -> tuple[str, str, int | None, int]:
    """Return a stable, UI-ready inventory health classification.

    The snapshot has a 7-day outbound window, so rows with no outbound are
    deliberately described as "7-day no movement" rather than long-term
    stagnant stock. That prevents the dashboard from implying a longer sales
    history than is actually present.
    """
    daily_sales = sales_7d / 7
    coverage_days = math.ceil(max(available_num, 0) / daily_sales) if daily_sales else None
    replenish_qty = math.ceil(max(0, (TARGET_COVER_DAYS + SAFETY_STOCK_DAYS) * daily_sales - max(available_num, 0))) if daily_sales else 0

    if available_num <= 0 and sales_7d > 0:
        return "out_of_stock", "已缺货", coverage_days, replenish_qty
    if not sales_7d and available_num > 0:
        return "no_movement", "近 7 日未动销", None, 0
    if sales_7d and coverage_days is not None and coverage_days < 7:
        return "urgent", "紧急补货", coverage_days, replenish_qty
    if sales_7d and coverage_days is not None and coverage_days < 14:
        return "replenish", "需安排补货", coverage_days, replenish_qty
    if sales_7d and coverage_days is not None and coverage_days <= 45:
        return "healthy", "库存健康", coverage_days, 0
    if sales_7d and coverage_days is not None and coverage_days <= 90:
        return "high", "库存偏高", coverage_days, 0
    if sales_7d:
        return "overstock", "库存积压", coverage_days, 0
    return "unavailable", "暂无可售", None, 0


def load_inventory_dashboard() -> dict[str, Any] | None:
    snapshot = read_snapshot(SNAPSHOT_PATH)
    if snapshot is None:
        return None

    sales = defaultdict(float)
    for row in snapshot.get("sales_7d", []):
        sales[(row.get("warehouse_no", ""), row.get("spec_no", ""))] += number(row.get("quantity"))
    inbound = defaultdict(float)
    for row in snapshot.get("inbound_30d", []):
        inbound[(row.get("warehouse_no", ""), row.get("spec_no", ""))] += number(row.get("quantity"))

    rows = []
    for row in snapshot.get("inventory", []):
        item = dict(row)
        key = (item.get("warehouse_no", ""), item.get("spec_no", ""))
        item["sales_7d"] = rounded(sales[key])
        item["inbound_30d"] = rounded(inbound[key])
        health_key, health_name, coverage_days, replenish_qty = health_for(
            number(item.get("available_num")), item["sales_7d"]
        )
        item["health_key"] = health_key
        item["health_name"] = health_name
        item["coverage_days"] = coverage_days
        item["replenish_qty"] = replenish_qty
        rows.append(item)

    warehouse_names = {
        str(row.get("warehouse_no") or ""): str(row.get("warehouse_name") or row.get("warehouse_no") or "未命名仓库")
        for row in rows
    }

    def build_group(key_name: str) -> list[dict[str, Any]]:
        groups: dict[str, dict[str, Any]] = {}
        for row in rows:
            name = row.get(key_name) or "未归类"
            group = groups.setdefault(name, {"name": name, "sku_records": 0, "stock_num": 0.0, "available_num": 0.0, "sales_7d": 0.0, "inbound_30d": 0.0, "negative_available": 0})
            group["sku_records"] += 1
            for metric in ("stock_num", "available_num", "sales_7d", "inbound_30d"):
                group[metric] += number(row.get(metric))
            group["negative_available"] += number(row.get("available_num")) < 0
        result = []
        for group in groups.values():
            group["turnover_days"] = rounded(group["available_num"] / (group["sales_7d"] / 7)) if group["sales_7d"] else None
            for metric in ("stock_num", "available_num", "sales_7d", "inbound_30d"):
                group[metric] = rounded(group[metric])
            result.append(group)
        return sorted(result, key=lambda item: item["available_num"], reverse=True)

    total_available = sum(number(row.get("available_num")) for row in rows)
    total_sales_7d = sum(number(row.get("quantity")) for row in snapshot.get("sales_7d", []))
    health_order = ["out_of_stock", "urgent", "replenish", "healthy", "high", "overstock", "no_movement", "unavailable"]
    health_names = {
        "out_of_stock": "已缺货", "urgent": "紧急补货", "replenish": "需安排补货", "healthy": "库存健康",
        "high": "库存偏高", "overstock": "库存积压", "no_movement": "近 7 日未动销", "unavailable": "暂无可售",
    }
    health = []
    for key in health_order:
        members = [row for row in rows if row["health_key"] == key]
        health.append({
            "key": key,
            "name": health_names[key],
            "sku_records": len(members),
            "available_num": rounded(sum(number(row.get("available_num")) for row in members)),
        })

    sales_by_date = defaultdict(float)
    sales_by_warehouse_date: dict[str, defaultdict[str, float]] = defaultdict(lambda: defaultdict(float))
    for row in snapshot.get("sales_7d", []):
        if row.get("date"):
            quantity = number(row.get("quantity"))
            sales_by_date[row["date"]] += quantity
            warehouse_name = warehouse_names.get(str(row.get("warehouse_no") or ""), "未命名仓库")
            sales_by_warehouse_date[warehouse_name][row["date"]] += quantity
    sales_trend_7d = [{"date": date, "quantity": rounded(quantity)} for date, quantity in sorted(sales_by_date.items())]
    sales_trend_7d_by_warehouse = {
        warehouse: [{"date": date, "quantity": rounded(quantity)} for date, quantity in sorted(values.items())]
        for warehouse, values in sales_by_warehouse_date.items()
    }
    coverage_rows = [row["coverage_days"] for row in rows if row["coverage_days"] is not None and row["sales_7d"] > 0]
    summary = {
        "sku_records": len(rows),
        "distinct_skus": len({row.get("spec_no") for row in rows if row.get("spec_no")}),
        "salable_skus": len({row.get("spec_no") for row in rows if number(row.get("available_num")) > 0}),
        "stock_num": rounded(sum(number(row.get("stock_num")) for row in rows)),
        "available_num": rounded(total_available),
        "sales_7d": rounded(total_sales_7d),
        "inbound_30d": rounded(sum(number(row.get("quantity")) for row in snapshot.get("inbound_30d", []))),
        "negative_available": sum(number(row.get("available_num")) < 0 for row in rows),
        "turnover_days": rounded(total_available / (total_sales_7d / 7)) if total_sales_7d else None,
        "average_coverage_days": rounded(sum(coverage_rows) / len(coverage_rows)) if coverage_rows else None,
        "replenishment_records": sum(row["health_key"] in {"out_of_stock", "urgent", "replenish"} for row in rows),
        "no_movement_records": sum(row["health_key"] == "no_movement" for row in rows),
        "overstock_records": sum(row["health_key"] in {"overstock", "high"} for row in rows),
    }
    priority = {key: index for index, key in enumerate(health_order)}
    rows.sort(key=lambda row: (priority[row["health_key"]], number(row.get("coverage_days") or 10**9), -number(row.get("sales_7d"))))
    history = historical_turnover()
    summary["actual_turnover_30d"] = history["actual_turnover_days"]
    summary["history_days"] = history["available_days"]
    return {
        "captured_at": snapshot.get("captured_at"),
        "source": snapshot.get("source", {}),
        "summary": summary,
        "warehouses": build_group("warehouse_name"),
        "brands": build_group("brand_name"),
        "health": health,
        "sales_trend_7d": sales_trend_7d,
        "sales_trend_7d_by_warehouse": sales_trend_7d_by_warehouse,
        "settings": {"target_cover_days": TARGET_COVER_DAYS, "safety_stock_days": SAFETY_STOCK_DAYS},
        "history": history,
        "rows": rows,
    }
