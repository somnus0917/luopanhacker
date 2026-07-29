import { $, $$ } from "../dom";
import {
  escapeHtml, hasValue, importTime, metricText, money, moneyOrDash, number,
  ratio, ratioOrDash, whole, wholeOrDash,
} from "../format";
import { barPanel, bindLineChartHover, lineChart } from "../charts";
import { isAdmin, state } from "../state";
import type { AnyRecord, OperationRecord } from "../state";
import { showLogin } from "./account";

function recordSourceLabel(item) {
  return item.source_label || (item.source === "external_orders" ? "订单明细" : "抖店罗盘");
}

function canonicalOperationRecord(item: OperationRecord): OperationRecord {
  if (item.source_key === "miaosuda" || item.shop_name === "羚稀官方旗舰店") {
    return { ...item, shop_name: "喵速达" };
  }
  return item;
}

function recordPlatform(item) {
  const explicit = item.platform || item.channel || item.content?.platform;
  if (explicit) return String(explicit);
  if (item.source !== "external_orders") return "抖音";
  const source = `${item.source_key || ""} ${item.source_label || ""} ${item.shop_name || ""}`.toLowerCase();
  if (/(jingdong|\bjd\b|京东)/.test(source)) return "京东";
  if (/(pinduoduo|\bpdd\b|拼多多)/.test(source)) return "拼多多";
  if (/(tmall|taobao|天猫|喵速达|优品|国际)/.test(source)) return "天猫";
  return "其他";
}

function aggregate(records: OperationRecord[]): Record<string, number> {
  const totals: Record<string, number> = {};
  const sumKeys = ["income_amt", "pay_amt", "settlement_amt_pay_time", "pay_cnt", "pay_ucnt", "refund_amt", "refund_order_cnt", "refund_order_cnt_pay_time", "platform_subsidy_amt", "talent_subsidy_amt", "pay_item_cnt", "product_show_ucnt", "product_click_ucnt", "product_show_cnt", "product_click_cnt", "expense_amt", "ad_cost_amt"];
  sumKeys.forEach((key) => totals[key] = records.reduce((sum, item) => sum + number(item.metrics?.[key]), 0));
  totals.per_usr_pay_amt = totals.pay_ucnt ? totals.pay_amt / totals.pay_ucnt : 0;
  const weightedRefundRate = records.reduce((sum, item) => sum + number(item.metrics?.income_amt) * number(item.metrics?.refund_amt_rate), 0);
  totals.refund_amt_rate = totals.refund_amt && totals.income_amt ? totals.refund_amt / totals.income_amt : totals.income_amt ? weightedRefundRate / totals.income_amt : 0;
  totals.product_click_pay_ucnt_ratio = totals.product_click_ucnt ? totals.pay_ucnt / totals.product_click_ucnt : 0;
  return totals;
}

function previousPeriodDates(selectedDates: Set<string>, allDates: string[]): Set<string> {
  const sorted = [...selectedDates].sort();
  if (!sorted.length) return new Set();
  const span = sorted.length;
  const earliestIndex = allDates.indexOf(sorted[0]);
  const prevSlice = allDates.slice(Math.max(0, earliestIndex - span), earliestIndex);
  return new Set(prevSlice);
}

function deltaNote(current: number, previous: number, formatter = whole): string {
  if (!previous) return "环比：无上期数据";
  const change = (current - previous) / previous;
  const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
  return `${arrow} ${Math.abs(change * 100).toFixed(1)}% 环比 ${formatter(previous)}`;
}

function deltaTrend(current: number, previous: number): string {
  if (!previous) return "";
  return current > previous ? "up" : current < previous ? "down" : "";
}

function operationFilteredRecords() {
  return state.records.filter((item) => state.operationDates.has(item.date) && state.operationPlatforms.has(recordPlatform(item)) && state.operationShops.has(item.shop_name) && state.operationSources.has(recordSourceLabel(item)));
}

function operationFilterSet(kind) {
  return kind === "date" ? state.operationDates : kind === "platform" ? state.operationPlatforms : kind === "shop" ? state.operationShops : state.operationSources;
}

