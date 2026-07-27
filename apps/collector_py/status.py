import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
COLLECTION_DIR = APP_DIR / "output" / "collection"
STATE_PATH = COLLECTION_DIR / "status.json"
LOGIN_SCREENSHOT = COLLECTION_DIR / "login.png"


def default_status_update_command():
    if shutil.which("luopan-worker-rs"):
        return "luopan-worker-rs status-update"
    return "cargo run -q -p luopan-worker-rs -- status-update"


STATUS_UPDATE_COMMAND = shlex.split(
    os.getenv("STATUS_UPDATE_COMMAND", default_status_update_command())
)


def default_status_update_timeout(command):
    return 120.0 if command and Path(command[0]).name == "cargo" else 5.0


STATUS_UPDATE_TIMEOUT = float(
    os.getenv(
        "STATUS_UPDATE_TIMEOUT",
        str(default_status_update_timeout(STATUS_UPDATE_COMMAND)),
    )
)


def read_status():
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def status_field_value(value):
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return json.dumps(str(value), ensure_ascii=False)


def write_status(**kwargs):
    if not STATUS_UPDATE_COMMAND:
        raise RuntimeError("STATUS_UPDATE_COMMAND is empty")
    command = [*STATUS_UPDATE_COMMAND]
    for key, value in kwargs.items():
        if key == "state":
            command.extend(["--state", str(value)])
        elif key == "message":
            command.extend(["--message", str(value)])
        elif key == "last_error":
            command.extend(["--last-error", str(value)])
        else:
            command.extend(["--field", f"{key}={status_field_value(value)}"])

    environment = os.environ.copy()
    environment.setdefault("LUOPAN_APP_DIR", str(APP_DIR))
    completed = subprocess.run(
        command,
        cwd=str(APP_DIR),
        env=environment,
        text=True,
        capture_output=True,
        timeout=STATUS_UPDATE_TIMEOUT,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"rust status update exited with {completed.returncode}: "
            f"{completed.stderr.strip()[:500]}"
        )
