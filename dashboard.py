import html
import json
import re
import sqlite3
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from db import init_db


DB_PATH = Path(__file__).parent / "metrics.db"
OUTPUT_PATH = Path(__file__).parent / "dashboard.html"
DAILY_OUTPUT_ROOT = Path(__file__).parent / "output" / "daily"

METRIC_LABELS = {
    "income_amt": "成交金额",
    "pay_amt": "用户支付金额",
    "platform_subsidy_amt": "平台补贴金额",
    "talent_subsidy_amt": "达人补贴金额",
    "settlement_amt_pay_time": "结算金额",
    "settlement_amt_7d": "7日结算金额",
    "settlement_amt_14d": "14日结算金额",
    "pay_cnt": "成交订单数",
    "pay_item_cnt": "成交件数",
    "pay_ucnt": "支付人数",
    "per_usr_pay_amt": "客单价",
    "per_item_pay_amt": "件单价",
    "product_show_ucnt": "商品曝光人数",
    "product_click_ucnt": "商品点击人数",
    "product_show_cnt": "商品曝光次数",
    "product_click_cnt": "商品点击次数",
    "product_show_click_ucnt_ratio": "曝光点击率",
    "product_click_pay_ucnt_ratio": "点击支付率",
    "product_show_pay_ucnt_ratio": "曝光成交率",
    "product_show_click_cnt_ratio": "曝光点击率（次数）",
    "product_click_pay_cnt_ratio": "点击成交率（次数）",
    "product_show_pay_cnt_ratio": "曝光成交率（次数）",
    "pay_amt_per_k_show": "千次曝光用户支付金额",
    "refund_amt": "退款金额",
    "refund_amt_pay_time": "退款金额（支付时间）",
    "deal_refund_amt_pay_time": "成交退款金额（支付时间）",
    "rfndsuc_amt": "退款成功金额",
    "refund_order_cnt": "退款订单数",
    "refund_order_cnt_pay_time": "退款订单数（支付时间）",
    "refund_amt_rate": "退款率",
    "expense_amt": "支出金额",
    "ad_cost_amt": "投放消耗",
    "service_score": "商家体验分",
}

CONTENT_LABELS = {
    "live": "直播",
    "product_card": "商品卡",
    "artc_video": "图文/短视频",
    "video": "短视频",
    "other_content": "其他内容",
}

MONEY_METRICS = {
    "income_amt",
    "pay_amt",
    "platform_subsidy_amt",
    "talent_subsidy_amt",
    "settlement_amt_pay_time",
    "settlement_amt_7d",
    "settlement_amt_14d",
    "per_usr_pay_amt",
    "per_item_pay_amt",
    "refund_amt",
    "refund_amt_pay_time",
    "deal_refund_amt_pay_time",
    "rfndsuc_amt",
    "pay_amt_per_k_show",
    "expense_amt",
    "ad_cost_amt",
    "talent_commission_amt",
    "platform_commission_amt",
}

COUNT_METRICS = {
    "pay_cnt",
    "pay_item_cnt",
    "pay_ucnt",
    "product_show_ucnt",
    "product_click_ucnt",
    "product_show_cnt",
    "product_click_cnt",
    "refund_order_cnt",
    "refund_order_cnt_pay_time",
}

RATIO_METRICS = {
    "product_show_click_ucnt_ratio",
    "product_click_pay_ucnt_ratio",
    "product_show_pay_ucnt_ratio",
    "product_show_click_cnt_ratio",
    "product_click_pay_cnt_ratio",
    "product_show_pay_cnt_ratio",
    "refund_amt_rate",
}