function operationFilterItems(kind, records = state.records): string[] {
  const channelRecords = state.channel?.records || [];
  if (kind === "date") return [...new Set([...records.map((item) => item.date), ...channelRecords.map((item) => item.date)])].sort((a, b) => b.localeCompare(a));
  if (kind === "platform") return [...new Set([...records.map(recordPlatform), ...(channelRecords.length ? ["抖音"] : [])])].sort((a, b) => a.localeCompare(b, "zh-CN"));
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
  if (value) selected.add(value);
  else operationFilterItems(kind).forEach((item) => selected.add(item));
  if (kind === "platform") resetOperationShopsForPlatforms();
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
    if (!shouldSelect && selected.size <= 1) { control.checked = true; return; }
    if (shouldSelect) selected.add(value); else selected.delete(value);
    if (control.dataset.operationFilter === "platform") resetOperationShopsForPlatforms();
    renderOperations();
  }));
  $$('[data-operation-select-all]').forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.operationSelectAll;
    const items = operationFilterItems(kind);
    const selected = operationFilterSet(kind);
    items.forEach((item) => selected.add(item));
    if (kind === "platform") resetOperationShopsForPlatforms();
    renderOperations();
  }));
  $$('[data-operation-clear]').forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.operationClear;
    const items = operationFilterItems(kind);
    const selected = operationFilterSet(kind);
    selected.clear();
    if (items.length) selected.add(items[0]);
    if (kind === "platform") resetOperationShopsForPlatforms();
    renderOperations();
  }));
  $$('[data-filter-kind]').forEach((details) => details.addEventListener("toggle", () => {
    const kind = details.dataset.filterKind;
    if (details.open) state.operationFilterOpen.add(kind); else state.operationFilterOpen.delete(kind);
  }));
}

function importDateRange(value) {
  return Array.isArray(value) && value.length === 2 ? `${value[0]} 至 ${value[1]}` : "—";
}

