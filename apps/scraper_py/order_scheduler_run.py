import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.scraper_py.douyin_orders import parse_args, run

ORDERS_ROOT = APP_DIR / "output" / "orders"
LOCK_PATH = ORDERS_ROOT / "order_job.lock"
STATUS_PATH = ORDERS_ROOT / "order_job_status.json"
LOCK_EXPIRE_SECONDS = 4 * 3600


def write_job_status(**kwargs):
    ORDERS_ROOT.mkdir(parents=True, exist_ok=True)
    payload = dict(kwargs)
    payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
    STATUS_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def is_lock_stale():
    if not LOCK_PATH.exists():
        return False
    try:
        lock_data = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        started_at = datetime.fromisoformat(lock_data.get("started_at", ""))
        return (datetime.now() - started_at).total_seconds() > LOCK_EXPIRE_SECONDS
    except (json.JSONDecodeError, ValueError, KeyError):
        return True


def remove_lock():
    try:
        LOCK_PATH.unlink()
    except FileNotFoundError:
        pass


async def main():
    ORDERS_ROOT.mkdir(parents=True, exist_ok=True)
    if LOCK_PATH.exists():
        if is_lock_stale():
            remove_lock()
        else:
            write_job_status(
                state="skipped",
                message="已有订单采集任务在运行，跳过本次执行",
            )
            return

    LOCK_PATH.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "started_at": datetime.now().isoformat(timespec="seconds"),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    try:
        write_job_status(state="running", message="正在采集昨日订单")
        results = await run(parse_args())
        total_orders = sum(item.get("orders_count", 0) for item in results)
        write_job_status(
            state="success",
            message=f"订单采集完成，共 {total_orders} 单",
            last_success_at=datetime.now().isoformat(timespec="seconds"),
            total_orders=total_orders,
            shops=results,
            last_error="",
        )
    except Exception as exc:
        write_job_status(
            state="failed",
            message="订单采集失败",
            last_error=repr(exc),
        )
        raise
    finally:
        remove_lock()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