DAILY_METRIC_MAP = {
    "成交金额": ("income_amt", "money"),
    "用户支付金额": ("pay_amt", "money"),
    "平台补贴金额": ("platform_subsidy_amt", "money"),
    "达人补贴金额": ("talent_subsidy_amt", "money"),
    "结算金额": ("settlement_amt_pay_time", "money"),
    "7日结算金额": ("settlement_amt_7d", "money"),
    "14日结算金额": ("settlement_amt_14d", "money"),
    "成交订单数": ("pay_cnt", "count"),
    "成交件数": ("pay_item_cnt", "count"),
    "件单价": ("per_item_pay_amt", "money"),
    "商品曝光人数": ("product_show_ucnt", "count"),
    "商品点击人数": ("product_click_ucnt", "count"),
    "商品曝光次数": ("product_show_cnt", "count"),
    "商品点击次数": ("product_click_cnt", "count"),
    "客单价": ("per_usr_pay_amt", "money"),
    "成交人数": ("pay_ucnt", "count"),
    "退款金额（退款时间）": ("refund_amt", "money"),
    "退款金额（支付时间）": ("refund_amt_pay_time", "money"),
    "退款率（支付时间）": ("refund_amt_rate", "ratio"),
    "成交退款金额（支付时间）": ("deal_refund_amt_pay_time", "money"),
    "成交退款金额（退款时间）": ("rfndsuc_amt", "money"),
    "退款订单数（退款时间）": ("refund_order_cnt", "count"),
    "退款订单数（支付时间）": ("refund_order_cnt_pay_time", "count"),
    "商品曝光-点击转化率（人数）": ("product_show_click_ucnt_ratio", "ratio"),
    "商品点击-成交转化率（人数）": ("product_click_pay_ucnt_ratio", "ratio"),
    "商品曝光-成交转化率（人数）": ("product_show_pay_ucnt_ratio", "ratio"),
    "商品曝光-点击转化率（次数）": ("product_show_click_cnt_ratio", "ratio"),
    "商品点击-成交转化率（次数）": ("product_click_pay_cnt_ratio", "ratio"),
    "商品曝光-成交转化率（次数）": ("product_show_pay_cnt_ratio", "ratio"),
    "千次曝光用户支付金额": ("pay_amt_per_k_show", "money"),
    "支出金额": ("expense_amt", "money"),
    "投放消耗（店铺被投）": ("ad_cost_amt", "money"),
    "达人佣金（财务已结算）": ("talent_commission_amt", "money"),
    "平台佣金（财务已结算）": ("platform_commission_amt", "money"),
    "商家体验分": ("service_score", "score"),
}


def load_rows():
    conn = init_db()
    try:
        return conn.execute(
            """
            SELECT
                id, captured_at, url, body,
                shop_id, shop_name, data_date, date_type, endpoint
            FROM metrics
            WHERE body IS NOT NULL AND body != ''
            ORDER BY id
            """
        ).fetchall()
    finally:
        conn.close()


