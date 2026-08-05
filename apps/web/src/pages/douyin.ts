import { $ } from "../dom";
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

function shopFilter() {
  const shops = douyinShops();
  if (state.douyinShop && !shops.includes(state.douyinShop)) state.douyinShop = "";
  return `<label class="douyin-shop-filter"><span>店铺</span><select data-douyin-shop aria-label="筛选店铺"><option value="">全部店铺</option>${shops.map((shop) => `<option value="${escapeHtml(shop)}" ${state.douyinShop === shop ? "selected" : ""}>${escapeHtml(shop)}</option>`).join("")}</select></label>`;
}

function latestDate(records: OperationRecord[]) {
  return [...new Set(records.map((record) => record.date))].sort().at(-1) ?? "";
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

function snapshotBanner(date: string, label: string, detail: string) {
  const snapshotLabel = date === yesterdayDate() ? "昨日快照" : "最近快照";
  return `<section class="douyin-snapshot"><div><span class="douyin-snapshot-dot" aria-hidden="true"></span><div><strong>${escapeHtml(label)} · ${snapshotLabel}</strong><small>${escapeHtml(detail)}</small></div></div><span class="douyin-date-chip">${escapeHtml(date || "等待数据")}</span></section>`;
}

function metricCards(items: Array<[string, string, string]>) {
  return `<div class="metric-grid four douyin-metrics">${items.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${value}</div><div class="metric-delta">${escapeHtml(note)}</div></article>`).join("")}</div>`;
}

function contentSection(records: OperationRecord[], key: "live" | "video", label: string) {
  const date = latestDate(records);
  const scoped = records.filter((record) => record.date === date);
  const contentAmount = sum(scoped, "content", key);
  const income = sum(scoped, "metrics", "income_amt");
  const pay = sum(scoped, "metrics", "pay_amt");
  const orders = sum(scoped, "metrics", "pay_cnt");
  const sectionLabel = key === "live" ? "直播" : "短视频";
  const rows = scoped.sort((a, b) => number(b.content?.[key]) - number(a.content?.[key])).map((record) => [
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
    ["全店成交订单", whole(orders), "昨日经营快照参照"],
  ] as Array<[string, string, string]>;
  const dedicatedNotice = key === "live"
    ? "直播间观看、开播时长与账号排行将在直播概览原始接口入库后展示。"
    : "播放、引流直播、看后搜与投放专属指标将在短视频原始接口入库后展示。";
  return `${snapshotBanner(date, label, key === "live" ? "已验证：数据概览 → 近 1 天" : "已验证：近 1 天")}${metricCards(metrics)}<section class="panel douyin-callout"><div><strong>已同步经营日快照</strong><span>${dedicatedNotice}</span></div><span>数据范围：${escapeHtml(date || "—")}</span></section><section class="panel"><div class="panel-head"><div><h3>${sectionLabel}店铺贡献</h3><span>按昨日已入库经营快照</span></div><span class="chart-semantic">内容归因</span></div>${compactTable(["店铺", `${sectionLabel}成交`, "全店成交", "成交订单", "内容贡献"], rows, "暂未采集到店铺日快照")}</section>`;
}

function productCardSection(records: OperationRecord[]) {
  const date = latestDate(records);
  const scoped = records.filter((record) => record.date === date);
  const channelRecords: AnyRecord[] = (state.channel?.records || []).filter((record: AnyRecord) => record.date === date && (!state.douyinShop || record.shop_name === state.douyinShop));
  const pay = sum(scoped, "content", "product_card");
  const exposure = sum(scoped, "metrics", "product_show_ucnt");
  const clicks = sum(scoped, "metrics", "product_click_ucnt");
  const buyers = sum(scoped, "metrics", "pay_ucnt");
  const productRows = channelRecords.flatMap((record) => (record.products || []).map((product: AnyRecord) => [
    escapeHtml(String(record.shop_name || "当前店铺")),
    escapeHtml(String(product.product_name || product.product_id || "—")),
    moneyOrDash(product.pay_amt),
    wholeOrDash(product.show_ucnt),
    wholeOrDash(product.click_ucnt),
    product.click_rate === null || product.click_rate === undefined ? "—" : ratio(product.click_rate),
    product.click_pay_rate === null || product.click_pay_rate === undefined ? "—" : ratio(product.click_pay_rate),
  ]));
  return `${snapshotBanner(date, "商品卡", "已验证：近 1 天 → 商品卡列表")}${metricCards([
    ["商品卡成交金额", money(pay), "经营快照载体分布"],
    ["商品曝光人数", whole(exposure), "昨日全店商品流量"],
    ["商品点击人数", whole(clicks), `点击率 ${ratio(exposure ? clicks / exposure : 0)}`],
    ["点击至成交", ratio(clicks ? buyers / clicks : 0), "成交人数 ÷ 商品点击人数"],
  ])}<section class="panel"><div class="panel-head"><div><h3>商品卡表现</h3><span>商品卡接口已入库时展示明细</span></div><span class="chart-semantic">转化链路</span></div>${compactTable(["店铺", "商品", "支付金额", "曝光", "点击", "点击率", "点击成交率"], productRows, "暂未采集到商品卡明细；下次渠道采集完成后会在此展示。")}</section>`;
}

function collectedPanelSection() {
  const all = selectedSnapshots();
  const date = [...new Set(all.map((record) => String(record.date || "")))].filter(Boolean).sort().at(-1) || "";
  const panels = all.filter((record) => record.date === date).flatMap((record) => (record.panels || []).map((panel: AnyRecord) => ({ ...panel, shop_name: record.shop_name })));
  const selected = panels.filter((panel) => panel.panel === state.douyinSection);
  const label = SECTIONS.find(([key]) => key === state.douyinSection)?.[1] || "抖音";
  const panelMetric = (panel: AnyRecord, key: string) => number(panel.metrics?.[key]);
  const panelMetricTotal = (key: string) => selected.reduce((total, panel) => total + panelMetric(panel, key), 0);
  const endpointRows = selected.flatMap((panel) => (panel.endpoints || []).map((endpoint: string) => [
    escapeHtml(String(panel.shop_name || "当前店铺")),
    escapeHtml(endpoint.split("/").at(-1) || endpoint),
    whole(panel.response_count),
  ]));
  const verification = `<details class="douyin-verification"><summary>查看采集校验详情</summary><p>已通过“近 1 天”日期核验；以下仅用于追溯采集来源，不作为业务指标。</p>${compactTable(["店铺", "接口", "响应数"], endpointRows, "该板块没有可展示的接口元数据")}</details>`;
  if (!selected.length) {
    return `${snapshotBanner(date, label, "暂无该板块的有效昨日快照")}<div class="empty-panel"><strong>等待 ${escapeHtml(label)} 数据</strong><span>采集会在页面中点击“近 1 天”，并在直播页先进入“数据概览”。</span></div>`;
  }
  if (state.douyinSection === "product_card") {
    const products = selected.flatMap((panel) => (panel.products || []).map((product: AnyRecord) => ({ ...product, shop_name: panel.shop_name })));
    const pay = products.reduce((total, product) => total + number(product.pay_amt), 0);
    const exposure = products.reduce((total, product) => total + number(product.show_ucnt), 0);
    const clicks = products.reduce((total, product) => total + number(product.click_ucnt), 0);
    const buyers = products.reduce((total, product) => total + number(product.pay_ucnt), 0);
    const rows = products.sort((left, right) => number(right.pay_amt) - number(left.pay_amt)).slice(0, 30).map((product) => [
      escapeHtml(String(product.shop_name || "当前店铺")),
      escapeHtml(String(product.product_name || product.product_id || "—")),
      moneyOrDash(product.pay_amt),
      wholeOrDash(product.show_ucnt),
      wholeOrDash(product.click_ucnt),
      product.click_rate === null || product.click_rate === undefined ? "—" : ratio(product.click_rate),
      product.click_pay_rate === null || product.click_pay_rate === undefined ? "—" : ratio(product.click_pay_rate),
    ]);
    return `${snapshotBanner(date, "商品卡", "已验证：近 1 天 → 商品卡列表")}${metricCards([
      ["商品卡成交金额", money(pay), "商品卡列表汇总"],
      ["商品曝光人数", whole(exposure), "商品卡明细汇总"],
      ["商品点击人数", whole(clicks), `点击率 ${ratio(exposure ? clicks / exposure : 0)}`],
      ["点击至成交", ratio(clicks ? buyers / clicks : 0), "成交人数 ÷ 商品点击人数"],
    ])}<section class="panel"><div class="panel-head"><div><h3>商品卡表现</h3><span>按支付金额排序 · 最多展示 30 个商品</span></div><span class="chart-semantic">商品转化</span></div>${compactTable(["店铺", "商品", "支付金额", "曝光", "点击", "点击率", "点击成交率"], rows, "该日期未返回商品卡明细")}</section>${verification}`;
  }

  const isLive = state.douyinSection === "live";
  const metricSpec = isLive
    ? [["直播成交金额", "pay_amt", "money", "直播数据概览"], ["成交订单", "pay_cnt", "whole", "直播间支付订单"], ["观看人数", "watch_cnt", "whole", "直播间累计观看"], ["开播场次", "room_cnt", "whole", "昨日开播直播间"]]
    : [["短视频成交金额", "pay_amt", "money", "短视频数据概览"], ["成交订单", "pay_cnt", "whole", "短视频支付订单"], ["商品曝光次数", "product_show_cnt", "whole", "短视频带货商品曝光"], ["引流店铺成交", "lead_shop_pay_amt", "money", "短视频引流店铺页"]];
  const typedMetricSpec = metricSpec as Array<[string, string, "money" | "whole", string]>;
  const metricValue = (key: string, kind: "money" | "whole") => kind === "money" ? money(panelMetricTotal(key)) : whole(panelMetricTotal(key));
  const rows = selected.sort((left, right) => panelMetric(right, "pay_amt") - panelMetric(left, "pay_amt")).map((panel) => [
    escapeHtml(String(panel.shop_name || "当前店铺")),
    moneyOrDash(panel.metrics?.pay_amt),
    wholeOrDash(panel.metrics?.pay_cnt),
    isLive ? wholeOrDash(panel.metrics?.watch_cnt) : wholeOrDash(panel.metrics?.product_show_cnt),
    isLive ? wholeOrDash(panel.metrics?.room_cnt) : moneyOrDash(panel.metrics?.lead_shop_pay_amt),
  ]);
  const headers = isLive ? ["店铺", "直播成交", "成交订单", "观看人数", "开播场次"] : ["店铺", "短视频成交", "成交订单", "商品曝光", "引流店铺成交"];
  return `${snapshotBanner(date, label, isLive ? "已验证：数据概览 → 近 1 天" : "已验证：近 1 天")}${metricCards(typedMetricSpec.map(([name, key, kind, note]) => [name, metricValue(key, kind), note]))}<section class="panel"><div class="panel-head"><div><h3>${isLive ? "直播" : "短视频"}店铺表现</h3><span>按${isLive ? "直播" : "短视频"}成交金额排序</span></div><span class="chart-semantic">业务数据</span></div>${compactTable(headers, rows, "该日期未返回可解析的业务指标")}</section>${verification}`;
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
  const records = douyinRecords();
  const snapshots = selectedSnapshots();
  const date = snapshots.length
    ? [...new Set(snapshots.map((record) => String(record.date || "")))].filter(Boolean).sort().at(-1) || ""
    : latestDate(records);
  freshness.textContent = date ? `${date === yesterdayDate() ? "昨日" : "最近"}快照 · ${date}` : "暂无抖音日快照";
  const content = state.douyin?.records?.length
    ? collectedPanelSection()
    : !records.length
    ? `<div class="empty-panel"><strong>等待首个抖音日快照</strong><span>采集器会先在罗盘选择“近 1 天”，验证为昨天后才写入面板。</span></div>`
    : state.douyinSection === "product_card"
      ? productCardSection(records)
      : contentSection(records, state.douyinSection, state.douyinSection === "live" ? "直播" : "短视频");
  target.innerHTML = `${shopFilter()}${sectionTabs()}${content}`;
  document.querySelector<HTMLSelectElement>("#douyin-content [data-douyin-shop]")?.addEventListener("change", (event) => {
    state.douyinShop = (event.currentTarget as HTMLSelectElement).value;
    renderDouyin();
  });
  document.querySelectorAll<HTMLElement>("#douyin-content [data-douyin-section]").forEach((button) => button.addEventListener("click", () => {
    state.douyinSection = button.dataset.douyinSection as DouyinSection;
    renderDouyin();
  }));
}
