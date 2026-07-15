import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import streamlit as st

from auth import (
    add_user,
    change_password,
    delete_user,
    get_user_role,
    list_users,
    logout,
    require_auth,
)
from dashboard import (
    CONTENT_LABELS,
    MONEY_METRICS,
    aggregate,
    by_date,
    dates,
    get_dashboard_records,
    integer,
    metric_display,
    money,
    percent,
    shop_list,
)
from order_dashboard import load_all_orders, load_tmall_msd_orders, normalize_order_status
from task_status import LOGIN_SCREENSHOT, read_status, write_status


APP_DIR = Path(__file__).parent
DAILY_LOCK = APP_DIR / "output" / "daily_job.lock"
PROGRESS_LOG = APP_DIR / "output" / "progress.log"
ORDER_LOCK = APP_DIR / "output" / "orders" / "order_job.lock"
ORDER_STATUS = APP_DIR / "output" / "orders" / "order_job_status.json"
ORDER_LOG = APP_DIR / "logs" / "order_scrape.log"


CORE_COLUMNS = [
    ("date", "日期"),
    ("shop_name", "店铺"),
    ("income_amt", "成交金额"),
    ("pay_amt", "支付金额"),
    ("platform_subsidy_amt", "平台补贴"),
    ("talent_subsidy_amt", "达人补贴"),
    ("settlement_amt_pay_time", "结算金额"),
    ("settlement_amt_7d", "7日结算"),
    ("settlement_amt_14d", "14日结算"),
    ("pay_cnt", "订单"),
    ("pay_item_cnt", "成交件数"),
    ("pay_ucnt", "成交人数"),
    ("per_usr_pay_amt", "客单价"),
    ("per_item_pay_amt", "件单价"),
    ("product_show_ucnt", "曝光人数"),
    ("product_click_ucnt", "点击人数"),
    ("product_show_cnt", "曝光次数"),
    ("product_click_cnt", "点击次数"),
    ("product_show_click_ucnt_ratio", "曝光点击率"),
    ("product_click_pay_ucnt_ratio", "点击支付率"),
    ("product_show_pay_ucnt_ratio", "曝光成交率"),
    ("product_show_click_cnt_ratio", "曝光点击率(次)"),
    ("product_click_pay_cnt_ratio", "点击成交率(次)"),
    ("product_show_pay_cnt_ratio", "曝光成交率(次)"),
    ("pay_amt_per_k_show", "千次曝光支付"),
    ("deal_refund_amt_pay_time", "成交退款(支付)"),
    ("refund_amt_pay_time", "退款金额(支付)"),
    ("refund_amt", "退款金额"),
    ("refund_order_cnt_pay_time", "退款订单(支付)"),
    ("refund_amt_rate", "退款率"),
    ("expense_amt", "支出金额"),
    ("service_score", "体验分"),
]

NEW_METRIC_GROUPS = [
    (
        "交易补贴",
        [
            ("platform_subsidy_amt", "平台补贴"),
            ("talent_subsidy_amt", "达人补贴"),
            ("pay_item_cnt", "成交件数"),
            ("per_item_pay_amt", "件单价"),
        ],
    ),
    (
        "结算退款",
        [
            ("settlement_amt_7d", "7日结算"),
            ("settlement_amt_14d", "14日结算"),
            ("deal_refund_amt_pay_time", "成交退款(支付)"),
            ("refund_amt_pay_time", "退款金额(支付)"),
            ("refund_order_cnt_pay_time", "退款订单(支付)"),
        ],
    ),
    (
        "流量次数口径",
        [
            ("product_show_cnt", "曝光次数"),
            ("product_click_cnt", "点击次数"),
            ("product_show_click_cnt_ratio", "曝光点击率(次)"),
            ("product_click_pay_cnt_ratio", "点击成交率(次)"),
            ("product_show_pay_cnt_ratio", "曝光成交率(次)"),
            ("pay_amt_per_k_show", "千次曝光支付"),
        ],
    ),
    (
        "流量人数口径",
        [
            ("product_show_ucnt", "曝光人数"),
            ("product_click_ucnt", "点击人数"),
            ("product_show_click_ucnt_ratio", "曝光点击率"),
            ("product_click_pay_ucnt_ratio", "点击支付率"),
            ("product_show_pay_ucnt_ratio", "曝光成交率"),
        ],
    ),
]


def records_to_frame(records):
    rows = []
    for record in records:
        row = {
            "date": record["date"],
            "shop_name": record["shop_name"],
            "captured_at": record.get("captured_at"),
            "source": record.get("source", ""),
            "source_file": record.get("source_file", ""),
        }
        row.update(record.get("metrics", {}))
        rows.append(row)
    return pd.DataFrame(rows)


def content_to_frame(records):
    rows = []
    for record in records:
        row = {
            "date": record["date"],
            "shop_name": record["shop_name"],
        }
        row.update(record.get("content", {}))
        rows.append(row)
    return pd.DataFrame(rows)


def metric_value(records, code):
    return aggregate(records).get(code)


def latest_records(records):
    all_dates = dates(records)
    if not all_dates:
        return "-", []
    latest_date = all_dates[-1]
    return latest_date, by_date(records).get(latest_date, [])


def format_delta(records, code):
    all_dates = dates(records)
    if len(all_dates) < 2:
        return None
    grouped = by_date(records)
    current = aggregate(grouped[all_dates[-1]]).get(code)
    previous = aggregate(grouped[all_dates[-2]]).get(code)
    if current is None or previous is None:
        return None
    diff = current - previous
    sign = "+" if diff > 0 else ""
    return sign + metric_display(code, diff)


