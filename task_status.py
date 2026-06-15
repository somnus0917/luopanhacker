import json
from datetime import datetime
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "output"
STATE_PATH = OUTPUT_DIR / "task_status.json"
LOGIN_SCREENSHOT = OUTPUT_DIR / "login.png"


def read_status():
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def write_status(**kwargs):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    current = read_status()
    current.update(kwargs)
    current["updated_at"] = datetime.now().isoformat(timespec="seconds")

    STATE_PATH.write_text(
        json.dumps(current, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
