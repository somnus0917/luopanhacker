import { $, $$ } from "../dom";
import { apiFetch as fetch } from "../api";
import { showToast } from "../feedback";
import {
  escapeHtml, number, settlementMoney, settlementMoneyOrDash, whole,
} from "../format";
import { isAdmin, state } from "../state";
import type { AnyRecord } from "../state";
import { showLogin } from "./account";

function settlementGroupTable(title: string, groups: AnyRecord[]) {
  const rows = [...(groups || [])]
    .sort((a, b) => number(b.settlement_amount) - number(a.settlement_amount))
    .map((item) => `<tr><td>${escapeHtml(item.name || "未标注")}</td><td>${settlementMoney(item.settlement_amount)}</td><td>${settlementMoney(item.income_total)}</td><td>${settlementMoney(item.expense_total)}</td><td>${whole(item.order_count)}</td><td>${whole(item.row_count)}</td></tr>`)
    .join("");
  return `<section class="panel"><div class="panel-head"><div><h3>${title}</h3><span>按结算金额排序</span></div></div><div class="table-wrap"><table class="table-freeze-leading"><thead><tr><th>维度</th><th>结算金额</th><th>收入合计</th><th>支出合计</th><th>订单数</th><th>明细行</th></tr></thead><tbody>${rows || `<tr><td colspan="6">暂无结算数据</td></tr>`}</tbody></table></div></section>`;
}

function settlementDates(payload = state.settlement) {
  return [...new Set<string>(payload?.available_dates || state.settlementAvailableDates || [])]
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));
}

function settlementCalendarDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function settlementCalendarMonthStart(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function shiftSettlementCalendarMonth(value: string, amount: number) {
  const cursor = settlementCalendarMonthStart(value);
  cursor.setUTCMonth(cursor.getUTCMonth() + amount);
  return settlementCalendarDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
}

function settlementDateLabel() {
  const dates = settlementDates();
  if (!state.settlementStartDate && !state.settlementEndDate) return "全部日期";
  if (state.settlementStartDate === state.settlementEndDate) return state.settlementStartDate;
  return `${state.settlementStartDate || dates.at(-1) || "最早"} 至 ${state.settlementEndDate || dates[0] || "最新"}`;
}

function settlementCalendarMonthMarkup(monthValue: string, availableDates: Set<string>, rangeStart: string, rangeEnd: string) {
  const cursor = settlementCalendarMonthStart(monthValue);
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth() + 1;
  const firstWeekday = cursor.getUTCDay() || 7;
  const gridStart = new Date(Date.UTC(year, month - 1, 2 - firstWeekday));
  const today = settlementCalendarDate(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    const value = settlementCalendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const inMonth = date.getUTCMonth() + 1 === month;
    const available = availableDates.has(value);
    const inRange = Boolean(rangeStart && rangeEnd && value >= rangeStart && value <= rangeEnd);
    const isStart = value === rangeStart;
    const isEnd = value === rangeEnd;
    const classes = ["calendar-day", inMonth ? "" : "outside", available ? "available" : "unavailable", inRange ? "in-range" : "", isStart ? "range-start" : "", isEnd ? "range-end" : "", value === today ? "today" : ""].filter(Boolean).join(" ");
    return `<button class="${classes}" type="button" data-settlement-calendar-date="${value}" aria-label="${value}" ${inMonth && available ? "" : "disabled"}><span>${date.getUTCDate()}</span></button>`;
  }).join("");
  return `<section class="calendar-month" aria-label="${year}年${month}月"><h4>${year}年 ${month}月</h4><div class="calendar-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-days">${days}</div></section>`;
}

