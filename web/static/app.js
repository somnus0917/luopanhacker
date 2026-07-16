const state = { records: [], dates: new Set(), shops: new Set(), operationDates: new Set(), operationShops: new Set(), page: "compass", inventory: null, inventoryView: "overview" };
const COLORS = ["#3da7f5", "#31d380", "#a461d2", "#f18a21", "#f7c91b"];

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (cents) => `¥${(number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (value) => Math.round(number(value)).toLocaleString("zh-CN");
const ratio = (value) => `${(number(value) * 100).toFixed(2)}%`;
const metricText = (key, value) => key.endsWith("_amt") || ["income_amt", "pay_amt", "per_usr_pay_amt", "settlement_amt_pay_time", "expense_amt"].includes(key) ? money(value) : key.endsWith("_ratio") || key.endsWith("_rate") ? ratio(value) : whole(value);

function aggregate(records) {
  const totals = {};
  const sumKeys = ["income_amt", "pay_amt", "settlement_amt_pay_time", "pay_cnt", "pay_ucnt", "refund_amt", "platform_subsidy_amt", "talent_subsidy_amt", "pay_item_cnt", "product_show_ucnt", "product_click_ucnt", "expense_amt"];
  sumKeys.forEach((key) => totals[key] = records.reduce((sum, item) => sum + number(item.metrics?.[key]), 0));
  totals.per_usr_pay_amt = totals.pay_ucnt ? totals.pay_amt / totals.pay_ucnt : 0;
  const weightedRefundRate = records.reduce((sum, item) => sum + number(item.metrics?.income_amt) * number(item.metrics?.refund_amt_rate), 0);
  totals.refund_amt_rate = totals.refund_amt && totals.income_amt ? totals.refund_amt / totals.income_amt : totals.income_amt ? weightedRefundRate / totals.income_amt : 0;
  totals.product_click_pay_ucnt_ratio = totals.product_click_ucnt ? totals.pay_ucnt / totals.product_click_ucnt : 0;
  return totals;
}

function filteredRecords() {
  return state.records.filter((item) => state.dates.has(item.date) && state.shops.has(item.shop_name));
}

function latestRecords(records) {
  const dates = [...new Set(records.map((item) => item.date))].sort();
  const latest = dates.at(-1);
  return { date: latest, records: records.filter((item) => item.date === latest) };
}

function delta(current, previous, key) {
  if (previous === undefined) return { text: "等待更多每日样本", kind: "" };
  const amount = number(current) - number(previous);
  return { text: `${amount >= 0 ? "+" : ""}${metricText(key, amount)}`, kind: amount > 0 ? "positive" : amount < 0 ? "negative" : "" };
}

function buildPlaceholders() {
  $$('[data-placeholder]').forEach((grid) => {
    grid.innerHTML = grid.dataset.placeholder.split("|").map((label) => `<article class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">—</div><div class="metric-delta">等待数据接入</div></article>`).join("");
  });
}

