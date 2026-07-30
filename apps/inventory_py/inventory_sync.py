"""Build a read-only inventory snapshot for the Compass dashboard.

Only three allow-listed, standard WDT query APIs are used here.  The script
never calls a create, update, acknowledgement, stocktake, stock-in, or
stock-out API.  It also deliberately discards order recipient data returned
by the sales-outbound endpoint before writing the local snapshot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


APP_DIR = Path(__file__).resolve().parents[2]
INVENTORY_DIR = APP_DIR / "output" / "inventory"
SNAPSHOT_PATH = INVENTORY_DIR / "inventory_snapshot.json"
HISTORY_DIR = INVENTORY_DIR / "history"
STATE_PATH = INVENTORY_DIR / "sync_state.json"
LOCK_PATH = INVENTORY_DIR / ".sync.lock"
GATEWAY = "https://api.wangdian.cn/openapi2/"
ALLOWED_APIS = {
    "inventory": "stock_query.php",
    "sales_outbound": "stockout_order_query_trade.php",
    "stock_inbound": "stockin_order_query.php",
}
PAGE_SIZE = 100
MAX_PAGES = 500
SHANGHAI = ZoneInfo("Asia/Shanghai")
SCHEMA_VERSION = 3
STALE_LOCK_SECONDS = 3 * 60 * 60


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def atomic_write_json(path: Path, payload: Any) -> Path:
    """Write complete JSON or leave the previous file untouched on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def inventory_key(row: dict[str, Any]) -> tuple[str, str]:
    return str(row.get("warehouse_no") or ""), str(row.get("spec_no") or "")


def deleted(row: dict[str, Any]) -> bool:
    return str(row.get("is_deleted") or row.get("deleted") or "0").strip().lower() in {"1", "true", "yes"}


