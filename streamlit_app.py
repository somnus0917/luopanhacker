import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import streamlit as st

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
from task_status import LOGIN_SCREENSHOT, read_status, write_status


APP_DIR = Path(__file__).parent
DAILY_LOCK = APP_DIR / "output" / "daily_job.lock"
MANUAL_LOG = APP_DIR / "logs" / "manual_scrape.log"


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


st.set_page_config(
    page_title="罗盘经营看板",
    page_icon="",
    layout="wide",
)

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

st.title("罗盘经营看板")

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
    button_label = "手动补采今天数据"
    if st.button(button_label, type="primary", disabled=job_running):
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

    st.link_button("打开远程浏览器 noVNC", NOVNC_URL)

records = get_dashboard_records()
if not records:
    st.info("还没有可展示的数据。先运行 ./run_daily.sh 获取每日数据。")
    st.stop()

all_dates = dates(records)
shops = shop_list(records)

with st.sidebar:
    st.header("筛选")
    selected_dates = st.multiselect("业务日期", all_dates, default=all_dates)
    selected_shops = st.multiselect(
        "店铺",
        [shop["shop_name"] for shop in shops],
        default=[shop["shop_name"] for shop in shops],
    )
    st.caption(f"最后刷新：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

filtered_records = [
    record
    for record in records
    if record["date"] in selected_dates and record["shop_name"] in selected_shops
]

if not filtered_records:
    st.warning("当前筛选条件下没有数据。")
    st.stop()

df = records_to_frame(filtered_records)
content_df = content_to_frame(filtered_records)
latest_date, latest = latest_records(filtered_records)
latest_totals = aggregate(latest)

st.caption(f"最新业务日期：{latest_date} · 店铺数：{len({record['shop_name'] for record in filtered_records})} · 业务天数：{len(dates(filtered_records))}")

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
tabs = st.tabs([title for title, _ in NEW_METRIC_GROUPS])
for tab, (title, metrics) in zip(tabs, NEW_METRIC_GROUPS):
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
