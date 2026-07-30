"""Privacy-safe, reversible storage for uploaded marketplace order exports.

The public dashboard receives only daily, per-shop aggregates.  A private
ledger keeps an HMAC digest of each imported order identifier solely for
duplicate detection and batch-level rollback; it never stores raw order IDs,
buyer data, addresses, or uploaded workbooks.
"""

import hashlib
import hmac
import json
import os
import secrets
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from apps.orders_py.import_external_orders import (
    daily_records_from_orders,
    parse_workbook_orders,
)


APP_DIR = Path(__file__).resolve().parents[2]
OUTPUT_DIR = APP_DIR / "output" / "external_orders"
LEDGER_PATH = OUTPUT_DIR / "import_ledger.json"
SNAPSHOT_PATH = OUTPUT_DIR / "orders_daily.json"
PREVIEW_DIR = OUTPUT_DIR / "previews"
LOCK_PATH = OUTPUT_DIR / ".import.lock"
SECRET_PATH = APP_DIR / "config" / "import_dedupe_secret.txt"
PREVIEW_TTL_MINUTES = 15
MAX_FILES_PER_UPLOAD = 10


class ImportValidationError(ValueError):
    """Raised when an uploaded workbook cannot safely be imported."""


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def default_ledger():
    return {"schema_version": 1, "batches": [], "orders": []}


def atomic_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(temporary, path)


def read_json(path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


@contextmanager
def ledger_lock():
    """Serialize writes so two browser tabs cannot create duplicate imports."""
    import fcntl

    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def get_dedupe_secret():
    SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    if SECRET_PATH.exists():
        secret = SECRET_PATH.read_text(encoding="utf-8").strip()
        if secret:
            return secret.encode("utf-8")
    secret = secrets.token_hex(32)
    SECRET_PATH.write_text(secret, encoding="utf-8")
    return secret.encode("utf-8")


def order_digest(order_id):
    normalized = str(order_id).strip().upper().encode("utf-8")
    return hmac.new(get_dedupe_secret(), normalized, hashlib.sha256).hexdigest()


def file_digest(content):
    return hashlib.sha256(content).hexdigest()


def load_ledger():
    data = read_json(LEDGER_PATH, default_ledger())
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("batches"), list)
        or not isinstance(data.get("orders"), list)
    ):
        return default_ledger()
    return data


def write_snapshot(ledger):
    records = daily_records_from_orders(ledger["orders"])
    payload = {
        "schema_version": 2,
        "generated_at": now_iso(),
        "imports": [batch_public(batch) for batch in ledger["batches"]],
        "records": records,
    }
    atomic_write(SNAPSHOT_PATH, payload)
    return records


def batch_public(batch):
    return {
        "id": batch["id"],
        "created_at": batch["created_at"],
        "files": batch["files"],
        "source_labels": batch["source_labels"],
        "added_orders": batch["added_orders"],
        "duplicate_orders": batch["duplicate_orders"],
        "date_range": batch["date_range"],
        "pay_amt": batch["pay_amt"],
        "pay_item_cnt": batch["pay_item_cnt"],
    }


def public_imports():
    ledger = load_ledger()
    orders = ledger["orders"]
    return {
        "batches": [batch_public(batch) for batch in reversed(ledger["batches"])],
        "summary": {
            "batches": len(ledger["batches"]),
            "orders": len(orders),
            "pay_amt": sum(float(order.get("amount_cent", 0)) for order in orders),
            "pay_item_cnt": sum(int(order.get("quantity", 0)) for order in orders),
        },
    }


def safe_filename(filename):
    name = Path(filename or "").name
    if not name or Path(name).suffix.lower() != ".xlsx":
        raise ImportValidationError("仅支持 .xlsx 格式的订单明细文件")
    return name


def parse_uploaded_file(file_storage):
    name = safe_filename(file_storage.filename)
    content = file_storage.read()
    if not content:
        raise ImportValidationError(f"{name} 是空文件")
    digest = file_digest(content)
    # Source identification intentionally uses the user-visible filename.  The
    # temporary filename cannot identify 喵速达/天猫 exports on its own.
    named_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix="-" + name, delete=False) as temporary:
            temporary.write(content)
            named_path = Path(temporary.name)
        orders, metadata = parse_workbook_orders(named_path)
        metadata["source_file"] = name
        for order in orders:
            order["source_file"] = name
    except Exception as exc:
        raise ImportValidationError(f"{name} 解析失败：{exc}") from exc
    finally:
        if named_path:
            named_path.unlink(missing_ok=True)
    return digest, orders, metadata


