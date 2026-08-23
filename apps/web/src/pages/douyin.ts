import { $, $$ } from "../dom";
import { errorMessage, isApiRequestError, request } from "../api";
import { showToast } from "../feedback";
import { escapeHtml, money, moneyOrDash, number, ratio, whole, wholeOrDash } from "../format";
import { state, type AnyRecord, type OperationRecord } from "../state";
import type { DouyinDashboard } from "../types";
import { showLogin } from "./account";

type DouyinSection = "live" | "video" | "product_card";

const SECTIONS: Array<[DouyinSection, string, string]> = [
  ["live", "直播", "全局概览与开播表现"],
  ["video", "短视频", "内容成交与引流价值"],
  ["product_card", "商品卡", "商品流量与转化"],
];

function isDouyinRecord(record: OperationRecord) {
  const explicit = record.platform || record.channel || record.content?.platform;
  if (explicit) return String(explicit) === "抖音";
  return record.source !== "external_orders" && record.source !== "jd_product_performance";
}

function douyinRecords() {
  return state.records.filter((record) => isDouyinRecord(record) && (!state.douyinShop || record.shop_name === state.douyinShop));
}

function douyinShops() {
  const shops = [
    ...(state.douyin?.records || []).map((record) => String(record.shop_name || "")),
    ...state.records.filter(isDouyinRecord).map((record) => record.shop_name),
  ].filter(Boolean);
  return [...new Set(shops)].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function selectedSnapshots() {
  return (state.douyin?.records || []).filter((record) => !state.douyinShop || String(record.shop_name || "") === state.douyinShop);
}

function douyinAvailableDates() {
  const source = state.douyin?.records?.length ? selectedSnapshots() : douyinRecords();
  return [...new Set(source.map((record) => String(record.date || "")))]
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left));
}

function isDouyinDateSelected(date: string) {
  return Boolean(date && (!state.douyinStartDate || date >= state.douyinStartDate) && (!state.douyinEndDate || date <= state.douyinEndDate));
}

function selectedDouyinDates() {
  return douyinAvailableDates().filter(isDouyinDateSelected);
}

function douyinCalendarDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function douyinCalendarMonthStart(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function shiftDouyinCalendarMonth(value: string, amount: number) {
  const cursor = douyinCalendarMonthStart(value);
  cursor.setUTCMonth(cursor.getUTCMonth() + amount);
  return douyinCalendarDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
}

function selectDouyinDatePreset(preset: "day" | "week" | "month" | "all") {
  const dates = douyinAvailableDates();
  if (!dates.length) {
    state.douyinStartDate = "";
    state.douyinEndDate = "";
    return;
  }
  const latest = dates[0];
  if (preset === "all") {
    state.douyinStartDate = dates.at(-1) || latest;
    state.douyinEndDate = latest;
  } else {
    const days = preset === "day" ? 1 : preset === "week" ? 7 : 30;
    const earliest = new Date(`${latest}T00:00:00Z`);
    earliest.setUTCDate(earliest.getUTCDate() - days + 1);
    const threshold = douyinCalendarDate(earliest.getUTCFullYear(), earliest.getUTCMonth() + 1, earliest.getUTCDate());
    const selected = dates.filter((date) => date >= threshold);
    state.douyinStartDate = selected.at(-1) || latest;
    state.douyinEndDate = latest;
  }
  state.douyinDatePreset = preset;
  state.douyinCalendarRangeStart = "";
  state.douyinCalendarOpen = false;
}

function ensureDouyinDateSelection() {
  const dates = douyinAvailableDates();
  if (!dates.length) {
    state.douyinStartDate = "";
    state.douyinEndDate = "";
    return;
  }
  if (!state.douyinStartDate || !state.douyinEndDate || !dates.some(isDouyinDateSelected)) {
    selectDouyinDatePreset("day");
  }
  if (!state.douyinCalendarCursor) state.douyinCalendarCursor = `${dates[0].slice(0, 7)}-01`;
}

function douyinDateLabel() {
  const selected = selectedDouyinDates();
  if (!selected.length) return "暂无日期";
  if (selected.length === douyinAvailableDates().length && state.douyinDatePreset === "all") return "全部日期";
  if (selected.length === 1) return selected[0];
  return `${selected.at(-1)} 至 ${selected[0]}`;
}

function douyinCalendarMonthMarkup(monthValue: string, availableDates: Set<string>, rangeStart: string, rangeEnd: string) {
  const cursor = douyinCalendarMonthStart(monthValue);
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth() + 1;
  const firstWeekday = cursor.getUTCDay() || 7;
  const gridStart = new Date(Date.UTC(year, month - 1, 2 - firstWeekday));
  const today = douyinCalendarDate(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    const value = douyinCalendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const inMonth = date.getUTCMonth() + 1 === month;
    const available = availableDates.has(value);
    const inRange = Boolean(rangeStart && rangeEnd && value >= rangeStart && value <= rangeEnd);
    const isStart = value === rangeStart;
    const isEnd = value === rangeEnd;
    const classes = ["calendar-day", inMonth ? "" : "outside", available ? "available" : "unavailable", inRange ? "in-range" : "", isStart ? "range-start" : "", isEnd ? "range-end" : "", value === today ? "today" : ""].filter(Boolean).join(" ");
    return `<button class="${classes}" type="button" data-douyin-calendar-date="${value}" aria-label="${value}" ${inMonth && available ? "" : "disabled"}><span>${date.getUTCDate()}</span></button>`;
  }).join("");
  return `<section class="calendar-month" aria-label="${year}年${month}月"><h4>${year}年 ${month}月</h4><div class="calendar-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-days">${days}</div></section>`;
}

