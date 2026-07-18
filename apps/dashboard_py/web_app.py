"""Standalone dashboard shell.

Flask owns browser sessions, static files, and the order preview upload. Business
data APIs are proxied to the Rust API sidecar.
"""

import hashlib
import hmac
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime
from functools import wraps
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.exceptions import RequestEntityTooLarge

APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from apps.orders_py.external_order_store import (
    ImportValidationError,
    preview_upload,
)


STATIC_DIR = APP_DIR / "web" / "static"
CONFIG_DIR = APP_DIR / "config"
USERS_FILE = CONFIG_DIR / "users.json"
SESSION_SECRET_FILE = CONFIG_DIR / "session_secret.txt"
PROGRESS_LOG = APP_DIR / "output" / "progress.log"
MAX_ORDER_UPLOAD_BYTES = 30 * 1024 * 1024


def env_float(name, default):
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


RUST_API_BASE_URL = os.getenv(
    "RUST_API_BASE_URL",
    f"http://127.0.0.1:{os.getenv('LUOPAN_API_RS_PORT', '8601')}",
).rstrip("/")
RUST_API_TIMEOUT = env_float("RUST_API_TIMEOUT", 2.0)


def default_rust_worker_command(subcommand):
    if shutil.which("luopan-worker-rs"):
        return f"luopan-worker-rs {subcommand}"
    return f"cargo run -q -p luopan-worker-rs -- {subcommand}"


DEFAULT_MANUAL_SCRAPE_COMMAND = default_rust_worker_command("compass-scrape")
MANUAL_SCRAPE_COMMAND = shlex.split(os.getenv("MANUAL_SCRAPE_COMMAND", DEFAULT_MANUAL_SCRAPE_COMMAND))
DEFAULT_STATUS_UPDATE_COMMAND = default_rust_worker_command("status-update")
STATUS_UPDATE_COMMAND = shlex.split(os.getenv("STATUS_UPDATE_COMMAND", DEFAULT_STATUS_UPDATE_COMMAND))

app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY="replace-me",
    SESSION_COOKIE_NAME="compass_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true",
    MAX_CONTENT_LENGTH=MAX_ORDER_UPLOAD_BYTES,
)


def get_session_secret():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if SESSION_SECRET_FILE.exists():
        return SESSION_SECRET_FILE.read_text(encoding="utf-8").strip()
    secret = hashlib.sha256(os.urandom(32)).hexdigest()
    SESSION_SECRET_FILE.write_text(secret, encoding="utf-8")
    return secret


app.config["SECRET_KEY"] = get_session_secret()


def load_users():
    if not USERS_FILE.exists():
        return {}
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def verify_password(password, stored_hash):
    try:
        salt, stored_digest = stored_hash.split("$", 1)
    except ValueError:
        return False
    calculated = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
    return hmac.compare_digest(calculated, stored_digest)


def current_user():
    username = session.get("username")
    users = load_users()
    if username and username in users:
        return username, users[username].get("role", "viewer")
    session.clear()
    return None, None


def require_login(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        username, _ = current_user()
        if not username:
            return jsonify({"error": "请先登录"}), 401
        return handler(*args, **kwargs)

    return wrapped


def start_manual_scrape():
    PROGRESS_LOG.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_LOG.write_text("", encoding="utf-8")
    write_manual_scrape_requested_status()
    environment = os.environ.copy()
    environment["PYTHONUNBUFFERED"] = "1"
    environment.setdefault("LUOPAN_APP_DIR", str(APP_DIR))
    command = [
        *MANUAL_SCRAPE_COMMAND,
        "--random-delay-seconds",
        "0",
        "--login-timeout-minutes",
        "30",
    ]
    with PROGRESS_LOG.open("ab") as log_file:
        log_file.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] start manual compass scrape\n".encode())
        log_file.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] command: {shlex.join(command)}\n".encode())
        log_file.flush()
        subprocess.Popen(
            command,
            cwd=str(APP_DIR),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=environment,
            start_new_session=True,
        )


def write_manual_scrape_requested_status():
    environment = os.environ.copy()
    environment.setdefault("LUOPAN_APP_DIR", str(APP_DIR))
    command = [
        *STATUS_UPDATE_COMMAND,
        "--state",
        "manual_requested",
        "--message",
        "已收到手动补采请求，正在启动采集任务",
        "--last-error",
        "",
    ]
    completed = subprocess.run(
        command,
        cwd=str(APP_DIR),
        env=environment,
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"rust status update exited with {completed.returncode}: {completed.stderr.strip()[:500]}"
        )


