import asyncio
import os
import random
from datetime import datetime
from pathlib import Path

from daily_compass import parse_args, run, save_results
from task_status import write_status

LOCK_PATH = Path(__file__).parent / "output" / "daily_job.lock"


async def main():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)

    if LOCK_PATH.exists():
        write_status(
            state="skipped",
            message="已有采集任务在运行，跳过本次执行",
        )
        return

    LOCK_PATH.write_text(str(os.getpid()), encoding="utf-8")

    try:
        delay = random.randint(0, 3600)
        write_status(
            state="waiting_random",
            message=f"随机等待 {delay} 秒后开始采集",
        )
        await asyncio.sleep(delay)

        write_status(
            state="running",
            message="正在采集罗盘数据",
        )

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
        try:
            LOCK_PATH.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    asyncio.run(main())
