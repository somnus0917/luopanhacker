const COLLECTION_SHOPS = ["华硕凡飞笔记本电脑专卖店", "惠普办公设备旗舰店", "HYPERX极度未知凡飞专卖店", "acer宏碁凡飞专卖店"];
const localDateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const currentLocalMonthStart = () => {
    const date = new Date();
    date.setDate(1);
    return localDateValue(date);
};
const previousLocalDate = () => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return localDateValue(date);
};
const latestBackfillDate = () => previousLocalDate() >= currentLocalMonthStart() ? previousLocalDate() : "";
const backfillDateAllowed = (value) => Boolean(value && value >= currentLocalMonthStart() && value <= previousLocalDate());
const state = { currentUser: null, users: [], accountMessage: "", records: [], operationDates: new Set(), operationPlatforms: new Set(), operationShops: new Set(), operationSources: new Set(), operationFilterOpen: new Set(), operationCalendarOpen: false, operationCalendarCursor: "", operationCalendarRangeStart: "", tablePlatform: "", tableShop: "", operationSection: "overview", status: null, collectionModules: new Set(["operations", "channel"]), collectionBackfillDate: latestBackfillDate(), collectionBackfillShops: new Set(COLLECTION_SHOPS), collectionMessage: "", page: "operations", inventory: null, inventoryView: "overview", inventoryWarehouse: "", inventoryBrand: "", inventorySortKey: "", inventorySortDir: "desc", settlement: null, settlementShop: "", settlementUploadMessage: "", orderImports: { batches: [], summary: {} }, orderPreview: null, orderImportMessage: "", channel: null };
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
function canonicalOperationRecord(item) {
    if (item.source_key === "miaosuda" || item.shop_name === "羚稀官方旗舰店") {
        return { ...item, shop_name: "喵速达" };
    }
    return item;
}
function recordPlatform(item) {
    const explicit = item.platform || item.channel || item.content?.platform;
    if (explicit)
        return String(explicit);
    if (item.source !== "external_orders")
        return "抖音";
    const source = `${item.source_key || ""} ${item.source_label || ""} ${item.shop_name || ""}`.toLowerCase();
    if (/(jingdong|\bjd\b|京东)/.test(source))
        return "京东";
    if (/(pinduoduo|\bpdd\b|拼多多)/.test(source))
        return "拼多多";
    if (/(tmall|taobao|天猫|喵速达|优品|国际)/.test(source))
        return "天猫";
    return "其他";
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
    const sumKeys = ["income_amt", "pay_amt", "settlement_amt_pay_time", "pay_cnt", "pay_ucnt", "refund_amt", "refund_order_cnt", "refund_order_cnt_pay_time", "platform_subsidy_amt", "talent_subsidy_amt", "pay_item_cnt", "product_show_ucnt", "product_click_ucnt", "product_show_cnt", "product_click_cnt", "expense_amt", "ad_cost_amt"];
    sumKeys.forEach((key) => totals[key] = records.reduce((sum, item) => sum + number(item.metrics?.[key]), 0));
    totals.per_usr_pay_amt = totals.pay_ucnt ? totals.pay_amt / totals.pay_ucnt : 0;
    const weightedRefundRate = records.reduce((sum, item) => sum + number(item.metrics?.income_amt) * number(item.metrics?.refund_amt_rate), 0);
    totals.refund_amt_rate = totals.refund_amt && totals.income_amt ? totals.refund_amt / totals.income_amt : totals.income_amt ? weightedRefundRate / totals.income_amt : 0;
    totals.product_click_pay_ucnt_ratio = totals.product_click_ucnt ? totals.pay_ucnt / totals.product_click_ucnt : 0;
    return totals;
}
function previousPeriodDates(selectedDates, allDates) {
    const sorted = [...selectedDates].sort();
    if (!sorted.length)
        return new Set();
    const span = sorted.length;
    const earliestIndex = allDates.indexOf(sorted[0]);
    const prevSlice = allDates.slice(Math.max(0, earliestIndex - span), earliestIndex);
    return new Set(prevSlice);
}
function deltaNote(current, previous, formatter = whole) {
    if (!previous)
        return "环比：无上期数据";
    const change = (current - previous) / previous;
    const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
    return `${arrow} ${Math.abs(change * 100).toFixed(1)}% 环比 ${formatter(previous)}`;
}
function deltaTrend(current, previous) {
    if (!previous)
        return "";
    return current > previous ? "up" : current < previous ? "down" : "";
}
function sortRows(rows, key, dir) {
    if (!key)
        return rows;
    return [...rows].sort((a, b) => {
        const av = number(a[key]), bv = number(b[key]);
        return dir === "asc" ? av - bv : bv - av;
    });
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
    return state.records.filter((item) => state.operationDates.has(item.date) && state.operationPlatforms.has(recordPlatform(item)) && state.operationShops.has(item.shop_name) && state.operationSources.has(recordSourceLabel(item)));
}
function operationFilterSet(kind) {
    return kind === "date" ? state.operationDates : kind === "platform" ? state.operationPlatforms : kind === "shop" ? state.operationShops : state.operationSources;
}
function operationFilterItems(kind, records = state.records) {
    const channelRecords = state.channel?.records || [];
    if (kind === "date")
        return [...new Set([...records.map((item) => item.date), ...channelRecords.map((item) => item.date)])].sort((a, b) => b.localeCompare(a));
    if (kind === "platform")
        return [...new Set([...records.map(recordPlatform), ...(channelRecords.length ? ["抖音"] : [])])].sort((a, b) => a.localeCompare(b, "zh-CN"));
    if (kind === "shop") {
        const operationShops = records.filter((item) => state.operationPlatforms.has(recordPlatform(item))).map((item) => item.shop_name);
        const channelShops = state.operationPlatforms.has("抖音") ? channelRecords.map((item) => item.shop_name) : [];
        return [...new Set([...operationShops, ...channelShops])].sort((a, b) => a.localeCompare(b, "zh-CN"));
    }
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
    if (kind === "platform")
        resetOperationShopsForPlatforms();
}
function resetOperationShopsForPlatforms() {
    state.operationShops.clear();
    operationFilterItems("shop").forEach((item) => state.operationShops.add(item));
}
function operationsFiltersMarkup() {
    const dates = operationFilterItems("date");
    const platforms = operationFilterItems("platform");
    const shops = operationFilterItems("shop");
    const sources = operationFilterItems("source");
    const openAttr = (kind) => state.operationFilterOpen.has(kind) ? " open" : "";
    const buildGroup = (title, items, selected, kind) => `<details class="filter-disclosure" data-filter-kind="${kind}"${openAttr(kind)}><summary><span>${title}</span><small>已选择 ${selected.size} 个</small></summary><div class="chip-list">${items.map((item) => `<button class="chip ${selected.has(item) ? "selected" : ""}" type="button" data-operation-filter="${kind}" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div></details>`;
    const buildDropdown = (title, items, selected, kind) => `<details class="filter-disclosure filter-dropdown" data-filter-kind="${kind}"${openAttr(kind)}><summary><span>${title}</span><small>已选择 ${selected.size} 个</small></summary><div class="dropdown-panel"><div class="dropdown-actions"><button type="button" class="dropdown-action" data-operation-select-all="${kind}">全选</button><button type="button" class="dropdown-action" data-operation-clear="${kind}">仅保留一个</button></div><div class="dropdown-list">${items.map((item) => `<label class="dropdown-option"><input type="checkbox" data-operation-filter="${kind}" data-value="${escapeHtml(item)}" ${selected.has(item) ? "checked" : ""}><span>${escapeHtml(item)}</span></label>`).join("")}</div></div></details>`;
    return `<div class="filter-accordion">${buildGroup("业务日期", dates, state.operationDates, "date")}${buildGroup("平台", platforms, state.operationPlatforms, "platform")}${buildDropdown("店铺", shops, state.operationShops, "shop")}${buildGroup("数据来源", sources, state.operationSources, "source")}</div>`;
}
function bindOperationsFilterEvents() {
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
        if (control.dataset.operationFilter === "platform")
            resetOperationShopsForPlatforms();
        renderOperations();
    }));
    $$('[data-operation-select-all]').forEach((button) => button.addEventListener("click", () => {
        const kind = button.dataset.operationSelectAll;
        const items = operationFilterItems(kind);
        const selected = operationFilterSet(kind);
        items.forEach((item) => selected.add(item));
        if (kind === "platform")
            resetOperationShopsForPlatforms();
        renderOperations();
    }));
    $$('[data-operation-clear]').forEach((button) => button.addEventListener("click", () => {
        const kind = button.dataset.operationClear;
        const items = operationFilterItems(kind);
        const selected = operationFilterSet(kind);
        selected.clear();
        if (items.length)
            selected.add(items[0]);
        if (kind === "platform")
            resetOperationShopsForPlatforms();
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
    target.classList.toggle("hidden", state.operationSection !== "sales");
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
function calendarDate(year, month, day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function calendarMonthStart(value) {
    const [year, month] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 1));
}
function shiftCalendarMonth(value, amount) {
    const cursor = calendarMonthStart(value);
    cursor.setUTCMonth(cursor.getUTCMonth() + amount);
    return calendarDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
}
function selectedDateBounds() {
    const dates = [...state.operationDates].sort();
    return { start: dates[0] || "", end: dates.at(-1) || "" };
}
function operationDateLabel() {
    const available = operationFilterItems("date");
    const selected = [...state.operationDates].sort();
    if (!selected.length)
        return "请选择日期";
    if (selected.length === available.length && available.every((date) => state.operationDates.has(date)))
        return "全部日期";
    if (selected.length === 1)
        return selected[0];
    const isRange = available.filter((date) => date >= selected[0] && date <= selected.at(-1)).every((date) => state.operationDates.has(date));
    return isRange ? `${selected[0]} 至 ${selected.at(-1)}` : `已选择 ${selected.length} 天`;
}
function calendarMonthMarkup(monthValue, availableDates, rangeStart, rangeEnd) {
    const cursor = calendarMonthStart(monthValue);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const firstWeekday = cursor.getUTCDay() || 7;
    const gridStart = new Date(Date.UTC(year, month - 1, 2 - firstWeekday));
    const today = calendarDate(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    const days = Array.from({ length: 42 }, (_, index) => {
        const date = new Date(gridStart);
        date.setUTCDate(gridStart.getUTCDate() + index);
        const value = calendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
        const inMonth = date.getUTCMonth() + 1 === month;
        const available = availableDates.has(value);
        const inRange = Boolean(rangeStart && rangeEnd && value >= rangeStart && value <= rangeEnd);
        const isStart = value === rangeStart;
        const isEnd = value === rangeEnd;
        const classes = ["calendar-day", inMonth ? "" : "outside", available ? "available" : "unavailable", inRange ? "in-range" : "", isStart ? "range-start" : "", isEnd ? "range-end" : "", value === today ? "today" : ""].filter(Boolean).join(" ");
        return `<button class="${classes}" type="button" data-calendar-date="${value}" aria-label="${value}" ${inMonth && available ? "" : "disabled"}><span>${date.getUTCDate()}</span></button>`;
    }).join("");
    return `<section class="calendar-month" aria-label="${year}年${month}月"><h4>${year}年 ${month}月</h4><div class="calendar-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-days">${days}</div></section>`;
}
function operationCalendarMarkup() {
    const dates = operationFilterItems("date");
    if (!dates.length)
        return `<div class="date-filter-field"><span>业务日期</span><button class="date-picker-trigger" type="button" disabled>暂无日期</button></div>`;
    const availableDates = new Set(dates);
    const latestDate = dates[0];
    const cursor = state.operationCalendarCursor || `${latestDate.slice(0, 7)}-01`;
    const selected = selectedDateBounds();
    const rangeStart = state.operationCalendarRangeStart || selected.start;
    const rangeEnd = state.operationCalendarRangeStart ? state.operationCalendarRangeStart : selected.end;
    const hint = state.operationCalendarRangeStart ? `已选择 ${state.operationCalendarRangeStart}，可再选结束日期或直接确定单日` : "点击一天选择单日，或依次点击开始和结束日期";
    return `<div class="date-filter-field"><span>业务日期</span><details class="date-range-picker" ${state.operationCalendarOpen ? "open" : ""}><summary class="date-picker-trigger"><span>${escapeHtml(operationDateLabel())}</span><i aria-hidden="true"></i></summary><div class="calendar-popover"><div class="calendar-toolbar"><button type="button" data-calendar-shift="-12" aria-label="上一年">«</button><button type="button" data-calendar-shift="-1" aria-label="上个月">‹</button><span>${escapeHtml(hint)}</span><button type="button" data-calendar-shift="1" aria-label="下个月">›</button><button type="button" data-calendar-shift="12" aria-label="下一年">»</button></div><div class="calendar-months">${calendarMonthMarkup(cursor, availableDates, rangeStart, rangeEnd)}${calendarMonthMarkup(shiftCalendarMonth(cursor, 1), availableDates, rangeStart, rangeEnd)}</div><div class="calendar-footer"><span>${state.operationDates.size} 个业务日</span><div><button type="button" data-calendar-all>全部日期</button><button class="calendar-confirm" type="button" data-calendar-confirm>确定</button></div></div></div></details></div>`;
}
function positionOperationCalendar() {
    const popover = $(".calendar-popover");
    if (!popover || window.matchMedia("(max-width: 760px)").matches)
        return;
    popover.style.transform = "";
    const bounds = popover.getBoundingClientRect();
    const viewportMargin = 12;
    if (bounds.right > window.innerWidth - viewportMargin) {
        popover.style.transform = `translateX(-${Math.ceil(bounds.right - window.innerWidth + viewportMargin)}px)`;
    }
    else if (bounds.left < viewportMargin) {
        popover.style.transform = `translateX(${Math.ceil(viewportMargin - bounds.left)}px)`;
    }
}
function detailTableFilters() {
    const platforms = operationFilterItems("platform");
    const shops = operationFilterItems("shop");
    state.tablePlatform = operationSingleFilterValue("platform");
    state.tableShop = operationSingleFilterValue("shop");
    const options = (items, selected, allLabel) => `<option value="">${allLabel}</option>${items.map((item) => `<option value="${escapeHtml(item)}" ${selected === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}`;
    return `<section class="table-filter-panel" aria-label="经营范围筛选"><div><strong>经营范围</strong><span>销售、流量和投放共用同一组筛选条件</span></div>${operationCalendarMarkup()}<label>平台<select data-table-filter="platform">${options(platforms, state.tablePlatform, "全部平台")}</select></label><label>店铺<select data-table-filter="shop">${options(shops, state.tableShop, "全部店铺")}</select></label></section>`;
}
function bindDetailTableFilters() {
    $$('[data-table-filter]').forEach((select) => select.addEventListener("change", () => {
        const kind = select.dataset.tableFilter;
        if (kind === "platform")
            state.tablePlatform = select.value;
        else
            state.tableShop = select.value;
        applySingleOperationFilter(kind, select.value);
        renderOperations();
    }));
    const picker = $(".date-range-picker");
    picker?.addEventListener("toggle", () => {
        state.operationCalendarOpen = picker.open;
        if (!picker.open)
            state.operationCalendarRangeStart = "";
        else
            window.requestAnimationFrame(positionOperationCalendar);
    });
    $$("[data-calendar-shift]").forEach((button) => button.addEventListener("click", () => {
        state.operationCalendarCursor = shiftCalendarMonth(state.operationCalendarCursor || `${operationFilterItems("date")[0].slice(0, 7)}-01`, number(button.dataset.calendarShift));
        state.operationCalendarOpen = true;
        renderOperations();
    }));
    $$("[data-calendar-date]").forEach((button) => button.addEventListener("click", () => {
        const value = button.dataset.calendarDate;
        if (!state.operationCalendarRangeStart) {
            state.operationDates = new Set([value]);
            state.operationCalendarRangeStart = value;
            state.operationCalendarOpen = true;
        }
        else {
            const start = value < state.operationCalendarRangeStart ? value : state.operationCalendarRangeStart;
            const end = value < state.operationCalendarRangeStart ? state.operationCalendarRangeStart : value;
            state.operationDates = new Set(operationFilterItems("date").filter((date) => date >= start && date <= end));
            state.operationCalendarRangeStart = "";
            state.operationCalendarOpen = false;
        }
        renderOperations();
    }));
    $("[data-calendar-all]")?.addEventListener("click", () => {
        state.operationDates = new Set(operationFilterItems("date"));
        state.operationCalendarRangeStart = "";
        state.operationCalendarOpen = false;
        renderOperations();
    });
    $("[data-calendar-confirm]")?.addEventListener("click", () => {
        state.operationCalendarRangeStart = "";
        state.operationCalendarOpen = false;
        renderOperations();
    });
    if (state.operationCalendarOpen)
        window.requestAnimationFrame(positionOperationCalendar);
}
function channelSelectedRecords() {
    const records = state.channel?.records || [];
    if (!state.operationPlatforms.has("抖音"))
        return [];
    return records.filter((record) => state.operationDates.has(record.date) && state.operationShops.has(record.shop_name));
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
function channelInsightsMarkup(records) {
    if (!records.length)
        return `<div class="empty-panel compact-empty"><strong>当前范围没有抖音渠道数据</strong><span>请选择抖音平台、其他日期或店铺；首次采集后会补充看流量、看商品和看搜索。</span></div>`;
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
    const trendSource = channelTrendRecords(records);
    const charts = `<div class="chart-grid"><div class="chart-stack">${lineChart(trendSource, "organic_search", "自然搜索曝光趋势")}${lineChart(trendSource, "recommendation", "推荐流量曝光趋势")}</div><div class="chart-stack"><section class="panel"><div class="panel-head"><div><h3>商品卡流量来源</h3><span>按罗盘商品曝光人数口径</span></div></div>${simpleTable(["来源", "曝光人数", "占比"], sourceRows)}</section><section class="panel operations-note"><h3>渠道口径</h3><p>自然搜索对应“非投放时段-搜索”；推荐流量包含“猜你喜欢”和“顶Tab推荐”；广告流量包含全域投广及标准/品牌投放。</p><p>搜索模块采用罗盘独立周口径，日期可能晚于经营数据更新。</p></section></div></div>`;
    const details = `<div class="detail-table-stack"><details class="detail-table-disclosure" open><summary><span>商品表现</span><small>商品卡TOP商品 · ${whole(productRows.length)} 条</small></summary><div class="detail-table-content">${simpleTable(["店铺", "商品", "支付金额", "曝光", "点击", "点击率", "点击成交率", "曝光变化"], productRows)}</div></details><details class="detail-table-disclosure"><summary><span>搜索渠道</span><small>商品卡、直播、短视频与图文搜索</small></summary><div class="detail-table-content">${simpleTable(["店铺", "搜索渠道", "曝光人数", "环比", "支付金额", "同行基准"], searchSourceRows)}</div></details><details class="detail-table-disclosure"><summary><span>本店搜索词</span><small>罗盘搜索周报TOP词</small></summary><div class="detail-table-content">${simpleTable(["店铺", "排名", "搜索词", "曝光人数", "环比", "支付金额"], searchTermRows)}</div></details></div>`;
    return `<section class="section-context"><span>抖音渠道下钻</span><small>${whole(records.length)} 条店铺日数据 · 搜索口径：${escapeHtml(periods.join("、") || "暂无")}</small></section>${cardHtml}${charts}${details}`;
}
function metricCards(metrics, columns = "six") {
    return `<div class="metric-grid ${columns}">${metrics.map(([label, value, note, trend]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta ${trend === "up" ? "positive" : trend === "down" ? "negative" : ""}">${note}</div></article>`).join("")}</div>`;
}
function attributedAdMetrics(records) {
    const platforms = new Set(records.filter((record) => number(record.metrics?.ad_cost_amt) > 0).map(recordPlatform));
    const scoped = records.filter((record) => platforms.has(recordPlatform(record)));
    return {
        spend: scoped.reduce((sum, record) => sum + number(record.metrics?.ad_cost_amt), 0),
        pay: scoped.reduce((sum, record) => sum + number(record.metrics?.pay_amt), 0),
        platforms,
    };
}
function operationTabsMarkup() {
    const tabs = [["overview", "经营总览", "跨模块概览"], ["sales", "销售", "成交与退款"], ["traffic", "流量", "曝光、商品与搜索"], ["ads", "投放", "消耗与投产"]];
    return `<div class="operations-tabs" role="tablist" aria-label="经营分类">${tabs.map(([key, label, note]) => `<button class="operations-tab ${state.operationSection === key ? "active" : ""}" type="button" data-operation-section="${key}" role="tab" aria-selected="${state.operationSection === key}"><span>${label}</span><small>${note}</small></button>`).join("")}</div>`;
}
function platformMatrixMarkup(records, channelRecords) {
    const groups = new Map();
    records.forEach((record) => {
        const platform = recordPlatform(record);
        const shops = groups.get(platform) || new Set();
        shops.add(record.shop_name);
        groups.set(platform, shops);
    });
    channelRecords.forEach((record) => {
        const shops = groups.get("抖音") || new Set();
        shops.add(record.shop_name);
        groups.set("抖音", shops);
    });
    const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([platform, shops]) => [
        `<span class="platform-pill">${escapeHtml(platform)}</span>`,
        whole(shops.size),
        escapeHtml([...shops].sort((a, b) => a.localeCompare(b, "zh-CN")).join("、")),
    ]);
    return `<section class="panel"><div class="panel-head"><div><h3>店铺矩阵</h3><span>平台 → 店铺的经营范围</span></div></div>${simpleTable(["平台", "店铺数", "已接入店铺"], rows, "当前范围没有店铺")}</section>`;
}
function operationSourceNote() {
    return `<section class="panel operations-note"><h3>数据口径</h3><p>销售使用罗盘日维度数据和已导入订单汇总；流量融合罗盘经营指标，以及抖音“看流量、看商品、看搜索”的渠道快照；投放只展示已采集的投放消耗和广告曝光。</p><p>外部订单只保存日期、店铺和汇总指标，不保存订单号、买家、地址或原始文件。不同平台尚未接入的指标统一显示“—”。</p><p>当前数据维度为日期与店铺；源数据尚未提供稳定品牌字段，因此不做推测性品牌归因。</p></section>`;
}
function overviewSectionMarkup(records, channelRecords) {
    const totals = aggregate(records);
    const organic = channelGroup(channelRecords, "organic_search");
    const ads = attributedAdMetrics(records);
    const allDates = operationFilterItems("date");
    const prevDates = previousPeriodDates(state.operationDates, allDates);
    const prevRecords = state.records.filter((item) => prevDates.has(item.date) &&
        state.operationPlatforms.has(recordPlatform(item)) &&
        state.operationShops.has(item.shop_name) &&
        state.operationSources.has(recordSourceLabel(item)));
    const prevTotals = aggregate(prevRecords);
    const prevChannelRecords = channelRecords.length ? (state.channel?.records || []).filter((record) => prevDates.has(record.date) && state.operationShops.has(record.shop_name)) : [];
    const prevOrganic = channelGroup(prevChannelRecords, "organic_search");
    const prevAds = attributedAdMetrics(prevRecords);
    const metrics = [
        ["成交金额", money(totals.income_amt), deltaNote(totals.income_amt, prevTotals.income_amt, money), deltaTrend(totals.income_amt, prevTotals.income_amt)],
        ["去退后成交", money(Math.max(totals.income_amt - totals.refund_amt, 0)), deltaNote(Math.max(totals.income_amt - totals.refund_amt, 0), Math.max(prevTotals.income_amt - prevTotals.refund_amt, 0), money), deltaTrend(Math.max(totals.income_amt - totals.refund_amt, 0), Math.max(prevTotals.income_amt - prevTotals.refund_amt, 0))],
        ["成交订单", whole(totals.pay_cnt), deltaNote(totals.pay_cnt, prevTotals.pay_cnt, whole), deltaTrend(totals.pay_cnt, prevTotals.pay_cnt)],
        ["商品曝光人数", whole(totals.product_show_ucnt), deltaNote(totals.product_show_ucnt, prevTotals.product_show_ucnt, whole), deltaTrend(totals.product_show_ucnt, prevTotals.product_show_ucnt)],
        ["自然搜索曝光", wholeOrDash(organic.value), deltaNote(number(organic.value), number(prevOrganic.value), whole), deltaTrend(number(organic.value), number(prevOrganic.value))],
        ["投放 ROI", operatingRatio(ads.spend ? ads.pay / ads.spend : null), ads.spend ? `${[...ads.platforms].join("、")} · 投放消耗 ${money(ads.spend)}` : "尚无投放消耗口径"],
    ];
    const charts = records.length ? `<div class="chart-grid"><div class="chart-stack">${lineChart(records, "income_amt", "成交金额趋势")}${lineChart(records, "pay_cnt", "成交订单趋势")}</div><div class="chart-stack">${barPanel(records, "income_amt", "店铺成交金额对比")}${platformMatrixMarkup(records, channelRecords)}${operationSourceNote()}</div></div>` : `${platformMatrixMarkup(records, channelRecords)}${operationSourceNote()}`;
    return `${metricCards(metrics)}${charts}`;
}
function salesSectionMarkup(records) {
    if (!records.length)
        return `<div class="empty-panel compact-empty"><strong>当前范围没有销售数据</strong><span>请调整平台、日期、店铺或数据来源。</span></div>`;
    const totals = aggregate(records);
    const refundOrders = totals.refund_order_cnt_pay_time || totals.refund_order_cnt;
    const netOrders = Math.max(totals.pay_cnt - refundOrders, 0);
    const netSales = Math.max(totals.income_amt - totals.refund_amt, 0);
    const metrics = [
        ["成交订单数", whole(totals.pay_cnt), `成交件数 ${whole(totals.pay_item_cnt)}`],
        ["成交金额", money(totals.income_amt), "按成交口径汇总"],
        ["退款订单数", whole(refundOrders), "优先使用支付时间退款口径"],
        ["退款金额", money(totals.refund_amt), `退款率 ${ratio(totals.refund_amt_rate)}`],
        ["去退后订单数", whole(netOrders), "成交订单减退款订单"],
        ["去退后成交金额", money(netSales), "成交金额减退款金额"],
        ["平台补贴", money(totals.platform_subsidy_amt), "已采集平台补贴金额"],
        ["客单价", money(totals.per_usr_pay_amt), `成交人数 ${whole(totals.pay_ucnt)}`],
    ];
    const count = whole(records.length);
    const details = `<div class="detail-table-stack"><details class="detail-table-disclosure"><summary><span>店铺销售明细</span><small>按日期与店铺 · ${count} 条</small></summary><div class="detail-table-content">${renderTable(records)}</div></details><details class="detail-table-disclosure"><summary><span>内容成交来源</span><small>直播、商品卡与内容贡献 · ${count} 条</small></summary><div class="detail-table-content">${renderTable(records, true)}</div></details></div>`;
    return `${metricCards(metrics, "four")}<div class="chart-grid"><div class="chart-stack">${lineChart(records, "income_amt", "成交金额趋势")}${lineChart(records, "pay_cnt", "成交订单趋势")}</div><div class="chart-stack">${barPanel(records, "income_amt", "店铺成交金额对比")}${barPanel(records, "pay_amt", "店铺支付金额对比")}</div></div>${details}`;
}
function trafficSectionMarkup(records, channelRecords) {
    const totals = aggregate(records);
    const organic = channelGroup(channelRecords, "organic_search");
    const recommendation = channelGroup(channelRecords, "recommendation");
    const metrics = [
        ["商品曝光人数", whole(totals.product_show_ucnt), "经营日维度"],
        ["商品点击人数", whole(totals.product_click_ucnt), "经营日维度"],
        ["成交人数", whole(totals.pay_ucnt), "经营日维度"],
        ["曝光-点击转化率", ratio(totals.product_show_ucnt ? totals.product_click_ucnt / totals.product_show_ucnt : 0), "点击人数 ÷ 曝光人数"],
        ["点击-成交转化率", ratio(totals.product_click_ucnt ? totals.pay_ucnt / totals.product_click_ucnt : 0), "成交人数 ÷ 点击人数"],
        ["自然 / 推荐曝光", `${wholeOrDash(organic.value)} / ${wholeOrDash(recommendation.value)}`, "抖音渠道下钻"],
    ];
    return `${metricCards(metrics)}${channelInsightsMarkup(channelRecords)}`;
}
function adsSectionMarkup(records, channelRecords) {
    const totals = aggregate(records);
    const paid = channelGroup(channelRecords, "paid");
    const ads = attributedAdMetrics(records);
    const adSpend = ads.spend;
    const metrics = [
        ["投放金额", adSpend ? money(adSpend) : "—", adSpend ? "投放消耗（店铺被投）" : "当前范围未采到投放消耗"],
        ["广告曝光", wholeOrDash(paid.value), "抖音全域、标准及品牌投放来源"],
        ["广告点击", "—", "当前采集接口未提供广告点击"],
        ["广告点击率", "—", "等待广告点击口径接入"],
        ["投放 ROI", operatingRatio(adSpend ? ads.pay / adSpend : null), adSpend ? `${[...ads.platforms].join("、")}支付金额 ÷ 投放金额` : "暂无可计算的投放金额"],
        ["经营支出金额", totals.expense_amt ? money(totals.expense_amt) : "—", "仅作参照，不等同投放金额"],
    ];
    const note = `<section class="panel operations-note"><h3>投放边界</h3><p>“广告曝光”来自抖音渠道流量来源；“投放金额”来自罗盘的“投放消耗（店铺被投）”。两者能够进入同一板块，但不是同一接口的完整广告报表。</p><p>当前没有稳定的广告点击、点击率字段，因此明确显示为“—”；经营页的商品点击不会替代广告点击。</p></section>`;
    const charts = records.length ? `<div class="chart-grid"><div class="chart-stack">${lineChart(records, "ad_cost_amt", "投放消耗趋势")}${lineChart(records, "pay_amt", "支付金额趋势")}</div><div class="chart-stack">${barPanel(records, "ad_cost_amt", "店铺投放消耗对比")}${note}</div></div>` : note;
    return `${metricCards(metrics)}${charts}`;
}
function renderOperations() {
    const records = operationFilteredRecords();
    const channelRecords = channelSelectedRecords();
    const target = $("#operations-content");
    const detailFiltersTarget = $("#detail-filters");
    const allDates = [...new Set([...records.map((item) => item.date), ...channelRecords.map((item) => item.date)])].sort();
    const allShops = new Set([...records.map((item) => item.shop_name), ...channelRecords.map((item) => item.shop_name)]);
    const allPlatforms = new Set([...records.map(recordPlatform), ...(channelRecords.length ? ["抖音"] : [])]);
    if (detailFiltersTarget) {
        detailFiltersTarget.innerHTML = detailTableFilters();
        bindDetailTableFilters();
    }
    renderOrderImportPanel();
    $("#operations-summary").textContent = `最新业务日期：${allDates.at(-1) || "—"} · ${allPlatforms.size} 个平台 · ${allShops.size} 家店铺 · ${allDates.length} 个业务日`;
    let content = "";
    if (!records.length && !channelRecords.length) {
        content = `<div class="empty-panel"><strong>当前筛选条件没有经营数据</strong><span>请调整日期、平台、店铺或数据来源。</span></div>`;
    }
    else if (state.operationSection === "sales") {
        content = salesSectionMarkup(records);
    }
    else if (state.operationSection === "traffic") {
        content = trafficSectionMarkup(records, channelRecords);
    }
    else if (state.operationSection === "ads") {
        content = adsSectionMarkup(records, channelRecords);
    }
    else {
        content = overviewSectionMarkup(records, channelRecords);
    }
    target.innerHTML = `${operationTabsMarkup()}${content}<details class="advanced-filter"><summary>高级筛选</summary><p>可同时选择多个日期、平台、店铺和数据来源。</p>${operationsFiltersMarkup()}</details>`;
    $$('[data-operation-section]').forEach((button) => button.addEventListener("click", () => {
        state.operationSection = button.dataset.operationSection;
        renderOperations();
    }));
    bindOperationsFilterEvents();
    const hoverRecords = state.operationSection === "traffic" ? channelTrendRecords(channelRecords) : records;
    if (hoverRecords.length)
        bindLineChartHover(hoverRecords);
}
async function loadChannel() {
    const response = await fetch("/api/channel");
    if (response.status === 401)
        return showLogin();
    state.channel = response.ok ? await response.json().catch(() => ({ records: [] })) : { records: [] };
    operationFilterItems("date").forEach((item) => state.operationDates.add(item));
    operationFilterItems("platform").forEach((item) => state.operationPlatforms.add(item));
    operationFilterItems("shop").forEach((item) => state.operationShops.add(item));
    renderOperations();
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
function inventoryBrandOptions(payload) {
    return [...new Set((payload.rows || []).map((item) => item.brand_name || "未归类品牌"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
function inventoryFilteredRows(payload) {
    const warehouses = inventoryWarehouseOptions(payload);
    const brands = inventoryBrandOptions(payload);
    if (state.inventoryWarehouse && !warehouses.includes(state.inventoryWarehouse))
        state.inventoryWarehouse = "";
    if (state.inventoryBrand && !brands.includes(state.inventoryBrand))
        state.inventoryBrand = "";
    return (payload.rows || []).filter((item) => {
        const warehouseMatch = !state.inventoryWarehouse || (item.warehouse_name || "未命名仓库") === state.inventoryWarehouse;
        const brandMatch = !state.inventoryBrand || (item.brand_name || "未归类品牌") === state.inventoryBrand;
        return warehouseMatch && brandMatch;
    });
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
    if (state.inventoryWarehouse && state.inventoryBrand) {
        return payload.sales_trend_7d_by_warehouse_brand?.[state.inventoryWarehouse]?.[state.inventoryBrand] || [];
    }
    if (state.inventoryWarehouse)
        return payload.sales_trend_7d_by_warehouse?.[state.inventoryWarehouse] || [];
    if (state.inventoryBrand)
        return payload.sales_trend_7d_by_brand?.[state.inventoryBrand] || [];
    return payload.sales_trend_7d || [];
}
function inventoryWarehouseFilter(payload) {
    const warehouses = inventoryWarehouseOptions(payload);
    const brands = inventoryBrandOptions(payload);
    const warehouseOptions = `<option value="">全部仓库</option>${warehouses.map((name) => `<option value="${escapeHtml(name)}" ${state.inventoryWarehouse === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
    const brandOptions = `<option value="">全部品牌</option>${brands.map((name) => `<option value="${escapeHtml(name)}" ${state.inventoryBrand === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
    return `<section class="table-filter-panel inventory-filter" aria-label="库存筛选"><div><strong>库存筛选</strong><span>筛选总览、补货、积压与 SKU 明细</span></div><label>仓库<select data-inventory-filter="warehouse">${warehouseOptions}</select></label><label>品牌<select data-inventory-filter="brand">${brandOptions}</select></label></section>`;
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
    const total = rows.length;
    const columnConfigs = mode === "replenish"
        ? [{ label: "状态", key: "" }, { label: "仓库", key: "" }, { label: "货品", key: "" }, { label: "商家编码", key: "" }, { label: "可发库存", key: "available_num" }, { label: "近 7 天出库", key: "sales_7d" }, { label: "预计可售", key: "coverage_days" }, { label: "建议补货", key: "replenish_qty" }, { label: "近 30 天入库", key: "inbound_30d" }]
        : [{ label: "状态", key: "" }, { label: "仓库", key: "" }, { label: "品牌", key: "" }, { label: "货品", key: "" }, { label: "商家编码", key: "" }, { label: "可发库存", key: "available_num" }, { label: "近 7 天出库", key: "sales_7d" }, { label: "预计可售", key: "coverage_days" }, { label: "近 30 天入库", key: "inbound_30d" }, { label: "最后出入库", key: "" }];
    const sorted = sortRows(rows, state.inventorySortKey, state.inventorySortDir);
    const visible = sorted.slice(0, 200);
    const body = visible.map((item) => {
        const shared = [healthPill(item), item.warehouse_name, item.goods_name, item.spec_no, whole(item.available_num), whole(item.sales_7d), coverageDays(item.coverage_days), whole(item.replenish_qty), whole(item.inbound_30d)];
        const cells = mode === "replenish" ? shared : [healthPill(item), item.warehouse_name, item.brand_name, item.goods_name, item.spec_no, whole(item.available_num), whole(item.sales_7d), coverageDays(item.coverage_days), whole(item.inbound_30d), item.last_inout_time || "—"];
        return `<tr class="${number(item.available_num) < 0 ? "inventory-alert" : ""}">${cells.map((cell, index) => `<td>${index === 0 ? cell : escapeHtml(cell)}</td>`).join("")}</tr>`;
    }).join("");
    const notice = total > 200 ? `<p class="table-truncate-note">共 ${whole(total)} 条，当前显示前 200 条，可通过筛选缩小范围</p>` : "";
    const headerCells = columnConfigs.map((col) => `<th ${col.key ? `data-sort-key="${col.key}"` : ""} class="${state.inventorySortKey === col.key ? "sorted-" + state.inventorySortDir : ""}">${col.label}</th>`).join("");
    return `${notice}<div class="table-wrap"><table><thead><tr>${headerCells}</tr></thead><tbody>${body || `<tr><td colspan="${columnConfigs.length}">暂无符合条件的库存记录</td></tr>`}</tbody></table></div>`;
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
    const scopeLabel = [
        state.inventoryWarehouse ? `仓库：${state.inventoryWarehouse}` : "全部仓库",
        state.inventoryBrand ? `品牌：${state.inventoryBrand}` : "全部品牌",
    ].join(" · ");
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
    $('[data-inventory-filter="brand"]')?.addEventListener("change", (event) => {
        state.inventoryBrand = event.currentTarget.value;
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
function collectionShopOptions() {
    return COLLECTION_SHOPS.map((shop) => {
        const selected = state.collectionBackfillShops.has(shop);
        return `<label class="backfill-shop ${selected ? "selected" : ""}">
      <input type="checkbox" data-backfill-shop="${escapeHtml(shop)}" ${selected ? "checked" : ""} ${isAdmin() ? "" : "disabled"} />
      <span>${selected ? "✓" : ""}</span><strong>${escapeHtml(shop)}</strong>
    </label>`;
    }).join("");
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
    const backfillReady = Boolean(backfillDateAllowed(state.collectionBackfillDate) && state.collectionBackfillShops.size);
    slot.innerHTML = `${feedback}
    <div class="collection-health-grid">
      <article class="collection-health"><span class="health-indicator ${online ? "online" : "offline"}"></span><small>服务状态</small><strong>${health}</strong></article>
      <article class="collection-health"><small>任务状态</small><strong>${escapeHtml(collectionStateLabel(status))}</strong><span>${escapeHtml(status.message || "暂无采集记录")}</span></article>
      <article class="collection-health"><small>任务队列</small><strong>${request}</strong><span>最近成功：${escapeHtml(status.last_success_at || "—")}</span></article>
    </div>
    <div class="collection-action-grid">
      <section class="panel collection-control"><div class="panel-head"><div><p class="collection-kicker">DAILY UPDATE</p><h3>日常更新</h3><span>${permission}</span></div><span class="collection-tag">近 1 天</span></div>
        <div class="collection-modules">
          ${collectionModuleCard("operations", "经营数据", "成交、退款、客单价及转化等近 1 天指标", status)}
          ${collectionModuleCard("channel", "渠道数据", "看流量、看商品和看搜索的渠道洞察", status)}
        </div>
        <div class="status-actions">
          ${isAdmin() ? `<button id="collection-run-button" class="button button-primary" ${busy || !online ? "disabled" : ""}>${busy ? "采集任务进行中" : online ? "开始日常采集" : "采集服务离线"}</button>` : ""}
          <a class="button" href="${escapeHtml(status.novnc_url || "#")}" target="_blank" rel="noreferrer">打开远程浏览器</a>
        </div>
      </section>
      <section class="panel collection-control collection-backfill"><div class="panel-head"><div><p class="collection-kicker">HISTORICAL BACKFILL</p><h3>历史数据补采</h3><span>漏采某一天时，从日历选日期并指定店铺。</span></div><span class="collection-tag new">新功能</span></div>
        <div class="backfill-form">
          <label class="backfill-date"><span>补采业务日期</span><input id="collection-backfill-date" type="date" value="${escapeHtml(state.collectionBackfillDate)}" min="${currentLocalMonthStart()}" max="${previousLocalDate()}" ${isAdmin() ? "" : "disabled"} /><small>目前支持本月 1 日至昨天</small></label>
          <div class="backfill-module"><span>采集模块</span><strong>经营数据</strong><small>指定日期已验证；渠道数据暂不参与补采</small></div>
        </div>
        <div class="backfill-shop-head"><span>选择店铺</span><small>已选 ${state.collectionBackfillShops.size} / ${COLLECTION_SHOPS.length}</small></div>
        <div class="backfill-shops">${collectionShopOptions()}</div>
        <div class="backfill-notice"><i>i</i><span>任务会逐店切换到“自定义”，把开始和结束日期设为同一天；写入前还会核对接口实际返回日期。</span></div>
        <div class="status-actions">
          ${isAdmin() ? `<button id="collection-backfill-button" class="button button-primary" ${busy || !online || !backfillReady ? "disabled" : ""}>${busy ? "采集任务进行中" : online ? `补采 ${escapeHtml(state.collectionBackfillDate || "指定日期")}` : "采集服务离线"}</button>` : ""}
        </div>
      </section>
    </div>
    <details class="panel status-panel" open><summary>采集终端与诊断</summary><div class="status-body">
      <p>状态更新时间：${escapeHtml(status.updated_at || "—")} · 请求模块：${escapeHtml((status.requested_modules || []).join("、") || "—")}${status.requested_date ? ` · 补采日期：${escapeHtml(status.requested_date)}` : ""}${status.requested_shops?.length ? ` · 指定店铺：${escapeHtml(status.requested_shops.join("、"))}` : ""}</p>
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
    $$("[data-backfill-shop]", slot).forEach((input) => input.addEventListener("change", () => {
        if (input.checked)
            state.collectionBackfillShops.add(input.dataset.backfillShop);
        else
            state.collectionBackfillShops.delete(input.dataset.backfillShop);
        renderCollectionCenter(state.status || {});
    }));
    $("#collection-backfill-date")?.addEventListener("change", (event) => {
        state.collectionBackfillDate = event.currentTarget.value;
        renderCollectionCenter(state.status || {});
    });
    $("#collection-run-button")?.addEventListener("click", startCollection);
    $("#collection-backfill-button")?.addEventListener("click", startHistoricalCollection);
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
async function startHistoricalCollection() {
    const button = $("#collection-backfill-button");
    const date = state.collectionBackfillDate;
    const shops = COLLECTION_SHOPS.filter((shop) => state.collectionBackfillShops.has(shop));
    if (!backfillDateAllowed(date) || !shops.length) {
        state.collectionMessage = "请选择本月 1 日至昨天之间的日期，并至少选择一家店铺。";
        renderCollectionCenter(state.status || {});
        return;
    }
    button.disabled = true;
    button.textContent = "正在提交补采…";
    const response = await fetch("/api/collection/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modules: ["operations"], date, shops }),
    });
    const payload = await response.json().catch(() => ({}));
    state.collectionMessage = payload.message || payload.error || (response.ok ? `已提交 ${date} 补采` : "补采提交失败");
    if (payload.status)
        renderCollectionCenter(payload.status);
    window.setTimeout(refreshCollectionStatus, 700);
}
async function loadCompass() {
    const response = await fetch("/api/compass");
    if (response.status === 401)
        return showLogin();
    const payload = await response.json();
    state.records = (payload.records || []).map(canonicalOperationRecord);
    state.channel = payload.channel || null;
    state.operationDates = new Set(operationFilterItems("date"));
    state.operationCalendarCursor = operationFilterItems("date")[0] ? `${operationFilterItems("date")[0].slice(0, 7)}-01` : "";
    state.operationCalendarRangeStart = "";
    state.operationCalendarOpen = false;
    state.operationPlatforms = new Set(operationFilterItems("platform"));
    state.operationShops = new Set(operationFilterItems("shop"));
    state.operationSources = new Set(state.records.map(recordSourceLabel));
    if (!payload.channel)
        return loadChannel();
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
    activatePage(desired === "channel" ? "operations" : ["inventory", "operations", "settlement", "collection", "account"].includes(desired) ? desired : "operations");
    $$(".nav-tab").forEach((tab) => tab.addEventListener("click", () => activatePage(tab.dataset.page)));
    $("#logout-button").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); showLogin(); });
    $("#inventory-content").addEventListener("click", (event) => {
        const th = event.target.closest("[data-sort-key]");
        if (!th)
            return;
        const key = th.dataset.sortKey;
        state.inventorySortDir = state.inventorySortKey === key && state.inventorySortDir === "desc" ? "asc" : "desc";
        state.inventorySortKey = key;
        renderInventory(state.inventory);
    });
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
        refreshCollectionStatus();
    });
    const me = await fetch("/api/me").then((response) => response.json());
    if (me.authenticated) {
        showApp(me);
        loadCompass();
        loadOrderImports();
        loadInventory();
        loadSettlement();
        refreshCollectionStatus();
    }
    else
        showLogin();
}
initialise();