class RustApiUnavailable(RuntimeError):
    pass


def rust_api_json(path, query=None, method="GET", payload=None):
    if not RUST_API_BASE_URL:
        raise RustApiUnavailable("RUST_API_BASE_URL is empty")

    encoded_query = f"?{urlencode(query)}" if query else ""
    url = f"{RUST_API_BASE_URL}{path}{encoded_query}"
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request_data = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request_data, timeout=RUST_API_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8")), response.status
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body), error.code
        except json.JSONDecodeError:
            return {"error": body[:500] or f"Rust API HTTP {error.code}"}, error.code
    except (URLError, TimeoutError, OSError) as error:
        raise RustApiUnavailable(f"rust api unavailable for {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise RustApiUnavailable(f"rust api returned invalid JSON for {path}: {error}") from error


def rust_api_response(path, query=None, method="GET", payload=None):
    try:
        response_payload, status_code = rust_api_json(path, query=query, method=method, payload=payload)
    except RustApiUnavailable as error:
        app.logger.error("%s", error)
        return jsonify({"error": "Rust API 不可用", "detail": str(error)}), 502
    return jsonify(response_payload), status_code


def status_payload(include_terminal_output=True):
    payload, _status_code = rust_api_json(
        "/api/status",
        {"terminal_output": "true" if include_terminal_output else "false"},
    )
    return payload


@app.errorhandler(RequestEntityTooLarge)
def upload_too_large(_error):
    return jsonify({"error": "上传文件总大小不能超过 30 MB"}), 413


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/assets/<path:filename>")
def assets(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.post("/api/login")
def login():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    users = load_users()
    user = users.get(username)
    if not user or not verify_password(password, user.get("password_hash", "")):
        time.sleep(0.35)
        return jsonify({"error": "用户名或密码错误"}), 401
    session.clear()
    session["username"] = username
    session["logged_in_at"] = datetime.now().isoformat(timespec="seconds")
    return jsonify({"username": username, "role": user.get("role", "viewer")})


@app.post("/api/logout")
def logout():
    session.clear()
    return ("", 204)


@app.get("/api/me")
def me():
    username, role = current_user()
    if not username:
        return jsonify({"authenticated": False})
    return jsonify({"authenticated": True, "username": username, "role": role})


@app.get("/api/compass")
@require_login
def compass_data():
    return rust_api_response("/api/compass")


@app.get("/api/orders/imports")
@require_login
def order_imports():
    return rust_api_response("/api/orders/imports")


@app.post("/api/orders/preview")
@require_login
def preview_order_import():
    try:
        return jsonify(preview_upload(request.files.getlist("files")))
    except ImportValidationError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/orders/imports")
@require_login
def commit_order_import():
    payload = request.get_json(silent=True) or {}
    token = str(payload.get("preview_token", "")).strip()
    if not token:
        return jsonify({"error": "缺少导入预览凭据，请重新选择文件"}), 400
    return rust_api_response(
        "/api/orders/imports",
        method="POST",
        payload={"preview_token": token},
    )


@app.delete("/api/orders/imports/<batch_id>")
@require_login
def remove_order_import(batch_id):
    return rust_api_response(f"/api/orders/imports/{batch_id}", method="DELETE")


@app.get("/api/inventory")
@require_login
def inventory_data():
    return rust_api_response("/api/inventory")


@app.get("/api/settlement")
@require_login
def settlement_data():
    return rust_api_response("/api/settlement")


@app.get("/api/status")
@require_login
def status():
    return rust_api_response("/api/status")


@app.post("/api/scrape")
@require_login
def scrape():
    try:
        current_status = status_payload(include_terminal_output=False)
    except RustApiUnavailable as error:
        app.logger.error("%s", error)
        return jsonify({"error": "Rust API 不可用", "detail": str(error)}), 502
    if current_status.get("job_running"):
        return jsonify({"error": "已有采集任务在运行"}), 409
    start_manual_scrape()
    return jsonify({"message": "已启动手动补采任务"}), 202


if __name__ == "__main__":
    app.run(
        host=os.getenv("DASHBOARD_HOST", "127.0.0.1"),
        port=int(os.getenv("DASHBOARD_PORT", "8501")),
        debug=False,
    )
