import json
import re
from datetime import datetime
from pathlib import Path

import html as html_module

ORDERS_ROOT = Path(__file__).parent / "output" / "orders"
OUTPUT_PATH = Path(__file__).parent / "order_dashboard.html"

BRAND_KEYWORDS = {
    "acer": "Acer/宏碁",
    "宏碁": "Acer/宏碁",
    "华硕": "华硕",
    "asus": "华硕",
}


def extract_brand(product_name):
    if not product_name:
        return ""
    lower = product_name.lower()
    for keyword, brand in BRAND_KEYWORDS.items():
        if keyword in lower:
            return brand
    return product_name.split("/")[0] if "/" in product_name else ""


def extract_quantity(price_quantity):
    if not price_quantity:
        return 1
    match = re.search(r"x(\d+)", price_quantity)
    return int(match.group(1)) if match else 1


def extract_price(text):
    if not text:
        return 0
    match = re.search(r"[\d,]+\.?\d*", text.replace(",", ""))
    return float(match.group()) if match else 0


def load_all_orders():
    orders = []
    seen_order_keys = set()
    if not ORDERS_ROOT.exists():
        return orders

    for date_dir in sorted(ORDERS_ROOT.iterdir()):
        if not date_dir.is_dir() or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_dir.name):
            continue
        for json_file in sorted(date_dir.rglob("douyin_orders_*.json")):
            if "_table_rows" in json_file.name or "_visible_text" in json_file.name:
                continue
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
                shop_name = data.get("shop_name") or (
                    json_file.parent.name if json_file.parent != date_dir else ""
                )
                for index, order in enumerate(data.get("orders", [])):
                    order_no = order.get("order_no", "")
                    dedupe_key = (shop_name, order_no) if order_no else (str(json_file), index)
                    if dedupe_key in seen_order_keys:
                        continue
                    seen_order_keys.add(dedupe_key)
                    orders.append({
                        "pay_time": order.get("order_time", ""),
                        "brand": extract_brand(order.get("product_name", "")),
                        "platform": "抖音",
                        "shop_name": shop_name,
                        "order_no": order_no,
                        "sku_code": order.get("merchant_sku_code", ""),
                        "model": order.get("sku_spec", ""),
                        "order_status": order.get("order_status", ""),
                        "quantity": extract_quantity(order.get("price_quantity", "")),
                        "product_price": extract_price(order.get("price_quantity", "")),
                        "order_amount": extract_price(order.get("merchant_income", "")),
                        "product_name": order.get("product_name", ""),
                    })
            except (json.JSONDecodeError, OSError):
                continue

    return sorted(orders, key=lambda x: x.get("pay_time", ""), reverse=True)


def money(value):
    if not value:
        return "-"
    return f"¥{value:,.2f}"