def trend_chart(df, metric_code, title):
    if df.empty or metric_code not in df:
        return
    chart_df = (
        df.pivot_table(
            index="date",
            columns="shop_name",
            values=metric_code,
            aggfunc="last",
        )
        .sort_index()
    )
    if metric_code.endswith("_amt"):
        chart_df = chart_df / 100
    elif metric_code.endswith("_ratio"):
        chart_df = chart_df * 100
    st.subheader(title)
    st.line_chart(chart_df, height=280)


def bar_chart(df, metric_code, title):
    if df.empty or metric_code not in df:
        return
    latest_date = sorted(df["date"].dropna().unique())[-1]
    latest = df[df["date"] == latest_date][["shop_name", metric_code]].dropna()
    if latest.empty:
        return
    latest = latest.sort_values(metric_code, ascending=False).set_index("shop_name")
    if metric_code.endswith("_amt"):
        latest[metric_code] = latest[metric_code] / 100
    elif metric_code.endswith("_ratio"):
        latest[metric_code] = latest[metric_code] * 100
    st.subheader(title)
    st.bar_chart(latest, height=240)
    value_label = "金额" if metric_code.endswith("_amt") else "数值"
    value_rows = []
    for shop_name, row in latest.iterrows():
        raw_value = row[metric_code]
        if metric_code.endswith("_amt"):
            shown_value = f"¥{raw_value:,.2f}"
        elif metric_code.endswith("_ratio"):
            shown_value = f"{raw_value:.2f}%"
        else:
            shown_value = f"{raw_value:,.0f}"
        value_rows.append({"店铺": shop_name, value_label: shown_value})
    st.table(pd.DataFrame(value_rows))


def display_value(code, value):
    return metric_display(code, value)


def display_table(df):
    rows = []
    for _, row in df.sort_values(["date", "shop_name"], ascending=[False, True]).iterrows():
        item = {}
        for code, label in CORE_COLUMNS:
            value = row.get(code)
            if code in {"date", "shop_name"}:
                item[label] = value
            else:
                item[label] = display_value(code, value if pd.notna(value) else None)
        rows.append(item)
    return pd.DataFrame(rows)


def start_manual_scrape():
    PROGRESS_LOG.parent.mkdir(parents=True, exist_ok=True)
    clear_progress_log()
    write_status(
        state="manual_requested",
        message="已收到手动补采请求，正在启动采集任务",
        last_error="",
    )
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    with PROGRESS_LOG.open("ab") as log_file:
        started_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_file.write(f"[{started_at}] start manual compass scrape\n".encode("utf-8"))
        log_file.flush()
        subprocess.Popen(
            [
                sys.executable,
                "scheduler_run.py",
                "--random-delay-seconds",
                "0",
                "--login-timeout-minutes",
                "30",
            ],
            cwd=str(APP_DIR),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )


def clear_progress_log():
    PROGRESS_LOG.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_LOG.write_text("", encoding="utf-8")


def read_recent_log(path, max_lines=80, max_bytes=60000):
    if not path.exists():
        return ""
    try:
        with path.open("rb") as file:
            file.seek(0, os.SEEK_END)
            size = file.tell()
            file.seek(max(0, size - max_bytes), os.SEEK_SET)
            text = file.read().decode("utf-8", errors="replace")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-max_lines:])


def read_order_status():
    if not ORDER_STATUS.exists():
        return {}
    try:
        return json.loads(ORDER_STATUS.read_text(encoding="utf-8"))
    except Exception:
        return {}


def start_manual_order_scrape():
    ORDER_LOG.parent.mkdir(parents=True, exist_ok=True)
    ORDER_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with ORDER_LOG.open("ab") as log_file:
        subprocess.Popen(
            [
                sys.executable,
                "order_scheduler_run.py",
                "--login-timeout-minutes",
                "30",
            ],
            cwd=str(APP_DIR),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )


def orders_to_frame(orders):
    columns = [
        "pay_time",
        "brand",
        "platform",
        "shop_name",
        "order_no",
        "sku_code",
        "model",
        "order_status",
        "quantity",
        "product_price",
        "order_amount",
        "product_name",
    ]
    df = pd.DataFrame(orders)
    for column in columns:
        if column not in df:
            df[column] = "" if column not in {"quantity", "product_price", "order_amount"} else 0
    if df.empty:
        return df
    df["pay_time_dt"] = pd.to_datetime(df["pay_time"], errors="coerce")
    df["pay_date"] = df["pay_time_dt"].dt.strftime("%Y-%m-%d").fillna("")
    df["quantity"] = pd.to_numeric(df["quantity"], errors="coerce").fillna(0).astype(int)
    df["product_price"] = pd.to_numeric(df["product_price"], errors="coerce").fillna(0)
    df["order_amount"] = pd.to_numeric(df["order_amount"], errors="coerce").fillna(0)
    df["brand"] = df["brand"].fillna("").replace("", "未识别")
    df["order_status"] = (
        df["order_status"].fillna("").map(normalize_order_status).replace("", "未知")
    )
    df["shop_name"] = df["shop_name"].fillna("").replace("", "未知店铺")
    df["sku_code"] = df["sku_code"].fillna("").replace("", "未填写")
    return df


def yuan(value):
    if value is None or pd.isna(value):
        return "-"
    return f"¥{float(value):,.2f}"


def order_table_column_config(df):
    config = {}
    for column in df.columns:
        if column in {"商品名称", "型号"}:
            config[column] = st.column_config.TextColumn(width="large")
        elif column in {"订单号", "商品编码", "店铺"}:
            config[column] = st.column_config.TextColumn(width="medium")
        else:
            config[column] = st.column_config.TextColumn(width="small")
    return config