def pid_running(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except (TypeError, ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True
    return True


@contextmanager
def sync_lock(now: datetime) -> Iterator[None]:
    """Prevent concurrent API runs; recover only clearly stale local locks."""
    INVENTORY_DIR.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    metadata = {"token": token, "pid": os.getpid(), "started_at": now.isoformat(timespec="seconds")}
    try:
        descriptor = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        existing = read_json(LOCK_PATH, {}) or {}
        age_seconds = max(0, time.time() - LOCK_PATH.stat().st_mtime) if LOCK_PATH.exists() else 0
        if age_seconds > STALE_LOCK_SECONDS and not pid_running(existing.get("pid")):
            LOCK_PATH.unlink(missing_ok=True)
            descriptor = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        else:
            raise RuntimeError("已有库存同步任务在运行；为避免覆盖数据，本次同步未执行")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(metadata, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        yield
    finally:
        existing = read_json(LOCK_PATH, {}) or {}
        if existing.get("token") == token:
            LOCK_PATH.unlink(missing_ok=True)


def credentials() -> tuple[str, str, str]:
    sid = os.getenv("WDT_SID", "").strip()
    appkey = os.getenv("WDT_APPKEY", "").strip()
    appsecret = os.getenv("WDT_APPSECRET", "").strip()
    if not all((sid, appkey, appsecret)):
        raise RuntimeError("请设置 WDT_SID、WDT_APPKEY 与 WDT_APPSECRET 环境变量")
    return sid, appkey, appsecret


def sign(params: dict[str, str], appsecret: str) -> str:
    encoded = ";".join(
        f"{len(key.encode()):02d}-{key}:{len(value.encode()):04d}-{value}"
        for key, value in sorted(params.items())
    )
    return hashlib.md5(f"{encoded}{appsecret}".encode()).hexdigest()


def request_page(api_name: str, params: dict[str, str]) -> dict[str, Any]:
    """Call exactly one allow-listed read endpoint and return its JSON body."""
    if api_name not in ALLOWED_APIS:
        raise ValueError(f"不允许调用的接口：{api_name}")

    sid, appkey, appsecret = credentials()
    payload = {
        "sid": sid,
        "appkey": appkey,
        "timestamp": str(int(time.time())),
        **params,
    }
    payload["sign"] = sign(payload, appsecret)
    url = f"{GATEWAY}{ALLOWED_APIS[api_name]}"
    body = urlencode(payload).encode()
    with urlopen(Request(url, data=body, method="POST"), timeout=45) as response:
        result = json.load(response)
    if result.get("code") != 0:
        raise RuntimeError(f"{ALLOWED_APIS[api_name]} 调用失败：{result.get('message') or result.get('code')}")
    return result


def fetch_all(api_name: str, params: dict[str, str], list_key: str) -> list[dict[str, Any]]:
    first = request_page(api_name, {**params, "page_no": "0", "page_size": str(PAGE_SIZE)})
    total = int(first.get("total_count") or 0)
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    if pages > MAX_PAGES:
        raise RuntimeError(f"{ALLOWED_APIS[api_name]} 返回 {total} 条，超过安全上限")

    records = list(first.get(list_key) or [])
    for page_no in range(1, pages):
        page = request_page(api_name, {**params, "page_no": str(page_no), "page_size": str(PAGE_SIZE)})
        records.extend(page.get(list_key) or [])
    return records


def inventory_rows(now: datetime) -> list[dict[str, Any]]:
    raw_rows = fetch_all(
        "inventory",
        {
            "start_time": (now - timedelta(days=29)).strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": now.strftime("%Y-%m-%d %H:%M:%S"),
            "is_deleted": "1",
            "spec_is_deleted": "0",
        },
        "stocks",
    )
    return [
        {
            "warehouse_no": row.get("warehouse_no", ""),
            "warehouse_name": row.get("warehouse_name") or row.get("warehouse_no") or "未命名仓库",
            "brand_no": row.get("brand_no", ""),
            "brand_name": row.get("brand_name") or "未归类品牌",
            "goods_no": row.get("goods_no", ""),
            "goods_name": row.get("goods_name", ""),
            "spec_no": row.get("spec_no", ""),
            "spec_name": row.get("spec_name", ""),
            "stock_num": number(row.get("stock_num")),
            "available_num": number(row.get("avaliable_num", row.get("available_num"))),
            "lock_num": number(row.get("lock_num")),
            "today_num": number(row.get("today_num", row.get("stock_today_num"))),
            # WDT returns unit cost in yuan. Keep zero values too; the
            # dashboard treats non-positive costs as not yet maintained.
            "cost_price": number(row.get("cost_price")),
            "last_inout_time": row.get("last_inout_time"),
            "modified": row.get("modified"),
            # Deletion markers are only used while merging incremental data;
            # they are removed before a snapshot is persisted.
            "deleted": deleted(row),
        }
        for row in raw_rows
    ]


def aggregate_order_details(
    raw_orders: list[dict[str, Any]],
    quantity_field: str,
    date_field: str,
) -> list[dict[str, Any]]:
    """Keep only SKU, warehouse, quantity and business date; discard PII."""
    totals: dict[tuple[str, str, str], float] = defaultdict(float)
    for order in raw_orders:
        warehouse_no = str(order.get("warehouse_no") or "")
        business_date = str(order.get(date_field) or "")[:10]
        if not business_date:
            continue
        for detail in order.get("details_list") or []:
            spec_no = str(detail.get("spec_no") or "")
            if spec_no:
                totals[(warehouse_no, spec_no, business_date)] += number(detail.get(quantity_field))
    return [
        {
            "warehouse_no": warehouse_no,
            "spec_no": spec_no,
            "date": business_date,
            "quantity": round(quantity, 4),
        }
        for (warehouse_no, spec_no, business_date), quantity in sorted(totals.items())
    ]


def sales_rows(now: datetime) -> list[dict[str, Any]]:
    raw_orders = fetch_all(
        "sales_outbound",
        {
            "start_time": (now - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": now.strftime("%Y-%m-%d %H:%M:%S"),
            "is_no_position": "1",
        },
        "stockout_list",
    )
    return aggregate_order_details(raw_orders, "goods_count", "consign_time")


def inbound_rows(now: datetime) -> list[dict[str, Any]]:
    raw_orders = fetch_all(
        "stock_inbound",
        {
            "start_time": (now - timedelta(days=29)).strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": now.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "stockin_list",
    )
    return aggregate_order_details(raw_orders, "goods_count", "check_time")


def merge_inventory(
    previous_rows: list[dict[str, Any]], incremental_rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, int | str]]:
    """Merge changed inventory into the last known stock baseline.

    ``stock_query.php`` is an incremental source. Replacing the last snapshot
    with only today's changed rows would silently make unchanged stock vanish,
    so a local baseline is kept and only valid warehouse/SKU changes alter it.
    """
    records: dict[tuple[str, str], dict[str, Any]] = {}
    for item in previous_rows:
        key = inventory_key(item)
        if all(key) and not deleted(item):
            records[key] = {key: value for key, value in item.items() if key not in {"deleted", "is_deleted"}}

    updated = removed = skipped = 0
    for item in incremental_rows:
        key = inventory_key(item)
        if not all(key):
            skipped += 1
            continue
        if deleted(item):
            if key in records:
                records.pop(key)
                removed += 1
            continue
        records[key] = {key: value for key, value in item.items() if key not in {"deleted", "is_deleted"}}
        updated += 1

    return (
        [records[key] for key in sorted(records)],
        {
            "mode": "incremental_merged" if previous_rows else "initial_incremental_window",
            "previous_records": len(previous_rows),
            "changed_records": updated,
            "deleted_records": removed,
            "skipped_records": skipped,
            "result_records": len(records),
        },
    )


def validate_snapshot(snapshot: dict[str, Any], previous_snapshot: dict[str, Any] | None = None) -> None:
    """Reject incomplete or implausible data before it can replace a good file."""
    inventory = snapshot.get("inventory")
    if not isinstance(inventory, list) or not inventory:
        raise RuntimeError("库存快照校验失败：没有有效库存记录")

    keys: set[tuple[str, str]] = set()
    for row in inventory:
        key = inventory_key(row)
        if not all(key):
            raise RuntimeError("库存快照校验失败：存在缺少仓库或 SKU 编码的记录")
        if key in keys:
            raise RuntimeError(f"库存快照校验失败：仓库/SKU 重复 {key[0]}/{key[1]}")
        keys.add(key)
        for field in ("stock_num", "available_num", "lock_num", "today_num"):
            if not math.isfinite(number(row.get(field))):
                raise RuntimeError(f"库存快照校验失败：{key[0]}/{key[1]} 的 {field} 无效")

    for name in ("sales_7d", "inbound_30d"):
        records = snapshot.get(name)
        if not isinstance(records, list):
            raise RuntimeError(f"库存快照校验失败：{name} 不是列表")
        for row in records:
            if not all(inventory_key(row)) or not str(row.get("date") or ""):
                raise RuntimeError(f"库存快照校验失败：{name} 存在缺少仓库、SKU 或日期的记录")
            if not math.isfinite(number(row.get("quantity"))) or number(row.get("quantity")) < 0:
                raise RuntimeError(f"库存快照校验失败：{name} 存在无效数量")

    previous_inventory = (previous_snapshot or {}).get("inventory") or []
    if len(previous_inventory) >= 20 and len(inventory) < len(previous_inventory) * 0.5:
        raise RuntimeError("库存快照校验失败：记录数较上一份快照骤降超过 50%，已保留旧快照")


def build_snapshot(now: datetime | None = None, previous_snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    now = now or datetime.now(SHANGHAI)
    previous_snapshot = previous_snapshot or {}
    inventory, merge = merge_inventory(previous_snapshot.get("inventory") or [], inventory_rows(now))
    return {
        "schema_version": SCHEMA_VERSION,
        "captured_at": now.isoformat(timespec="seconds"),
        "source": {
            "mode": "read_only_standard_apis",
            "apis": list(ALLOWED_APIS.values()),
            "inventory_window_days": 29,
            "sales_window_days": 7,
            "inbound_window_days": 29,
        },
        "integrity": {
            "inventory_merge": merge,
            "privacy": "outbound recipient and address data are discarded before persistence",
        },
        "inventory": inventory,
        "sales_7d": sales_rows(now),
        "inbound_30d": inbound_rows(now),
    }


def save_snapshot(snapshot: dict[str, Any]) -> Path:
    return atomic_write_json(SNAPSHOT_PATH, snapshot)


def history_path_for(snapshot: dict[str, Any]) -> Path:
    captured_at = str(snapshot.get("captured_at") or "")
    try:
        history_date = datetime.fromisoformat(captured_at).astimezone(SHANGHAI).date().isoformat()
    except ValueError as error:
        raise RuntimeError("库存快照缺少有效 captured_at，无法写入日结历史") from error
    return HISTORY_DIR / f"{history_date}.json"


def save_daily_history(snapshot: dict[str, Any]) -> tuple[Path, bool]:
    """Write one immutable close-of-day sample; a later refresh never rewrites it."""
    path = history_path_for(snapshot)
    existing = read_json(path)
    if existing is not None:
        if not isinstance(existing, dict) or not existing.get("inventory"):
            raise RuntimeError(f"历史快照文件损坏：{path}")
        return path, False
    atomic_write_json(path, snapshot)
    return path, True


def read_state() -> dict[str, Any]:
    state = read_json(STATE_PATH, {})
    return state if isinstance(state, dict) else {}


def write_state(state: dict[str, Any]) -> Path:
    state["schema_version"] = SCHEMA_VERSION
    return atomic_write_json(STATE_PATH, state)


def record_failure(error: Exception, now: datetime) -> None:
    state = read_state()
    state["last_failure"] = {
        "at": now.isoformat(timespec="seconds"),
        "message": str(error)[:500],
    }
    write_state(state)


def run_sync(now: datetime | None = None, write_history: bool = True) -> dict[str, Any]:
    """Run a safe read-only sync and return file/status metadata.

    All network work finishes and all validations pass before the current
    snapshot is replaced. A failure therefore leaves the dashboard on its
    last known-good data and records only diagnostic state.
    """
    now = now or datetime.now(SHANGHAI)
    try:
        with sync_lock(now):
            previous = read_json(SNAPSHOT_PATH, {})
            previous = previous if isinstance(previous, dict) else {}
            snapshot = build_snapshot(now, previous)
            validate_snapshot(snapshot, previous)
            history_path: Path | None = None
            history_written = False
            if write_history:
                history_path, history_written = save_daily_history(snapshot)
            latest_path = save_snapshot(snapshot)

            state = read_state()
            state.update({
                "last_success_at": now.isoformat(timespec="seconds"),
                "last_inventory_records": len(snapshot["inventory"]),
                "last_history_date": history_path.stem if history_path else state.get("last_history_date"),
                "last_failure": None,
            })
            write_state(state)
            return {
                "snapshot_path": str(latest_path),
                "history_path": str(history_path) if history_path else None,
                "history_written": history_written,
                "inventory_records": len(snapshot["inventory"]),
            }
    except Exception as error:
        record_failure(error, now)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="同步旺店通库存快照（只读）")
    parser.add_argument("--refresh-only", action="store_true", help="只更新最新快照，不写入日结历史")
    args = parser.parse_args()
    result = run_sync(write_history=not args.refresh_only)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