def load_daily_payloads():
    if not DAILY_OUTPUT_ROOT.exists():
        return []

    payloads = []
    for path in sorted(DAILY_OUTPUT_ROOT.glob("**/compass_daily_*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        payload["_path"] = str(path)
        payloads.append(payload)
    return payloads


def parse_number(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text or text == "-":
        return None

    multiplier = 10000 if "万" in text else 1
    cleaned = re.sub(r"[^\d.\-]", "", text.replace(",", ""))
    if not cleaned or cleaned in {"-", "."}:
        return None
    try:
        return float(cleaned) * multiplier
    except ValueError:
        return None


def parse_daily_metric(value, kind):
    number = parse_number(value)
    if number is None:
        return None
    if kind == "money":
        return number * 100
    if kind == "ratio":
        return number / 100
    return number


def compact_lines(text):
    return [" ".join(line.split()) for line in str(text or "").splitlines() if line.strip()]


def section(lines, start_label, end_label):
    try:
        start = lines.index(start_label) + 1
    except ValueError:
        return []
    try:
        end = lines.index(end_label, start)
    except ValueError:
        end = len(lines)
    return lines[start:end]


def money_after(lines, label):
    for index, line in enumerate(lines[:-1]):
        if line == label:
            return parse_daily_metric(lines[index + 1], "money")
    return None


def extract_daily_content(raw_text):
    lines = section(compact_lines(raw_text), "载体分布", "收支概况")
    content = {}
    for label, code in (
        ("直播", "live"),
        ("商品卡", "product_card"),
        ("短视频", "video"),
        ("图文", "artc_video"),
    ):
        value = money_after(lines, label)
        if value is not None:
            content[code] = value

    match = re.search(r"其他成交金额(¥[\d,.]+万?)", raw_text or "")
    if match:
        value = parse_daily_metric(match.group(1), "money")
        if value is not None:
            content["other_content"] = value
    return content


def parse_daily_date(value):
    if not value:
        return None
    return str(value).replace("/", "-")


def parse_daily_dashboard_data(payloads):
    records_by_key = {}

    for payload in payloads:
        captured_at = payload.get("captured_at") or ""
        source_file = payload.get("_path", "")
        for item in payload.get("results", []):
            shop_name = item.get("shop_name") or "当前店铺"
            data_date = parse_daily_date(item.get("data_end") or item.get("data_start"))
            if not data_date:
                continue

            metrics = {}
            for label, raw_value in (item.get("metrics") or {}).items():
                mapped = DAILY_METRIC_MAP.get(label)
                if not mapped:
                    continue
                code, kind = mapped
                value = parse_daily_metric(raw_value, kind)
                if value is not None:
                    metrics[code] = value

            if not metrics:
                continue

            key = (shop_name, data_date)
            previous = records_by_key.get(key)
            if previous and previous["captured_at"] >= captured_at:
                continue

            records_by_key[key] = {
                "shop_id": shop_name,
                "shop_name": shop_name,
                "date": data_date,
                "captured_at": captured_at,
                "metrics": metrics,
                "content": extract_daily_content(item.get("raw_text")),
                "trend": {},
                "source": "daily_json",
                "source_file": source_file,
            }

    return sorted(records_by_key.values(), key=lambda item: (item["date"], item["shop_name"]))


def merge_records(*record_groups):
    merged = {}
    for records in record_groups:
        for record in records:
            key = (record["shop_id"], record["date"])
            existing = merged.get(key)
            if existing is None:
                merged[key] = record
                continue

            existing_source = existing.get("source")
            record_source = record.get("source")
            prefer_record = (
                record_source == "daily_json"
                and existing_source != "daily_json"
            ) or record.get("captured_at", "") >= existing.get("captured_at", "")

            if prefer_record:
                merged[key] = {
                    **existing,
                    **record,
                    "content": record.get("content") or existing.get("content", {}),
                    "trend": record.get("trend") or existing.get("trend", {}),
                }

    records = list(merged.values())
    daily_dates = {
        record["date"]
        for record in records
        if record.get("source") == "daily_json"
    }
    records = [
        record
        for record in records
        if not (
            record.get("source") != "daily_json"
            and record["date"] in daily_dates
            and record.get("shop_id") in {"unknown", "", None}
        )
    ]
    return sorted(records, key=lambda item: (item["date"], item["shop_name"]))


def query_date(url):
    query = parse_qs(urlparse(url).query)
    raw = query.get("begin_date", [""])[0]
    if not raw:
        return None
    return raw.split()[0].replace("/", "-")


def query_date_type(url):
    return parse_qs(urlparse(url).query).get("date_type", [None])[0]


def value_from(cell):
    value = cell.get("index_value", {}).get("value", {})
    return value.get("value")


def metric_values(payload, root_key="homepage_core_index"):
    card = payload["data"]["module_data"][root_key]["compass_general_multi_index_card_value"]
    row = card.get("data", [{}])[0]
    return {key: value_from(cell) for key, cell in row.items()}


def parse_dashboard_data(rows):
    records_by_key = {}

    for row in rows:
        row_id, captured_at, url, body, shop_id, shop_name, data_date, date_type, endpoint = row
        endpoint = endpoint or urlparse(url).path
        data_date = data_date or query_date(url)
        date_type = date_type or query_date_type(url)
        if date_type != "20" or not data_date:
            continue

        shop_id = shop_id or "unknown"
        shop_name = shop_name or shop_id or "当前店铺"
        key = (shop_id, data_date)
        record = records_by_key.setdefault(
            key,
            {
                "shop_id": shop_id,
                "shop_name": shop_name,
                "date": data_date,
                "captured_at": captured_at,
                "metrics": {},
                "content": {},
                "trend": {},
                "source": "sqlite_api",
            },
        )
        if captured_at >= record["captured_at"]:
            record["captured_at"] = captured_at
            record["shop_name"] = shop_name

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            continue

        if endpoint.endswith("/core_index_v3"):
            record["metrics"] = metric_values(payload)
        elif endpoint.endswith("/content_detail_v3"):
            record["content"] = metric_values(payload)
        elif endpoint.endswith("/core_trend_v3"):
            trend = payload["data"]["module_data"]["homepage_core_index_trend"]["unify_chart_info"]
            record["trend"] = trend.get("axis_data", {})

    records = [record for record in records_by_key.values() if record["metrics"]]
    known_dates = {record["date"] for record in records if record["shop_id"] != "unknown"}
    records = [
        record
        for record in records
        if record["shop_id"] != "unknown" or record["date"] not in known_dates
    ]
    return sorted(records, key=lambda item: (item["date"], item["shop_name"]))


def money(cents):
    if cents is None:
        return "-"
    return f"¥{cents / 100:,.2f}"


def integer(value):
    if value is None:
        return "-"
    return f"{value:,.0f}"


def percent(value):
    if value is None:
        return "-"
    return f"{value * 100:.2f}%"


def metric_display(code, value):
    if code in RATIO_METRICS or code.endswith("_ratio"):
        return percent(value)
    if code in MONEY_METRICS:
        return money(value)
    if code == "service_score":
        return "-" if value is None else f"{value:.0f}分"
    return integer(value)


def aggregate(records):
    totals = defaultdict(float)
    for record in records:
        metrics = record["metrics"]
        for code in MONEY_METRICS | COUNT_METRICS:
            value = metrics.get(code)
            if value is not None:
                totals[code] += value

    show = totals.get("product_show_ucnt")
    click = totals.get("product_click_ucnt")
    pay_users = totals.get("pay_ucnt")
    show_count = totals.get("product_show_cnt")
    click_count = totals.get("product_click_cnt")
    pay_count = totals.get("pay_cnt")
    income = totals.get("income_amt")
    refund = totals.get("refund_amt") or totals.get("refund_amt_pay_time") or 0
    totals["product_show_click_ucnt_ratio"] = click / show if show else None
    totals["product_click_pay_ucnt_ratio"] = pay_users / click if click else None
    totals["product_show_pay_ucnt_ratio"] = pay_users / show if show else None
    totals["product_show_click_cnt_ratio"] = click_count / show_count if show_count else None
    totals["product_click_pay_cnt_ratio"] = pay_count / click_count if click_count else None
    totals["product_show_pay_cnt_ratio"] = pay_count / show_count if show_count else None
    pay_amt = totals.get("pay_amt") or 0
    totals["per_usr_pay_amt"] = pay_amt / pay_users if pay_users else None
    totals["per_item_pay_amt"] = pay_amt / totals.get("pay_item_cnt") if totals.get("pay_item_cnt") else None
    totals["pay_amt_per_k_show"] = pay_amt / show_count * 1000 if show_count else None
    totals["refund_amt_rate"] = refund / income if income else None
    return dict(totals)


def shop_list(records):
    shops = {}
    for record in records:
        shops[record["shop_id"]] = record["shop_name"]
    return [{"shop_id": key, "shop_name": shops[key]} for key in sorted(shops, key=shops.get)]


def dates(records):
    return sorted({record["date"] for record in records})


def by_date(records):
    grouped = defaultdict(list)
    for record in records:
        grouped[record["date"]].append(record)
    return grouped


def by_shop(records):
    grouped = defaultdict(list)
    for record in records:
        grouped[record["shop_id"]].append(record)
    return grouped


def points(values, width, height, pad):
    clean = [value for value in values if value is not None]
    if not clean:
        return ""
    minimum = min(clean)
    maximum = max(clean)
    if minimum == maximum:
        minimum = 0
    span = maximum - minimum or 1
    step = (width - pad * 2) / max(len(values) - 1, 1)
    coords = []
    for index, value in enumerate(values):
        if value is None:
            continue
        x = pad + index * step
        y = height - pad - ((value - minimum) / span) * (height - pad * 2)
        coords.append(f"{x:.1f},{y:.1f}")
    return " ".join(coords)


def multi_line_chart(title, records, metric_code, formatter, include_total=True):
    width, height, pad = 920, 320, 46
    all_dates = dates(records)
    shops = shop_list(records)
    shop_records = by_shop(records)
    colors = ["#2563eb", "#16a34a", "#f97316", "#7c3aed", "#0891b2", "#dc2626", "#4b5563"]
    lines = []
    legend_items = []

    if include_total:
        grouped = by_date(records)
        values = [aggregate(grouped[date]).get(metric_code) for date in all_dates]
        lines.append(
            f'<polyline points="{points(values, width, height, pad)}" fill="none" stroke="#111827" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
        )
        legend_items.append(("#111827", "全店汇总"))

    for index, shop in enumerate(shops):
        rows = {record["date"]: record for record in shop_records[shop["shop_id"]]}
        values = [rows.get(date, {}).get("metrics", {}).get(metric_code) for date in all_dates]
        color = colors[index % len(colors)]
        lines.append(
            f'<polyline points="{points(values, width, height, pad)}" fill="none" stroke="{color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
        )
        legend_items.append((color, shop["shop_name"]))

    labels = "".join(
        f'<text x="{pad + idx * ((width - pad * 2) / max(len(all_dates) - 1, 1)):.1f}" y="{height - 12}" class="axis">{html.escape(date[5:])}</text>'
        for idx, date in enumerate(all_dates)
    )
    legend = "".join(
        f'<span><i style="background:{color}"></i>{html.escape(name)}</span>'
        for color, name in legend_items
    )
    latest_values = by_date(records)
    latest_total = aggregate(latest_values[all_dates[-1]]).get(metric_code) if all_dates else None

    return f"""
    <section class="panel">
      <div class="chart-head">
        <div><h2>{html.escape(title)}</h2><p>{html.escape(formatter(latest_total))} · 最新汇总</p></div>
        <div class="legend">{legend}</div>
      </div>
      <svg viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(title)}">
        <line x1="{pad}" y1="{height-pad}" x2="{width-pad}" y2="{height-pad}" class="grid"/>
        <line x1="{pad}" y1="{pad}" x2="{pad}" y2="{height-pad}" class="grid"/>
        {''.join(lines)}
        {labels}
      </svg>
    </section>
    """


def bar_chart(items, formatter):
    max_value = max([value for _, value in items if value is not None] or [1])
    rows = []
    for label, value in items:
        pct = 0 if not value else max(2, value / max_value * 100)
        rows.append(
            f'<div class="bar-row"><div class="bar-label">{html.escape(label)}</div>'
            f'<div class="bar-track"><div class="bar-fill" style="width:{pct:.1f}%"></div></div>'
            f'<div class="bar-value">{html.escape(formatter(value))}</div></div>'
        )
    return "".join(rows)


def latest_shop_bars(records, metric_code, formatter):
    if not records:
        return ""
    latest_date = dates(records)[-1]
    rows = [record for record in records if record["date"] == latest_date]
    items = sorted(
        [(record["shop_name"], record["metrics"].get(metric_code)) for record in rows],
        key=lambda item: item[1] or 0,
        reverse=True,
    )
    return bar_chart(items, formatter)


def latest_content_table(records):
    if not records:
        return ""
    latest_date = dates(records)[-1]
    rows = [record for record in records if record["date"] == latest_date]
    table_rows = []
    for record in sorted(rows, key=lambda item: item["shop_name"]):
        cells = "".join(
            f"<td>{money(record['content'].get(code))}</td>"
            for code in CONTENT_LABELS
        )
        table_rows.append(f"<tr><td>{html.escape(record['shop_name'])}</td>{cells}</tr>")
    headers = "".join(f"<th>{html.escape(label)}</th>" for label in CONTENT_LABELS.values())
    return f"<table><thead><tr><th>店铺</th>{headers}</tr></thead><tbody>{''.join(table_rows)}</tbody></table>"


def detail_table(records):
    rows = []
    for record in sorted(records, key=lambda item: (item["date"], item["shop_name"]), reverse=True):
        metrics = record["metrics"]
        rows.append(
            "<tr>"
            f"<td>{html.escape(record['date'])}</td>"
            f"<td>{html.escape(record['shop_name'])}</td>"
            f"<td>{money(metrics.get('income_amt'))}</td>"
            f"<td>{money(metrics.get('pay_amt'))}</td>"
            f"<td>{integer(metrics.get('pay_cnt'))}</td>"
            f"<td>{money(metrics.get('per_usr_pay_amt'))}</td>"
            f"<td>{integer(metrics.get('product_show_ucnt'))}</td>"
            f"<td>{integer(metrics.get('product_click_ucnt'))}</td>"
            f"<td>{percent(metrics.get('product_show_click_ucnt_ratio'))}</td>"
            f"<td>{percent(metrics.get('product_click_pay_ucnt_ratio'))}</td>"
            f"<td>{money(metrics.get('refund_amt'))}</td>"
            f"<td>{money(metrics.get('expense_amt'))}</td>"
            f"<td>{metric_display('service_score', metrics.get('service_score'))}</td>"
            "</tr>"
        )
    return "".join(rows)


def render(records):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    all_dates = dates(records)
    shops = shop_list(records)
    latest_date = all_dates[-1] if all_dates else "-"
    latest_records = by_date(records).get(latest_date, [])
    latest_totals = aggregate(latest_records)
    previous_date = all_dates[-2] if len(all_dates) > 1 else None
    previous_totals = aggregate(by_date(records).get(previous_date, [])) if previous_date else {}

    def delta(code):
        if not previous_date:
            return "等待更多每日样本"
        current = latest_totals.get(code)
        before = previous_totals.get(code)
        if current is None or before is None:
            return "-"
        diff = current - before
        sign = "+" if diff > 0 else ""
        return sign + metric_display(code, diff)

    kpis = [
        ("income_amt", "全店成交金额"),
        ("pay_amt", "全店支付金额"),
        ("settlement_amt_pay_time", "全店结算金额"),
        ("pay_cnt", "全店成交订单"),
        ("pay_ucnt", "全店支付人数"),
        ("refund_amt_rate", "全店退款率"),
    ]
    cards = "".join(
        f'<section class="kpi"><div class="kpi-label">{label}</div><div class="kpi-value">{metric_display(code, latest_totals.get(code))}</div><div class="kpi-delta">较上一业务日 {delta(code)}</div></section>'
        for code, label in kpis
    )
    notice = ""
    if len(shops) < 2:
        notice = '<div class="notice">当前只识别到 1 个店铺。运行 <code>./run_daily.sh</code> 抓取两家店铺后，这里会自动变成跨店铺对比。</div>'

    payload = html.escape(json.dumps(records, ensure_ascii=False))
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>罗盘跨店铺经营看板</title>
  <style>
    :root {{
      --bg: #f5f7fb;
      --surface: #ffffff;
      --text: #182033;
      --muted: #697386;
      --line: #dfe5ef;
      --blue: #2563eb;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0;
    }}
    header {{
      background: var(--surface);
      border-bottom: 1px solid var(--line);
      padding: 28px 32px 18px;
    }}
    h1 {{ margin: 0 0 8px; font-size: 28px; font-weight: 760; }}
    h2 {{ margin: 0; font-size: 18px; }}
    p {{ margin: 6px 0 0; color: var(--muted); font-size: 13px; }}
    main {{ max-width: 1480px; margin: 0 auto; padding: 24px 32px 44px; }}
    code {{ background: #eef2f7; border-radius: 5px; padding: 2px 5px; }}
    .subtitle {{ color: var(--muted); font-size: 14px; }}
    .notice {{ background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; }}
    .kpis {{ display: grid; grid-template-columns: repeat(6, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }}
    .kpi {{ background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; min-height: 118px; }}
    .kpi-label {{ color: var(--muted); font-size: 13px; margin-bottom: 10px; }}
    .kpi-value {{ font-size: 25px; font-weight: 760; line-height: 1.15; }}
    .kpi-delta {{ color: var(--muted); font-size: 12px; margin-top: 12px; }}
    .grid-layout {{ display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: start; }}
    .grid-layout > * {{ min-width: 0; }}
    .panel {{ background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-bottom: 16px; min-width: 0; }}
    .chart-head {{ display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 8px; }}
    .legend {{ display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; color: var(--muted); font-size: 12px; max-width: 55%; }}
    .legend i {{ display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }}
    svg {{ width: 100%; height: auto; display: block; }}
    .grid {{ stroke: var(--line); stroke-width: 1; }}
    .axis {{ fill: var(--muted); font-size: 12px; text-anchor: middle; }}
    .bar-row {{ display: grid; grid-template-columns: minmax(90px, 150px) 1fr 110px; gap: 10px; align-items: center; min-height: 34px; }}
    .bar-label, .bar-value {{ font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
    .bar-value {{ text-align: right; color: var(--text); font-weight: 650; }}
    .bar-track {{ height: 12px; background: #edf1f7; border-radius: 999px; overflow: hidden; }}
    .bar-fill {{ height: 100%; background: var(--blue); border-radius: 999px; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    th, td {{ padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }}
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) {{ text-align: left; }}
    th {{ color: var(--muted); font-weight: 650; }}
    .source {{ color: var(--muted); font-size: 12px; line-height: 1.7; }}
    @media (max-width: 1100px) {{
      header, main {{ padding-left: 18px; padding-right: 18px; }}
      .kpis {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      .grid-layout {{ grid-template-columns: 1fr; }}
      .legend {{ max-width: none; justify-content: flex-start; }}
    }}
    @media (max-width: 560px) {{
      .kpis {{ grid-template-columns: 1fr; }}
      .kpi-value {{ font-size: 22px; }}
      .chart-head {{ flex-direction: column; }}
      .bar-row {{ grid-template-columns: 92px 1fr; }}
      .bar-value {{ grid-column: 2; text-align: left; }}
      table {{ display: block; max-width: 100%; overflow-x: auto; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>罗盘跨店铺经营看板</h1>
    <div class="subtitle">最新业务日期：{html.escape(latest_date)} · 店铺数：{len(shops)} · 业务天数：{len(all_dates)} · 生成时间：{html.escape(now)}</div>
  </header>
  <main>
    {notice}
    <section class="kpis">{cards}</section>
    {multi_line_chart("跨店铺成交金额趋势", records, "income_amt", money, len(shops) > 1)}
    <section class="grid-layout">
      <div>
        {multi_line_chart("跨店铺订单趋势", records, "pay_cnt", integer, len(shops) > 1)}
        {multi_line_chart("跨店铺点击支付率趋势", records, "product_click_pay_ucnt_ratio", percent, len(shops) > 1)}
        <section class="panel">
          <h2>店铺 × 日期明细</h2>
          <table>
            <thead><tr><th>日期</th><th>店铺</th><th>成交金额</th><th>支付金额</th><th>订单</th><th>客单价</th><th>曝光人数</th><th>点击人数</th><th>曝光点击率</th><th>点击支付率</th><th>退款金额</th><th>支出金额</th><th>体验分</th></tr></thead>
            <tbody>{detail_table(records)}</tbody>
          </table>
        </section>
      </div>
      <aside>
        <section class="panel">
          <h2>最新日店铺成交对比</h2>
          <p>{html.escape(latest_date)} · 按成交金额排序</p>
          {latest_shop_bars(records, "income_amt", money)}
        </section>
        <section class="panel">
          <h2>最新日店铺订单对比</h2>
          <p>{html.escape(latest_date)} · 按订单数排序</p>
          {latest_shop_bars(records, "pay_cnt", integer)}
        </section>
        <section class="panel">
          <h2>最新日内容来源拆分</h2>
          {latest_content_table(records)}
        </section>
      </aside>
    </section>
    <section class="panel source">
      数据源：优先读取 <code>output/daily/**/*.json</code> 的每日可见指标，并兼容本地 SQLite <code>metrics.db</code> 中的接口响应。
      金额统一展示为元；比例统一展示为百分比。每日方式：执行 <code>./run_daily.sh</code> 后会自动刷新本看板。
    </section>
  </main>
  <script type="application/json" id="dashboard-data">{payload}</script>
</body>
</html>"""


def build_dashboard():
    records = get_dashboard_records()
    html_text = render(records)
    OUTPUT_PATH.write_text(html_text, encoding="utf-8")
    return OUTPUT_PATH, len(records), len(shop_list(records))


def get_dashboard_records():
    return merge_records(
        parse_dashboard_data(load_rows()),
        parse_daily_dashboard_data(load_daily_payloads()),
    )


if __name__ == "__main__":
    path, days, shops = build_dashboard()
    print(f"已生成 {path}，包含 {shops} 个店铺、{days} 条店铺日期记录")