def content_table(content_df):
    rows = []
    for _, row in content_df.sort_values(["date", "shop_name"], ascending=[False, True]).iterrows():
        item = {
            "日期": row.get("date"),
            "店铺": row.get("shop_name"),
        }
        for code, label in CONTENT_LABELS.items():
            value = row.get(code)
            item[label] = money(value if pd.notna(value) else None)
        rows.append(item)
    return pd.DataFrame(rows)


def apply_dashboard_theme():
    """Apply the shared dark data-center visual system to every dashboard page."""
    st.markdown(
        """
        <style>
          :root {
            --ink: #f5f7ff;
            --muted: #8d96b5;
            --navy-950: #0a0c18;
            --navy-900: #0f1222;
            --navy-850: #15182d;
            --navy-800: #1a1e36;
            --navy-700: #202746;
            --line: rgba(132, 151, 205, .18);
            --pink: #f43f67;
            --blue: #3ba7f5;
            --green: #32d17a;
            --orange: #ff931f;
            --purple: #ad62d7;
          }
          .stApp, [data-testid="stAppViewContainer"], [data-testid="stHeader"] {
            background: var(--navy-950);
            color: var(--ink);
          }
          .stApp:before {
            content: "";
            position: fixed;
            inset: 0;
            pointer-events: none;
            opacity: .38;
            background-image: radial-gradient(rgba(130, 148, 203, .10) .6px, transparent .6px);
            background-size: 5px 5px;
            z-index: 0;
          }
          [data-testid="stAppViewContainer"] > .main { position: relative; z-index: 1; }
          .block-container { padding: 1rem 2.65rem 3.4rem !important; max-width: 1740px; }
          [data-testid="stSidebar"] { background: #111426; border-right: 1px solid var(--line); }
          [data-testid="stSidebar"] * { color: var(--ink); }
          [data-testid="stSidebar"] [data-baseweb="input"] { background: var(--navy-800); }
          h1, h2, h3, p, label, .stMarkdown, .stCaption, [data-testid="stWidgetLabel"] { color: var(--ink); }
          h1, h2, h3 { letter-spacing: -.025em; }
          h2 { font-size: 1.28rem !important; margin-top: .25rem !important; }
          [data-testid="stCaptionContainer"] p, .stCaption { color: var(--muted) !important; }
          [data-baseweb="tab-list"] {
            gap: .55rem;
            border-bottom: 2px solid #183258;
            padding: 0 .1rem;
          }
          button[data-baseweb="tab"] {
            height: 4.5rem;
            padding: 0 1.45rem;
            color: #9ba5c2 !important;
            font-size: 1.02rem;
            font-weight: 700;
            border-radius: .72rem .72rem 0 0;
            transition: background .2s ease, color .2s ease;
          }
          button[data-baseweb="tab"][aria-selected="true"] {
            color: var(--pink) !important;
            background: rgba(244, 63, 103, .13) !important;
          }
          button[data-baseweb="tab"]:hover { color: #f0f2fa !important; background: rgba(91, 104, 156, .13); }
          [data-testid="stMetric"] {
            background: linear-gradient(145deg, rgba(28, 32, 58, .98), rgba(20, 23, 43, .98));
            border: 1px solid rgba(125, 146, 207, .12);
            border-radius: .8rem;
            min-height: 8.8rem;
            padding: 1.35rem 1.45rem;
            box-shadow: inset 3px 0 0 var(--blue), 0 14px 30px rgba(0, 0, 0, .16);
          }
          [data-testid="stMetricLabel"] p { color: #9da6c1 !important; font-size: .96rem; }
          [data-testid="stMetricValue"] { color: #f7f8fd !important; font-size: clamp(1.7rem, 2.3vw, 2.55rem); font-variant-numeric: tabular-nums; }
          [data-testid="stMetricDelta"] { color: var(--muted) !important; }
          div[data-testid="stVerticalBlockBorderWrapper"] {
            background: rgba(24, 28, 51, .95);
            border: 1px solid var(--line) !important;
            border-radius: .8rem;
            box-shadow: none !important;
          }
          [data-baseweb="select"] > div, [data-baseweb="input"] > div,
          [data-baseweb="base-input"] { background: #17203b !important; border-color: #526389 !important; color: var(--ink) !important; }
          [data-baseweb="select"] *, [data-baseweb="input"] input { color: var(--ink) !important; }
          [data-baseweb="popover"] { background: #1a1e36 !important; }
          [data-baseweb="menu"] { background: #1a1e36 !important; }
          [data-baseweb="menu"] * { color: var(--ink) !important; }
          .stButton > button, .stDownloadButton > button, [data-testid="stLinkButton"] a {
            background: #1b2545 !important;
            border: 1px solid #5d6f99 !important;
            color: var(--ink) !important;
            border-radius: .65rem !important;
            font-weight: 700;
          }
          .stButton > button[kind="primary"] { background: var(--pink) !important; border-color: var(--pink) !important; }
          .stButton > button:hover, .stDownloadButton > button:hover { transform: translateY(-1px); border-color: #91a4d6 !important; }
          [data-testid="stDataFrame"] { border: 1px solid var(--line); border-radius: .8rem; overflow: hidden; }
          [data-testid="stDataFrame"] [role="columnheader"] { background: #192747 !important; }
          [data-testid="stDataFrame"] * { color: #e9ecf7 !important; }
          [data-testid="stExpander"] { border: 1px solid var(--line); border-radius: .75rem; background: rgba(22, 26, 47, .92); }
          [data-testid="stAlert"] { background: rgba(37, 50, 86, .58); color: var(--ink); border-color: var(--line); }
          .dashboard-topline {
            display: flex; align-items: center; justify-content: space-between; gap: 1rem;
            padding: .7rem 0 1rem;
          }
          .dashboard-brand { display: flex; align-items: center; gap: .75rem; font-size: 1.45rem; font-weight: 800; color: #fff; }
          .dashboard-brand-mark { width: 2.15rem; height: 2.15rem; display: inline-grid; place-items: center; color: #071728; background: #2fd49a; border-radius: .65rem; font-size: 1.2rem; }
          .dashboard-meta { color: var(--muted); font-size: .86rem; text-align: right; }
          .page-kicker { color: #8f9abb; font-size: .82rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-top: 1.5rem; }
          .page-title { margin: .18rem 0 .4rem; font-size: clamp(1.55rem, 2.2vw, 2.15rem); font-weight: 800; }
          .page-subtitle { color: var(--muted); font-size: .96rem; margin-bottom: 1.35rem; }
          .empty-dashboard {
            min-height: 18rem; display: grid; place-items: center; text-align: center;
            border: 1px dashed rgba(126, 148, 211, .36); border-radius: .85rem;
            background: linear-gradient(135deg, rgba(32, 38, 69, .7), rgba(20, 23, 42, .68));
            margin-top: 1rem; padding: 2rem;
          }
          .empty-dashboard strong { display: block; font-size: 1.16rem; margin-bottom: .55rem; color: #f0f2fb; }
          .empty-dashboard span { color: var(--muted); font-size: .92rem; }
          .section-label { margin: 1.75rem 0 .78rem; color: #f4f5fb; font-size: 1.22rem; font-weight: 800; }
          @media (max-width: 700px) {
            .block-container { padding: .7rem 1rem 2.5rem !important; }
            .dashboard-topline { align-items: flex-start; }
            .dashboard-meta { display: none; }
            button[data-baseweb="tab"] { padding: 0 .75rem; height: 3.6rem; font-size: .9rem; }
          }
        </style>
        """,
        unsafe_allow_html=True,
    )


