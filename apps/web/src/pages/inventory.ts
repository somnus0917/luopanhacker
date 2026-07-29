import { $, $$ } from "../dom";
import { escapeHtml, money, number, whole } from "../format";
import { state } from "../state";
import type { AnyRecord } from "../state";
import { showLogin } from "./account";

function sortRows(rows: AnyRecord[], key: string, dir: string): AnyRecord[] {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const av = number(a[key]), bv = number(b[key]);
    return dir === "asc" ? av - bv : bv - av;
  });
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

function inventoryWarehouseOptions(payload): string[] {
  return [...new Set<string>((payload.rows || []).map((item) => item.warehouse_name || "未命名仓库"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function inventoryBrandOptions(payload): string[] {
  return [...new Set<string>((payload.rows || []).map((item) => item.brand_name || "未归类品牌"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function inventoryFilteredRows(payload) {
  const warehouses = inventoryWarehouseOptions(payload);
  const brands = inventoryBrandOptions(payload);
  if (state.inventoryWarehouse && !warehouses.includes(state.inventoryWarehouse)) state.inventoryWarehouse = "";
  if (state.inventoryBrand && !brands.includes(state.inventoryBrand)) state.inventoryBrand = "";
  return (payload.rows || []).filter((item) => {
    const warehouseMatch = !state.inventoryWarehouse || (item.warehouse_name || "未命名仓库") === state.inventoryWarehouse;
    const brandMatch = !state.inventoryBrand || (item.brand_name || "未归类品牌") === state.inventoryBrand;
    return warehouseMatch && brandMatch;
  });
}

function inventoryGroup(rows, keyName) {
  const groups = new Map<string, AnyRecord>();
  rows.forEach((row) => {
    const name = row[keyName] || "未归类";
    const group = groups.get(name) || { name, sku_records: 0, stock_num: 0, available_num: 0, sales_7d: 0, inbound_30d: 0, negative_available: 0 };
    group.sku_records += 1;
    ["stock_num", "available_num", "sales_7d", "inbound_30d"].forEach((key) => group[key] += number(row[key]));
    group.negative_available += number(row.available_num) < 0 ? 1 : 0;
    groups.set(name, group);
  });
  return [...groups.values()].map((group): AnyRecord => ({
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
  if (state.inventoryWarehouse) return payload.sales_trend_7d_by_warehouse?.[state.inventoryWarehouse] || [];
  if (state.inventoryBrand) return payload.sales_trend_7d_by_brand?.[state.inventoryBrand] || [];
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

export function renderInventory(payload, view = state.inventoryView) {
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

export async function loadInventory() {
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
