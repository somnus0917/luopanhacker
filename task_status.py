import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "output"
STATE_PATH = OUTPUT_DIR / "task_status.json"
LOGIN_SCREENSHOT = OUTPUT_DIR / "login.png"


def default_status_update_command():
    if shutil.which("luopan-worker-rs"):
        return "luopan-worker-rs status-update"
    return "cargo run -q -p luopan-worker-rs -- status-update"


STATUS_UPDATE_COMMAND = shlex.split(os.getenv("STATUS_UPDATE_COMMAND", default_status_update_command()))
STATUS_UPDATE_TIMEOUT = float(os.getenv("STATUS_UPDATE_TIMEOUT", "5"))


def read_status():
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def status_field_value(value):
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return json.dumps(str(value), ensure_ascii=False)


def write_status_rust(**kwargs):
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
    environment.setdefault("LUOPAN_APP_DIR", str(Path(__file__).parent))
    completed = subprocess.run(
        command,
        cwd=str(Path(__file__).parent),
        env=environment,
        text=True,
        capture_output=True,
        timeout=STATUS_UPDATE_TIMEOUT,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"rust status update exited with {completed.returncode}: {completed.stderr.strip()[:500]}"
        )


def write_status(**kwargs):
    write_status_rust(**kwargs)