function douyinCalendarMarkup() {
  const dates = douyinAvailableDates();
  if (!dates.length) return `<div class="date-filter-field"><span>数据日期</span><button class="date-picker-trigger" type="button" disabled>暂无日期</button></div>`;
  const cursor = state.douyinCalendarCursor || `${dates[0].slice(0, 7)}-01`;
  const rangeStart = state.douyinCalendarRangeStart || state.douyinStartDate;
  const rangeEnd = state.douyinCalendarRangeStart ? state.douyinCalendarRangeStart : state.douyinEndDate;
  const hint = state.douyinCalendarRangeStart ? `已选择 ${state.douyinCalendarRangeStart}，可再选结束日期或直接确定单日` : "点击一天选择单日，或依次点击开始和结束日期";
  const presets: Array<["day" | "week" | "month" | "custom", string]> = [["day", "近 1 日"], ["week", "近 7 日"], ["month", "近 30 天"], ["custom", "自定义日期"]];
  const shortcuts = `<div class="date-shortcuts" role="group" aria-label="抖音日期快捷筛选">${presets.map(([key, label]) => `<button class="date-shortcut ${state.douyinDatePreset === key ? "active" : ""}" type="button" data-douyin-date-preset="${key}">${label}</button>`).join("")}</div>`;
  return `<div class="date-filter-field operation-date-filter"><span>数据日期</span>${shortcuts}<details class="date-range-picker" ${state.douyinCalendarOpen ? "open" : ""}><summary class="date-picker-trigger"><span>${escapeHtml(douyinDateLabel())}</span><i aria-hidden="true"></i></summary><div class="calendar-popover"><div class="calendar-toolbar"><button type="button" data-douyin-calendar-shift="-12" aria-label="上一年">«</button><button type="button" data-douyin-calendar-shift="-1" aria-label="上个月">‹</button><span>${escapeHtml(hint)}</span><button type="button" data-douyin-calendar-shift="1" aria-label="下个月">›</button><button type="button" data-douyin-calendar-shift="12" aria-label="下一年">»</button></div><div class="calendar-months">${douyinCalendarMonthMarkup(cursor, new Set(dates), rangeStart, rangeEnd)}${douyinCalendarMonthMarkup(shiftDouyinCalendarMonth(cursor, 1), new Set(dates), rangeStart, rangeEnd)}</div><div class="calendar-footer"><span>${selectedDouyinDates().length} 个数据日</span><div><button type="button" data-douyin-calendar-all>全部日期</button><button class="calendar-confirm" type="button" data-douyin-calendar-confirm>确定</button></div></div></div></details></div>`;
}

