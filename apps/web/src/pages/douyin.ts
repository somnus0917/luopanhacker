import { $ } from "../dom";
import { escapeHtml, money, moneyOrDash, number, ratio, whole, wholeOrDash } from "../format";
import { state, type AnyRecord, type OperationRecord } from "../state";

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
  return state.records.filter(isDouyinRecord);
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
  const channelRecords: AnyRecord[] = (state.channel?.records || []).filter((record: AnyRecord) => record.date === date);
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

export function renderDouyin() {
  const target = $("#douyin-content");
  const freshness = $("#douyin-freshness");
  if (!target || !freshness) return;
  const records = douyinRecords();
  const date = latestDate(records);
  freshness.textContent = date ? `${date === yesterdayDate() ? "昨日" : "最近"}快照 · ${date}` : "暂无抖音日快照";
  const content = !records.length
    ? `<div class="empty-panel"><strong>等待首个抖音日快照</strong><span>采集器会先在罗盘选择“近 1 天”，验证为昨天后才写入面板。</span></div>`
    : state.douyinSection === "product_card"
      ? productCardSection(records)
      : contentSection(records, state.douyinSection, state.douyinSection === "live" ? "直播" : "短视频");
  target.innerHTML = `${sectionTabs()}${content}`;
  document.querySelectorAll<HTMLElement>("#douyin-content [data-douyin-section]").forEach((button) => button.addEventListener("click", () => {
    state.douyinSection = button.dataset.douyinSection as DouyinSection;
    renderDouyin();
  }));
}