def render_page_heading(kicker, title, subtitle):
    st.markdown(
        f'<div class="page-kicker">{kicker}</div>'
        f'<div class="page-title">{title}</div>'
        f'<div class="page-subtitle">{subtitle}</div>',
        unsafe_allow_html=True,
    )


def render_empty_dashboard(title, subtitle, metrics):
    """Render an intentional empty state instead of inventing business data."""
    render_page_heading("数据看板", title, subtitle)
    columns = st.columns(len(metrics))
    for index, label in enumerate(metrics):
        with columns[index]:
            st.metric(label, "—", "等待数据接入")
    st.markdown(
        """
        <div class="empty-dashboard">
          <div><strong>该页暂未接入数据</strong><span>页面结构、筛选和指标口径已准备完成；数据到位后会自动展示。</span></div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_kpis(kpis, totals, records):
    columns = st.columns(3)
    for index, (code, label) in enumerate(kpis):
        value = display_value(code, totals.get(code))
        delta = format_delta(records, code)
        with columns[index % 3]:
            st.metric(label, value, delta=delta)
            if delta is None:
                st.caption("等待更多每日样本")
        if index == 2:
            columns = st.columns(3)


def latest_metric_rows(records, metrics):
    rows = []
    for record in sorted(records, key=lambda item: item["shop_name"]):
        item = {"店铺": record["shop_name"]}
        for code, label in metrics:
            value = record.get("metrics", {}).get(code)
            item[label] = display_value(code, value)
        rows.append(item)
    return pd.DataFrame(rows)


def render_metric_group(title, metrics, latest_records_for_date, totals):
    st.markdown(f"**{title}**")
    columns = st.columns(min(len(metrics), 4))
    for index, (code, label) in enumerate(metrics):
        with columns[index % len(columns)]:
            with st.container(border=True):
                st.caption(label)
                st.markdown(f"**{display_value(code, totals.get(code))}**")
    group_df = latest_metric_rows(latest_records_for_date, metrics)
    st.dataframe(
        group_df,
        width="stretch",
        hide_index=True,
        column_config=table_column_config(group_df),
    )


def table_column_config(df):
    config = {}
    wide_columns = {"店铺"}
    money_columns = {
        label
        for code, label in CORE_COLUMNS
        if code in MONEY_METRICS or code.endswith("_amt")
    }
    for column in df.columns:
        if column in wide_columns:
            config[column] = st.column_config.TextColumn(width="large")
        elif column in money_columns:
            config[column] = st.column_config.TextColumn(width="medium")
        else:
            config[column] = st.column_config.TextColumn(width="small")
    return config


def render_account_sidebar(current_user, current_role):
    with st.sidebar:
        st.caption(f"最后刷新：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        st.markdown("---")
        st.markdown(f"**当前用户：** {current_user}")
        st.markdown(f"**角色：** {current_role}")

        with st.expander("修改密码"):
            with st.form("change_password_form"):
                old_password = st.text_input("当前密码", type="password")
                new_password = st.text_input("新密码", type="password")
                confirm_password = st.text_input("确认新密码", type="password")
                if st.form_submit_button("保存"):
                    if new_password != confirm_password:
                        st.error("两次输入的新密码不一致")
                    elif change_password(current_user, old_password, new_password):
                        st.success("密码修改成功")
                    else:
                        st.error("当前密码错误")

        if current_role == "admin":
            with st.expander("用户管理"):
                st.markdown("**添加用户**")
                with st.form("add_user_form"):
                    new_username = st.text_input("用户名")
                    new_user_password = st.text_input("密码", type="password")
                    new_user_role = st.selectbox("角色", ["viewer", "admin"])
                    if st.form_submit_button("添加"):
                        if add_user(new_username, new_user_password, new_user_role):
                            st.success(f"用户 {new_username} 添加成功")
                            st.rerun()
                        else:
                            st.error("用户名已存在")

                st.markdown("**用户列表**")
                users = list_users()
                for user in users:
                    col1, col2 = st.columns([2, 1])
                    with col1:
                        st.write(f"{user['username']} ({user['role']})")
                    with col2:
                        if user["username"] != "admin":
                            if st.button("删除", key=f"del_{user['username']}"):
                                if delete_user(user["username"]):
                                    st.success(f"用户 {user['username']} 已删除")
                                    st.rerun()

        if st.button("退出登录"):
            logout()


@st.fragment(run_every="2s")
def render_compass_status_fragment(novnc_url):
    status = read_status()
    state = status.get("state", "unknown")
    message = status.get("message", "暂无采集状态")

    st.write(f"状态：**{state}**")
    st.write(message)

    if status.get("updated_at"):
        st.caption(f"更新时间：{status['updated_at']}")

    if status.get("last_success_at"):
        st.success(f"最近成功采集：{status['last_success_at']}")

    if status.get("last_error"):
        st.error(status["last_error"])

    job_running = DAILY_LOCK.exists()
    if st.button("手动补采今天数据", type="primary", disabled=job_running):
        try:
            start_manual_scrape()
            st.success("已启动手动补采任务，请稍后刷新状态；如需要登录，请打开 noVNC 扫码。")
            st.rerun(scope="fragment")
        except Exception as exc:
            st.error(f"手动补采启动失败：{exc!r}")

    if job_running:
        st.info("已有采集任务在运行，暂时不能重复启动。")

    st.button("刷新采集进度")

    if st.button("清除终端进度日志"):
        clear_progress_log()
        st.success("已清除终端进度日志。")

    if state == "success":
        if st.button("刷新整个看板数据"):
            st.rerun(scope="app")

    progress_log = read_recent_log(PROGRESS_LOG)
    if progress_log:
        st.caption("最近终端进度日志（仅此区域每 2 秒自动更新）")
        st.code(progress_log, language="text")
    else:
        st.caption("暂无终端进度日志。")

    if state == "login_required":
        st.warning("当前需要扫码登录。请扫描下方截图中的二维码，或打开 noVNC 远程浏览器完成登录。")
        if LOGIN_SCREENSHOT.exists():
            st.image(str(LOGIN_SCREENSHOT), caption="登录页面截图")
        else:
            st.info("暂未生成登录截图，请稍后刷新页面。")

    st.link_button("打开远程浏览器 noVNC", novnc_url)


def render_compass_status(novnc_url):
    with st.expander("采集状态", expanded=True):
        render_compass_status_fragment(novnc_url)


def render_compass_dashboard(novnc_url):
    render_page_heading(
        "抖店罗盘",
        "罗盘数据",
        "汇总已采集店铺的交易、流量、转化与结算指标。",
    )

    records = get_dashboard_records()
    if not records:
        render_empty_dashboard(
            "罗盘数据",
            "尚未读取到罗盘采集结果。完成采集后，数据会直接显示在此页。",
            ["成交金额", "支付金额", "结算金额", "成交订单", "退款率"],
        )
        render_compass_status(novnc_url)
        return

    all_dates = dates(records)
    shops = shop_list(records)
    filter_left, filter_right = st.columns(2)
    with filter_left:
        selected_dates = st.multiselect("业务日期", all_dates, default=all_dates)
    with filter_right:
        shop_names = [shop["shop_name"] for shop in shops]
        selected_shops = st.multiselect("店铺", shop_names, default=shop_names)

    filtered_records = [
        record
        for record in records
        if record["date"] in selected_dates and record["shop_name"] in selected_shops
    ]

    if not filtered_records:
        st.warning("当前筛选条件下没有数据。")
        return

    df = records_to_frame(filtered_records)
    content_df = content_to_frame(filtered_records)
    latest_date, latest = latest_records(filtered_records)
    latest_totals = aggregate(latest)

    st.caption(
        f"最新业务日期：{latest_date} · "
        f"店铺数：{len({record['shop_name'] for record in filtered_records})} · "
        f"业务天数：{len(dates(filtered_records))}"
    )

    kpis = [
        ("income_amt", "全店成交金额"),
        ("pay_amt", "全店支付金额"),
        ("settlement_amt_pay_time", "全店结算金额"),
        ("pay_cnt", "成交订单"),
        ("pay_ucnt", "成交人数"),
        ("refund_amt_rate", "退款率"),
    ]
    render_kpis(kpis, latest_totals, filtered_records)

    st.markdown('<div class="section-label">指标总览</div>', unsafe_allow_html=True)
    metric_tabs = st.tabs([title for title, _ in NEW_METRIC_GROUPS])
    for tab, (title, metrics) in zip(metric_tabs, NEW_METRIC_GROUPS):
        with tab:
            render_metric_group(title, metrics, latest, latest_totals)

    left, right = st.columns([2, 1])
    with left:
        trend_chart(df, "income_amt", "成交金额趋势")
        trend_chart(df, "pay_cnt", "订单趋势")
        trend_chart(df, "product_click_pay_ucnt_ratio", "点击成交转化率趋势")

    with right:
        bar_chart(df, "income_amt", "最新日成交对比")
        bar_chart(df, "pay_cnt", "最新日订单对比")

    st.markdown('<div class="section-label">店铺明细</div>', unsafe_allow_html=True)
    detail_df = display_table(df)
    st.dataframe(
        detail_df,
        width="stretch",
        hide_index=True,
        column_config=table_column_config(detail_df),
    )

    st.markdown('<div class="section-label">内容来源拆分</div>', unsafe_allow_html=True)
    content_display_df = content_table(content_df)
    st.dataframe(
        content_display_df,
        width="stretch",
        hide_index=True,
        column_config=table_column_config(content_display_df),
    )

    with st.expander("数据来源"):
        source_files = sorted(
            {
                str(record.get("source_file"))
                for record in filtered_records
                if record.get("source_file")
            }
        )
        if source_files:
            st.write("每日 JSON：")
            for source_file in source_files:
                st.code(source_file)
        st.write("Streamlit 看板直接读取本地 `output/daily/**/*.json`，并兼容 `metrics.db` 中的历史接口数据。")

    render_compass_status(novnc_url)


def render_order_status(novnc_url):
    with st.expander("订单采集状态", expanded=True):
        status = read_order_status()
        state = status.get("state", "unknown")
        st.write(f"状态：**{state}**")
        st.write(status.get("message", "暂无订单采集状态"))

        if status.get("updated_at"):
            st.caption(f"更新时间：{status['updated_at']}")
        if status.get("last_success_at"):
            st.success(f"最近成功采集：{status['last_success_at']}")
        if status.get("last_error"):
            st.error(status["last_error"])

        order_running = ORDER_LOCK.exists()
        if st.button("手动采集昨日订单", type="primary", disabled=order_running):
            try:
                start_manual_order_scrape()
                st.success("已启动订单采集任务，请稍后刷新；如需要登录，请打开 noVNC 完成扫码。")
                st.rerun()
            except Exception as exc:
                st.error(f"订单采集启动失败：{exc!r}")

        if order_running:
            st.info("已有订单采集任务在运行，暂时不能重复启动。")

        st.link_button("打开远程浏览器 noVNC", novnc_url)


def render_order_dashboard(novnc_url):
    st.header("订单数据看板")
    render_order_status(novnc_url)

    orders = load_all_orders()
    df = orders_to_frame(orders)
    if df.empty:
        st.info("还没有订单数据。可以点击上方按钮采集昨日订单。")
        return

    date_options = sorted([date for date in df["pay_date"].dropna().unique() if date])
    shop_options = sorted([shop for shop in df["shop_name"].dropna().unique() if shop])
    brand_options = sorted([brand for brand in df["brand"].dropna().unique() if brand])
    sku_options = sorted([sku for sku in df["sku_code"].dropna().unique() if sku])
    status_options = sorted([status for status in df["order_status"].dropna().unique() if status])
    default_statuses = [status for status in status_options if status != "已关闭"]
    if not default_statuses:
        default_statuses = status_options

    col1, col2, col3, col4, col5 = st.columns(5)
    with col1:
        selected_order_dates = st.multiselect("下单日期", date_options, default=date_options)
    with col2:
        selected_order_shops = st.multiselect("订单店铺", shop_options, default=shop_options)
    with col3:
        selected_brands = st.multiselect("品牌", brand_options, default=brand_options)
    with col4:
        selected_skus = st.multiselect("商品编码", sku_options, default=sku_options)
    with col5:
        selected_statuses = st.multiselect("订单状态", status_options, default=default_statuses)
    if "已关闭" in status_options and "已关闭" not in selected_statuses:
        st.caption('订单看板默认忽略"已关闭"订单；如需查看，可在订单状态筛选中勾选。')
    search = st.text_input("搜索订单号 / 商品 / SKU / 型号")

    filtered = df[
        df["pay_date"].isin(selected_order_dates)
        & df["shop_name"].isin(selected_order_shops)
        & df["brand"].isin(selected_brands)
        & df["sku_code"].isin(selected_skus)
        & df["order_status"].isin(selected_statuses)
    ].copy()
    if search:
        search_lower = search.lower()
        searchable = (
            filtered["order_no"].astype(str)
            + " "
            + filtered["product_name"].astype(str)
            + " "
            + filtered["sku_code"].astype(str)
            + " "
            + filtered["model"].astype(str)
        ).str.lower()
        filtered = filtered[searchable.str.contains(search_lower, regex=False)]

    total_count = len(filtered)
    total_amount = filtered["order_amount"].sum()
    avg_amount = total_amount / total_count if total_count else 0
    shipped_count = filtered["order_status"].astype(str).str.contains("待发货|已发货", regex=True).sum()

    metric_cols = st.columns(4)
    metric_cols[0].metric("订单总数", f"{total_count:,}")
    metric_cols[1].metric("订单总金额", yuan(total_amount))
    metric_cols[2].metric("平均订单金额", yuan(avg_amount))
    metric_cols[3].metric("待处理/已发货", f"{int(shipped_count):,}")

    chart_left, chart_right = st.columns(2)
    with chart_left:
        if not filtered.empty:
            daily_amount = filtered.groupby("pay_date")["order_amount"].sum().sort_index()
            st.subheader("订单金额趋势")
            st.line_chart(daily_amount, height=260)
    with chart_right:
        if not filtered.empty:
            status_counts = filtered["order_status"].replace("", "未知").value_counts()
            st.subheader("订单状态分布")
            st.bar_chart(status_counts, height=260)

    shop_summary = (
        filtered.groupby("shop_name", dropna=False)
        .agg(订单数=("order_no", "count"), 订单金额=("order_amount", "sum"))
        .sort_values("订单金额", ascending=False)
        .reset_index()
        .rename(columns={"shop_name": "店铺"})
    )
    if not shop_summary.empty:
        shop_summary["订单金额"] = shop_summary["订单金额"].map(yuan)
        st.subheader("店铺汇总")
        st.dataframe(shop_summary, width="stretch", hide_index=True)

    sku_summary = (
        filtered.groupby("sku_code", dropna=False)
        .agg(
            销量=("quantity", "sum"),
            订单数=("order_no", "count"),
            订单金额=("order_amount", "sum"),
            店铺=("shop_name", lambda values: " / ".join(sorted(set(values)))),
            品牌=("brand", lambda values: " / ".join(sorted(set(values)))),
            型号=("model", "first"),
            商品名称=("product_name", "first"),
        )
        .sort_values(["销量", "订单金额"], ascending=[False, False])
        .reset_index()
        .rename(columns={"sku_code": "商品编码"})
    )
    if not sku_summary.empty:
        sku_summary["订单金额"] = sku_summary["订单金额"].map(yuan)
        st.subheader("商品编码销量汇总")
        st.dataframe(
            sku_summary,
            width="stretch",
            hide_index=True,
            column_config=order_table_column_config(sku_summary),
        )

    table_df = filtered.sort_values("pay_time_dt", ascending=False)[
        [
            "pay_time",
            "brand",
            "platform",
            "shop_name",
            "order_no",
            "sku_code",
            "model",
            "order_status",
            "quantity",
            "product_price",
            "order_amount",
            "product_name",
        ]
    ].rename(
        columns={
            "pay_time": "支付完成时间",
            "brand": "品牌",
            "platform": "平台",
            "shop_name": "店铺",
            "order_no": "订单号",
            "sku_code": "商品编码",
            "model": "型号",
            "order_status": "订单状态",
            "quantity": "商品数量",
            "product_price": "商品金额",
            "order_amount": "订单金额",
            "product_name": "商品名称",
        }
    )
    for column in ("商品金额", "订单金额"):
        table_df[column] = table_df[column].map(yuan)

    st.subheader("订单明细")
    st.dataframe(
        table_df,
        width="stretch",
        hide_index=True,
        column_config=order_table_column_config(table_df),
    )
    st.download_button(
        "导出当前筛选 CSV",
        filtered.to_csv(index=False).encode("utf-8-sig"),
        file_name=f"orders_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        mime="text/csv",
    )

    with st.expander("数据来源"):
        st.write("订单看板直接读取本地 `output/orders/**/*.json`。")
        st.code(str(APP_DIR / "output" / "orders"))


def render_tmall_msd_dashboard():
    st.header("天猫MSD订单看板")

    orders = load_tmall_msd_orders()
    df = orders_to_frame(orders)
    if df.empty:
        st.info("还没有天猫MSD订单数据。请先运行采集脚本获取数据。")
        return

    date_options = sorted([date for date in df["pay_date"].dropna().unique() if date])
    brand_options = sorted([brand for brand in df["brand"].dropna().unique() if brand])
    sku_options = sorted([sku for sku in df["sku_code"].dropna().unique() if sku])
    status_options = sorted([status for status in df["order_status"].dropna().unique() if status])
    default_statuses = [status for status in status_options if status != "已关闭"]
    if not default_statuses:
        default_statuses = status_options

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        selected_dates = st.multiselect("下单日期", date_options, default=date_options, key="tmall_dates")
    with col2:
        selected_brands = st.multiselect("品牌", brand_options, default=brand_options, key="tmall_brands")
    with col3:
        selected_skus = st.multiselect("商品编码", sku_options, default=sku_options, key="tmall_skus")
    with col4:
        selected_statuses = st.multiselect("订单状态", status_options, default=default_statuses, key="tmall_statuses")
    if "已关闭" in status_options and "已关闭" not in selected_statuses:
        st.caption('默认忽略"已关闭"订单；如需查看，可在订单状态筛选中勾选。')
    search = st.text_input("搜索订单号 / 商品 / SKU / 型号", key="tmall_search")

    filtered = df[
        df["pay_date"].isin(selected_dates)
        & df["brand"].isin(selected_brands)
        & df["sku_code"].isin(selected_skus)
        & df["order_status"].isin(selected_statuses)
    ].copy()
    if search:
        search_lower = search.lower()
        searchable = (
            filtered["order_no"].astype(str)
            + " "
            + filtered["product_name"].astype(str)
            + " "
            + filtered["sku_code"].astype(str)
            + " "
            + filtered["model"].astype(str)
        ).str.lower()
        filtered = filtered[searchable.str.contains(search_lower, regex=False)]

    total_count = len(filtered)
    total_amount = filtered["order_amount"].sum()
    avg_amount = total_amount / total_count if total_count else 0
    shipped_count = filtered["order_status"].astype(str).str.contains("待发货|已发货", regex=True).sum()

    metric_cols = st.columns(4)
    metric_cols[0].metric("订单总数", f"{total_count:,}")
    metric_cols[1].metric("订单总金额", yuan(total_amount))
    metric_cols[2].metric("平均订单金额", yuan(avg_amount))
    metric_cols[3].metric("待处理/已发货", f"{int(shipped_count):,}")

    chart_left, chart_right = st.columns(2)
    with chart_left:
        if not filtered.empty:
            daily_amount = filtered.groupby("pay_date")["order_amount"].sum().sort_index()
            st.subheader("订单金额趋势")
            st.line_chart(daily_amount, height=260)
    with chart_right:
        if not filtered.empty:
            status_counts = filtered["order_status"].replace("", "未知").value_counts()
            st.subheader("订单状态分布")
            st.bar_chart(status_counts, height=260)

    brand_summary = (
        filtered.groupby("brand", dropna=False)
        .agg(订单数=("order_no", "count"), 订单金额=("order_amount", "sum"))
        .sort_values("订单金额", ascending=False)
        .reset_index()
        .rename(columns={"brand": "品牌"})
    )
    if not brand_summary.empty:
        brand_summary["订单金额"] = brand_summary["订单金额"].map(yuan)
        st.subheader("品牌汇总")
        st.dataframe(brand_summary, width="stretch", hide_index=True)

    sku_summary = (
        filtered.groupby("sku_code", dropna=False)
        .agg(
            销量=("quantity", "sum"),
            订单数=("order_no", "count"),
            订单金额=("order_amount", "sum"),
            品牌=("brand", lambda values: " / ".join(sorted(set(values)))),
            型号=("model", "first"),
            商品名称=("product_name", "first"),
        )
        .sort_values(["销量", "订单金额"], ascending=[False, False])
        .reset_index()
        .rename(columns={"sku_code": "商品编码"})
    )
    if not sku_summary.empty:
        sku_summary["订单金额"] = sku_summary["订单金额"].map(yuan)
        st.subheader("商品编码销量汇总")
        st.dataframe(
            sku_summary,
            width="stretch",
            hide_index=True,
            column_config=order_table_column_config(sku_summary),
        )

    table_df = filtered.sort_values("pay_time_dt", ascending=False)[
        [
            "pay_time",
            "brand",
            "platform",
            "shop_name",
            "order_no",
            "sku_code",
            "model",
            "order_status",
            "quantity",
            "product_price",
            "order_amount",
            "product_name",
        ]
    ].rename(
        columns={
            "pay_time": "支付完成时间",
            "brand": "品牌",
            "platform": "平台",
            "shop_name": "店铺",
            "order_no": "订单号",
            "sku_code": "商品编码",
            "model": "型号",
            "order_status": "订单状态",
            "quantity": "商品数量",
            "product_price": "商品金额",
            "order_amount": "订单金额",
            "product_name": "商品名称",
        }
    )
    for column in ("商品金额", "订单金额"):
        table_df[column] = table_df[column].map(yuan)

    st.subheader("订单明细")
    st.dataframe(
        table_df,
        width="stretch",
        hide_index=True,
        column_config=order_table_column_config(table_df),
    )
    st.download_button(
        "导出当前筛选 CSV",
        filtered.to_csv(index=False).encode("utf-8-sig"),
        file_name=f"tmall_msd_orders_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        mime="text/csv",
        key="tmall_export",
    )

    with st.expander("数据来源"):
        st.write("天猫MSD订单数据来自 `output/orders/**/tmall_msd/` 目录。")
        st.code(str(APP_DIR / "output" / "orders"))


def render_inventory_dashboard():
    render_empty_dashboard(
        "库存周转",
        "按品牌查看库存规模、库龄结构与近 7 天动销情况。",
        ["总 SKU 数", "有库存 SKU", "总库存量", "总库存金额", "动销率", "平均周转天数"],
    )


def render_operations_dashboard():
    render_empty_dashboard(
        "经营看板",
        "按日期、品牌和店铺查看成交、订单、退款与平台补贴。",
        ["成交金额", "成交订单量", "退货金额", "退货订单量", "平台补贴", "客单价"],
    )


def render_settlement_dashboard():
    render_empty_dashboard(
        "结算看板",
        "按月核对品牌结算、返利、国补及平台补贴。",
        ["月度结算总额", "返利总额", "国补总额", "平台补贴总额"],
    )


def render_douyin_channel_dashboard():
    render_empty_dashboard(
        "抖音渠道",
        "查看商品卡流量来源、点击率和商品成交表现。",
        ["自然搜索", "推荐流量", "广告投放", "短视频引流"],
    )


st.set_page_config(
    page_title="抖店数据看板",
    page_icon="◈",
    layout="wide",
    initial_sidebar_state="collapsed",
)

current_user = require_auth()
current_role = get_user_role(current_user)
NOVNC_URL = os.getenv("NOVNC_URL", "http://127.0.0.1:6080")

apply_dashboard_theme()

render_account_sidebar(current_user, current_role)

st.markdown(
    f"""
    <div class="dashboard-topline">
      <div class="dashboard-brand"><span class="dashboard-brand-mark">◈</span> 罗盘数据中心</div>
      <div class="dashboard-meta">已登录：{current_user} · 数据按页面来源独立更新</div>
    </div>
    """,
    unsafe_allow_html=True,
)

inventory_tab, operations_tab, settlement_tab, douyin_tab, compass_tab = st.tabs(
    ["📦 库存周转", "💰 经营看板", "🧾 结算看板", "🎬 抖音渠道", "◈ 罗盘数据"]
)

with inventory_tab:
    render_inventory_dashboard()

with operations_tab:
    render_operations_dashboard()

with settlement_tab:
    render_settlement_dashboard()

with douyin_tab:
    render_douyin_channel_dashboard()

with compass_tab:
    render_compass_dashboard(NOVNC_URL)
    with st.expander("其他数据看板（订单与天猫 MSD）"):
        order_tab, tmall_tab = st.tabs(["订单数据", "天猫 MSD 订单"])
        with order_tab:
            render_order_dashboard(NOVNC_URL)
        with tmall_tab:
            render_tmall_msd_dashboard()
