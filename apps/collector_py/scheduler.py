import argparse
import asyncio
import json
import os
import random
import sys
from datetime import datetime
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.collector_py.compass import parse_args, run, save_run
from apps.collector_py.status import COLLECTION_DIR, read_status, write_status

LOCK_PATH = COLLECTION_DIR / "job.lock"
LOCK_EXPIRE_SECONDS = 3 * 3600


def stale_lock():
    if not LOCK_PATH.exists():
        return False
    try:
        started = datetime.fromisoformat(json.loads(LOCK_PATH.read_text(encoding="utf-8"))["started_at"])
        return (datetime.now() - started).total_seconds() > LOCK_EXPIRE_SECONDS
    except (OSError, json.JSONDecodeError, ValueError, KeyError):
        return True


def acquire_lock():
    payload = json.dumps({"pid": os.getpid(), "started_at": datetime.now().isoformat(timespec="seconds")})
    for _ in range(2):
        try:
            with LOCK_PATH.open("x", encoding="utf-8") as lock:
                lock.write(payload)
            return True
        except FileExistsError:
            if not stale_lock():
                return False
            LOCK_PATH.unlink(missing_ok=True)
    return False


def scheduler_args():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--random-delay-seconds", type=int)
    args, remaining = parser.parse_known_args()
    return args, remaining


async def main():
    schedule, remaining = scheduler_args()
    COLLECTION_DIR.mkdir(parents=True, exist_ok=True)
    if not acquire_lock():
        write_status(state="skipped", message="已有采集任务在运行，跳过本次执行")
        return
    try:
        delay = schedule.random_delay_seconds if schedule.random_delay_seconds is not None else random.randint(0, 3600)
        args = parse_args(remaining)
        requested = args.module or ["operations", "channel"]
        write_status(state="waiting_random", message=f"随机等待 {delay} 秒后开始采集", requested_modules=requested)
        print(f"随机等待 {delay} 秒后开始采集", flush=True)
        await asyncio.sleep(delay)
        write_status(state="running", message="正在运行罗盘采集服务", requested_modules=requested)
        result = await run(args)
        outputs = save_run(result, args.output_dir)
        if not outputs:
            raise RuntimeError("所有采集模块均未生成输出")
        completed_at = datetime.now().isoformat(timespec="seconds")
        previous_modules = read_status().get("modules", {})
        merged_modules = dict(previous_modules) if isinstance(previous_modules, dict) else {}
        for name in requested:
            module_result = dict(result["modules"][name])
            successes = module_result["success_count"]
            errors = module_result["error_count"]
            module_result["state"] = "partial_success" if successes and errors else "success" if successes else "failed"
            module_result["last_run_at"] = completed_at
            if name in outputs:
                module_result["last_outputs"] = outputs[name]
            merged_modules[name] = module_result
        has_module_failure = any(
            result["modules"][name]["error_count"] or not result["modules"][name]["success_count"]
            for name in requested
        )
        state = "partial_success" if has_module_failure else "success"
        write_status(
            state=state,
            message="采集部分完成，请查看模块错误" if has_module_failure else "采集完成",
            last_success_at=completed_at,
            last_outputs=outputs,
            modules=merged_modules,
            last_error="",
        )
    except Exception as exc:
        write_status(state="failed", message="采集失败", last_error=repr(exc))
        raise
    finally:
        LOCK_PATH.unlink(missing_ok=True)


if __name__ == "__main__":
    asyncio.run(main())
