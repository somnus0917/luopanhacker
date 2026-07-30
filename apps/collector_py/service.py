import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.collector_py.status import COLLECTION_DIR, write_status

REQUEST_PATH = COLLECTION_DIR / "request.json"
RUNNING_REQUEST_PATH = COLLECTION_DIR / "request.running.json"
HEARTBEAT_PATH = COLLECTION_DIR / "heartbeat.json"
LOCK_PATH = COLLECTION_DIR / "job.lock"
PROGRESS_LOG = COLLECTION_DIR / "progress.log"


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(temporary, path)


def heartbeat():
    atomic_json(
        HEARTBEAT_PATH,
        {
            "pid": os.getpid(),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        },
    )


def worker_command(modules, data_day=None, shops=None):
    configured = os.getenv(
        "COLLECTION_WORKER_COMMAND", "luopan-worker-rs compass-collect"
    )
    parts = shlex.split(configured)
    if not parts or not shutil.which(parts[0]):
        parts = ["python3", "apps/collector_py/scheduler.py"]
    parts.extend(["--random-delay-seconds", "0", "--login-timeout-minutes", "30"])
    for module in modules:
        parts.extend(["--module", module])
    if data_day:
        parts.extend(["--date", data_day])
    for shop in shops or []:
        parts.extend(["--shop", shop])
    return parts


def run_request(request):
    modules = [
        name for name in request.get("modules", []) if name in {"operations", "channel"}
    ]
    if not modules:
        modules = ["operations", "channel"]
    data_day = request.get("date") if isinstance(request.get("date"), str) else None
    shops = [
        name.strip()
        for name in request.get("shops", [])
        if isinstance(name, str) and name.strip()
    ]
    while lock_active():
        heartbeat()
        time.sleep(2)
    PROGRESS_LOG.parent.mkdir(parents=True, exist_ok=True)
    with PROGRESS_LOG.open("a", encoding="utf-8") as log:
        request_label = f", date={data_day}" if data_day else ""
        shop_label = f", shops={','.join(shops)}" if shops else ""
        log.write(
            f"\n[{datetime.now().isoformat(timespec='seconds')}] manual collection: {','.join(modules)}{request_label}{shop_label}\n"
        )
        log.flush()
        environment = os.environ.copy()
        environment.setdefault("PYTHONUNBUFFERED", "1")
        process = subprocess.Popen(
            worker_command(modules, data_day, shops),
            cwd=str(APP_DIR),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        while process.poll() is None:
            heartbeat()
            time.sleep(2)
        if process.returncode:
            write_status(
                state="failed",
                message="手动采集进程失败",
                last_error=f"collector worker exited with {process.returncode}",
            )


def recover_request():
    if (
        RUNNING_REQUEST_PATH.exists()
        and not lock_active()
        and not REQUEST_PATH.exists()
    ):
        os.replace(RUNNING_REQUEST_PATH, REQUEST_PATH)


def lock_active():
    if not LOCK_PATH.exists():
        return False
    try:
        payload = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        datetime.fromisoformat(payload["started_at"])
        hostname = payload.get("hostname")
        if hostname and hostname != socket.gethostname():
            LOCK_PATH.unlink(missing_ok=True)
            return False
        os.kill(int(payload["pid"]), 0)
        return True
    except ProcessLookupError:
        LOCK_PATH.unlink(missing_ok=True)
        return False
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        LOCK_PATH.unlink(missing_ok=True)
        return False


def main():
    COLLECTION_DIR.mkdir(parents=True, exist_ok=True)
    recover_request()
    while True:
        heartbeat()
        recover_request()
        if REQUEST_PATH.exists() and not RUNNING_REQUEST_PATH.exists():
            try:
                os.replace(REQUEST_PATH, RUNNING_REQUEST_PATH)
                request = json.loads(RUNNING_REQUEST_PATH.read_text(encoding="utf-8"))
                run_request(request)
            except Exception as exc:
                write_status(
                    state="failed", message="采集服务处理请求失败", last_error=repr(exc)
                )
            finally:
                RUNNING_REQUEST_PATH.unlink(missing_ok=True)
        time.sleep(2)


if __name__ == "__main__":
    main()