function douyinFiltersMarkup() {
  const shops = douyinShops();
  if (state.douyinShop && !shops.includes(state.douyinShop)) state.douyinShop = "";
  const options = `<option value="">全部店铺</option>${shops.map((shop) => `<option value="${escapeHtml(shop)}" ${state.douyinShop === shop ? "selected" : ""}>${escapeHtml(shop)}</option>`).join("")}`;
  const tags = [douyinDateLabel(), state.douyinShop ? `店铺：${state.douyinShop}` : "全部店铺"]
    .map((tag) => `<span class="filter-summary-tag">${escapeHtml(tag)}</span>`).join("");
  return `<section class="table-filter-panel douyin-filter-panel" aria-label="抖音数据范围筛选"><div><strong>抖音数据范围</strong></div><div class="filter-summary" aria-live="polite"><span class="filter-summary-label">当前范围</span>${tags}<button class="filter-reset" type="button" data-reset-douyin-filters>重置</button></div>${douyinCalendarMarkup()}<label>店铺<select data-douyin-shop aria-label="筛选店铺">${options}</select></label></section>`;
}

function positionDouyinCalendar() {
  const target = $("#douyin-content");
  const popover = target ? $(".calendar-popover", target) : null;
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

function yesterdayDate() {
  const value = new Date();
  value.setDate(value.getDate() - 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function sum(records: OperationRecord[], path: "metrics" | "content", key: string) {
  return records.reduce((total, record) => total + number(record[path]?.[key]), 0);
}

function compactTable(headers: string[], rows: string[][], empty: string) {
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}">${escapeHtml(empty)}</td></tr>`;
  return `<div class="table-wrap douyin-table"><table class="table-freeze-leading"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function sectionTabs() {
  return `<div class="douyin-tabs" role="tablist" aria-label="抖音业务板块">${SECTIONS.map(([key, label, note]) => `<button class="douyin-tab ${state.douyinSection === key ? "active" : ""}" type="button" role="tab" aria-selected="${state.douyinSection === key}" data-douyin-section="${key}"><span>${label}</span><small>${note}</small></button>`).join("")}</div>`;
}

function snapshotBanner(label: string, detail: string) {
  const dates = selectedDouyinDates();
  const snapshotLabel = dates.length === 1 ? (dates[0] === yesterdayDate() ? "昨日快照" : "历史快照") : `${dates.length} 日汇总`;
  return `<section class="douyin-snapshot"><div><span class="douyin-snapshot-dot" aria-hidden="true"></span><div><strong>${escapeHtml(label)} · ${snapshotLabel}</strong><small>${escapeHtml(detail)}</small></div></div><span class="douyin-date-chip">${escapeHtml(douyinDateLabel())}</span></section>`;
}

function metricCards(items: Array<[string, string, string]>) {
  return `<div class="metric-grid four douyin-metrics">${items.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${value}</div><div class="metric-delta">${escapeHtml(note)}</div></article>`).join("")}</div>`;
}

function contentSection(records: OperationRecord[], key: "live" | "video", label: string) {
  const scoped = records;
  const contentAmount = sum(scoped, "content", key);
  const income = sum(scoped, "metrics", "income_amt");
  const pay = sum(scoped, "metrics", "pay_amt");
  const orders = sum(scoped, "metrics", "pay_cnt");
  const sectionLabel = key === "live" ? "直播" : "短视频";
  const rows = scoped.sort((a, b) => number(b.content?.[key]) - number(a.content?.[key])).map((record) => [
    escapeHtml(record.date),
    escapeHtml(record.shop_name),
    moneyOrDash(record.content?.[key]),
    moneyOrDash(record.metrics?.income_amt),
    wholeOrDash(record.metrics?.pay_cnt),
    ratio(record.metrics?.income_amt ? number(record.content?.[key]) / number(record.metrics?.income_amt) : 0),
  ]);
  const metrics = [
    [`${sectionLabel}成交金额`, money(contentAmount), "经营快照载体分布"],
    ["全店成交金额", money(income), "用于计算内容贡献"],
    [`${sectionLabel}成交贡献`, ratio(income ? contentAmount / income : 0), "内容成交 ÷ 全店成交"],
    ["全店成交订单", whole(orders), "所选日期经营快照参照"],
  ] as Array<[string, string, string]>;
  const dedicatedNotice = key === "live"
    ? "直播间观看、开播时长与账号排行将在直播概览原始接口入库后展示。"
    : "播放、引流直播、看后搜与投放专属指标将在短视频原始接口入库后展示。";
  return `${snapshotBanner(label, "按所选数据日期汇总")}${metricCards(metrics)}<section class="panel douyin-callout"><div><strong>已同步经营日快照</strong><span>${dedicatedNotice}</span></div><span>数据范围：${escapeHtml(douyinDateLabel())}</span></section><section class="panel"><div class="panel-head"><div><h3>${sectionLabel}店铺贡献</h3><span>按所选日期的已入库经营快照</span></div><span class="chart-semantic">内容归因</span></div>${compactTable(["日期", "店铺", `${sectionLabel}成交`, "全店成交", "成交订单", "内容贡献"], rows, "所选日期暂未采集到店铺日快照")}</section>`;
}

function productCardSection(records: OperationRecord[]) {
  const scoped = records;
  const channelRecords: AnyRecord[] = (state.channel?.records || []).filter((record: AnyRecord) => isDouyinDateSelected(String(record.date || "")) && (!state.douyinShop || record.shop_name === state.douyinShop));
  const pay = sum(scoped, "content", "product_card");
  const exposure = sum(scoped, "metrics", "product_show_ucnt");
  const clicks = sum(scoped, "metrics", "product_click_ucnt");
  const buyers = sum(scoped, "metrics", "pay_ucnt");
  const productRows = channelRecords.flatMap((record) => (record.products || []).map((product: AnyRecord) => [
    escapeHtml(String(record.date || "—")),
    escapeHtml(String(record.shop_name || "当前店铺")),
    escapeHtml(String(product.product_name || product.product_id || "—")),
    moneyOrDash(product.pay_amt),
    wholeOrDash(product.show_ucnt),
    wholeOrDash(product.click_ucnt),
    product.click_rate === null || product.click_rate === undefined ? "—" : ratio(product.click_rate),
    product.click_pay_rate === null || product.click_pay_rate === undefined ? "—" : ratio(product.click_pay_rate),
  ]));
  return `${snapshotBanner("商品卡", "按所选数据日期汇总")}${metricCards([
    ["商品卡成交金额", money(pay), "经营快照载体分布"],
    ["商品曝光人数", whole(exposure), "所选日期全店商品流量"],
    ["商品点击人数", whole(clicks), `点击率 ${ratio(exposure ? clicks / exposure : 0)}`],
    ["点击至成交", ratio(clicks ? buyers / clicks : 0), "成交人数 ÷ 商品点击人数"],
  ])}<section class="panel"><div class="panel-head"><div><h3>商品卡表现</h3><span>商品卡接口已入库时展示明细</span></div><span class="chart-semantic">转化链路</span></div>${compactTable(["日期", "店铺", "商品", "支付金额", "曝光", "点击", "点击率", "点击成交率"], productRows, "所选日期暂未采集到商品卡明细。")}</section>`;
}

function collectedPanelSection() {
  const all = selectedSnapshots().filter((record) => isDouyinDateSelected(String(record.date || "")));
  const panels = all.flatMap((record) => (record.panels || []).map((panel: AnyRecord) => ({ ...panel, date: record.date, shop_name: record.shop_name })));
  const selected = panels.filter((panel) => panel.panel === state.douyinSection);
  const label = SECTIONS.find(([key]) => key === state.douyinSection)?.[1] || "抖音";
  const panelMetric = (panel: AnyRecord, key: string) => number(panel.metrics?.[key]);
  const panelMetricTotal = (key: string) => selected.reduce((total, panel) => total + panelMetric(panel, key), 0);
  const endpointRows = selected.flatMap((panel) => (panel.endpoints || []).map((endpoint: string) => [
    escapeHtml(String(panel.date || "—")),
    escapeHtml(String(panel.shop_name || "当前店铺")),
    escapeHtml(endpoint.split("/").at(-1) || endpoint),
    whole(panel.response_count),
  ]));
  const verification = `<details class="douyin-verification"><summary>查看采集校验详情</summary><p>每条日快照均已通过采集日期核验；以下仅用于追溯采集来源，不作为业务指标。</p>${compactTable(["日期", "店铺", "接口", "响应数"], endpointRows, "该板块没有可展示的接口元数据")}</details>`;
  if (!selected.length) {
    return `${snapshotBanner(label, "所选日期暂无该板块的有效快照")}<div class="empty-panel"><strong>所选日期暂无 ${escapeHtml(label)} 数据</strong><span>请切换其他日期范围或等待对应日快照完成采集。</span></div>`;
  }
  if (state.douyinSection === "product_card") {
    const products = selected.flatMap((panel) => (panel.products || []).map((product: AnyRecord) => ({ ...product, date: panel.date, shop_name: panel.shop_name })));
    const pay = products.reduce((total, product) => total + number(product.pay_amt), 0);
    const exposure = products.reduce((total, product) => total + number(product.show_ucnt), 0);
    const clicks = products.reduce((total, product) => total + number(product.click_ucnt), 0);
    const buyers = products.reduce((total, product) => total + number(product.pay_ucnt), 0);
    const rows = products.sort((left, right) => number(right.pay_amt) - number(left.pay_amt)).slice(0, 30).map((product) => [
      escapeHtml(String(product.date || "—")),
      escapeHtml(String(product.shop_name || "当前店铺")),
      escapeHtml(String(product.product_name || product.product_id || "—")),
      moneyOrDash(product.pay_amt),
      wholeOrDash(product.show_ucnt),
      wholeOrDash(product.click_ucnt),
      product.click_rate === null || product.click_rate === undefined ? "—" : ratio(product.click_rate),
      product.click_pay_rate === null || product.click_pay_rate === undefined ? "—" : ratio(product.click_pay_rate),
    ]);
    return `${snapshotBanner("商品卡", "按所选数据日期汇总")}${metricCards([
      ["商品卡成交金额", money(pay), "商品卡列表汇总"],
      ["商品曝光人数", whole(exposure), "商品卡明细汇总"],
      ["商品点击人数", whole(clicks), `点击率 ${ratio(exposure ? clicks / exposure : 0)}`],
      ["点击至成交", ratio(clicks ? buyers / clicks : 0), "成交人数 ÷ 商品点击人数"],
    ])}<section class="panel"><div class="panel-head"><div><h3>商品卡表现</h3><span>按支付金额排序 · 最多展示 30 个商品</span></div><span class="chart-semantic">商品转化</span></div>${compactTable(["日期", "店铺", "商品", "支付金额", "曝光", "点击", "点击率", "点击成交率"], rows, "所选日期未返回商品卡明细")}</section>${verification}`;
  }

  const isLive = state.douyinSection === "live";
  const metricSpec = isLive
    ? [["直播成交金额", "pay_amt", "money", "直播数据概览"], ["成交订单", "pay_cnt", "whole", "直播间支付订单"], ["观看人数", "watch_cnt", "whole", "直播间累计观看"], ["开播场次", "room_cnt", "whole", "所选日期开播直播间"]]
    : [["短视频成交金额", "pay_amt", "money", "短视频数据概览"], ["成交订单", "pay_cnt", "whole", "短视频支付订单"], ["商品曝光次数", "product_show_cnt", "whole", "短视频带货商品曝光"], ["引流店铺成交", "lead_shop_pay_amt", "money", "短视频引流店铺页"]];
  const typedMetricSpec = metricSpec as Array<[string, string, "money" | "whole", string]>;
  const metricValue = (key: string, kind: "money" | "whole") => kind === "money" ? money(panelMetricTotal(key)) : whole(panelMetricTotal(key));
  const rows = selected.sort((left, right) => panelMetric(right, "pay_amt") - panelMetric(left, "pay_amt")).map((panel) => [
    escapeHtml(String(panel.date || "—")),
    escapeHtml(String(panel.shop_name || "当前店铺")),
    moneyOrDash(panel.metrics?.pay_amt),
    wholeOrDash(panel.metrics?.pay_cnt),
    isLive ? wholeOrDash(panel.metrics?.watch_cnt) : wholeOrDash(panel.metrics?.product_show_cnt),
    isLive ? wholeOrDash(panel.metrics?.room_cnt) : moneyOrDash(panel.metrics?.lead_shop_pay_amt),
  ]);
  const headers = isLive ? ["日期", "店铺", "直播成交", "成交订单", "观看人数", "开播场次"] : ["日期", "店铺", "短视频成交", "成交订单", "商品曝光", "引流店铺成交"];
  return `${snapshotBanner(label, "按所选数据日期汇总")}${metricCards(typedMetricSpec.map(([name, key, kind, note]) => [name, metricValue(key, kind), note]))}<section class="panel"><div class="panel-head"><div><h3>${isLive ? "直播" : "短视频"}店铺表现</h3><span>按${isLive ? "直播" : "短视频"}成交金额排序</span></div><span class="chart-semantic">业务数据</span></div>${compactTable(headers, rows, "所选日期未返回可解析的业务指标")}</section>${verification}`;
}

export async function loadDouyin() {
  try {
    state.douyin = await request<DouyinDashboard>("/api/douyin");
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    state.douyin = { records: [] };
    showToast(errorMessage(error, "抖音面板数据读取失败。"), "error");
  }
  renderDouyin();
}

export function renderDouyin() {
  const target = $("#douyin-content");
  const freshness = $("#douyin-freshness");
  if (!target || !freshness) return;
  ensureDouyinDateSelection();
  const records = douyinRecords().filter((record) => isDouyinDateSelected(record.date));
  const selectedDates = selectedDouyinDates();
  freshness.textContent = selectedDates.length ? `${selectedDates.length} 日视图 · ${douyinDateLabel()}` : "暂无抖音日快照";
  const content = state.douyin?.records?.length
    ? collectedPanelSection()
    : !records.length
    ? `<div class="empty-panel"><strong>所选日期暂无抖音日快照</strong><span>请切换其他日期范围；若没有可选日期，请等待采集器写入首个快照。</span></div>`
    : state.douyinSection === "product_card"
      ? productCardSection(records)
      : contentSection(records, state.douyinSection, state.douyinSection === "live" ? "直播" : "短视频");
  target.innerHTML = `${douyinFiltersMarkup()}${sectionTabs()}${content}`;
  document.querySelector<HTMLSelectElement>("#douyin-content [data-douyin-shop]")?.addEventListener("change", (event) => {
    state.douyinShop = (event.currentTarget as HTMLSelectElement).value;
    state.douyinCalendarCursor = "";
    state.douyinCalendarRangeStart = "";
    state.douyinCalendarOpen = false;
    renderDouyin();
  });
  $("#douyin-content [data-reset-douyin-filters]")?.addEventListener("click", () => {
    state.douyinShop = "";
    state.douyinCalendarCursor = "";
    selectDouyinDatePreset("day");
    renderDouyin();
  });
  $$("#douyin-content [data-douyin-date-preset]").forEach((button) => button.addEventListener("click", () => {
    const preset = button.dataset.douyinDatePreset as "day" | "week" | "month" | "custom";
    if (preset === "custom") {
      state.douyinDatePreset = "custom";
      state.douyinCalendarOpen = true;
    } else {
      selectDouyinDatePreset(preset);
    }
    renderDouyin();
  }));
  const picker = $("#douyin-content .date-range-picker");
  picker?.addEventListener("toggle", () => {
    state.douyinCalendarOpen = picker.open;
    if (!picker.open) state.douyinCalendarRangeStart = "";
    else window.requestAnimationFrame(positionDouyinCalendar);
  });
  $$("#douyin-content [data-douyin-calendar-shift]").forEach((button) => button.addEventListener("click", () => {
    const dates = douyinAvailableDates();
    state.douyinCalendarCursor = shiftDouyinCalendarMonth(state.douyinCalendarCursor || `${dates[0].slice(0, 7)}-01`, number(button.dataset.douyinCalendarShift));
    state.douyinCalendarOpen = true;
    renderDouyin();
  }));
  $$("#douyin-content [data-douyin-calendar-date]").forEach((button) => button.addEventListener("click", () => {
    const value = button.dataset.douyinCalendarDate;
    if (!state.douyinCalendarRangeStart) {
      state.douyinStartDate = value;
      state.douyinEndDate = value;
      state.douyinCalendarRangeStart = value;
      state.douyinDatePreset = "custom";
      state.douyinCalendarOpen = true;
    } else {
      state.douyinStartDate = value < state.douyinCalendarRangeStart ? value : state.douyinCalendarRangeStart;
      state.douyinEndDate = value < state.douyinCalendarRangeStart ? state.douyinCalendarRangeStart : value;
      state.douyinCalendarRangeStart = "";
      state.douyinDatePreset = "custom";
      state.douyinCalendarOpen = false;
    }
    renderDouyin();
  }));
  $("#douyin-content [data-douyin-calendar-all]")?.addEventListener("click", () => {
    selectDouyinDatePreset("all");
    renderDouyin();
  });
  $("#douyin-content [data-douyin-calendar-confirm]")?.addEventListener("click", () => {
    state.douyinCalendarRangeStart = "";
    state.douyinCalendarOpen = false;
    renderDouyin();
  });
  document.querySelectorAll<HTMLElement>("#douyin-content [data-douyin-section]").forEach((button) => button.addEventListener("click", () => {
    state.douyinSection = button.dataset.douyinSection as DouyinSection;
    renderDouyin();
  }));
  if (state.douyinCalendarOpen) window.requestAnimationFrame(positionDouyinCalendar);
}
