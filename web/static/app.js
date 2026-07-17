const state = { records: [], operationDates: new Set(), operationShops: new Set(), operationSources: new Set(), operationFilterOpen: new Set(), tableDate: "", tableShop: "", status: null, page: "operations", inventory: null, inventoryView: "overview", inventoryWarehouse: "", orderImports: { batches: [], summary: {} }, orderPreview: null, orderImportMessage: "" };
const COLORS = ["#3da7f5", "#31d380", "#a461d2", "#f18a21", "#f7c91b"];
let statusRefreshTimer = null;
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (cents) => `¥${(number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (value) => Math.round(number(value)).toLocaleString("zh-CN");
const ratio = (value) => `${(number(value) * 100).toFixed(2)}%`;
const metricText = (key, value) => key.endsWith("_amt") || ["income_amt", "pay_amt", "per_usr_pay_amt", "settlement_amt_pay_time", "expense_amt"].includes(key) ? money(value) : key.endsWith("_ratio") || key.endsWith("_rate") ? ratio(value) : whole(value);
const hasValue = (value) => value !== null && value !== undefined && value !== "";
const moneyOrDash = (value) => hasValue(value) ? money(value) : "—";
const wholeOrDash = (value) => hasValue(value) ? whole(value) : "—";
const ratioOrDash = (value) => hasValue(value) ? ratio(value) : "—";
function recordSourceLabel(item) {
    return item.source_label || (item.source === "external_orders" ? "订单明细" : "抖店罗盘");
}
function compactMoney(cents) {
    const yuan = number(cents) / 100;
    const abs = Math.abs(yuan);
    if (abs >= 1e8)
        return `¥${(yuan / 1e8).toFixed(abs >= 1e9 ? 1 : 2)}亿`;
    if (abs >= 1e4)
        return `¥${(yuan / 1e4).toFixed(abs >= 1e5 ? 1 : 2)}万`;
    return `¥${Math.round(yuan).toLocaleString("zh-CN")}`;
}
function chartAxisValue(metricKey, value) {
    return metricKey.endsWith("_amt") ? compactMoney(value) : Math.round(number(value)).toLocaleString("zh-CN");
}
function chartDateTicks(dates, maxLabels = 6) {
    if (dates.length <= maxLabels)
        return dates.map((date, index) => ({ date, index }));
    const indexes = new Set();
    for (let step = 0; step < maxLabels; step += 1) {
        indexes.add(Math.round(step * (dates.length - 1) / (maxLabels - 1)));
    }
    return [...indexes].sort((a, b) => a - b).map((index) => ({ date: dates[index], index }));
}
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
function latestRecords(records) {
    const dates = [...new Set(records.map((item) => item.date))].sort();
    const latest = dates.at(-1);
    return { date: latest, records: records.filter((item) => item.date === latest) };
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
function operationFilteredRecords() {
    return state.records.filter((item) => state.operationDates.has(item.date) && state.operationShops.has(item.shop_name) && state.operationSources.has(recordSourceLabel(item)));
}
function operationFilterSet(kind) {
    return kind === "date" ? state.operationDates : kind === "shop" ? state.operationShops : state.operationSources;
}
function operationFilterItems(kind, records = state.records) {
    if (kind === "date")
        return [...new Set(records.map((item) => item.date))].sort();
    if (kind === "shop")
        return [...new Set(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    return [...new Set(records.map(recordSourceLabel))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
function operationSingleFilterValue(kind) {
    const selected = [...operationFilterSet(kind)];
    return selected.length === 1 ? selected[0] : "";
}
function applySingleOperationFilter(kind, value) {
    const selected = operationFilterSet(kind);
    selected.clear();
    if (value)
        selected.add(value);
    else
        operationFilterItems(kind).forEach((item) => selected.add(item));
}
function operationsFiltersMarkup() {
    const dates = operationFilterItems("date");
    const shops = operationFilterItems("shop");
    const sources = operationFilterItems("source");
    const openAttr = (kind) => state.operationFilterOpen.has(kind) ? " open" : "";
    const buildGroup = (title, items, selected, kind) => `<details class="filter-disclosure" data-filter-kind="${kind}"${openAttr(kind)}><summary><span>${title}</span><small>已选择 ${selected.size} 个</small></summary><div class="chip-list">${items.map((item) => `<button class="chip ${selected.has(item) ? "selected" : ""}" type="button" data-operation-filter="${kind}" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div></details>`;
    const buildDropdown = (title, items, selected, kind) => `<details class="filter-disclosure filter-dropdown" data-filter-kind="${kind}"${openAttr(kind)}><summary><span>${title}</span><small>已选择 ${selected.size} 个</small></summary><div class="dropdown-panel"><div class="dropdown-actions"><button type="button" class="dropdown-action" data-operation-select-all="${kind}">全选</button><button type="button" class="dropdown-action" data-operation-clear="${kind}">仅保留一个</button></div><div class="dropdown-list">${items.map((item) => `<label class="dropdown-option"><input type="checkbox" data-operation-filter="${kind}" data-value="${escapeHtml(item)}" ${selected.has(item) ? "checked" : ""}><span>${escapeHtml(item)}</span></label>`).join("")}</div></div></details>`;
    return buildGroup("业务日期", dates, state.operationDates, "date") + buildDropdown("店铺", shops, state.operationShops, "shop") + buildGroup("数据来源", sources, state.operationSources, "source");
}
function bindOperationsFilterEvents() {
    const dates = operationFilterItems("date");
    const shops = operationFilterItems("shop");
    const sources = operationFilterItems("source");
    $$('[data-operation-filter]').forEach((control) => control.addEventListener(control.type === "checkbox" ? "change" : "click", () => {
        const selected = operationFilterSet(control.dataset.operationFilter);
        const value = control.dataset.value;
        const shouldSelect = control.type === "checkbox" ? control.checked : !selected.has(value);
        if (!shouldSelect && selected.size <= 1) {
            control.checked = true;
            return;
        }
        if (shouldSelect)
            selected.add(value);
        else
            selected.delete(value);
        renderOperations();
    }));
    $$('[data-operation-select-all]').forEach((button) => button.addEventListener("click", () => {
        const kind = button.dataset.operationSelectAll;
        const items = kind === "date" ? dates : kind === "shop" ? shops : sources;
        const selected = operationFilterSet(kind);
        items.forEach((item) => selected.add(item));
        renderOperations();
    }));
    $$('[data-operation-clear]').forEach((button) => button.addEventListener("click", () => {
        const kind = button.dataset.operationClear;
        const items = kind === "date" ? dates : kind === "shop" ? shops : sources;
        const selected = operationFilterSet(kind);
        selected.clear();
        if (items.length)
            selected.add(items[0]);
        renderOperations();
    }));
    $$('[data-filter-kind]').forEach((details) => details.addEventListener("toggle", () => {
        const kind = details.dataset.filterKind;
        if (details.open)
            state.operationFilterOpen.add(kind);
        else
            state.operationFilterOpen.delete(kind);
    }));
}
function importTime(value) {
    if (!value)
        return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function importDateRange(value) {
    return Array.isArray(value) && value.length === 2 ? `${value[0]} 至 ${value[1]}` : "—";
}
function renderOrderImportPanel() {
    const target = $("#order-import-panel");
    if (!target)
        return;
    const preview = state.orderPreview;
    const batches = state.orderImports?.batches || [];
    const summary = state.orderImports?.summary || {};
    const message = state.orderImportMessage ? `<p class="order-import-message">${escapeHtml(state.orderImportMessage)}</p>` : "";
    const previewBlock = preview ? `<div class="import-preview"><div class="import-preview-head"><strong>导入预览</strong><span>${escapeHtml(importDateRange(preview.summary?.date_range))}</span></div><div class="import-preview-metrics"><span>将新增 <b>${whole(preview.summary?.added_orders)}</b> 单</span><span>跳过重复 <b>${whole(preview.summary?.duplicate_orders)}</b> 单</span><span>支付金额 <b>${money(preview.summary?.pay_amt)}</b></span><span>商品件数 <b>${whole(preview.summary?.pay_item_cnt)}</b></span></div><ul class="import-file-list">${(preview.files || []).map((file) => `<li><span>${escapeHtml(file.source_label)} · ${escapeHtml(file.file_name)}</span><small>${file.known_file ? "文件已导入" : `新增 ${whole(file.added_orders)} 单，跳过 ${whole(file.duplicate_orders)} 单`}</small></li>`).join("")}</ul><div class="status-actions"><button class="button button-primary" type="button" data-commit-order-import ${preview.summary?.added_orders ? "" : "disabled"}>确认写入看板</button><button class="button" type="button" data-cancel-order-preview>取消</button></div><p class="import-help">确认后只保存日汇总与不可逆订单指纹，用于防止重复导入；上传的 Excel 会立即删除。</p></div>` : "";
    const history = batches.length ? `<div class="import-history"><div class="import-history-head"><strong>导入历史</strong><span>累计 ${whole(summary.orders)} 单 · ${money(summary.pay_amt)}</span></div>${batches.map((batch) => `<div class="import-history-row"><div><strong>${escapeHtml((batch.source_labels || []).join("、"))}</strong><span>${escapeHtml(importTime(batch.created_at))} · ${escapeHtml(importDateRange(batch.date_range))} · 新增 ${whole(batch.added_orders)} 单</span></div><button class="text-button import-delete" type="button" data-delete-order-import="${escapeHtml(batch.id)}">撤销</button></div>`).join("")}</div>` : `<p class="import-help">暂无线上导入批次。可上传喵速达、天猫订单明细；抖店罗盘继续由现有采集任务更新。</p>`;
    target.innerHTML = `<details class="panel order-import-panel"><summary><span>订单数据导入</span><small>上传 Excel → 预览去重 → 确认写入</small></summary><div class="order-import-body"><form id="order-upload-form" class="order-upload-form"><label class="file-picker"><span>选择订单明细（.xlsx，可多选）</span><input id="order-upload-files" type="file" name="files" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple required /></label><button class="button" type="submit">解析并预览</button></form>${message}${previewBlock}${history}<p class="import-help">同一文件按指纹跳过；可匹配的相同订单按不可逆指纹跳过。订单号、买家、地址与原始文件不会保存。</p></div></details>`;
    $("#order-upload-form")?.addEventListener("submit", previewOrderImport);
    $("[data-commit-order-import]")?.addEventListener("click", commitOrderImport);
    $("[data-cancel-order-preview]")?.addEventListener("click", () => { state.orderPreview = null; state.orderImportMessage = "已取消本次预览，尚未写入任何数据。"; renderOrderImportPanel(); });
    $$('[data-delete-order-import]').forEach((button) => button.addEventListener("click", () => deleteOrderImport(button.dataset.deleteOrderImport)));
}
async function loadOrderImports() {
    const response = await fetch("/api/orders/imports");
    if (response.status === 401)
        return showLogin();
    state.orderImports = await response.json();
    renderOrderImportPanel();
}
async function previewOrderImport(event) {
    event.preventDefault();
    const files = $("#order-upload-files")?.files;
    if (!files?.length)
        return;
    const button = $("#order-upload-form button");
    button.disabled = true;
    button.textContent = "正在解析…";
    state.orderImportMessage = "";
    const response = await fetch("/api/orders/preview", { method: "POST", body: new FormData(event.currentTarget) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        state.orderImportMessage = payload.error || "文件解析失败，请检查格式后重试。";
    }
    else {
        state.orderPreview = payload;
        state.orderImportMessage = "预览完成，请核对新增与重复数量后确认写入。";
    }
    renderOrderImportPanel();
}
async function commitOrderImport() {
    if (!state.orderPreview?.preview_token)
        return;
    const response = await fetch("/api/orders/imports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview_token: state.orderPreview.preview_token }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        state.orderImportMessage = payload.error || "写入失败，请重新预览。";
        renderOrderImportPanel();
        return;
    }
    state.orderPreview = null;
    state.orderImportMessage = `已写入 ${whole(payload.batch?.added_orders)} 单订单汇总。`;
    await Promise.all([loadCompass(), loadOrderImports()]);
}
async function deleteOrderImport(batchId) {
    if (!batchId || !window.confirm("撤销后，该批次导入的数据将从经营看板移除。确定继续吗？"))
        return;
    const response = await fetch(`/api/orders/imports/${encodeURIComponent(batchId)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    state.orderImportMessage = response.ok ? `已撤销 ${whole(payload.deleted?.added_orders)} 单导入数据。` : (payload.error || "撤销失败，请稍后重试。");
    await Promise.all([loadCompass(), loadOrderImports()]);
}
function operatingRatio(value) {
    return value === null || value === undefined ? "—" : `${number(value).toFixed(2)}×`;
}
function detailTableRecords(records) {
    return records.filter((item) => state.operationDates.has(item.date) &&
        state.operationShops.has(item.shop_name));
}
function detailTableFilters() {
    const dates = operationFilterItems("date");
    const shops = operationFilterItems("shop");
    state.tableDate = operationSingleFilterValue("date");
    state.tableShop = operationSingleFilterValue("shop");
    const options = (items, selected, allLabel) => `<option value="">${allLabel}</option>${items.map((item) => `<option value="${escapeHtml(item)}" ${selected === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}`;
    return `<section class="table-filter-panel" aria-label="看板筛选"><div><strong>看板筛选</strong><span>筛选卡片、趋势、对比与下方明细表</span></div><label>业务日期<select data-table-filter="date">${options(dates, state.tableDate, "全部日期")}</select></label><label>店铺<select data-table-filter="shop">${options(shops, state.tableShop, "全部店铺")}</select></label></section>`;
}
function bindDetailTableFilters() {
    $$('[data-table-filter]').forEach((select) => select.addEventListener("change", () => {
        const kind = select.dataset.tableFilter;
        if (kind === "date")
            state.tableDate = select.value;
        else
            state.tableShop = select.value;
        applySingleOperationFilter(kind, select.value);
        renderOperations();
    }));
}
function renderOperations() {
    const records = operationFilteredRecords();
    const target = $("#operations-content");
    const detailFiltersTarget = $("#detail-filters");
    if (!records.length) {
        if (detailFiltersTarget)
            detailFiltersTarget.innerHTML = "";
        target.innerHTML = `<div class="empty-panel"><strong>当前筛选条件没有经营数据</strong><span>请选择至少一个业务日期和店铺。</span></div>${operationsFiltersMarkup()}`;
        bindOperationsFilterEvents();
        return;
    }
    if (detailFiltersTarget) {
        detailFiltersTarget.innerHTML = detailTableFilters();
        bindDetailTableFilters();
    }
    const totals = aggregate(records);
    const returnOnSpend = totals.expense_amt ? totals.pay_amt / totals.expense_amt : null;
    const latestDate = [...new Set(records.map((item) => item.date))].sort().at(-1);
    $("#operations-summary").textContent = `数据来源：${[...new Set(records.map(recordSourceLabel))].join("、")} · 最新业务日期：${latestDate || "—"} · 已选择 ${new Set(records.map((item) => item.shop_name)).size} 家店铺、${new Set(records.map((item) => item.date)).size} 个业务日`;
    const metrics = [
        ["成交金额", money(totals.income_amt), "按成交口径汇总"],
        ["用户支付金额", money(totals.pay_amt), "按支付口径汇总"],
        ["结算金额", money(totals.settlement_amt_pay_time), "按支付时间结算口径"],
        ["成交订单", whole(totals.pay_cnt), `成交件数：${whole(totals.pay_item_cnt)}`],
        ["投产比", operatingRatio(returnOnSpend), totals.expense_amt ? `支付金额 ÷ 投放消耗 ${money(totals.expense_amt)}` : "暂无投放消耗数据"],
        ["退款率", ratio(totals.refund_amt_rate), "按成交金额加权汇总"],
    ];
    const cards = `<div class="metric-grid six">${metrics.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("")}</div>`;
    const sourceNote = `<section class="panel operations-note"><h3>数据口径</h3><p>经营看板同时使用已采集的罗盘日维度数据和外部订单明细汇总；筛选“数据来源”可分别查看。</p><p>外部订单仅按支付日期与店铺汇总已支付、未关闭订单，不保存原始订单、买家、地址或联系方式；其未提供的流量、结算与内容归因指标显示为“—”。</p><p>当前数据维度为日期与店铺；品牌维度在罗盘源数据中尚未提供，因此未做品牌归因。</p></section>`;
    const detailRecords = detailTableRecords(records);
    const tableCount = whole(detailRecords.length);
    const detailTables = `<details class="detail-table-disclosure"><summary><span>店铺经营明细</span><small>按日期与店铺查看关键经营指标 · ${tableCount} 条</small></summary><div class="detail-table-content">${renderTable(detailRecords)}</div></details><details class="detail-table-disclosure"><summary><span>内容成交来源</span><small>直播、商品卡与内容贡献 · ${tableCount} 条</small></summary><div class="detail-table-content">${renderTable(detailRecords, true)}</div></details>`;
    target.innerHTML = `${cards}<div class="chart-grid"><div class="chart-stack">${lineChart(records, "income_amt", "成交金额趋势")}${lineChart(records, "pay_cnt", "成交订单趋势")}${lineChart(records, "expense_amt", "投放消耗趋势")}</div><div class="chart-stack">${barPanel(records, "income_amt", "店铺成交金额对比")}${barPanel(records, "pay_amt", "店铺支付金额对比")}${sourceNote}</div></div>${operationsFiltersMarkup()}<div class="detail-table-stack">${detailTables}</div>`;
    bindLineChartHover(records);
    bindOperationsFilterEvents();
}
function lineChart(records, metricKey, title) {
    const dates = [...new Set(records.map((item) => item.date))].sort();
    const shops = [...new Set(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const values = shops.map((shop) => dates.map((date) => number(records.find((item) => item.date === date && item.shop_name === shop)?.metrics?.[metricKey])));
    const totals = dates.map((date) => values.reduce((sum, series) => sum + number(series[dates.indexOf(date)]), 0));
    const max = Math.max(...totals, ...values.flat(), 1) * 1.08;
    const width = 760, height = 252, pad = { l: 68, r: 16, t: 15, b: 38 };
    const point = (value, index) => [pad.l + index * ((width - pad.l - pad.r) / Math.max(dates.length - 1, 1)), height - pad.b - (value / max) * (height - pad.t - pad.b)];
    const path = (series) => series.map((value, index) => `${index ? "L" : "M"}${point(value, index).map((n) => n.toFixed(1)).join(" ")}`).join(" ");
    const levels = [0.25, 0.5, 0.75, 1];
    const grid = levels.map((level) => { const y = height - pad.b - level * (height - pad.t - pad.b); return `<line class="chart-gridline" x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}"/>`; }).join("");
    const yAxis = levels.map((level) => { const y = height - pad.b - level * (height - pad.t - pad.b); return `<span style="top:${(y / height * 100).toFixed(3)}%">${chartAxisValue(metricKey, max * level)}</span>`; }).join("");
    const xAxis = chartDateTicks(dates).map(({ date, index }) => `<span style="left:${(point(0, index)[0] / width * 100).toFixed(3)}%">${date.slice(5)}</span>`).join("");
    const series = values.map((line, index) => `<path class="chart-line" stroke="${COLORS[index % COLORS.length]}" d="${path(line)}"/>`).join("");
    const legend = shops.map((shop, index) => `<span><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(shop)}</span>`).join("");
    return `<section class="panel chart-panel"><div class="panel-head"><div><h3>${title}</h3><span>将鼠标停留在曲线上查看数值</span></div></div><div class="chart-frame"><svg class="chart" data-metric="${metricKey}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}">${grid}${series}<line class="chart-hover-line" visibility="hidden" y1="${pad.t}" y2="${height - pad.b}"/><rect class="chart-hit-area" x="${pad.l}" y="${pad.t}" width="${width - pad.l - pad.r}" height="${height - pad.t - pad.b}" /></svg><div class="chart-y-axis" aria-hidden="true">${yAxis}</div><div class="chart-x-axis" aria-hidden="true">${xAxis}</div></div><div class="chart-tooltip hidden" role="status"></div><div class="legend">${legend}</div></section>`;
}
function bindLineChartHover(records) {
    $$(".chart[data-metric]").forEach((chart) => {
        const metricKey = chart.dataset.metric;
        const panel = chart.closest(".chart-panel");
        const tooltip = $(".chart-tooltip", panel);
        const hoverLine = $(".chart-hover-line", chart);
        const dates = [...new Set(records.map((item) => item.date))].sort();
        const shops = [...new Set(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
        const width = 760, leftPadding = 68, rightPadding = 16;
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
    const headers = content ? ["日期", "店铺", "来源", "直播", "商品卡", "图文/短视频", "短视频", "其他内容"] : ["日期", "店铺", "来源", "成交金额", "支付金额", "结算金额", "成交订单", "成交人数", "客单价", "曝光人数", "点击人数", "点击支付率", "退款率"];
    const rows = [...records].sort((a, b) => `${b.date}${b.shop_name}`.localeCompare(`${a.date}${a.shop_name}`, "zh-CN")).map((item) => {
        const metrics = item.metrics || {}, source = item.content || {};
        const cells = content
            ? [item.date, item.shop_name, recordSourceLabel(item), moneyOrDash(source.live), moneyOrDash(source.product_card), moneyOrDash(source.artc_video), moneyOrDash(source.video), moneyOrDash(source.other_content)]
            : [item.date, item.shop_name, recordSourceLabel(item), moneyOrDash(metrics.income_amt), moneyOrDash(metrics.pay_amt), moneyOrDash(metrics.settlement_amt_pay_time), wholeOrDash(metrics.pay_cnt), wholeOrDash(metrics.pay_ucnt), moneyOrDash(metrics.per_usr_pay_amt), wholeOrDash(metrics.product_show_ucnt), wholeOrDash(metrics.product_click_ucnt), ratioOrDash(metrics.product_click_pay_ucnt_ratio), ratioOrDash(metrics.refund_amt_rate)];
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
const INVENTORY_HEALTH_ORDER = ["out_of_stock", "urgent", "replenish", "healthy", "high", "overstock", "no_movement", "unavailable"];
const INVENTORY_HEALTH_NAMES = {
    out_of_stock: "已缺货",
    urgent: "紧急补货",
    replenish: "需安排补货",
    healthy: "库存健康",
    high: "库存偏高",
    overstock: "库存积压",
    no_movement: "近 7 日未动销",
    unavailable: "暂无可售",
};
function inventoryWarehouseOptions(payload) {
    return [...new Set((payload.rows || []).map((item) => item.warehouse_name || "未命名仓库"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
function inventoryFilteredRows(payload) {
    const warehouses = inventoryWarehouseOptions(payload);
    if (state.inventoryWarehouse && !warehouses.includes(state.inventoryWarehouse))
        state.inventoryWarehouse = "";
    return state.inventoryWarehouse
        ? (payload.rows || []).filter((item) => (item.warehouse_name || "未命名仓库") === state.inventoryWarehouse)
        : (payload.rows || []);
}
function inventoryGroup(rows, keyName) {
    const groups = new Map();
    rows.forEach((row) => {
        const name = row[keyName] || "未归类";
        const group = groups.get(name) || { name, sku_records: 0, stock_num: 0, available_num: 0, sales_7d: 0, inbound_30d: 0, negative_available: 0 };
        group.sku_records += 1;
        ["stock_num", "available_num", "sales_7d", "inbound_30d"].forEach((key) => group[key] += number(row[key]));
        group.negative_available += number(row.available_num) < 0 ? 1 : 0;
        groups.set(name, group);
    });
    return [...groups.values()].map((group) => ({
        ...group,
        turnover_days: group.sales_7d ? group.available_num / (group.sales_7d / 7) : null,
    })).sort((a, b) => number(b.available_num) - number(a.available_num));
}
function inventoryHealth(rows) {
    return INVENTORY_HEALTH_ORDER.map((key) => {
        const members = rows.filter((row) => row.health_key === key);
        return {
            key,
            name: INVENTORY_HEALTH_NAMES[key],
            sku_records: members.length,
            available_num: members.reduce((sum, row) => sum + number(row.available_num), 0),
        };
    });
}
function inventorySummary(rows) {
    const coverageRows = rows.filter((row) => row.coverage_days !== null && row.coverage_days !== undefined && number(row.sales_7d) > 0);
    const available = rows.reduce((sum, row) => sum + number(row.available_num), 0);
    const sales7d = rows.reduce((sum, row) => sum + number(row.sales_7d), 0);
    return {
        sku_records: rows.length,
        distinct_skus: new Set(rows.map((row) => row.spec_no).filter(Boolean)).size,
        salable_skus: new Set(rows.filter((row) => number(row.available_num) > 0).map((row) => row.spec_no).filter(Boolean)).size,
        stock_num: rows.reduce((sum, row) => sum + number(row.stock_num), 0),
        available_num: available,
        sales_7d: sales7d,
        inbound_30d: rows.reduce((sum, row) => sum + number(row.inbound_30d), 0),
        negative_available: rows.filter((row) => number(row.available_num) < 0).length,
        turnover_days: sales7d ? available / (sales7d / 7) : null,
        average_coverage_days: coverageRows.length ? coverageRows.reduce((sum, row) => sum + number(row.coverage_days), 0) / coverageRows.length : null,
        replenishment_records: rows.filter((row) => ["out_of_stock", "urgent", "replenish"].includes(row.health_key)).length,
        no_movement_records: rows.filter((row) => row.health_key === "no_movement").length,
        overstock_records: rows.filter((row) => ["overstock", "high"].includes(row.health_key)).length,
    };
}
function inventorySalesTrend(payload) {
    return state.inventoryWarehouse
        ? (payload.sales_trend_7d_by_warehouse?.[state.inventoryWarehouse] || [])
        : (payload.sales_trend_7d || []);
}
function inventoryWarehouseFilter(payload) {
    const warehouses = inventoryWarehouseOptions(payload);
    const options = `<option value="">全部仓库</option>${warehouses.map((name) => `<option value="${escapeHtml(name)}" ${state.inventoryWarehouse === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
    return `<section class="table-filter-panel inventory-filter" aria-label="库存筛选"><div><strong>库存筛选</strong><span>筛选总览、补货、积压与 SKU 明细</span></div><label>仓库<select data-inventory-filter="warehouse">${options}</select></label></section>`;
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
    const rows = inventoryFilteredRows(payload);
    const summary = inventorySummary(rows);
    const warehouses = inventoryGroup(rows, "warehouse_name");
    const health = inventoryHealth(rows);
    const salesTrend = inventorySalesTrend(payload);
    const scopeLabel = state.inventoryWarehouse || "全部仓库";
    $("#inventory-summary").textContent = `快照时间：${payload.captured_at || "—"} · 当前范围：${scopeLabel} · 页面只读取服务器本地库存快照`;
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
    const overview = `${cards}<div class="chart-grid"><div class="chart-stack">${healthDistribution(health)}${salesTrendPanel(salesTrend)}</div><div class="chart-stack">${inventoryBarPanel(warehouses, "仓库可发库存排行", "available_num")}${inventoryNotes(payload)}</div></div><h3 class="section-title">优先处理 <small>先补货，再处理库存偏高与未动销</small></h3>${inventoryTable(replenishment, "replenish")}`;
    const content = view === "replenish"
        ? `<h3 class="section-title inventory-first-title">补货优先级 <small>按缺货与预计可售天数排序，显示前 200 条</small></h3>${inventoryTable(replenishment, "replenish")}${inventoryNotes(payload)}`
        : view === "overstock"
            ? `<h3 class="section-title inventory-first-title">积压 / 未动销清单 <small>“未动销”仅基于近 7 天销售出库</small></h3>${inventoryTable(overstock)}${inventoryNotes(payload)}`
            : view === "detail"
                ? `<h3 class="section-title inventory-first-title">SKU 明细 <small>按风险优先级排序，显示前 200 条</small></h3>${inventoryTable(rows)}${inventoryNotes(payload)}`
                : overview;
    $("#inventory-content").innerHTML = `${inventoryWarehouseFilter(payload)}${inventoryTabs(view)}${content}`;
    $('[data-inventory-filter="warehouse"]')?.addEventListener("change", (event) => {
        state.inventoryWarehouse = event.currentTarget.value;
        renderInventory(payload);
    });
    $$('[data-inventory-view]').forEach((button) => button.addEventListener("click", () => renderInventory(payload, button.dataset.inventoryView)));
}
async function loadInventory() {
    const target = $("#inventory-content");
    try {
        const response = await fetch("/api/inventory");
        if (response.status === 401)
            return showLogin();
        const payload = await response.json();
        if (!response.ok)
            throw new Error(payload.error || "库存快照不可用");
        renderInventory(payload);
    }
    catch (error) {
        target.innerHTML = `<div class="empty-panel"><strong>库存快照暂不可用</strong><span>${escapeHtml(error.message || "请在服务器侧运行只读库存同步")}</span></div>`;
    }
}
function statusTerminal(status, logMessage) {
    if (typeof status.terminal_output === "string" && status.terminal_output) {
        const lineCount = status.terminal_output.split("\n").length;
        return `<div class="status-log"><div class="status-log-head"><span>采集终端输出</span><small>最近 ${escapeHtml(String(lineCount))} 行</small></div><pre>${escapeHtml(status.terminal_output)}</pre></div>`;
    }
    return `<p class="status-log-empty">${escapeHtml(logMessage || "展开后读取本次采集终端输出。")}</p>`;
}
function placeCollectionStatus(status, { open = false, logMessage = "" } = {}) {
    const slot = $("#collection-status");
    if (!slot)
        return;
    state.status = status;
    const message = status.message || "暂无采集状态";
    const html = `<details class="panel status-panel"><summary>采集状态 · ${escapeHtml(status.state || "unknown")}</summary><div class="status-body"><p>${escapeHtml(message)}</p><p>最近成功采集：${escapeHtml(status.last_success_at || "—")}</p>${statusTerminal(status, logMessage)}<div class="status-actions"><button id="scrape-button" class="button button-primary" ${status.job_running ? "disabled" : ""}>${status.job_running ? "采集任务进行中" : "手动补采今天数据"}</button><a class="button" href="${escapeHtml(status.novnc_url || "#")}" target="_blank" rel="noreferrer">打开远程浏览器</a></div></div></details>`;
    slot.innerHTML = html;
    const details = $(".status-panel", slot);
    if (open)
        details.open = true;
    $("#scrape-button")?.addEventListener("click", startScrape);
    details.addEventListener("toggle", () => {
        if (details.open && !Object.prototype.hasOwnProperty.call(state.status || {}, "terminal_output")) {
            refreshCollectionStatus({ open: true });
        }
    });
}
async function refreshCollectionStatus({ open = false } = {}) {
    window.clearTimeout(statusRefreshTimer);
    try {
        const response = await fetch("/api/status");
        if (!response.ok)
            throw new Error("status unavailable");
        const status = await response.json();
        placeCollectionStatus(status, { open });
        const shouldRefresh = Boolean(status.job_running) || ["manual_requested", "waiting_random", "running"].includes(status.state);
        if (shouldRefresh && open)
            statusRefreshTimer = window.setTimeout(() => refreshCollectionStatus({ open: true }), 5000);
    }
    catch {
        if (state.status)
            placeCollectionStatus(state.status, { open, logMessage: "暂时无法读取终端输出，稍后可再次展开重试。" });
    }
}
async function startScrape() {
    const button = $("#scrape-button");
    button.disabled = true;
    button.textContent = "正在启动…";
    const response = await fetch("/api/scrape", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    button.textContent = payload.message || payload.error || "请求已发送";
    window.setTimeout(() => refreshCollectionStatus({ open: true }), 700);
}
async function loadCompass() {
    const response = await fetch("/api/compass");
    if (response.status === 401)
        return showLogin();
    const payload = await response.json();
    state.records = payload.records || [];
    state.status = payload.status || state.status;
    state.operationDates = new Set(state.records.map((item) => item.date));
    state.operationShops = new Set(state.records.map((item) => item.shop_name));
    state.operationSources = new Set(state.records.map(recordSourceLabel));
    renderOperations();
    if (state.status)
        placeCollectionStatus(state.status);
}
function showLogin() { $("#login-layer").classList.remove("hidden"); $("#app-shell").classList.add("hidden"); }
function showApp(user) { $("#login-layer").classList.add("hidden"); $("#app-shell").classList.remove("hidden"); $("#account-name").textContent = `已登录：${user.username}`; }
async function initialise() {
    buildPlaceholders();
    const desired = location.hash.slice(1);
    activatePage(["inventory", "operations", "settlement", "channel"].includes(desired) ? desired : "operations");
    $$(".nav-tab").forEach((tab) => tab.addEventListener("click", () => activatePage(tab.dataset.page)));
    $("#logout-button").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); showLogin(); });
    $("#login-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
        const payload = await response.json();
        if (!response.ok) {
            $("#login-error").textContent = payload.error || "登录失败";
            return;
        }
        $("#login-error").textContent = "";
        showApp(payload);
        loadCompass();
        loadOrderImports();
        loadInventory();
    });
    const me = await fetch("/api/me").then((response) => response.json());
    if (me.authenticated) {
        showApp(me);
        loadCompass();
        loadOrderImports();
        loadInventory();
    }
    else
        showLogin();
}
initialise();
