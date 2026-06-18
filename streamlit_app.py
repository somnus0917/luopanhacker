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
from order_dashboard import load_all_orders
from task_status import LOGIN_SCREENSHOT, read_status, write_status


APP_DIR = Path(__file__).parent
DAILY_LOCK = APP_DIR / "output" / "daily_job.lock"
MANUAL_LOG = APP_DIR / "logs" / "manual_scrape.log"
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
    MANUAL_LOG.parent.mkdir(parents=True, exist_ok=True)
    write_status(
        state="manual_requested",
        message="已收到手动补采请求，正在启动采集任务",
        last_error="",
    )
    with MANUAL_LOG.open("ab") as log_file:
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
            start_new_session=True,
        )


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
    df["order_status"] = df["order_status"].fillna("").replace("", "未知")
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


def render_kpis(kpis, totals, records):
    columns = st.columns(3)
    for index, (code, label) in enumerate(kpis):
        value = display_value(code, totals.get(code))
        delta = format_delta(records, code) or "等待更多每日样本"
        with columns[index % 3]:
            with st.container(border=True):
                st.caption(label)
                st.markdown(f"**{value}**")
                st.caption(f"较上一业务日 {delta}")
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


def render_compass_status(novnc_url):
    with st.expander("采集状态", expanded=True):
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
                st.rerun()
            except Exception as exc:
                st.error(f"手动补采启动失败：{exc!r}")

        if job_running:
            st.info("已有采集任务在运行，暂时不能重复启动。")

        if state == "login_required":
            st.warning("当前需要扫码登录。请扫描下方截图中的二维码，或打开 noVNC 远程浏览器完成登录。")
            if LOGIN_SCREENSHOT.exists():
                st.image(str(LOGIN_SCREENSHOT), caption="登录页面截图")
            else:
                st.info("暂未生成登录截图，请稍后刷新页面。")

        st.link_button("打开远程浏览器 noVNC", novnc_url)


def render_compass_dashboard(novnc_url):
    st.header("罗盘经营看板")
    render_compass_status(novnc_url)

    records = get_dashboard_records()
    if not records:
        st.info("还没有可展示的数据。先运行 ./run_daily.sh 获取每日数据。")
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

    st.subheader("新增指标总览")
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

    st.subheader("店铺明细")
    detail_df = display_table(df)
    st.dataframe(
        detail_df,
        width="stretch",
        hide_index=True,
        column_config=table_column_config(detail_df),
    )

    st.subheader("内容来源拆分")
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
        st.caption("订单看板默认忽略“已关闭”订单；如需查看，可在订单状态筛选中勾选。")
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


st.set_page_config(
    page_title="抖店数据看板",
    page_icon="",
    layout="wide",
)

current_user = require_auth()
current_role = get_user_role(current_user)
NOVNC_URL = os.getenv("NOVNC_URL", "http://127.0.0.1:6080")

st.markdown(
    """
    <style>
      .block-container {
        padding-top: 1.4rem;
        padding-left: 2rem;
        padding-right: 2rem;
        max-width: 1680px;
      }
      div[data-testid="stVerticalBlockBorderWrapper"] strong {
        font-size: clamp(20px, 2vw, 30px);
        line-height: 1.2;
        overflow-wrap: anywhere;
        white-space: normal;
      }
      [data-testid="stDataFrame"] {
        width: 100%;
      }
    </style>
    """,
    unsafe_allow_html=True,
)

render_account_sidebar(current_user, current_role)

st.title("抖店数据看板")
compass_tab, order_tab = st.tabs(["罗盘经营看板", "订单数据看板"])

with compass_tab:
    render_compass_dashboard(NOVNC_URL)

with order_tab:
    render_order_dashboard(NOVNC_URL)