function settlementCalendarMarkup(payload: AnyRecord) {
  const dates = settlementDates(payload);
  if (!dates.length) return `<div class="date-filter-field"><span>结算日期</span><button class="date-picker-trigger" type="button" disabled>暂无日期</button></div>`;
  const availableDates = new Set(dates);
  const cursor = state.settlementCalendarCursor || `${dates[0].slice(0, 7)}-01`;
  const rangeStart = state.settlementCalendarRangeStart || state.settlementStartDate;
  const rangeEnd = state.settlementCalendarRangeStart ? state.settlementCalendarRangeStart : state.settlementEndDate;
  const selectedCount = state.settlementStartDate || state.settlementEndDate
    ? dates.filter((date) => (!state.settlementStartDate || date >= state.settlementStartDate) && (!state.settlementEndDate || date <= state.settlementEndDate)).length
    : dates.length;
  const hint = state.settlementCalendarRangeStart ? `已选择 ${state.settlementCalendarRangeStart}，可再选结束日期或直接确定单日` : "点击一天选择单日，或依次点击开始和结束日期";
  return `<div class="date-filter-field"><span>结算日期</span><details class="date-range-picker" ${state.settlementCalendarOpen ? "open" : ""}><summary class="date-picker-trigger"><span>${escapeHtml(settlementDateLabel())}</span><i aria-hidden="true"></i></summary><div class="calendar-popover"><div class="calendar-toolbar"><button type="button" data-settlement-calendar-shift="-12" aria-label="上一年">«</button><button type="button" data-settlement-calendar-shift="-1" aria-label="上个月">‹</button><span>${escapeHtml(hint)}</span><button type="button" data-settlement-calendar-shift="1" aria-label="下个月">›</button><button type="button" data-settlement-calendar-shift="12" aria-label="下一年">»</button></div><div class="calendar-months">${settlementCalendarMonthMarkup(cursor, availableDates, rangeStart, rangeEnd)}${settlementCalendarMonthMarkup(shiftSettlementCalendarMonth(cursor, 1), availableDates, rangeStart, rangeEnd)}</div><div class="calendar-footer"><span>${selectedCount} 个结算日</span><div><button type="button" data-settlement-calendar-all>全部日期</button><button class="calendar-confirm" type="button" data-settlement-calendar-confirm>确定</button></div></div></div></details></div>`;
}