function renderOrderImportPanel() {
  const target = $("#order-import-panel");
  if (!target) return;
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

export async function loadOrderImports() {
  const response = await fetch("/api/orders/imports");
  if (response.status === 401) return showLogin();
  state.orderImports = await response.json();
  renderOrderImportPanel();
}

async function previewOrderImport(event) {
  event.preventDefault();
  const files = $("#order-upload-files")?.files;
  if (!files?.length) return;
  const button = $("#order-upload-form button");
  button.disabled = true;
  button.textContent = "正在解析…";
  state.orderImportMessage = "";
  const response = await fetch("/api/orders/preview", { method: "POST", body: new FormData(event.currentTarget) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    state.orderImportMessage = payload.error || "文件解析失败，请检查格式后重试。";
  } else {
    state.orderPreview = payload;
    state.orderImportMessage = "预览完成，请核对新增与重复数量后确认写入。";
  }
  renderOrderImportPanel();
}

async function commitOrderImport() {
  if (!state.orderPreview?.preview_token) return;
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
  if (!batchId || !window.confirm("撤销后，该批次导入的数据将从经营看板移除。确定继续吗？")) return;
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

function calendarMonthStart(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function shiftCalendarMonth(value: string, amount: number) {
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
  if (!selected.length) return "请选择日期";
  if (selected.length === available.length && available.every((date) => state.operationDates.has(date))) return "全部日期";
  if (selected.length === 1) return selected[0];
  const isRange = available.filter((date) => date >= selected[0] && date <= selected.at(-1)).every((date) => state.operationDates.has(date));
  return isRange ? `${selected[0]} 至 ${selected.at(-1)}` : `已选择 ${selected.length} 天`;
}

function calendarMonthMarkup(monthValue: string, availableDates: Set<string>, rangeStart: string, rangeEnd: string) {
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
  if (!dates.length) return `<div class="date-filter-field"><span>业务日期</span><button class="date-picker-trigger" type="button" disabled>暂无日期</button></div>`;
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
  if (!popover || window.matchMedia("(max-width: 760px)").matches) return;
  popover.style.transform = "";
  const bounds = popover.getBoundingClientRect();
  const viewportMargin = 12;
  if (bounds.right > window.innerWidth - viewportMargin) {
    popover.style.transform = `translateX(-${Math.ceil(bounds.right - window.innerWidth + viewportMargin)}px)`;
  } else if (bounds.left < viewportMargin) {
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
    if (kind === "platform") state.tablePlatform = select.value;
    else state.tableShop = select.value;
    applySingleOperationFilter(kind, select.value);
    renderOperations();
  }));
  const picker = $(".date-range-picker");
  picker?.addEventListener("toggle", () => {
    state.operationCalendarOpen = picker.open;
    if (!picker.open) state.operationCalendarRangeStart = "";
    else window.requestAnimationFrame(positionOperationCalendar);
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
    } else {
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
  if (state.operationCalendarOpen) window.requestAnimationFrame(positionOperationCalendar);
}

function channelSelectedRecords() {
  const records = state.channel?.records || [];
  if (!state.operationPlatforms.has("抖音")) return [];
  return records.filter((record) => state.operationDates.has(record.date) && state.operationShops.has(record.shop_name));
}

function channelGroup(records, key) {
  let value = 0, weightedRatio = 0, weight = 0, available = 0;
  records.forEach((record) => {
    const group = record.traffic?.groups?.[key];
    if (!group) return;
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
  if (!records.length) return `<div class="empty-panel compact-empty"><strong>当前范围没有抖音渠道数据</strong><span>请选择抖音平台、其他日期或店铺；首次采集后会补充看流量、看商品和看搜索。</span></div>`;
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

  const sourceMap = new Map<string, AnyRecord>();
  records.forEach((record) => (record.traffic?.sources || []).forEach((source) => {
    if (source.parent === null) return;
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

  const periods = [...new Set<string>(records.map((record) => {
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
  const groups = new Map<string, Set<string>>();
  records.forEach((record) => {
    const platform = recordPlatform(record);
    const shops = groups.get(platform) || new Set<string>();
    shops.add(record.shop_name);
    groups.set(platform, shops);
  });
  channelRecords.forEach((record) => {
    const shops = groups.get("抖音") || new Set<string>();
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

function overviewSectionMarkup(records, channelRecords) {
  const totals = aggregate(records);
  const organic = channelGroup(channelRecords, "organic_search");
  const ads = attributedAdMetrics(records);
  const allDates = operationFilterItems("date");
  const prevDates = previousPeriodDates(state.operationDates, allDates);
  const prevRecords = state.records.filter((item) =>
    prevDates.has(item.date) &&
    state.operationPlatforms.has(recordPlatform(item)) &&
    state.operationShops.has(item.shop_name) &&
    state.operationSources.has(recordSourceLabel(item))
  );
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
  const charts = records.length ? `<div class="chart-grid"><div class="chart-stack">${lineChart(records, "income_amt", "成交金额趋势")}${lineChart(records, "pay_cnt", "成交订单趋势")}</div><div class="chart-stack">${barPanel(records, "income_amt", "店铺成交金额对比")}${platformMatrixMarkup(records, channelRecords)}</div></div>` : platformMatrixMarkup(records, channelRecords);
  return `${metricCards(metrics)}${charts}`;
}

function salesSectionMarkup(records) {
  if (!records.length) return `<div class="empty-panel compact-empty"><strong>当前范围没有销售数据</strong><span>请调整平台、日期、店铺或数据来源。</span></div>`;
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
  const charts = records.length ? `<div class="chart-grid"><div class="chart-stack">${lineChart(records, "ad_cost_amt", "投放消耗趋势")}${lineChart(records, "pay_amt", "支付金额趋势")}</div><div class="chart-stack">${barPanel(records, "ad_cost_amt", "店铺投放消耗对比")}</div></div>` : "";
  return `${metricCards(metrics)}${charts}`;
}

export function renderOperations() {
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
  } else if (state.operationSection === "sales") {
    content = salesSectionMarkup(records);
  } else if (state.operationSection === "traffic") {
    content = trafficSectionMarkup(records, channelRecords);
  } else if (state.operationSection === "ads") {
    content = adsSectionMarkup(records, channelRecords);
  } else {
    content = overviewSectionMarkup(records, channelRecords);
  }
  target.innerHTML = `${operationTabsMarkup()}${content}<details class="advanced-filter"><summary>高级筛选</summary><p>可同时选择多个日期、平台、店铺和数据来源。</p>${operationsFiltersMarkup()}</details>`;
  $$('[data-operation-section]').forEach((button) => button.addEventListener("click", () => {
    state.operationSection = button.dataset.operationSection;
    renderOperations();
  }));
  bindOperationsFilterEvents();
  const hoverRecords = state.operationSection === "traffic" ? channelTrendRecords(channelRecords) : records;
  if (hoverRecords.length) bindLineChartHover(hoverRecords);
}

export async function loadChannel() {
  const response = await fetch("/api/channel");
  if (response.status === 401) return showLogin();
  state.channel = response.ok ? await response.json().catch(() => ({ records: [] })) : { records: [] };
  operationFilterItems("date").forEach((item) => state.operationDates.add(item));
  operationFilterItems("platform").forEach((item) => state.operationPlatforms.add(item));
  operationFilterItems("shop").forEach((item) => state.operationShops.add(item));
  renderOperations();
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

export async function loadCompass() {
  const response = await fetch("/api/compass");
  if (response.status === 401) return showLogin();
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
  if (!payload.channel) return loadChannel();
  renderOperations();
}
