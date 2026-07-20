const state = { currentUser: null, users: [], accountMessage: "", records: [], operationDates: new Set(), operationShops: new Set(), operationSources: new Set(), operationFilterOpen: new Set(), tableDate: "", tableShop: "", status: null, collectionModules: new Set(["operations", "channel"]), collectionMessage: "", page: "operations", inventory: null, inventoryView: "overview", inventoryWarehouse: "", settlement: null, settlementShop: "", settlementUploadMessage: "", orderImports: { batches: [], summary: {} }, orderPreview: null, orderImportMessage: "", channel: null, channelDate: "", channelShop: "" };
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
const settlementMoney = (yuan) => `¥${number(yuan).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const settlementMoneyOrDash = (value) => hasValue(value) ? settlementMoney(value) : "—";
const wholeOrDash = (value) => hasValue(value) ? whole(value) : "—";
const ratioOrDash = (value) => hasValue(value) ? ratio(value) : "—";
const isAdmin = () => state.currentUser?.role === "admin";
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
    if (name === "collection" && state.currentUser)
        refreshCollectionStatus();
    else
        window.clearTimeout(statusRefreshTimer);
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
    const previewBlock = isAdmin() && preview ? `<div class="import-preview"><div class="import-preview-head"><strong>导入预览</strong><span>${escapeHtml(importDateRange(preview.summary?.date_range))}</span></div><div class="import-preview-metrics"><span>将新增 <b>${whole(preview.summary?.added_orders)}</b> 单</span><span>跳过重复 <b>${whole(preview.summary?.duplicate_orders)}</b> 单</span><span>支付金额 <b>${money(preview.summary?.pay_amt)}</b></span><span>商品件数 <b>${whole(preview.summary?.pay_item_cnt)}</b></span></div><ul class="import-file-list">${(preview.files || []).map((file) => `<li><span>${escapeHtml(file.source_label)} · ${escapeHtml(file.file_name)}</span><small>${file.known_file ? "文件已导入" : `新增 ${whole(file.added_orders)} 单，跳过 ${whole(file.duplicate_orders)} 单`}</small></li>`).join("")}</ul><div class="status-actions"><button class="button button-primary" type="button" data-commit-order-import ${preview.summary?.added_orders ? "" : "disabled"}>确认写入看板</button><button class="button" type="button" data-cancel-order-preview>取消</button></div><p class="import-help">确认后只保存日汇总与不可逆订单指纹，用于防止重复导入；上传的 Excel 会立即删除。</p></div>` : "";
    const history = batches.length ? `<div class="import-history"><div class="import-history-head"><strong>导入历史</strong><span>累计 ${whole(summary.orders)} 单 · ${money(summary.pay_amt)}</span></div>${batches.map((batch) => `<div class="import-history-row"><div><strong>${escapeHtml((batch.source_labels || []).join("、"))}</strong><span>${escapeHtml(importTime(batch.created_at))} · ${escapeHtml(importDateRange(batch.date_range))} · 新增 ${whole(batch.added_orders)} 单</span></div>${isAdmin() ? `<button class="text-button import-delete" type="button" data-delete-order-import="${escapeHtml(batch.id)}">撤销</button>` : ""}</div>`).join("")}</div>` : `<p class="import-help">暂无线上导入批次。${isAdmin() ? "可上传喵速达、天猫订单明细；" : ""}抖店罗盘继续由现有采集任务更新。</p>`;
    const uploadForm = isAdmin() ? `<form id="order-upload-form" class="order-upload-form"><label class="file-picker"><span>选择订单明细（.xlsx，可多选）</span><input id="order-upload-files" type="file" name="files" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple required /></label><button class="button" type="submit">解析并预览</button></form>` : `<p class="import-help">当前为只读账户，可查看导入历史，不能上传或撤销订单数据。</p>`;
    target.innerHTML = `<details class="panel order-import-panel"><summary><span>订单数据导入</span><small>${isAdmin() ? "上传 Excel → 预览去重 → 确认写入" : "导入历史（只读）"}</small></summary><div class="order-import-body">${uploadForm}${message}${previewBlock}${history}<p class="import-help">同一文件按指纹跳过；可匹配的相同订单按不可逆指纹跳过。订单号、买家、地址与原始文件不会保存。</p></div></details>`;
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
function channelSelectedRecords() {
    const records = state.channel?.records || [];
    return records.filter((record) => (!state.channelDate || record.date === state.channelDate) && (!state.channelShop || record.shop_name === state.channelShop));
}
function channelGroup(records, key) {
    let value = 0, weightedRatio = 0, weight = 0, available = 0;
    records.forEach((record) => {
        const group = record.traffic?.groups?.[key];
        if (!group)
            return;
        available += 1;
        value += number(group?.value);
        if (hasValue(group?.ratio)) {
            const currentWeight = Math.max(number(record.traffic?.source_total), 1);
            weightedRatio += number(group.ratio) * currentWeight;
            weight += currentWeight;
        }
    });
    return { value: available ? value : null, ratio: weight ? weightedRatio / weight : null };
}
function channelFilters(records) {
    const allRecords = state.channel?.records || [];
    const dates = [...new Set(allRecords.map((record) => record.date))].sort().reverse();
    const shops = [...new Set(allRecords.map((record) => record.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const options = (items, selected, allLabel) => `<option value="">${allLabel}</option>${items.map((item) => `<option value="${escapeHtml(item)}" ${selected === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}`;
    return `<section class="table-filter-panel channel-filter" aria-label="渠道筛选"><div><strong>渠道筛选</strong><span>当前展示 ${whole(records.length)} 条店铺日数据</span></div><label>业务日期<select data-channel-filter="date">${options(dates, state.channelDate, "全部日期")}</select></label><label>店铺<select data-channel-filter="shop">${options(shops, state.channelShop, "全部店铺")}</select></label></section>`;
}
function simpleTable(headers, rows, empty = "暂无数据") {
    const body = rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}">${escapeHtml(empty)}</td></tr>`;
    return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function channelTrendRecords(records) {
    return records.map((record) => ({
        date: record.date,
        shop_name: record.shop_name,
        metrics: {
            organic_search: number(record.traffic?.groups?.organic_search?.value),
            recommendation: number(record.traffic?.groups?.recommendation?.value),
        },
    }));
}
function renderChannel() {
    const target = $("#channel-content");
    const allRecords = state.channel?.records || [];
    if (!target)
        return;
    if (!allRecords.length) {
        $("#channel-summary").textContent = "尚未生成渠道接口采集数据。";
        target.innerHTML = `<div class="empty-panel"><strong>等待首次渠道采集</strong><span>下一次罗盘采集将同时读取看流量、看商品和看搜索。</span></div>`;
        return;
    }
    if (!state.channelDate)
        state.channelDate = [...new Set(allRecords.map((record) => record.date))].sort().at(-1) || "";
    const records = channelSelectedRecords();
    if (!records.length) {
        target.innerHTML = `${channelFilters(records)}<div class="empty-panel"><strong>当前筛选没有渠道数据</strong><span>请选择其他日期或店铺。</span></div>`;
        bindChannelFilters();
        return;
    }
    const organic = channelGroup(records, "organic_search");
    const recommendation = channelGroup(records, "recommendation");
    const paid = channelGroup(records, "paid");
    const shortVideoViews = records.reduce((sum, record) => sum + number(record.traffic?.carriers?.short_video?.watch_ucnt || record.traffic?.groups?.short_video?.value), 0);
    const shortVideoPay = records.reduce((sum, record) => sum + number(record.traffic?.carriers?.short_video?.pay_amt), 0);
    const cards = [
        ["自然搜索曝光", wholeOrDash(organic.value), `商品卡来源占比 ${ratioOrDash(organic.ratio)}`],
        ["推荐流量曝光", wholeOrDash(recommendation.value), `猜你喜欢/推荐页占比 ${ratioOrDash(recommendation.ratio)}`],
        ["广告流量曝光", wholeOrDash(paid.value), `投放渠道占比 ${ratioOrDash(paid.ratio)}`],
        ["短视频观看", whole(shortVideoViews), `短视频支付 ${money(shortVideoPay)}`],
    ];
    const cardHtml = `<div class="metric-grid four">${cards.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("")}</div>`;
    const sourceMap = new Map();
    records.forEach((record) => (record.traffic?.sources || []).forEach((source) => {
        if (source.parent === null)
            return;
        const current = sourceMap.get(source.name) || { name: source.name, value: 0, weightedRatio: 0, weight: 0 };
        const currentWeight = Math.max(number(record.traffic?.source_total), 1);
        current.value += number(source.value);
        current.weightedRatio += number(source.source_ratio) * currentWeight;
        current.weight += currentWeight;
        sourceMap.set(source.name, current);
    }));
    const sourceRows = [...sourceMap.values()].sort((a, b) => b.value - a.value).map((source) => [escapeHtml(source.name), whole(source.value), ratioOrDash(source.weight ? source.weightedRatio / source.weight : null)]);
    const productRows = records.flatMap((record) => (record.products || []).map((product) => ({ ...product, shop_name: record.shop_name })))
        .sort((a, b) => number(b.pay_amt) - number(a.pay_amt) || number(b.show_ucnt) - number(a.show_ucnt))
        .slice(0, 30)
        .map((product) => [escapeHtml(product.shop_name), `<span class="table-primary">${escapeHtml(product.product_name || product.product_id)}</span><small>${escapeHtml(product.product_id)}</small>`, moneyOrDash(product.pay_amt), wholeOrDash(product.show_ucnt), wholeOrDash(product.click_ucnt), ratioOrDash(product.click_rate), ratioOrDash(product.click_pay_rate), ratioOrDash(product.show_ucnt_change)]);
    const searchSourceRows = records.flatMap((record) => (record.search?.sources || []).map((source) => ({ ...source, shop_name: record.shop_name })))
        .map((source) => [escapeHtml(source.shop_name), escapeHtml(source.name), wholeOrDash(source.show_ucnt), ratioOrDash(source.show_ucnt_change), moneyOrDash(source.pay_amt), moneyOrDash(source.pay_amt_benchmark)]);
    const searchTermRows = records.flatMap((record) => (record.search?.shop_terms || []).map((term) => ({ ...term, shop_name: record.shop_name })))
        .sort((a, b) => number(a.rank) - number(b.rank))
        .map((term) => [escapeHtml(term.shop_name), wholeOrDash(term.rank), escapeHtml(term.word), wholeOrDash(term.show_ucnt), ratioOrDash(term.show_ucnt_change), moneyOrDash(term.pay_amt)]);
    const periods = [...new Set(records.map((record) => {
            const period = record.search?.period || {};
            return period.begin_date && period.end_date ? `${period.begin_date} 至 ${period.end_date}` : "";
        }).filter(Boolean))];
    $("#channel-summary").textContent = `最新业务日期：${state.channelDate || "—"} · ${new Set(records.map((record) => record.shop_name)).size} 家店铺 · 搜索口径：${periods.join("、") || "暂无"}`;
    const trendSource = channelTrendRecords(allRecords.filter((record) => !state.channelShop || record.shop_name === state.channelShop));
    const charts = `<div class="chart-grid"><div class="chart-stack">${lineChart(trendSource, "organic_search", "自然搜索曝光趋势")}${lineChart(trendSource, "recommendation", "推荐流量曝光趋势")}</div><div class="chart-stack"><section class="panel"><div class="panel-head"><div><h3>商品卡流量来源</h3><span>按罗盘商品曝光人数口径</span></div></div>${simpleTable(["来源", "曝光人数", "占比"], sourceRows)}</section><section class="panel operations-note"><h3>渠道口径</h3><p>自然搜索对应“非投放时段-搜索”；推荐流量包含“猜你喜欢”和“顶Tab推荐”；广告流量包含全域投广及标准/品牌投放。</p><p>搜索模块采用罗盘独立周口径，日期可能晚于经营数据更新。</p></section></div></div>`;
    const details = `<div class="detail-table-stack"><details class="detail-table-disclosure" open><summary><span>商品表现</span><small>商品卡TOP商品 · ${whole(productRows.length)} 条</small></summary><div class="detail-table-content">${simpleTable(["店铺", "商品", "支付金额", "曝光", "点击", "点击率", "点击成交率", "曝光变化"], productRows)}</div></details><details class="detail-table-disclosure"><summary><span>搜索渠道</span><small>商品卡、直播、短视频与图文搜索</small></summary><div class="detail-table-content">${simpleTable(["店铺", "搜索渠道", "曝光人数", "环比", "支付金额", "同行基准"], searchSourceRows)}</div></details><details class="detail-table-disclosure"><summary><span>本店搜索词</span><small>罗盘搜索周报TOP词</small></summary><div class="detail-table-content">${simpleTable(["店铺", "排名", "搜索词", "曝光人数", "环比", "支付金额"], searchTermRows)}</div></details></div>`;
    target.innerHTML = `${channelFilters(records)}${cardHtml}${charts}${details}`;
    bindChannelFilters();
    bindLineChartHover(trendSource);
}
function bindChannelFilters() {
    $$('[data-channel-filter]').forEach((select) => select.addEventListener("change", () => {
        if (select.dataset.channelFilter === "date")
            state.channelDate = select.value;
        else
            state.channelShop = select.value;
        renderChannel();
    }));
}
async function loadChannel() {
    const response = await fetch("/api/channel");
    if (response.status === 401)
        return showLogin();
    const payload = await response.json().catch(() => ({}));
    state.channel = response.ok ? payload : { records: [] };
    renderChannel();
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
function settlementGroupTable(title, groups) {
    const rows = [...(groups || [])]
        .sort((a, b) => number(b.settlement_amount) - number(a.settlement_amount))
        .map((item) => `<tr><td>${escapeHtml(item.name || "未标注")}</td><td>${settlementMoney(item.settlement_amount)}</td><td>${settlementMoney(item.income_total)}</td><td>${settlementMoney(item.expense_total)}</td><td>${whole(item.order_count)}</td><td>${whole(item.row_count)}</td></tr>`)
        .join("");
    return `<section class="panel"><div class="panel-head"><div><h3>${title}</h3><span>按结算金额排序</span></div></div><div class="table-wrap"><table><thead><tr><th>维度</th><th>结算金额</th><th>收入合计</th><th>支出合计</th><th>订单数</th><th>明细行</th></tr></thead><tbody>${rows || `<tr><td colspan="6">暂无结算数据</td></tr>`}</tbody></table></div></section>`;
}
function settlementShopFilter(payload) {
    const shops = payload.shops || [];
    const selected = payload.selected_shop || state.settlementShop || "";
    const options = `<option value="">全部店铺</option>${shops.map((name) => `<option value="${escapeHtml(name)}" ${selected === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
    return `<section class="table-filter-panel" aria-label="结算筛选"><div><strong>结算筛选</strong><span>按结算 CSV 对应店铺重算汇总与明细</span></div><label>店铺<select data-settlement-filter="shop">${options}</select></label></section>`;
}
function settlementUploadPanel() {
    if (!isAdmin())
        return "";
    const message = state.settlementUploadMessage ? `<p class="order-import-message">${escapeHtml(state.settlementUploadMessage)}</p>` : "";
    const defaultShop = state.settlementShop || "";
    return `<details class="panel order-import-panel"><summary><span>结算 CSV 导入</span><small>填写店铺 → 上传 CSV → 自动刷新</small></summary><div class="order-import-body"><form id="settlement-upload-form" class="order-upload-form"><label>店铺名称<input name="shop_name" value="${escapeHtml(defaultShop)}" required /></label><label class="file-picker"><span>选择结算 CSV</span><input id="settlement-upload-file" type="file" name="file" accept=".csv,text/csv" required /></label><button class="button" type="submit">上传并解析</button></form>${message}<p class="import-help">上传后文件保存在服务器 <code>output/settlement/</code>，店铺名会保存为本地映射，用于后续筛选与汇总。</p></div></details>`;
}
function settlementDetailTable(rows) {
    const body = [...(rows || [])].map((item) => {
        const governmentSubsidy = number(item.government_merchant) + number(item.government_platform);
        const cells = [
            item.shop_name,
            item.settlement_time || item.settlement_date,
            item.order_id,
            item.product_name,
            item.business_type,
            settlementMoneyOrDash(item.settlement_amount),
            settlementMoneyOrDash(item.user_paid),
            settlementMoneyOrDash(item.income_total),
            settlementMoneyOrDash(item.expense_total),
            settlementMoneyOrDash(item.service_fee),
            settlementMoney(governmentSubsidy),
        ];
        return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
    }).join("");
    return `<details class="detail-table-disclosure" open><summary><span>结算明细</span><small>最多显示前 ${whole(rows?.length || 0)} 条</small></summary><div class="detail-table-content"><div class="table-wrap"><table><thead><tr><th>店铺</th><th>结算时间</th><th>订单号</th><th>商品</th><th>业务类型</th><th>结算金额</th><th>用户实付</th><th>收入合计</th><th>支出合计</th><th>平台服务费</th><th>政府补贴</th></tr></thead><tbody>${body || `<tr><td colspan="11">暂无结算明细</td></tr>`}</tbody></table></div></div></details>`;
}
function renderSettlement(payload) {
    state.settlement = payload;
    state.settlementShop = payload.selected_shop || "";
    const summary = payload.summary || {};
    const fileNames = (payload.files || []).map((file) => file.name).filter(Boolean);
    const governmentSubsidy = number(summary.government_merchant) + number(summary.government_platform);
    const metrics = [
        ["结算净额", settlementMoney(summary.settlement_amount), `明细行：${whole(summary.row_count)}`],
        ["收入合计", settlementMoney(summary.income_total), `用户实付：${settlementMoney(summary.user_paid)}`],
        ["支出合计", settlementMoney(summary.expense_total), `平台服务费：${settlementMoney(summary.service_fee)}`],
        ["订单数", whole(summary.order_count), "按订单号去重"],
        ["平台补贴", settlementMoney(summary.platform_subsidy), "平台、其他平台与运费补贴"],
        ["政府补贴", settlementMoney(governmentSubsidy), "商家垫资 + 平台垫资"],
    ];
    $("#settlement-summary-cards").innerHTML = metrics.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("");
    $("#settlement-content").innerHTML = summary.row_count
        ? `${settlementUploadPanel()}${settlementShopFilter(payload)}<section class="panel operations-note"><h3>数据来源</h3><p>读取服务器本地 <code>output/settlement/</code> 目录下的抖音结算 CSV；金额按 CSV 原始元单位展示，不做分转元转换。</p><p>已读取文件：${escapeHtml(fileNames.join("、") || "—")}</p></section><div class="chart-grid"><div class="chart-stack">${settlementGroupTable("按结算月份", payload.months)}${settlementGroupTable("按店铺", payload.shop_groups)}</div><div class="chart-stack">${settlementGroupTable("按商户主体", payload.subjects)}${settlementGroupTable("按业务类型", payload.business_types)}</div></div>${settlementDetailTable(payload.rows)}`
        : `${settlementUploadPanel()}${settlementShopFilter(payload)}<div class="empty-panel"><strong>暂无结算数据</strong><span>请上传结算 CSV 或把文件放入服务器 output/settlement/ 目录后刷新页面。</span></div>`;
    $("#settlement-upload-form")?.addEventListener("submit", uploadSettlement);
    $('[data-settlement-filter="shop"]')?.addEventListener("change", (event) => {
        state.settlementShop = event.currentTarget.value;
        loadSettlement();
        loadChannel();
    });
}
async function uploadSettlement(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $("button", form);
    const data = new FormData(form);
    const uploadFile = data.get("file");
    const shopName = String(data.get("shop_name") || "").trim();
    if (!(uploadFile instanceof File) || !shopName) {
        state.settlementUploadMessage = "请选择结算 CSV 并填写店铺名称。";
        if (state.settlement)
            renderSettlement(state.settlement);
        return;
    }
    button.disabled = true;
    button.textContent = "正在上传…";
    state.settlementUploadMessage = "";
    const content = await uploadFile.text();
    const response = await fetch("/api/settlement/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop_name: shopName, file_name: uploadFile.name, content }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        state.settlementUploadMessage = response.status === 413
            ? "结算 CSV 超过 32MB 上传上限，请拆分文件后重试。"
            : payload.error || "结算 CSV 上传失败，请检查文件格式。";
        if (state.settlement)
            renderSettlement(state.settlement);
        return;
    }
    const uploaded = payload.upload?.file || {};
    state.settlementShop = uploaded.shop_name || state.settlementShop;
    state.settlementUploadMessage = `已导入 ${uploaded.original_name || uploaded.name || "结算 CSV"}，解析 ${whole(uploaded.rows)} 行。`;
    renderSettlement(payload.dashboard || state.settlement || {});
}
async function loadSettlement() {
    const target = $("#settlement-content");
    try {
        const query = state.settlementShop ? `?shop=${encodeURIComponent(state.settlementShop)}` : "";
        const response = await fetch(`/api/settlement${query}`);
        if (response.status === 401)
            return showLogin();
        const payload = await response.json();
        if (!response.ok)
            throw new Error(payload.error || "结算数据不可用");
        renderSettlement(payload);
    }
    catch (error) {
        target.innerHTML = `<div class="empty-panel"><strong>结算数据暂不可用</strong><span>${escapeHtml(error.message || "请检查 Rust API 与 output/settlement 目录")}</span></div>`;
    }
}
function statusTerminal(status, logMessage) {
    if (typeof status.terminal_output === "string" && status.terminal_output) {
        const lineCount = status.terminal_output.split("\n").length;
        return `<div class="status-log"><div class="status-log-head"><span>采集终端输出</span><small>最近 ${escapeHtml(String(lineCount))} 行</small></div><pre>${escapeHtml(status.terminal_output)}</pre></div>`;
    }
    return `<p class="status-log-empty">${escapeHtml(logMessage || "当前还没有采集终端输出。")}</p>`;
}
function collectionModuleCard(name, title, description, status) {
    const result = status.modules?.[name] || {};
    const selected = state.collectionModules.has(name);
    const finished = number(result.success_count) + number(result.error_count);
    const resultLabel = finished
        ? `${whole(result.success_count)} 个成功 · ${whole(result.error_count)} 个异常`
        : "等待下一次采集";
    return `<label class="collection-module ${selected ? "selected" : ""}">
    <input type="checkbox" data-collection-module="${name}" ${selected ? "checked" : ""} ${isAdmin() ? "" : "disabled"} />
    <span class="collection-module-check">${selected ? "✓" : ""}</span>
    <span class="collection-module-copy"><strong>${title}</strong><small>${description}</small><em>${resultLabel}</em></span>
  </label>`;
}
function collectionStateLabel(status) {
    const labels = { unknown: "等待首次运行", manual_requested: "请求已排队", waiting_random: "等待启动", running: "采集中", success: "采集成功", partial_success: "部分成功", failed: "采集失败", skipped: "已跳过" };
    return labels[status.state] || status.state || "未知";
}
function renderCollectionCenter(status, { logMessage = "" } = {}) {
    const slot = $("#collection-center");
    if (!slot)
        return;
    state.status = status;
    const online = Boolean(status.collector_online);
    const busy = Boolean(status.job_running || status.request_pending) || ["manual_requested", "waiting_random", "running"].includes(status.state);
    const health = online ? "采集服务在线" : "采集服务离线";
    const request = status.request_pending ? "有任务等待或执行中" : "队列为空";
    const feedback = state.collectionMessage ? `<p class="collection-feedback">${escapeHtml(state.collectionMessage)}</p>` : "";
    const permission = isAdmin() ? "选择本次要更新的数据；模块异常互不影响。" : "当前账户为只读权限，可查看状态但不能提交任务。";
    slot.innerHTML = `${feedback}
    <div class="collection-health-grid">
      <article class="collection-health"><span class="health-indicator ${online ? "online" : "offline"}"></span><small>服务状态</small><strong>${health}</strong></article>
      <article class="collection-health"><small>任务状态</small><strong>${escapeHtml(collectionStateLabel(status))}</strong><span>${escapeHtml(status.message || "暂无采集记录")}</span></article>
      <article class="collection-health"><small>任务队列</small><strong>${request}</strong><span>最近成功：${escapeHtml(status.last_success_at || "—")}</span></article>
    </div>
    <section class="panel collection-control"><div class="panel-head"><div><h3>手动采集</h3><span>${permission}</span></div></div>
      <div class="collection-modules">
        ${collectionModuleCard("operations", "经营数据", "成交、退款、客单价及转化等近 1 天指标", status)}
        ${collectionModuleCard("channel", "渠道数据", "看流量、看商品和看搜索的渠道洞察", status)}
      </div>
      <div class="status-actions">
        ${isAdmin() ? `<button id="collection-run-button" class="button button-primary" ${busy || !online ? "disabled" : ""}>${busy ? "采集任务进行中" : online ? "开始采集所选模块" : "采集服务离线"}</button>` : ""}
        <a class="button" href="${escapeHtml(status.novnc_url || "#")}" target="_blank" rel="noreferrer">打开远程浏览器</a>
      </div>
    </section>
    <details class="panel status-panel" open><summary>采集终端与诊断</summary><div class="status-body">
      <p>状态更新时间：${escapeHtml(status.updated_at || "—")} · 请求模块：${escapeHtml((status.requested_modules || []).join("、") || "—")}</p>
      ${status.last_error ? `<p class="collection-error">${escapeHtml(status.last_error)}</p>` : ""}
      ${statusTerminal(status, logMessage)}
    </div></details>`;
    $$('[data-collection-module]', slot).forEach((input) => input.addEventListener("change", () => {
        if (input.checked)
            state.collectionModules.add(input.dataset.collectionModule);
        else
            state.collectionModules.delete(input.dataset.collectionModule);
        renderCollectionCenter(state.status || {});
    }));
    $("#collection-run-button")?.addEventListener("click", startCollection);
}
async function refreshCollectionStatus() {
    window.clearTimeout(statusRefreshTimer);
    try {
        const response = await fetch("/api/collection/status", { cache: "no-store" });
        if (response.status === 401)
            return showLogin();
        if (!response.ok)
            throw new Error("status unavailable");
        const status = await response.json();
        renderCollectionCenter(status);
        const busy = Boolean(status.job_running || status.request_pending) || ["manual_requested", "waiting_random", "running"].includes(status.state);
        if (state.page === "collection")
            statusRefreshTimer = window.setTimeout(refreshCollectionStatus, busy ? 5000 : 15000);
    }
    catch {
        if (state.status)
            renderCollectionCenter(state.status, { logMessage: "暂时无法读取采集服务状态，请稍后重试。" });
    }
}
async function startCollection() {
    const button = $("#collection-run-button");
    const modules = [...state.collectionModules];
    if (!modules.length) {
        state.collectionMessage = "请至少选择一个采集模块。";
        renderCollectionCenter(state.status || {});
        return;
    }
    button.disabled = true;
    button.textContent = "正在提交…";
    const response = await fetch("/api/collection/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modules }) });
    const payload = await response.json().catch(() => ({}));
    state.collectionMessage = payload.message || payload.error || (response.ok ? "请求已发送" : "提交失败");
    if (payload.status)
        renderCollectionCenter(payload.status);
    window.setTimeout(refreshCollectionStatus, 700);
}
async function loadCompass() {
    const response = await fetch("/api/compass");
    if (response.status === 401)
        return showLogin();
    const payload = await response.json();
    state.records = payload.records || [];
    state.operationDates = new Set(state.records.map((item) => item.date));
    state.operationShops = new Set(state.records.map((item) => item.shop_name));
    state.operationSources = new Set(state.records.map(recordSourceLabel));
    renderOperations();
}
function renderAccount() {
    const target = $("#account-content");
    if (!target || !state.currentUser)
        return;
    const message = state.accountMessage ? `<p class="order-import-message">${escapeHtml(state.accountMessage)}</p>` : "";
    const passwordPanel = `<section class="panel account-panel"><div class="panel-head"><div><h3>修改密码</h3><span>更新后其他设备上的登录会话将失效</span></div></div><form id="password-change-form" class="account-form"><label>当前密码<input name="current_password" type="password" autocomplete="current-password" required /></label><label>新密码<input name="new_password" type="password" autocomplete="new-password" minlength="12" required /></label><button class="button button-primary" type="submit">更新密码</button></form></section>`;
    const userRows = state.users.map((user) => `<div class="user-row"><div><strong>${escapeHtml(user.username)}</strong><span>${user.role === "admin" ? "管理员" : "只读用户"} · 创建于 ${escapeHtml(importTime(user.created_at))}</span></div>${user.username === state.currentUser?.username ? `<small>当前账户</small>` : `<button class="text-button import-delete" type="button" data-delete-user="${escapeHtml(user.username)}">删除</button>`}</div>`).join("");
    const adminPanel = isAdmin() ? `<section class="panel account-panel"><div class="panel-head"><div><h3>用户管理</h3><span>管理员可新增账户；viewer 只能读取看板</span></div></div><form id="user-create-form" class="account-form account-form-user"><label>用户名<input name="username" maxlength="64" required /></label><label>初始密码<input name="password" type="password" autocomplete="new-password" minlength="12" required /></label><label>角色<select name="role"><option value="viewer">viewer · 只读</option><option value="admin">admin · 管理员</option></select></label><button class="button" type="submit">新增用户</button></form><div class="user-list">${userRows || `<p class="import-help">正在读取用户列表…</p>`}</div></section>` : `<section class="panel account-panel"><div class="panel-head"><div><h3>账户权限</h3><span>viewer · 只读</span></div></div><p class="import-help">你可以查看经营、库存和结算数据；上传、撤销、补采及用户管理由管理员执行。</p></section>`;
    target.innerHTML = `${message}<div class="account-grid">${passwordPanel}${adminPanel}</div>`;
    $("#password-change-form")?.addEventListener("submit", changePassword);
    $("#user-create-form")?.addEventListener("submit", createUser);
    $$('[data-delete-user]').forEach((button) => button.addEventListener("click", () => deleteUser(button.dataset.deleteUser)));
}
async function loadUsers() {
    if (!isAdmin())
        return;
    const response = await fetch("/api/users");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        state.accountMessage = payload.error || "用户列表读取失败。";
    }
    else {
        state.users = payload.users || [];
    }
    renderAccount();
}
async function changePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetch("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const payload = await response.json().catch(() => ({}));
    state.accountMessage = response.ok ? (payload.message || "密码已更新。") : (payload.error || "密码更新失败。");
    if (response.ok)
        form.reset();
    renderAccount();
}
async function createUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const payload = await response.json().catch(() => ({}));
    state.accountMessage = response.ok ? `已新增用户 ${payload.user?.username || ""}。` : (payload.error || "新增用户失败。");
    if (response.ok)
        form.reset();
    await loadUsers();
}
async function deleteUser(username) {
    if (!username || !window.confirm(`确定删除用户“${username}”吗？该用户的登录会话会立即失效。`))
        return;
    const response = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    state.accountMessage = response.ok ? `已删除用户 ${payload.deleted || username}。` : (payload.error || "删除用户失败。");
    await loadUsers();
}
function showLogin() {
    state.currentUser = null;
    state.users = [];
    state.accountMessage = "";
    state.orderPreview = null;
    $("#login-layer").classList.remove("hidden");
    $("#app-shell").classList.add("hidden");
}
function showApp(user) {
    state.currentUser = { username: user.username, role: user.role };
    $("#login-layer").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    $("#account-name").textContent = `${user.username} · ${user.role === "admin" ? "管理员" : "只读"}`;
    renderAccount();
    if (isAdmin())
        loadUsers();
}
async function initialise() {
    buildPlaceholders();
    const desired = location.hash.slice(1);
    activatePage(["inventory", "operations", "settlement", "channel", "collection", "account"].includes(desired) ? desired : "operations");
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
        loadSettlement();
        loadChannel();
        refreshCollectionStatus();
    });
    const me = await fetch("/api/me").then((response) => response.json());
    if (me.authenticated) {
        showApp(me);
        loadCompass();
        loadOrderImports();
        loadInventory();
        loadSettlement();
        loadChannel();
        refreshCollectionStatus();
    }
    else
        showLogin();
}
initialise();