function settlementFiltersMarkup(payload: AnyRecord) {
  const shops = payload.shops || [];
  const selected = payload.selected_shop || state.settlementShop || "";
  const options = `<option value="">全部店铺</option>${shops.map((name: string) => `<option value="${escapeHtml(name)}" ${selected === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  const tags = [settlementDateLabel(), selected ? `店铺：${selected}` : "全部店铺"]
    .map((tag) => `<span class="filter-summary-tag">${escapeHtml(tag)}</span>`).join("");
  return `<section class="table-filter-panel" aria-label="结算范围筛选"><div><strong>结算范围</strong></div><div class="filter-summary" aria-live="polite"><span class="filter-summary-label">当前范围</span>${tags}<button class="filter-reset" type="button" data-reset-settlement-filters>重置</button></div>${settlementCalendarMarkup(payload)}<label>店铺<select data-settlement-filter="shop">${options}</select></label></section>`;
}

function positionSettlementCalendar() {
  const filters = $("#settlement-filters");
  const popover = filters ? $(".calendar-popover", filters) : null;
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

function renderSettlementFilters(payload: AnyRecord) {
  const target = $("#settlement-filters");
  if (!target) return;
  target.innerHTML = settlementFiltersMarkup(payload);
  $('[data-settlement-filter="shop"]', target)?.addEventListener("change", (event: Event) => {
    state.settlementShop = (event.currentTarget as HTMLSelectElement).value;
    state.settlementCalendarCursor = "";
    state.settlementCalendarRangeStart = "";
    state.settlementCalendarOpen = false;
    loadSettlement();
  });
  $("[data-reset-settlement-filters]", target)?.addEventListener("click", () => {
    state.settlementShop = "";
    state.settlementStartDate = "";
    state.settlementEndDate = "";
    state.settlementCalendarRangeStart = "";
    state.settlementCalendarOpen = false;
    loadSettlement();
  });
  const picker = $(".date-range-picker", target);
  picker?.addEventListener("toggle", () => {
    state.settlementCalendarOpen = picker.open;
    if (!picker.open) state.settlementCalendarRangeStart = "";
    else window.requestAnimationFrame(positionSettlementCalendar);
  });
  $$("[data-settlement-calendar-shift]", target).forEach((button) => button.addEventListener("click", () => {
    const dates = settlementDates(payload);
    state.settlementCalendarCursor = shiftSettlementCalendarMonth(state.settlementCalendarCursor || `${dates[0].slice(0, 7)}-01`, number(button.dataset.settlementCalendarShift));
    state.settlementCalendarOpen = true;
    renderSettlementFilters(payload);
  }));
  $$("[data-settlement-calendar-date]", target).forEach((button) => button.addEventListener("click", () => {
    const value = button.dataset.settlementCalendarDate;
    if (!state.settlementCalendarRangeStart) {
      state.settlementStartDate = value;
      state.settlementEndDate = value;
      state.settlementCalendarRangeStart = value;
      state.settlementCalendarOpen = true;
    } else {
      state.settlementStartDate = value < state.settlementCalendarRangeStart ? value : state.settlementCalendarRangeStart;
      state.settlementEndDate = value < state.settlementCalendarRangeStart ? state.settlementCalendarRangeStart : value;
      state.settlementCalendarRangeStart = "";
      state.settlementCalendarOpen = false;
    }
    loadSettlement();
  }));
  $("[data-settlement-calendar-all]", target)?.addEventListener("click", () => {
    state.settlementStartDate = "";
    state.settlementEndDate = "";
    state.settlementCalendarRangeStart = "";
    state.settlementCalendarOpen = false;
    loadSettlement();
  });
  $("[data-settlement-calendar-confirm]", target)?.addEventListener("click", () => {
    state.settlementCalendarRangeStart = "";
    state.settlementCalendarOpen = false;
    renderSettlementFilters(payload);
  });
  if (state.settlementCalendarOpen) window.requestAnimationFrame(positionSettlementCalendar);
}

function settlementUploadPanel() {
  if (!isAdmin()) return "";
  const message = state.settlementUploadMessage ? `<p class="order-import-message">${escapeHtml(state.settlementUploadMessage)}</p>` : "";
  const defaultShop = state.settlementShop || "";
  return `<details class="panel order-import-panel"><summary><span>结算 CSV 导入</span><small>填写店铺 → 上传 CSV → 自动刷新</small></summary><div class="order-import-body"><form id="settlement-upload-form" class="order-upload-form"><label>店铺名称<input name="shop_name" value="${escapeHtml(defaultShop)}" required /></label><label class="file-picker"><span>选择结算 CSV</span><input id="settlement-upload-file" type="file" name="file" accept=".csv,text/csv" required /></label><button class="button" type="submit">上传并解析</button></form>${message}<p class="import-help">上传后文件保存在服务器 <code>output/settlement/</code>，店铺名会保存为本地映射，用于后续筛选与汇总。</p></div></details>`;
}

function settlementDetailTable(rows: AnyRecord[]) {
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
  return `<details class="detail-table-disclosure" open><summary><span>结算明细</span><small>最多显示前 ${whole(rows?.length || 0)} 条</small></summary><div class="detail-table-content"><div class="table-wrap"><table class="table-freeze-leading"><thead><tr><th>店铺</th><th>结算时间</th><th>订单号</th><th>商品</th><th>业务类型</th><th>结算金额</th><th>用户实付</th><th>收入合计</th><th>支出合计</th><th>平台服务费</th><th>政府补贴</th></tr></thead><tbody>${body || `<tr><td colspan="11">暂无结算明细</td></tr>`}</tbody></table></div></div></details>`;
}

export function renderSettlement(payload: AnyRecord) {
  state.settlement = payload;
  state.settlementShop = payload.selected_shop || "";
  state.settlementAvailableDates = settlementDates(payload);
  state.settlementStartDate = payload.selected_start_date || "";
  state.settlementEndDate = payload.selected_end_date || "";
  if (!state.settlementCalendarCursor && state.settlementAvailableDates.length) {
    state.settlementCalendarCursor = `${state.settlementAvailableDates[0].slice(0, 7)}-01`;
  }
  renderSettlementFilters(payload);
  const summary = payload.summary || {};
  const fileNames = (payload.files || []).map((file: AnyRecord) => file.name).filter(Boolean);
  $("#settlement-freshness").textContent = state.settlementAvailableDates.length ? `结算至 ${state.settlementAvailableDates[0]}` : "暂无数据";
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
  const hasActiveFilter = Boolean(state.settlementShop || state.settlementStartDate || state.settlementEndDate);
  const emptyMessage = hasActiveFilter
    ? "当前筛选范围暂无结算数据，请调整结算日期或店铺。"
    : "请上传结算 CSV 或把文件放入服务器 output/settlement/ 目录后刷新页面。";
  $("#settlement-content").innerHTML = summary.row_count
    ? `${settlementUploadPanel()}<section class="panel operations-note"><h3>数据来源</h3><p>读取服务器本地 <code>output/settlement/</code> 目录下的抖音结算 CSV；金额按 CSV 原始元单位展示，不做分转元转换。</p><p>已读取文件：${escapeHtml(fileNames.join("、") || "—")}</p></section><div class="chart-grid"><div class="chart-stack">${settlementGroupTable("按结算月份", payload.months)}${settlementGroupTable("按店铺", payload.shop_groups)}</div><div class="chart-stack">${settlementGroupTable("按商户主体", payload.subjects)}${settlementGroupTable("按业务类型", payload.business_types)}</div></div>${settlementDetailTable(payload.rows)}`
    : `${settlementUploadPanel()}<div class="empty-panel"><strong>暂无结算数据</strong><span>${emptyMessage}</span></div>`;
  $("#settlement-upload-form")?.addEventListener("submit", uploadSettlement);
}

async function uploadSettlement(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const button = $("button", form);
  const data = new FormData(form);
  const uploadFile = data.get("file");
  const shopName = String(data.get("shop_name") || "").trim();
  if (!(uploadFile instanceof File) || !shopName) {
    state.settlementUploadMessage = "请选择结算 CSV 并填写店铺名称。";
    showToast(state.settlementUploadMessage, "error");
    if (state.settlement) renderSettlement(state.settlement);
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
    showToast(state.settlementUploadMessage, "error");
    if (state.settlement) renderSettlement(state.settlement);
    return;
  }
  const uploaded = payload.upload?.file || {};
  state.settlementShop = uploaded.shop_name || state.settlementShop;
  state.settlementUploadMessage = `已导入 ${uploaded.original_name || uploaded.name || "结算 CSV"}，解析 ${whole(uploaded.rows)} 行。`;
  showToast(state.settlementUploadMessage, "success");
  await loadSettlement();
}

export async function loadSettlement() {
  const target = $("#settlement-content");
  try {
    const query = new URLSearchParams();
    if (state.settlementShop) query.set("shop", state.settlementShop);
    if (state.settlementStartDate) query.set("start_date", state.settlementStartDate);
    if (state.settlementEndDate) query.set("end_date", state.settlementEndDate);
    const response = await fetch(`/api/settlement${query.size ? `?${query}` : ""}`);
    if (response.status === 401) return showLogin();
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "结算数据不可用");
    renderSettlement(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "请检查 Rust API 与 output/settlement 目录";
    target.innerHTML = `<div class="empty-panel"><strong>结算数据暂不可用</strong><span>${escapeHtml(message)}</span></div>`;
  }
}