def preview_upload(files):
    if not files:
        raise ImportValidationError("请选择至少一个订单明细文件")
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise ImportValidationError(f"单次最多上传 {MAX_FILES_PER_UPLOAD} 个文件")

    with ledger_lock():
        ledger = load_ledger()
        known_file_hashes = {
            item.get("file_hash")
            for batch in ledger["batches"]
            for item in batch.get("files", [])
        }
        known_order_hashes = {item.get("order_key") for item in ledger["orders"]}

    preview_orders, file_rows, candidate_hashes = [], [], set()
    for file_storage in files:
        file_hash, orders, metadata = parse_uploaded_file(file_storage)
        row = {
            "file_name": metadata["source_file"],
            "file_hash": file_hash,
            "source_key": metadata["source_key"],
            "source_label": metadata["source_label"],
            "input_rows": metadata["input_rows"],
            "accepted_order_rows": metadata["accepted_order_rows"],
            "accepted_orders": metadata["accepted_orders"],
            "added_orders": 0,
            "duplicate_orders": 0,
            "known_file": file_hash in known_file_hashes,
        }
        if row["known_file"]:
            row["duplicate_orders"] = len(orders)
            file_rows.append(row)
            continue

        for order in orders:
            digest = order_digest(order["order_id"])
            if digest in known_order_hashes or digest in candidate_hashes:
                row["duplicate_orders"] += 1
                continue
            candidate_hashes.add(digest)
            preview_orders.append(
                {
                    "order_key": digest,
                    "date": order["date"],
                    "shop_name": order["shop_name"],
                    "amount_cent": order["amount_cent"],
                    "quantity": order["quantity"],
                    "source": "external_orders",
                    "source_key": order["source_key"],
                    "source_label": order["source_label"],
                }
            )
            row["added_orders"] += 1
        file_rows.append(row)

    token = secrets.token_urlsafe(24)
    created_at = datetime.now()
    preview = {
        "token": token,
        "created_at": created_at.isoformat(timespec="seconds"),
        "expires_at": (created_at + timedelta(minutes=PREVIEW_TTL_MINUTES)).isoformat(
            timespec="seconds"
        ),
        "files": file_rows,
        "orders": preview_orders,
    }
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(PREVIEW_DIR / f"{token}.json", preview)
    return preview_public(preview)


def preview_public(preview):
    orders = preview["orders"]
    dates = sorted({order["date"] for order in orders})
    return {
        "preview_token": preview["token"],
        "expires_at": preview["expires_at"],
        "files": preview["files"],
        "summary": {
            "added_orders": len(orders),
            "duplicate_orders": sum(
                item["duplicate_orders"] for item in preview["files"]
            ),
            "pay_amt": sum(float(order["amount_cent"]) for order in orders),
            "pay_item_cnt": sum(int(order["quantity"]) for order in orders),
            "date_range": [dates[0], dates[-1]] if dates else [],
            "source_labels": sorted({order["source_label"] for order in orders}),
        },
    }


def commit_preview(token):
    preview_path = PREVIEW_DIR / f"{token}.json"
    with ledger_lock():
        preview = read_json(preview_path, None)
        if not preview or preview.get("token") != token:
            raise ImportValidationError("导入预览不存在或已失效，请重新选择文件")
        if datetime.fromisoformat(preview["expires_at"]) < datetime.now():
            preview_path.unlink(missing_ok=True)
            raise ImportValidationError("导入预览已过期，请重新选择文件")

        ledger = load_ledger()
        known_hashes = {item.get("order_key") for item in ledger["orders"]}
        known_files = {
            item.get("file_hash")
            for batch in ledger["batches"]
            for item in batch.get("files", [])
        }
        new_orders = [
            order
            for order in preview["orders"]
            if order["order_key"] not in known_hashes
        ]
        files = []
        for item in preview["files"]:
            current = dict(item)
            if current["file_hash"] in known_files:
                current["added_orders"] = 0
                current["known_file"] = True
            files.append(current)
        if not new_orders:
            raise ImportValidationError("没有可新增的数据：文件或订单已导入")

        batch_id = f"imp_{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:8]}"
        for order in new_orders:
            order["batch_id"] = batch_id
        dates = sorted({order["date"] for order in new_orders})
        batch = {
            "id": batch_id,
            "created_at": now_iso(),
            "files": files,
            "source_labels": sorted({order["source_label"] for order in new_orders}),
            "added_orders": len(new_orders),
            "duplicate_orders": sum(item["duplicate_orders"] for item in files)
            + (len(preview["orders"]) - len(new_orders)),
            "date_range": [dates[0], dates[-1]],
            "pay_amt": sum(float(order["amount_cent"]) for order in new_orders),
            "pay_item_cnt": sum(int(order["quantity"]) for order in new_orders),
        }
        ledger["batches"].append(batch)
        ledger["orders"].extend(new_orders)
        atomic_write(LEDGER_PATH, ledger)
        write_snapshot(ledger)
        preview_path.unlink(missing_ok=True)
    return {
        "batch": batch_public(batch),
        "records": len(daily_records_from_orders(new_orders)),
    }


def delete_batch(batch_id):
    with ledger_lock():
        ledger = load_ledger()
        batch = next(
            (item for item in ledger["batches"] if item.get("id") == batch_id), None
        )
        if batch is None:
            raise ImportValidationError("未找到该导入批次")
        ledger["batches"] = [
            item for item in ledger["batches"] if item.get("id") != batch_id
        ]
        ledger["orders"] = [
            item for item in ledger["orders"] if item.get("batch_id") != batch_id
        ]
        atomic_write(LEDGER_PATH, ledger)
        write_snapshot(ledger)
    return batch_public(batch)


def bootstrap_files(paths):
    """Create a first ledger from trusted local files; used for one-time migration."""

    class LocalUpload:
        def __init__(self, path):
            self.filename = path.name
            self._content = path.read_bytes()

        def read(self):
            return self._content

    preview = preview_upload([LocalUpload(Path(path)) for path in paths])
    return commit_preview(preview["preview_token"])
