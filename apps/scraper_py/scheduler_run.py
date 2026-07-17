import asyncio
import argparse
import json
import os
import random
import sys
from datetime import datetime
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.scraper_py.daily_compass import parse_args, run, save_results
from apps.scraper_py.task_status import write_status

LOCK_PATH = APP_DIR / "output" / "daily_job.lock"
LOCK_EXPIRE_SECONDS = 3 * 3600  # 3 小时过期


def is_lock_stale():
    """检查 lock 文件是否过期"""
    if not LOCK_PATH.exists():
        return False

    try:
        lock_data = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        started_at = datetime.fromisoformat(lock_data.get("started_at", ""))
        elapsed = (datetime.now() - started_at).total_seconds()
        return elapsed > LOCK_EXPIRE_SECONDS
    except (json.JSONDecodeError, ValueError, KeyError):
        # lock 文件格式错误，视为过期
        return True


def remove_lock():
    """删除 lock 文件"""
    try:
        LOCK_PATH.unlink()
    except FileNotFoundError:
        pass


def parse_scheduler_args():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--random-delay-seconds", type=int)
    scheduler_args, remaining_args = parser.parse_known_args()
    sys.argv = [sys.argv[0], *remaining_args]
    return scheduler_args


async def main():
    scheduler_args = parse_scheduler_args()
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)

    if LOCK_PATH.exists():
        if is_lock_stale():
            remove_lock()
        else:
            write_status(
                state="skipped",
                message="已有采集任务在运行，跳过本次执行",
            )
            return

    lock_data = {
        "pid": os.getpid(),
        "started_at": datetime.now().isoformat(timespec="seconds"),
    }
    LOCK_PATH.write_text(json.dumps(lock_data), encoding="utf-8")

    try:
        delay = (
            scheduler_args.random_delay_seconds
            if scheduler_args.random_delay_seconds is not None
            else random.randint(0, 3600)
        )
        write_status(
            state="waiting_random",
            message=f"随机等待 {delay} 秒后开始采集",
        )
        print(f"随机等待 {delay} 秒后开始采集", flush=True)
        await asyncio.sleep(delay)

        write_status(
            state="running",
            message="正在采集罗盘数据",
        )
        print("正在采集罗盘数据", flush=True)

        args = parse_args()
        results = await run(args)
        json_path, csv_path = save_results(results, args.output_dir)

        write_status(
            state="success",
            message=f"采集完成：{json_path.name}",
            last_success_at=datetime.now().isoformat(timespec="seconds"),
            last_json=str(json_path),
            last_csv=str(csv_path),
            last_error="",
        )
    except Exception as exc:
        write_status(
            state="failed",
            message="采集失败",
            last_error=repr(exc),
        )
        raise
    finally:
        remove_lock()


if __name__ == "__main__":
    asyncio.run(main())
