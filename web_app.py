"""Standalone dashboard web server.

This module only exposes the existing dashboard records and job controls.  The
scraper, normalisation code and daily-output format stay in their original
modules so the presentation layer can evolve independently.
"""

import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, session

from dashboard import get_dashboard_records
from task_status import read_status, write_status


APP_DIR = Path(__file__).parent
STATIC_DIR = APP_DIR / "web" / "static"
CONFIG_DIR = APP_DIR / "config"
USERS_FILE = CONFIG_DIR / "users.json"
SESSION_SECRET_FILE = CONFIG_DIR / "session_secret.txt"
DAILY_LOCK = APP_DIR / "output" / "daily_job.lock"
PROGRESS_LOG = APP_DIR / "output" / "progress.log"
NOVNC_URL = os.getenv("NOVNC_URL", "http://127.0.0.1:6080")

app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY="replace-me",
    SESSION_COOKIE_NAME="compass_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true",
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
        salt, _ = stored_hash.split("$", 1)
    except ValueError:
        return False
    calculated = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
    return calculated == stored_hash


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
    write_status(state="manual_requested", message="已收到手动补采请求，正在启动采集任务", last_error="")
    environment = os.environ.copy()
    environment["PYTHONUNBUFFERED"] = "1"
    with PROGRESS_LOG.open("ab") as log_file:
        log_file.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] start manual compass scrape\n".encode())
        log_file.flush()
        subprocess.Popen(
            [sys.executable, "scheduler_run.py", "--random-delay-seconds", "0", "--login-timeout-minutes", "30"],
            cwd=str(APP_DIR),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=environment,
            start_new_session=True,
        )


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
    return jsonify({"records": get_dashboard_records(), "generated_at": datetime.now().isoformat(timespec="seconds")})


@app.get("/api/status")
@require_login
def status():
    data = read_status()
    data["job_running"] = DAILY_LOCK.exists()
    data["novnc_url"] = NOVNC_URL
    return jsonify(data)


@app.post("/api/scrape")
@require_login
def scrape():
    if DAILY_LOCK.exists():
        return jsonify({"error": "已有采集任务在运行"}), 409
    start_manual_scrape()
    return jsonify({"message": "已启动手动补采任务"}), 202


if __name__ == "__main__":
    app.run(
        host=os.getenv("DASHBOARD_HOST", "127.0.0.1"),
        port=int(os.getenv("DASHBOARD_PORT", "8501")),
        debug=False,
    )