def render(orders):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    total_amount = sum(o["order_amount"] for o in orders)
    total_count = len(orders)
    status_counts = {}
    for o in orders:
        status = o["order_status"] or "未知"
        status_counts[status] = status_counts.get(status, 0) + 1

    status_cards = "".join(
        f'<div class="status-card"><div class="status-count">{count}</div><div class="status-label">{html_module.escape(status)}</div></div>'
        for status, count in sorted(status_counts.items(), key=lambda x: -x[1])
    )

    table_rows = []
    for o in orders:
        table_rows.append(
            "<tr>"
            f'<td>{html_module.escape(o["pay_time"])}</td>'
            f'<td>{html_module.escape(o["brand"])}</td>'
            f'<td>{html_module.escape(o["platform"])}</td>'
            f'<td>{html_module.escape(o["shop_name"])}</td>'
            f'<td class="order-no">{html_module.escape(o["order_no"])}</td>'
            f'<td>{html_module.escape(o["sku_code"])}</td>'
            f'<td class="model">{html_module.escape(o["model"])}</td>'
            f'<td><span class="status-badge status-{o["order_status"]}">{html_module.escape(o["order_status"])}</span></td>'
            f'<td class="num">{o["quantity"]}</td>'
            f'<td class="money">{money(o["product_price"])}</td>'
            f'<td class="money">{money(o["order_amount"])}</td>'
            "</tr>"
        )

    shops = sorted(set(o["shop_name"] for o in orders))
    shop_options = "".join(
        f'<option value="{html_module.escape(s)}">{html_module.escape(s)}</option>'
        for s in shops
    )

    statuses = sorted(set(o["order_status"] for o in orders if o["order_status"]))
    status_options = "".join(
        f'<option value="{html_module.escape(s)}">{html_module.escape(s)}</option>'
        for s in statuses
    )

    brands = sorted(set(o["brand"] for o in orders if o["brand"]))
    brand_options = "".join(
        f'<option value="{html_module.escape(b)}">{html_module.escape(b)}</option>'
        for b in brands
    )

    orders_json = json.dumps(orders, ensure_ascii=False)

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>订单数据看板</title>
  <style>
    :root {{
      --bg: #f5f7fb;
      --surface: #ffffff;
      --text: #182033;
      --muted: #697386;
      --line: #dfe5ef;
      --blue: #2563eb;
      --green: #16a34a;
      --red: #dc2626;
      --orange: #f97316;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    }}
    header {{
      background: var(--surface);
      border-bottom: 1px solid var(--line);
      padding: 28px 32px 18px;
    }}
    h1 {{ margin: 0 0 8px; font-size: 28px; font-weight: 760; }}
    .subtitle {{ color: var(--muted); font-size: 14px; }}
    main {{ max-width: 1600px; margin: 0 auto; padding: 24px 32px 44px; }}
    .summary-cards {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }}
    .summary-card {{
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }}
    .summary-label {{ color: var(--muted); font-size: 13px; margin-bottom: 8px; }}
    .summary-value {{ font-size: 24px; font-weight: 760; }}
    .status-cards {{
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 20px;
    }}
    .status-card {{
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 20px;
      text-align: center;
    }}
    .status-count {{ font-size: 20px; font-weight: 700; color: var(--blue); }}
    .status-label {{ font-size: 12px; color: var(--muted); margin-top: 4px; }}
    .filters {{
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: end;
    }}
    .filter-group {{
      display: flex;
      flex-direction: column;
      gap: 4px;
    }}
    .filter-group label {{
      font-size: 12px;
      color: var(--muted);
    }}
    .filter-group select, .filter-group input {{
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      font-size: 14px;
      min-width: 160px;
    }}
    .filter-group input {{
      min-width: 200px;
    }}
    button {{
      padding: 8px 16px;
      background: var(--blue);
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }}
    button:hover {{ opacity: 0.9; }}
    .btn-secondary {{
      background: var(--muted);
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--line);
    }}
    th {{
      background: #f8fafc;
      padding: 12px 10px;
      text-align: left;
      font-size: 13px;
      font-weight: 650;
      color: var(--muted);
      border-bottom: 1px solid var(--line);
      white-space: nowrap;
      position: sticky;
      top: 0;
    }}
    td {{
      padding: 10px 10px;
      font-size: 13px;
      border-bottom: 1px solid #f1f5f9;
      white-space: nowrap;
    }}
    tr:hover {{ background: #f8fafc; }}
    .order-no {{ font-family: monospace; font-size: 12px; }}
    .model {{ max-width: 200px; overflow: hidden; text-overflow: ellipsis; }}
    .num {{ text-align: right; }}
    .money {{ text-align: right; font-weight: 600; }}
    .status-badge {{
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }}
    .status-已完成 {{ background: #dcfce7; color: #166534; }}
    .status-已关闭 {{ background: #fef2f2; color: #991b1b; }}
    .status-待发货 {{ background: #fef9c3; color: #854d0e; }}
    .status-已发货 {{ background: #dbeafe; color: #1e40af; }}
    .status-待付款 {{ background: #f3f4f6; color: #374151; }}
    .table-container {{
      overflow-x: auto;
      border-radius: 8px;
    }}
    .no-data {{
      text-align: center;
      padding: 40px;
      color: var(--muted);
    }}
    @media (max-width: 768px) {{
      header, main {{ padding-left: 16px; padding-right: 16px; }}
      .filters {{ flex-direction: column; }}
      .filter-group select, .filter-group input {{ min-width: 100%; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>订单数据看板</h1>
    <div class="subtitle">生成时间：{html_module.escape(now)} · 订单总数：{total_count} · 总金额：{money(total_amount)}</div>
  </header>
  <main>
    <div class="summary-cards">
      <div class="summary-card">
        <div class="summary-label">订单总数</div>
        <div class="summary-value">{total_count}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">订单总金额</div>
        <div class="summary-value">{money(total_amount)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">平均订单金额</div>
        <div class="summary-value">{money(total_amount / total_count if total_count else 0)}</div>
      </div>
    </div>

    <div class="status-cards">{status_cards}</div>

    <div class="filters">
      <div class="filter-group">
        <label>店铺</label>
        <select id="filterShop">
          <option value="">全部店铺</option>
          {shop_options}
        </select>
      </div>
      <div class="filter-group">
        <label>品牌</label>
        <select id="filterBrand">
          <option value="">全部品牌</option>
          {brand_options}
        </select>
      </div>
      <div class="filter-group">
        <label>订单状态</label>
        <select id="filterStatus">
          <option value="">全部状态</option>
          {status_options}
        </select>
      </div>
      <div class="filter-group">
        <label>搜索订单号/商品</label>
        <input type="text" id="filterSearch" placeholder="输入关键词...">
      </div>
      <button onclick="applyFilters()">筛选</button>
      <button class="btn-secondary" onclick="resetFilters()">重置</button>
      <button onclick="exportCSV()">导出 CSV</button>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>支付完成时间</th>
            <th>品牌</th>
            <th>平台</th>
            <th>店铺</th>
            <th>订单编号</th>
            <th>商品编码</th>
            <th>型号</th>
            <th>订单状态</th>
            <th>商品数量</th>
            <th>商品金额</th>
            <th>订单金额</th>
          </tr>
        </thead>
        <tbody id="tableBody">
        </tbody>
      </table>
    </div>
  </main>

  <script>
    const allOrders = {orders_json};
    let filteredOrders = [...allOrders];

    function escapeHtml(text) {{
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }}

    function formatMoney(value) {{
      if (!value && value !== 0) return '-';
      return '¥' + value.toLocaleString('zh-CN', {{minimumFractionDigits: 2, maximumFractionDigits: 2}});
    }}

    function renderTable() {{
      const tbody = document.getElementById('tableBody');
      if (filteredOrders.length === 0) {{
        tbody.innerHTML = '<tr><td colspan="11" class="no-data">没有匹配的数据</td></tr>';
        return;
      }}
      tbody.innerHTML = filteredOrders.map(o => `
        <tr>
          <td>${{escapeHtml(o.pay_time)}}</td>
          <td>${{escapeHtml(o.brand)}}</td>
          <td>${{escapeHtml(o.platform)}}</td>
          <td>${{escapeHtml(o.shop_name)}}</td>
          <td class="order-no">${{escapeHtml(o.order_no)}}</td>
          <td>${{escapeHtml(o.sku_code)}}</td>
          <td class="model" title="${{escapeHtml(o.model)}}">${{escapeHtml(o.model)}}</td>
          <td><span class="status-badge status-${{o.order_status}}">${{escapeHtml(o.order_status)}}</span></td>
          <td class="num">${{o.quantity}}</td>
          <td class="money">${{formatMoney(o.product_price)}}</td>
          <td class="money">${{formatMoney(o.order_amount)}}</td>
        </tr>
      `).join('');
    }}

    function applyFilters() {{
      const shop = document.getElementById('filterShop').value;
      const brand = document.getElementById('filterBrand').value;
      const status = document.getElementById('filterStatus').value;
      const search = document.getElementById('filterSearch').value.toLowerCase();

      filteredOrders = allOrders.filter(o => {{
        if (shop && o.shop_name !== shop) return false;
        if (brand && o.brand !== brand) return false;
        if (status && o.order_status !== status) return false;
        if (search) {{
          const match = o.order_no.includes(search) ||
                       (o.product_name && o.product_name.toLowerCase().includes(search)) ||
                       (o.sku_code && o.sku_code.includes(search)) ||
                       (o.model && o.model.toLowerCase().includes(search));
          if (!match) return false;
        }}
        return true;
      }});
      renderTable();
    }}

    function resetFilters() {{
      document.getElementById('filterShop').value = '';
      document.getElementById('filterBrand').value = '';
      document.getElementById('filterStatus').value = '';
      document.getElementById('filterSearch').value = '';
      filteredOrders = [...allOrders];
      renderTable();
    }}

    function exportCSV() {{
      const headers = ['支付完成时间', '品牌', '平台', '店铺', '订单编号', '商品编码', '型号', '订单状态', '商品数量', '商品金额', '订单金额'];
      const rows = filteredOrders.map(o => [
        o.pay_time, o.brand, o.platform, o.shop_name, o.order_no,
        o.sku_code, o.model, o.order_status, o.quantity,
        o.product_price.toFixed(2), o.order_amount.toFixed(2)
      ]);
      const csv = [headers, ...rows].map(row => row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\\n');
      const blob = new Blob(['\\uFEFF' + csv], {{ type: 'text/csv;charset=utf-8;' }});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'orders_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    }}

    document.getElementById('filterSearch').addEventListener('keyup', function(e) {{
      if (e.key === 'Enter') applyFilters();
    }});

    renderTable();
  </script>
</body>
</html>"""


def build_dashboard():
    orders = load_all_orders()
    html_text = render(orders)
    OUTPUT_PATH.write_text(html_text, encoding="utf-8")
    return OUTPUT_PATH, len(orders)


if __name__ == "__main__":
    path, count = build_dashboard()
    print(f"已生成 {path}，包含 {count} 条订单记录")