function activatePage(name) {
  state.page = name;
  $$(".dashboard-page").forEach((page) => page.classList.toggle("active", page.dataset.page === name));
  $$(".nav-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.page === name));
  history.replaceState(null, "", `#${name}`);
}

function renderFilters() {
  const dates = [...new Set(state.records.map((item) => item.date))].sort();
  const shops = [...new Set(state.records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const buildGroup = (title, items, selected, kind) => `<div class="filter-group"><span class="filter-title">${title}</span><div class="chip-list">${items.map((item) => `<button class="chip ${selected.has(item) ? "selected" : ""}" type="button" data-filter="${kind}" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div></div>`;
  $("#filters").innerHTML = buildGroup("业务日期", dates, state.dates, "date") + buildGroup("店铺", shops, state.shops, "shop");
  $$("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    const selected = button.dataset.filter === "date" ? state.dates : state.shops;
    const value = button.dataset.value;
    if (selected.has(value) && selected.size > 1) selected.delete(value); else selected.add(value);
    renderFilters();
    renderCompass();
  }));
}

function operationFilteredRecords() {
  return state.records.filter((item) => state.operationDates.has(item.date) && state.operationShops.has(item.shop_name));
}

function renderOperationsFilters() {
  const dates = [...new Set(state.records.map((item) => item.date))].sort();
  const shops = [...new Set(state.records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const buildGroup = (title, items, selected, kind) => `<div class="filter-group"><span class="filter-title">${title}</span><div class="chip-list">${items.map((item) => `<button class="chip ${selected.has(item) ? "selected" : ""}" type="button" data-operation-filter="${kind}" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div></div>`;
  $("#operations-filters").innerHTML = buildGroup("业务日期", dates, state.operationDates, "date") + buildGroup("店铺", shops, state.operationShops, "shop");
  $$('[data-operation-filter]').forEach((button) => button.addEventListener("click", () => {
    const selected = button.dataset.operationFilter === "date" ? state.operationDates : state.operationShops;
    const value = button.dataset.value;
    if (selected.has(value) && selected.size > 1) selected.delete(value); else selected.add(value);
    renderOperationsFilters();
    renderOperations();
  }));
}

function operatingRatio(value) {
  return value === null || value === undefined ? "—" : `${number(value).toFixed(2)}×`;
}

function renderOperations() {
  const records = operationFilteredRecords();
  const target = $("#operations-content");
  if (!records.length) {
    target.innerHTML = `<div class="empty-panel"><strong>当前筛选条件没有经营数据</strong><span>请选择至少一个业务日期和店铺。</span></div>`;
    return;
  }
  const totals = aggregate(records);
  const returnOnSpend = totals.expense_amt ? totals.pay_amt / totals.expense_amt : null;
  const latestDate = [...new Set(records.map((item) => item.date))].sort().at(-1);
  $("#operations-summary").textContent = `数据来源：罗盘日维度数据 · 最新业务日期：${latestDate || "—"} · 已选择 ${new Set(records.map((item) => item.shop_name)).size} 家店铺、${new Set(records.map((item) => item.date)).size} 个业务日`;
  const metrics = [
    ["成交金额", money(totals.income_amt), "按成交口径汇总"],
    ["用户支付金额", money(totals.pay_amt), "按支付口径汇总"],
    ["结算金额", money(totals.settlement_amt_pay_time), "按支付时间结算口径"],
    ["成交订单", whole(totals.pay_cnt), `成交件数：${whole(totals.pay_item_cnt)}`],
    ["投产比", operatingRatio(returnOnSpend), totals.expense_amt ? `支付金额 ÷ 投放消耗 ${money(totals.expense_amt)}` : "暂无投放消耗数据"],
    ["退款率", ratio(totals.refund_amt_rate), "按成交金额加权汇总"],
  ];
  const cards = `<div class="metric-grid six">${metrics.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("")}</div>`;
  const sourceNote = `<section class="panel operations-note"><h3>数据口径</h3><p>经营看板复用罗盘已采集的日维度数据，不新增浏览器采集或第三方接口调用。</p><p>当前数据维度为日期与店铺；品牌维度在罗盘源数据中尚未提供，因此未做品牌归因。</p></section>`;
  target.innerHTML = `${cards}<div class="chart-grid"><div class="chart-stack">${lineChart(records, "income_amt", "成交金额趋势")}${lineChart(records, "pay_cnt", "成交订单趋势")}${lineChart(records, "expense_amt", "投放消耗趋势")}</div><div class="chart-stack">${barPanel(records, "income_amt", "店铺成交金额对比")}${barPanel(records, "pay_amt", "店铺支付金额对比")}${sourceNote}</div></div><h3 class="section-title">店铺经营明细 <small>按日期与店铺查看关键经营指标</small></h3>${renderTable(records)}<h3 class="section-title">内容成交来源 <small>用于判断直播、商品卡与内容贡献</small></h3>${renderTable(records, true)}`;
  bindLineChartHover(records);
}

function metricCards(records) {
  const { date, records: currentRecords } = latestRecords(records);
  const allDates = [...new Set(records.map((item) => item.date))].sort();
  const previousDate = allDates.at(-2);
  const current = aggregate(currentRecords);
  const previous = previousDate ? aggregate(records.filter((item) => item.date === previousDate)) : null;
  const metrics = [["income_amt", "全店成交金额"], ["pay_amt", "全店支付金额"], ["settlement_amt_pay_time", "全店结算金额"], ["pay_cnt", "成交订单"], ["pay_ucnt", "成交人数"], ["refund_amt_rate", "退款率"]];
  const cards = metrics.map(([key, label]) => {
    const change = delta(current[key], previous?.[key], key);
    return `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${metricText(key, current[key])}</div><div class="metric-delta ${change.kind}">${change.text}</div></article>`;
  }).join("");
  return { date, html: `<div class="metric-grid six">${cards}</div>` };
}

function lineChart(records, metricKey, title) {
  const dates = [...new Set(records.map((item) => item.date))].sort();
  const shops = [...new Set(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const values = shops.map((shop) => dates.map((date) => number(records.find((item) => item.date === date && item.shop_name === shop)?.metrics?.[metricKey])));
  const totals = dates.map((date) => values.reduce((sum, series) => sum + number(series[dates.indexOf(date)]), 0));
  const max = Math.max(...totals, ...values.flat(), 1) * 1.08;
  const width = 760, height = 238, pad = { l: 48, r: 16, t: 15, b: 30 };
  const point = (value, index) => [pad.l + index * ((width - pad.l - pad.r) / Math.max(dates.length - 1, 1)), height - pad.b - (value / max) * (height - pad.t - pad.b)];
  const path = (series) => series.map((value, index) => `${index ? "L" : "M"}${point(value, index).map((n) => n.toFixed(1)).join(" ")}`).join(" ");
  const grid = [0.25, 0.5, 0.75, 1].map((level) => { const y = height - pad.b - level * (height - pad.t - pad.b); return `<line class="chart-gridline" x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}"/><text class="chart-axis" x="0" y="${y + 4}">${metricKey.endsWith("_amt") ? `¥${Math.round(max * level / 100).toLocaleString()}` : Math.round(max * level).toLocaleString()}</text>`; }).join("");
  const labels = dates.map((date, index) => `<text class="chart-axis" text-anchor="middle" x="${point(0, index)[0]}" y="${height - 8}">${date.slice(5)}</text>`).join("");
  const series = values.map((line, index) => `<path class="chart-line" stroke="${COLORS[index % COLORS.length]}" d="${path(line)}"/>`).join("");
  const legend = shops.map((shop, index) => `<span><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(shop)}</span>`).join("");
  return `<section class="panel chart-panel"><div class="panel-head"><div><h3>${title}</h3><span>将鼠标停留在曲线上查看数值</span></div></div><svg class="chart" data-metric="${metricKey}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}">${grid}${series}<line class="chart-hover-line" visibility="hidden" y1="${pad.t}" y2="${height - pad.b}"/>${labels}<rect class="chart-hit-area" x="${pad.l}" y="${pad.t}" width="${width - pad.l - pad.r}" height="${height - pad.t - pad.b}" /></svg><div class="chart-tooltip hidden" role="status"></div><div class="legend">${legend}</div></section>`;
}

function bindLineChartHover(records) {
  $$(".chart[data-metric]").forEach((chart) => {
    const metricKey = chart.dataset.metric;
    const panel = chart.closest(".chart-panel");
    const tooltip = $(".chart-tooltip", panel);
    const hoverLine = $(".chart-hover-line", chart);
    const dates = [...new Set(records.map((item) => item.date))].sort();
    const shops = [...new Set(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const width = 760, leftPadding = 48, rightPadding = 16;

    const hide = () => {
      tooltip.classList.add("hidden");
      hoverLine.setAttribute("visibility", "hidden");
    };
    const move = (event) => {
      const bounds = chart.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * width;
      const step = (width - leftPadding - rightPadding) / Math.max(dates.length - 1, 1);
      const index = Math.max(0, Math.min(dates.length - 1, Math.round((x - leftPadding) / step)));
      const date = dates[index];
      const chartX = leftPadding + index * step;
      const rows = shops.map((shop, shopIndex) => {
        const record = records.find((item) => item.date === date && item.shop_name === shop);
        return `<div><i style="background:${COLORS[shopIndex % COLORS.length]}"></i><span>${escapeHtml(shop)}</span><strong>${metricText(metricKey, record?.metrics?.[metricKey])}</strong></div>`;
      }).join("");
      tooltip.innerHTML = `<b>${date}</b>${rows}`;
      tooltip.classList.remove("hidden");
      const panelBounds = panel.getBoundingClientRect();
      const desiredLeft = event.clientX - panelBounds.left + 14;
      tooltip.style.left = `${Math.max(10, Math.min(desiredLeft, panel.clientWidth - tooltip.offsetWidth - 10))}px`;
      tooltip.style.top = `${Math.max(48, event.clientY - panelBounds.top - 8)}px`;
      hoverLine.setAttribute("x1", chartX);
      hoverLine.setAttribute("x2", chartX);
      hoverLine.setAttribute("visibility", "visible");
    };
    chart.addEventListener("mousemove", move);
    chart.addEventListener("mouseleave", hide);
  });
}

function barPanel(records, metricKey, title) {
  const { date, records: latest } = latestRecords(records);
  const items = latest.map((item) => ({ name: item.shop_name, value: number(item.metrics?.[metricKey]) })).sort((a, b) => b.value - a.value);
  const max = Math.max(...items.map((item) => item.value), 1);
  const bars = items.map((item) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, item.value / max * 100)}%"></div></div><span class="bar-value">${metricText(metricKey, item.value)}</span></div>`).join("");
  return `<section class="panel"><div class="panel-head"><div><h3>${title}</h3><span>${date || "—"} · 最新日</span></div></div>${bars || "<span class='metric-delta'>暂无数据</span>"}</section>`;
}

function renderTable(records, content = false) {
  const headers = content ? ["日期", "店铺", "直播", "商品卡", "图文/短视频", "短视频", "其他内容"] : ["日期", "店铺", "成交金额", "支付金额", "结算金额", "成交订单", "成交人数", "客单价", "曝光人数", "点击人数", "点击支付率", "退款率"];
  const rows = [...records].sort((a, b) => `${b.date}${b.shop_name}`.localeCompare(`${a.date}${a.shop_name}`, "zh-CN")).map((item) => {
    const metrics = item.metrics || {}, source = item.content || {};
    const cells = content ? [item.date, item.shop_name, money(source.live), money(source.product_card), money(source.artc_video), money(source.video), money(source.other_content)] : [item.date, item.shop_name, money(metrics.income_amt), money(metrics.pay_amt), money(metrics.settlement_amt_pay_time), whole(metrics.pay_cnt), whole(metrics.pay_ucnt), money(metrics.per_usr_pay_amt), whole(metrics.product_show_ucnt), whole(metrics.product_click_ucnt), ratio(metrics.product_click_pay_ucnt_ratio), ratio(metrics.refund_amt_rate)];
    return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}">暂无数据</td></tr>`}</tbody></table></div>`;
}

function inventoryDays(value) {
  return value === null || value === undefined ? "—" : `${number(value).toFixed(1)} 天`;
}

function coverageDays(value) {
  return value === null || value === undefined ? "—" : `${Math.ceil(number(value))} 天`;
}

function inventoryBarPanel(items, title, key, formatter = whole) {
  const top = [...items].sort((a, b) => number(b[key]) - number(a[key])).slice(0, 10);
  const max = Math.max(...top.map((item) => number(item[key])), 1);
  const bars = top.map((item) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, number(item[key]) / max * 100)}%"></div></div><span class="bar-value">${formatter(item[key])}</span></div>`).join("");
  return `<section class="panel"><div class="panel-head"><div><h3>${title}</h3><span>按可发库存排序 · 前 10</span></div></div>${bars || "<span class='metric-delta'>暂无数据</span>"}</section>`;
}

function healthPill(item) {
  return `<span class="health-pill ${escapeHtml(item.health_key || item.key)}">${escapeHtml(item.health_name || item.name)}</span>`;
}

function inventoryTable(rows, mode = "detail") {
  const columns = mode === "replenish"
    ? ["状态", "仓库", "货品", "商家编码", "可发库存", "近 7 天出库", "预计可售", "建议补货", "近 30 天入库"]
    : ["状态", "仓库", "品牌", "货品", "商家编码", "可发库存", "近 7 天出库", "预计可售", "近 30 天入库", "最后出入库"];
  const body = rows.slice(0, 200).map((item) => {
    const shared = [healthPill(item), item.warehouse_name, item.goods_name, item.spec_no, whole(item.available_num), whole(item.sales_7d), coverageDays(item.coverage_days), whole(item.replenish_qty), whole(item.inbound_30d)];
    const cells = mode === "replenish" ? shared : [healthPill(item), item.warehouse_name, item.brand_name, item.goods_name, item.spec_no, whole(item.available_num), whole(item.sales_7d), coverageDays(item.coverage_days), whole(item.inbound_30d), item.last_inout_time || "—"];
    return `<tr class="${number(item.available_num) < 0 ? "inventory-alert" : ""}">${cells.map((cell, index) => `<td>${index === 0 ? cell : escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${columns.map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${body || `<tr><td colspan="${columns.length}">暂无符合条件的库存记录</td></tr>`}</tbody></table></div>`;
}

function healthDistribution(items) {
  const max = Math.max(...items.map((item) => number(item.sku_records)), 1);
  const cards = items.map((item) => `<div class="health-row"><div class="health-row-head">${healthPill(item)}<strong>${whole(item.sku_records)} 条</strong></div><div class="health-track"><i class="${escapeHtml(item.key)}" style="width:${Math.max(2, number(item.sku_records) / max * 100)}%"></i></div><span>可发 ${whole(item.available_num)}</span></div>`).join("");
  return `<section class="panel health-panel"><div class="panel-head"><div><h3>库存健康结构</h3><span>按仓库 × SKU 记录划分</span></div></div>${cards}</section>`;
}

function salesTrendPanel(items) {
  const max = Math.max(...items.map((item) => number(item.quantity)), 1);
  const bars = items.map((item) => `<div class="sales-day"><span>${escapeHtml(String(item.date || "").slice(5) || "—")}</span><div class="sales-column"><i style="height:${Math.max(4, number(item.quantity) / max * 100)}%"></i></div><strong>${whole(item.quantity)}</strong></div>`).join("");
  return `<section class="panel sales-trend"><div class="panel-head"><div><h3>近 7 天销售出库</h3><span>按出库日期汇总</span></div></div><div class="sales-days">${bars || "<span class='metric-delta'>暂无销售出库明细</span>"}</div></section>`;
}

function inventoryTabs(view) {
  const tabs = [["overview", "总览"], ["replenish", "补货清单"], ["overstock", "积压 / 未动销"], ["detail", "SKU 明细"]];
  return `<div class="inventory-tabs" role="tablist">${tabs.map(([key, label]) => `<button class="inventory-tab ${view === key ? "active" : ""}" type="button" data-inventory-view="${key}" role="tab" aria-selected="${view === key}">${label}</button>`).join("")}</div>`;
}

function inventoryNotes(payload) {
  const source = payload.source || {};
  const settings = payload.settings || {};
  const history = payload.history || {};
  const historyMessage = history.ready
    ? `已具备连续 30 天日结快照：实际 30 天周转约 ${inventoryDays(history.actual_turnover_days)}。`
    : `日结快照已累计 ${whole(history.available_days)}/${whole(history.required_days || 30)} 天；连续满 30 天后将自动计算实际 30 天周转。`;
  return `<section class="panel inventory-note"><h3>计算口径与边界</h3><p>预计可售天数 = 当前可发库存 ÷（近 7 天销售出库 ÷ 7）。补货建议以 ${whole(settings.target_cover_days)} 天目标库存和 ${whole(settings.safety_stock_days)} 天安全库存估算，只作经营建议，不创建采购或修改库存。</p><p>${historyMessage}</p><p>库存来自 ${escapeHtml((source.apis || []).join("、"))} 的本地快照。仅使用一次收费的查询接口；未调用任何按次计费、创建、回写或库存变更接口。</p><p>“未动销”当前只代表近 7 天无销售出库；累计每日库存快照后，可升级为 30 天实际周转与长期滞销判断。</p></section>`;
}

function renderInventory(payload, view = state.inventoryView) {
  state.inventory = payload;
  state.inventoryView = view;
  const summary = payload.summary || {}, rows = payload.rows || [];
  $("#inventory-summary").textContent = `快照时间：${payload.captured_at || "—"} · 页面只读取服务器本地库存快照`;
  const metrics = [
    ["可发库存", whole(summary.available_num), `可售 SKU：${whole(summary.salable_skus)}`],
    ["近 7 天出库", whole(summary.sales_7d), "用于估算近期日均需求"],
    ["预计可售天数", inventoryDays(summary.turnover_days), "整体可发库存 ÷ 日均出库"],
    ["需补货记录", whole(summary.replenishment_records), "已缺货、紧急补货与需补货"],
    ["偏高 / 积压", whole(summary.overstock_records), "可售超过 45 天的动销记录"],
    ["近 7 日未动销", whole(summary.no_movement_records), "有可发库存、近 7 日无出库"],
  ];
  const cards = `<div class="metric-grid six">${metrics.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("")}</div>`;
  const replenishment = rows.filter((item) => ["out_of_stock", "urgent", "replenish"].includes(item.health_key));
  const overstock = rows.filter((item) => ["high", "overstock", "no_movement"].includes(item.health_key));
  const overview = `${cards}<div class="chart-grid"><div class="chart-stack">${healthDistribution(payload.health || [])}${salesTrendPanel(payload.sales_trend_7d || [])}</div><div class="chart-stack">${inventoryBarPanel(payload.warehouses || [], "仓库可发库存排行", "available_num")}${inventoryNotes(payload)}</div></div><h3 class="section-title">优先处理 <small>先补货，再处理库存偏高与未动销</small></h3>${inventoryTable(replenishment, "replenish")}`;
  const content = view === "replenish"
    ? `<h3 class="section-title inventory-first-title">补货优先级 <small>按缺货与预计可售天数排序，显示前 200 条</small></h3>${inventoryTable(replenishment, "replenish")}${inventoryNotes(payload)}`
    : view === "overstock"
      ? `<h3 class="section-title inventory-first-title">积压 / 未动销清单 <small>“未动销”仅基于近 7 天销售出库</small></h3>${inventoryTable(overstock)}${inventoryNotes(payload)}`
      : view === "detail"
        ? `<h3 class="section-title inventory-first-title">SKU 明细 <small>按风险优先级排序，显示前 200 条</small></h3>${inventoryTable(rows)}${inventoryNotes(payload)}`
        : overview;
  $("#inventory-content").innerHTML = `${inventoryTabs(view)}${content}`;
  $$('[data-inventory-view]').forEach((button) => button.addEventListener("click", () => renderInventory(payload, button.dataset.inventoryView)));
}

async function loadInventory() {
  const target = $("#inventory-content");
  try {
    const response = await fetch("/api/inventory");
    if (response.status === 401) return showLogin();
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "库存快照不可用");
    renderInventory(payload);
  } catch (error) {
    target.innerHTML = `<div class="empty-panel"><strong>库存快照暂不可用</strong><span>${escapeHtml(error.message || "请在服务器侧运行只读库存同步")}</span></div>`;
  }
}

async function renderStatus() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) return "";
    const status = await response.json();
    const message = status.message || "暂无采集状态";
    return `<details class="panel status-panel"><summary>采集状态 · ${escapeHtml(status.state || "unknown")}</summary><div class="status-body"><p>${escapeHtml(message)}</p><p>最近成功采集：${escapeHtml(status.last_success_at || "—")}</p><div class="status-actions"><button id="scrape-button" class="button button-primary" ${status.job_running ? "disabled" : ""}>${status.job_running ? "采集任务进行中" : "手动补采今天数据"}</button><a class="button" href="${escapeHtml(status.novnc_url || "#")}" target="_blank" rel="noreferrer">打开远程浏览器</a></div></div></details>`;
  } catch { return ""; }
}

async function renderCompass() {
  const records = filteredRecords();
  const target = $("#compass-content");
  if (!records.length) {
    target.innerHTML = `<div class="empty-panel"><strong>当前筛选条件没有数据</strong><span>请选择至少一个业务日期和店铺。</span></div>`;
    return;
  }
  const cards = metricCards(records);
  $("#compass-summary").textContent = `最新业务日期：${cards.date} · 已选择 ${new Set(records.map((item) => item.shop_name)).size} 家店铺 · ${new Set(records.map((item) => item.date)).size} 个业务日`;
  target.innerHTML = `${cards.html}<h3 class="section-title">趋势与对比</h3><div class="chart-grid"><div class="chart-stack">${lineChart(records, "income_amt", "成交金额趋势")}${lineChart(records, "pay_cnt", "成交订单趋势")}${lineChart(records, "product_click_pay_ucnt_ratio", "点击支付率趋势")}</div><div class="chart-stack">${barPanel(records, "income_amt", "最新日成交对比")}${barPanel(records, "pay_cnt", "最新日订单对比")}</div></div><h3 class="section-title">店铺明细</h3>${renderTable(records)}<h3 class="section-title">内容来源拆分</h3>${renderTable(records, true)}<div id="status-slot"></div>`;
  bindLineChartHover(records);
  $("#status-slot").innerHTML = await renderStatus();
  $("#scrape-button")?.addEventListener("click", startScrape);
}

async function startScrape() {
  const button = $("#scrape-button");
  button.disabled = true;
  button.textContent = "正在启动…";
  const response = await fetch("/api/scrape", { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  button.textContent = payload.message || payload.error || "请求已发送";
}

async function loadCompass() {
  const response = await fetch("/api/compass");
  if (response.status === 401) return showLogin();
  const payload = await response.json();
  state.records = payload.records || [];
  state.dates = new Set(state.records.map((item) => item.date));
  state.shops = new Set(state.records.map((item) => item.shop_name));
  state.operationDates = new Set(state.records.map((item) => item.date));
  state.operationShops = new Set(state.records.map((item) => item.shop_name));
  renderFilters();
  renderCompass();
  renderOperationsFilters();
  renderOperations();
}

function showLogin() { $("#login-layer").classList.remove("hidden"); $("#app-shell").classList.add("hidden"); }
function showApp(user) { $("#login-layer").classList.add("hidden"); $("#app-shell").classList.remove("hidden"); $("#account-name").textContent = `已登录：${user.username}`; }

async function initialise() {
  buildPlaceholders();
  const desired = location.hash.slice(1);
  activatePage(["inventory", "operations", "settlement", "channel", "compass"].includes(desired) ? desired : "compass");
  $$(".nav-tab").forEach((tab) => tab.addEventListener("click", () => activatePage(tab.dataset.page)));
  $("#logout-button").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); showLogin(); });
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
    const payload = await response.json();
    if (!response.ok) { $("#login-error").textContent = payload.error || "登录失败"; return; }
    $("#login-error").textContent = "";
    showApp(payload);
    loadCompass();
    loadInventory();
  });
  const me = await fetch("/api/me").then((response) => response.json());
  if (me.authenticated) { showApp(me); loadCompass(); loadInventory(); } else showLogin();
}

initialise();
