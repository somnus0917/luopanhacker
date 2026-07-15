import hashlib
import hmac
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import time
from urllib.parse import unquote

import streamlit as st

USERS_FILE = Path(__file__).parent / "config" / "users.json"
SESSION_SECRET_FILE = Path(__file__).parent / "config" / "session_secret.txt"
SESSION_TIMEOUT_HOURS = 24
SESSION_COOKIE_NAME = "compass_session"


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
        token = unquote(str(token))
        parts = token.split(":")
        if len(parts) < 4:
            return False, None, None
        username = parts[0]
        expiry_str = parts[1]
        login_time = ":".join(parts[2:-1])
        signature = parts[-1]
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

    # If not authenticated, check browser cookies.
    if not st.session_state.authenticated:
        token = None
        try:
            cookies = st.context.cookies
        except Exception:
            cookies = {}

        token = cookies.get(SESSION_COOKIE_NAME)
        if not token:
            try:
                from streamlit_cookies_controller import CookieController
                controller = CookieController()
                token = controller.get(SESSION_COOKIE_NAME)
            except Exception:
                token = None

        is_valid, username, login_time = verify_session_token(token)
        if is_valid:
            st.session_state.authenticated = True
            st.session_state.username = username
            st.session_state.login_time = login_time

    return st.session_state.authenticated


def login_form():
    st.markdown("""
    <style>
        .stApp, [data-testid="stAppViewContainer"], [data-testid="stHeader"] {
            background: #0a0c18;
            color: #f5f7ff;
        }
        .stApp:before {
            content: "";
            position: fixed;
            inset: 0;
            pointer-events: none;
            opacity: .3;
            background-image: radial-gradient(rgba(130, 148, 203, .10) .6px, transparent .6px);
            background-size: 5px 5px;
        }
        .block-container { padding-top: 5.5rem !important; }
        .login-container {
            max-width: 400px;
            margin: 0 auto;
            padding: 2rem;
            background: linear-gradient(145deg, #1c203a, #15182d);
            border: 1px solid rgba(132, 151, 205, .24);
            border-radius: 14px;
            box-shadow: inset 3px 0 0 #32d17a, 0 18px 42px rgba(0, 0, 0, .24);
        }
        .login-title {
            text-align: center;
            color: #f5f7ff;
            margin-bottom: 1.5rem;
        }
        .login-subtitle {
            text-align: center;
            color: #9da6c1;
            font-size: 0.9rem;
            margin-bottom: 2rem;
        }
        [data-testid="stTextInputRootElement"] input {
            background: #171c33 !important;
            color: #f5f7ff !important;
            border-color: #526389 !important;
        }
        [data-testid="stTextInputRootElement"] input::placeholder { color: #8994b4 !important; }
        [data-testid="stWidgetLabel"] p { color: #dce1f1 !important; }
        .stButton > button, [data-testid="stFormSubmitButton"] > button {
            background: #f43f67 !important;
            color: #fff !important;
            border-color: #f43f67 !important;
            border-radius: .65rem !important;
            font-weight: 700;
        }
        .stButton > button:hover, [data-testid="stFormSubmitButton"] > button:hover { background: #ff5477 !important; border-color: #ff5477 !important; }
    </style>
    """, unsafe_allow_html=True)

    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        st.markdown('<h1 class="login-title">罗盘数据中心</h1>', unsafe_allow_html=True)
        st.markdown('<p class="login-subtitle">请登录以访问系统</p>', unsafe_allow_html=True)

        from streamlit_cookies_controller import CookieController
        controller = CookieController()
        login_success = False

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
                    login_success = True
                else:
                    st.error("用户名或密码错误")

        if login_success:
            # Write persistent cookie outside of st.form context
            try:
                expiry = int(time.time()) + SESSION_TIMEOUT_HOURS * 3600
                secret = get_session_secret()
                sig_data = f"{username}:{expiry}:{login_time}:{secret}".encode("utf-8")
                signature = hashlib.sha256(sig_data).hexdigest()
                token = f"{username}:{expiry}:{login_time}:{signature}"
                controller.set(
                    SESSION_COOKIE_NAME,
                    token,
                    max_age=SESSION_TIMEOUT_HOURS * 3600,
                    same_site="lax",
                )
                st.success("登录成功！正在进入系统...")
                st.components.v1.html(
                    """
                    <script>
                      setTimeout(() => window.parent.location.reload(), 800);
                    </script>
                    """,
                    height=0,
                )
                st.stop()
            except Exception as e:
                st.warning(f"无法保存登录 Cookie: {e}")


def logout():
    st.session_state.authenticated = False
    st.session_state.username = None
    st.session_state.login_time = None

    try:
        from streamlit_cookies_controller import CookieController
        controller = CookieController()
        controller.remove(SESSION_COOKIE_NAME, same_site="lax")
    except Exception:
        pass



def require_auth():
    init_default_admin()
    if not check_session():
        login_form()
        if not st.session_state.authenticated:
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
