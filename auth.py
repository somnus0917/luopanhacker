import hashlib
import hmac
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import time

import streamlit as st

USERS_FILE = Path(__file__).parent / "config" / "users.json"
SESSION_SECRET_FILE = Path(__file__).parent / "config" / "session_secret.txt"
SESSION_TIMEOUT_HOURS = 24


def get_session_secret() -> str:
    if not SESSION_SECRET_FILE.exists():
        SESSION_SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
        secret = hashlib.sha256(os.urandom(32)).hexdigest()
        SESSION_SECRET_FILE.write_text(secret, encoding="utf-8")
        return secret
    try:
        return SESSION_SECRET_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return "fallback_secret_key_123456"


def verify_session_token(token: str) -> tuple[bool, str | None, str | None]:
    if not token:
        return False, None, None
    try:
        parts = token.split(":")
        if len(parts) != 4:
            return False, None, None
        username, expiry_str, login_time, signature = parts
        expiry = int(expiry_str)
        if time.time() > expiry:
            return False, None, None  # Expired

        # Verify signature
        secret = get_session_secret()
        sig_data = f"{username}:{expiry}:{login_time}:{secret}".encode("utf-8")
        expected_signature = hashlib.sha256(sig_data).hexdigest()
        if hmac.compare_digest(signature, expected_signature):
            return True, username, login_time
    except Exception:
        pass
    return False, None, None


def _hash_password(password: str, salt: str = None) -> tuple[str, str]:
    if salt is None:
        salt = hashlib.sha256(os.urandom(32)).hexdigest()[:16]
    hashed = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
    return f"{salt}${hashed}", salt


def _verify_password(password: str, stored_hash: str) -> bool:
    salt, _ = stored_hash.split("$", 1)
    computed, _ = _hash_password(password, salt)
    return computed == stored_hash


def load_users() -> dict:
    if not USERS_FILE.exists():
        return {}
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_users(users: dict):
    USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")


def init_default_admin():
    users = load_users()
    if not users:
        admin_password = os.getenv("ADMIN_PASSWORD", "admin123")
        hashed, _ = _hash_password(admin_password)
        users["admin"] = {
            "password_hash": hashed,
            "role": "admin",
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        save_users(users)
    return users


def authenticate(username: str, password: str) -> bool:
    users = load_users()
    if username not in users:
        return False
    return _verify_password(password, users[username]["password_hash"])


def get_user_role(username: str) -> str:
    users = load_users()
    if username in users:
        return users[username].get("role", "viewer")
    return "viewer"


def check_session():
    if "authenticated" not in st.session_state:
        st.session_state.authenticated = False
        st.session_state.username = None
        st.session_state.login_time = None

    if st.session_state.authenticated and st.session_state.login_time:
        elapsed = datetime.now() - datetime.fromisoformat(st.session_state.login_time)
        if elapsed > timedelta(hours=SESSION_TIMEOUT_HOURS):
            st.session_state.authenticated = False
            st.session_state.username = None
            st.session_state.login_time = None

    # If not authenticated, check browser cookies (fast path using st.context.cookies)
    if not st.session_state.authenticated:
        try:
            cookies = st.context.cookies
            if "compass_session" in cookies:
                token = cookies["compass_session"]
                is_valid, username, login_time = verify_session_token(token)
                if is_valid:
                    st.session_state.authenticated = True
                    st.session_state.username = username
                    st.session_state.login_time = login_time
        except Exception:
            pass

    return st.session_state.authenticated


def login_form():
    st.markdown("""
    <style>
        .login-container {
            max-width: 400px;
            margin: 0 auto;
            padding: 2rem;
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .login-title {
            text-align: center;
            color: #1f2937;
            margin-bottom: 1.5rem;
        }
        .login-subtitle {
            text-align: center;
            color: #6b7280;
            font-size: 0.9rem;
            margin-bottom: 2rem;
        }
    </style>
    """, unsafe_allow_html=True)

    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        st.markdown('<h1 class="login-title">罗盘经营看板</h1>', unsafe_allow_html=True)
        st.markdown('<p class="login-subtitle">请登录以访问系统</p>', unsafe_allow_html=True)

        with st.form("login_form"):
            username = st.text_input("用户名", placeholder="请输入用户名")
            password = st.text_input("密码", type="password", placeholder="请输入密码")
            submitted = st.form_submit_button("登录", use_container_width=True)

            if submitted:
                if authenticate(username, password):
                    st.session_state.authenticated = True
                    st.session_state.username = username
                    login_time = datetime.now().isoformat(timespec="seconds")
                    st.session_state.login_time = login_time

                    # Persistent cookie write using streamlit-cookies-controller
                    try:
                        from streamlit_cookies_controller import CookieController
                        expiry = int(time.time()) + SESSION_TIMEOUT_HOURS * 3600
                        secret = get_session_secret()
                        sig_data = f"{username}:{expiry}:{login_time}:{secret}".encode("utf-8")
                        signature = hashlib.sha256(sig_data).hexdigest()
                        token = f"{username}:{expiry}:{login_time}:{signature}"

                        controller = CookieController()
                        controller.set("compass_session", token, max_age=SESSION_TIMEOUT_HOURS * 3600)
                        # Add a small delay for the browser to register the cookie
                        time.sleep(0.5)
                    except Exception as e:
                        st.warning(f"无法保存登录 Cookie: {e}")

                    st.rerun()
                else:
                    st.error("用户名或密码错误")


def logout():
    st.session_state.authenticated = False
    st.session_state.username = None
    st.session_state.login_time = None

    try:
        from streamlit_cookies_controller import CookieController
        controller = CookieController()
        controller.remove("compass_session")
        time.sleep(0.5)
    except Exception:
        pass
    st.rerun()


def require_auth():
    init_default_admin()
    if not check_session():
        login_form()
        st.stop()
    return st.session_state.username



def change_password(username: str, old_password: str, new_password: str) -> bool:
    if not authenticate(username, old_password):
        return False

    users = load_users()
    if username not in users:
        return False

    hashed, _ = _hash_password(new_password)
    users[username]["password_hash"] = hashed
    users[username]["password_changed_at"] = datetime.now().isoformat(timespec="seconds")
    save_users(users)
    return True


def add_user(username: str, password: str, role: str = "viewer") -> bool:
    users = load_users()
    if username in users:
        return False

    hashed, _ = _hash_password(password)
    users[username] = {
        "password_hash": hashed,
        "role": role,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    save_users(users)
    return True


def delete_user(username: str) -> bool:
    users = load_users()
    if username not in users or username == "admin":
        return False

    del users[username]
    save_users(users)
    return True


def list_users() -> list[dict]:
    users = load_users()
    return [
        {
            "username": username,
            "role": info.get("role", "viewer"),
            "created_at": info.get("created_at", ""),
        }
        for username, info in users.items()
    ]
