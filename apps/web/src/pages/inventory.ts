import { $, $$ } from "../dom";
import { errorMessage, isApiRequestError, request } from "../api";
import { showToast } from "../feedback";
import { escapeHtml, importTime, number, settlementMoney, whole } from "../format";
import { isAdmin, state } from "../state";
import type { AnyRecord } from "../state";
import type { InventoryView } from "../types";
import { showLogin } from "./account";

export function sortRows(
  rows: AnyRecord[],
  key: string,
  dir: string,
): AnyRecord[] {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const av = number(a[key]),
      bv = number(b[key]);
    return dir === "asc" ? av - bv : bv - av;
  });
}

function inventoryDays(value: unknown) {
  return value === null || value === undefined
    ? "—"
    : `${number(value).toFixed(1)} 天`;
}

function coverageDays(value: unknown) {
  return value === null || value === undefined
    ? "—"
    : `${Math.ceil(number(value))} 天`;
}

function costMoney(value: unknown) {
  return value === null || value === undefined ? "—" : settlementMoney(value);
}

function summaryCostMoney(value: unknown) {
  if (value === null || value === undefined) return "—";

  const amount = number(value);

  if (Math.abs(amount) >= 100_000_000) {
    return `¥${(amount / 100_000_000).toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}亿`;
  }

  if (Math.abs(amount) >= 10_000) {
    return `¥${(amount / 10_000).toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}万`;
  }

  return settlementMoney(amount);
}

const INVENTORY_HEALTH_ORDER = [
  "out_of_stock",
  "urgent",
  "replenish",
  "healthy",
  "high",
  "overstock",
  "no_movement",
  "unavailable",
];

const INVENTORY_HEALTH_NAMES: Record<string, string> = {
  out_of_stock: "已缺货",
  urgent: "紧急补货",
  replenish: "需安排补货",
  healthy: "库存健康",
  high: "库存偏高",
  overstock: "库存积压",
  no_movement: "近 7 日未动销",
  unavailable: "暂无可售",
};

function inventoryWarehouseOptions(payload: AnyRecord): string[] {
  return [
    ...new Set<string>(
      (payload.rows || []).map(
        (item: AnyRecord) => item.warehouse_name || "未命名仓库",
      ),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function inventoryBrandOptions(payload: AnyRecord): string[] {
  return [
    ...new Set<string>(
      (payload.rows || []).map(
        (item: AnyRecord) => item.brand_name || "未归类品牌",
      ),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function inventoryFilteredRows(payload: AnyRecord): AnyRecord[] {
  const warehouses = inventoryWarehouseOptions(payload);
  const brands = inventoryBrandOptions(payload);
  if (
    state.inventoryWarehouse &&
    !warehouses.includes(state.inventoryWarehouse)
  )
    state.inventoryWarehouse = "";
  if (state.inventoryBrand && !brands.includes(state.inventoryBrand))
    state.inventoryBrand = "";
  return (payload.rows || []).filter((item: AnyRecord) => {
    const warehouseMatch =
      !state.inventoryWarehouse ||
      (item.warehouse_name || "未命名仓库") === state.inventoryWarehouse;
    const brandMatch =
      !state.inventoryBrand ||
      (item.brand_name || "未归类品牌") === state.inventoryBrand;
    return warehouseMatch && brandMatch;
  });
}

function inventoryGroup(rows: AnyRecord[], keyName: string): AnyRecord[] {
  const groups = new Map<string, AnyRecord>();
  rows.forEach((row) => {
    const name = row[keyName] || "未归类";
    const group = groups.get(name) || {
      name,
      sku_records: 0,
      stock_num: 0,
      available_num: 0,
      sales_7d: 0,
      inbound_30d: 0,
      available_cost_amount: 0,
      cost_covered_records: 0,
      negative_available: 0,
    };
    group.sku_records += 1;
    ["stock_num", "available_num", "sales_7d", "inbound_30d", "available_cost_amount"].forEach(
      (key) => (group[key] += number(row[key])),
    );
    group.cost_covered_records += row.cost_covered ? 1 : 0;
    group.negative_available += number(row.available_num) < 0 ? 1 : 0;
    groups.set(name, group);
  });
  return [...groups.values()]
    .map((group): AnyRecord => ({
      ...group,
      turnover_days: group.sales_7d
        ? group.available_num / (group.sales_7d / 7)
        : null,
    }))
    .sort((a, b) => number(b.available_num) - number(a.available_num));
}

export function inventoryHealth(rows: AnyRecord[]) {
  return INVENTORY_HEALTH_ORDER.map((key) => {
    const members = rows.filter((row) => row.health_key === key);
    return {
      key,
      name: INVENTORY_HEALTH_NAMES[key],
      sku_records: members.length,
      available_num: members.reduce(
        (sum, row) => sum + number(row.available_num),
        0,
      ),
    };
  });
}

export function inventorySummary(rows: AnyRecord[]) {
  const coverageRows = rows.filter(
    (row) =>
      row.coverage_days !== null &&
      row.coverage_days !== undefined &&
      number(row.sales_7d) > 0,
  );
  const available = rows.reduce(
    (sum, row) => sum + number(row.available_num),
    0,
  );
  const sales7d = rows.reduce((sum, row) => sum + number(row.sales_7d), 0);
  const costRows = rows.filter((row) => row.cost_covered);
  return {
    sku_records: rows.length,
    distinct_skus: new Set(rows.map((row) => row.spec_no).filter(Boolean)).size,
    salable_skus: new Set(
      rows
        .filter((row) => number(row.available_num) > 0)
        .map((row) => row.spec_no)
        .filter(Boolean),
    ).size,
    stock_num: rows.reduce((sum, row) => sum + number(row.stock_num), 0),
    available_num: available,
    sales_7d: sales7d,
    inbound_30d: rows.reduce((sum, row) => sum + number(row.inbound_30d), 0),
    negative_available: rows.filter((row) => number(row.available_num) < 0)
      .length,
    turnover_days: sales7d ? available / (sales7d / 7) : null,
    inventory_turnover_days: sales7d
      ? rows.reduce((sum, row) => sum + number(row.stock_num), 0) /
        (sales7d / 7)
      : null,
    average_coverage_days: coverageRows.length
      ? coverageRows.reduce((sum, row) => sum + number(row.coverage_days), 0) /
        coverageRows.length
      : null,
    replenishment_records: rows.filter((row) =>
      ["out_of_stock", "urgent", "replenish"].includes(row.health_key),
    ).length,
    no_movement_records: rows.filter((row) => row.health_key === "no_movement")
      .length,
    overstock_records: rows.filter((row) =>
      ["overstock", "high"].includes(row.health_key),
    ).length,
    cost_covered_records: costRows.length,
    cost_coverage_rate: rows.length ? costRows.length / rows.length : null,
    stock_cost_amount: costRows.length
      ? costRows.reduce((sum, row) => sum + number(row.stock_cost_amount), 0)
      : null,
    available_cost_amount: costRows.length
      ? costRows.reduce(
          (sum, row) => sum + number(row.available_cost_amount),
          0,
        )
      : null,
  };
}

function inventorySalesTrend(payload: AnyRecord): AnyRecord[] {
  if (state.inventoryWarehouse && state.inventoryBrand) {
    return (
      payload.sales_trend_7d_by_warehouse_brand?.[state.inventoryWarehouse]?.[
        state.inventoryBrand
      ] || []
    );
  }
  if (state.inventoryWarehouse)
    return (
      payload.sales_trend_7d_by_warehouse?.[state.inventoryWarehouse] || []
    );
  if (state.inventoryBrand)
    return payload.sales_trend_7d_by_brand?.[state.inventoryBrand] || [];
  return payload.sales_trend_7d || [];
}

function inventoryWarehouseFilter(payload: AnyRecord): string {
  const warehouses = inventoryWarehouseOptions(payload);
  const brands = inventoryBrandOptions(payload);
  const warehouseOptions = `<option value="">全部仓库</option>${warehouses.map((name) => `<option value="${escapeHtml(name)}" ${state.inventoryWarehouse === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  const brandOptions = `<option value="">全部品牌</option>${brands.map((name) => `<option value="${escapeHtml(name)}" ${state.inventoryBrand === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  const tags = [
    state.inventoryWarehouse ? `仓库：${state.inventoryWarehouse}` : "全部仓库",
    state.inventoryBrand ? `品牌：${state.inventoryBrand}` : "全部品牌",
  ]
    .map((tag) => `<span class="filter-summary-tag">${escapeHtml(tag)}</span>`)
    .join("");
  return `<section class="table-filter-panel inventory-filter" aria-label="库存筛选"><div><strong>库存筛选</strong></div><div class="filter-summary" aria-live="polite"><span class="filter-summary-label">当前范围</span>${tags}<button class="filter-reset" type="button" data-reset-inventory-filters>重置</button></div><label>仓库<select data-inventory-filter="warehouse">${warehouseOptions}</select></label><label>品牌<select data-inventory-filter="brand">${brandOptions}</select></label></section>`;
}

function inventoryBarPanel(
  items: AnyRecord[],
  title: string,
  key: string,
  formatter: (value: unknown) => string = whole,
) {
  const top = [...items]
    .sort((a, b) => number(b[key]) - number(a[key]))
    .slice(0, 10);
  const max = Math.max(...top.map((item) => number(item[key])), 1);
  const bars = top
    .map(
      (item) =>
        `<div class="bar-row"><span class="bar-label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, (number(item[key]) / max) * 100)}%"></div></div><span class="bar-value">${formatter(item[key])}</span></div>`,
    )
    .join("");
  return `<section class="panel"><div class="panel-head"><div><h3>${title}</h3><span>按可发库存排序 · 前 10</span></div></div>${bars || "<span class='metric-delta'>暂无数据</span>"}</section>`;
}

function warehouseDistributionPanel(items: AnyRecord[]) {
  const rows = items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${whole(item.available_num)}</td><td>${item.cost_covered_records ? summaryCostMoney(item.available_cost_amount) : "—"}</td></tr>`).join("");
  return `<details class="panel detail-table-disclosure warehouse-distribution"><summary><span>仓库分布</span><small>可发库存数量与已覆盖成本金额 · ${whole(items.length)} 个仓库</small></summary><div class="detail-table-content"><div class="table-wrap"><table class="table-freeze-leading"><thead><tr><th>仓库名</th><th>可发库存数量</th><th>可发库存金额</th></tr></thead><tbody>${rows || "<tr><td colspan=\"3\">暂无仓库数据</td></tr>"}</tbody></table></div></div></details>`;
}

function healthPill(item: AnyRecord) {
  return `<span class="health-pill ${escapeHtml(item.health_key || item.key)}">${escapeHtml(item.health_name || item.name)}</span>`;
}

function inventoryTable(rows: AnyRecord[], mode = "detail") {
  const total = rows.length;
  const rowsWithTurnover = rows.map((item) => ({
    ...item,
    inventory_turnover_days: number(item.sales_7d)
      ? number(item.stock_num) / (number(item.sales_7d) / 7)
      : null,
  }));
  const columnConfigs =
    mode === "replenish"
      ? [
          { label: "状态", key: "" },
          { label: "仓库", key: "" },
          { label: "货品", key: "" },
          { label: "商家编码", key: "" },
          { label: "可发库存", key: "available_num" },
          { label: "近 7 天出库", key: "sales_7d" },
          { label: "预计可售", key: "coverage_days" },
          { label: "建议补货", key: "replenish_qty" },
          { label: "近 30 天入库", key: "inbound_30d" },
        ]
      : [
          { label: "状态", key: "" },
          { label: "仓库", key: "" },
          { label: "品牌", key: "" },
          { label: "货品", key: "" },
          { label: "商家编码", key: "" },
          { label: "可发库存", key: "available_num" },
          { label: "成本单价", key: "cost_price" },
          { label: "库存成本", key: "stock_cost_amount" },
          { label: "可售库存成本", key: "available_cost_amount" },
          { label: "近 7 天出库", key: "sales_7d" },
          { label: "预计可售", key: "coverage_days" },
          { label: "周转天数", key: "inventory_turnover_days" },
          { label: "近 30 天入库", key: "inbound_30d" },
          { label: "最后出入库", key: "" },
        ];
  const sorted = sortRows(
    rowsWithTurnover,
    state.inventorySortKey,
    state.inventorySortDir,
  );
  const visible = sorted.slice(0, 200);
  const body = visible
    .map((item) => {
      const shared = [
        healthPill(item),
        item.warehouse_name,
        item.goods_name,
        item.spec_no,
        whole(item.available_num),
        whole(item.sales_7d),
        coverageDays(item.coverage_days),
        whole(item.replenish_qty),
        whole(item.inbound_30d),
      ];
      const cells =
        mode === "replenish"
          ? shared
          : [
              healthPill(item),
              item.warehouse_name,
              item.brand_name,
              item.goods_name,
              item.spec_no,
              whole(item.available_num),
              item.cost_covered ? costMoney(item.cost_price) : "—",
              costMoney(item.stock_cost_amount),
              costMoney(item.available_cost_amount),
              whole(item.sales_7d),
              coverageDays(item.coverage_days),
              inventoryDays(item.inventory_turnover_days),
              whole(item.inbound_30d),
              item.last_inout_time || "—",
            ];
      return `<tr class="${number(item.available_num) < 0 ? "inventory-alert" : ""}">${cells.map((cell, index) => `<td>${index === 0 ? cell : escapeHtml(cell)}</td>`).join("")}</tr>`;
    })
    .join("");
  const notice =
    total > 200
      ? `<p class="table-truncate-note">共 ${whole(total)} 条，当前显示前 200 条，可通过筛选缩小范围</p>`
      : "";
  const headerCells = columnConfigs
    .map(
      (col) =>
        `<th ${col.key ? `data-sort-key="${col.key}"` : ""} class="${state.inventorySortKey === col.key ? "sorted-" + state.inventorySortDir : ""}">${col.label}</th>`,
    )
    .join("");
  return `${notice}<div class="table-wrap"><table class="table-freeze-leading"><thead><tr>${headerCells}</tr></thead><tbody>${body || `<tr><td colspan="${columnConfigs.length}">暂无符合条件的库存记录</td></tr>`}</tbody></table></div>`;
}

function healthDistribution(items: AnyRecord[]) {
  const max = Math.max(...items.map((item) => number(item.sku_records)), 1);
  const cards = items
    .map(
      (item) =>
        `<div class="health-row"><div class="health-row-head">${healthPill(item)}<strong>${whole(item.sku_records)} 条</strong></div><div class="health-track"><i class="${escapeHtml(item.key)}" style="width:${Math.max(2, (number(item.sku_records) / max) * 100)}%"></i></div><span>可发 ${whole(item.available_num)}</span></div>`,
    )
    .join("");
  return `<section class="panel health-panel"><div class="panel-head"><div><h3>库存健康结构</h3><span>按仓库 × SKU 记录划分</span></div></div>${cards}</section>`;
}

function salesTrendPanel(items: AnyRecord[]) {
  const max = Math.max(...items.map((item) => number(item.quantity)), 1);
  const bars = items
    .map(
      (item) =>
        `<div class="sales-day"><span>${escapeHtml(String(item.date || "").slice(5) || "—")}</span><div class="sales-column"><i style="height:${Math.max(4, (number(item.quantity) / max) * 100)}%"></i></div><strong>${whole(item.quantity)}</strong></div>`,
    )
    .join("");
  return `<section class="panel sales-trend"><div class="panel-head"><div><h3>近 7 天销售出库</h3><span>按出库日期汇总</span></div></div><div class="sales-days">${bars || "<span class='metric-delta'>暂无销售出库明细</span>"}</div></section>`;
}

function inventoryTabs(view: string) {
  const tabs = [
    ["overview", "总览"],
    ["replenish", "补货清单"],
    ["overstock", "积压 / 未动销"],
    ["detail", "单品维度"],
  ];
  return `<div class="inventory-tabs" role="tablist">${tabs.map(([key, label]) => `<button class="inventory-tab ${view === key ? "active" : ""}" type="button" data-inventory-view="${key}" role="tab" aria-selected="${view === key}">${label}</button>`).join("")}</div>`;
}

function businessOutboundTable(headers: string[], rows: string[][], empty: string) {
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}">${escapeHtml(empty)}</td></tr>`;
  return `<div class="table-wrap"><table class="table-freeze-leading"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function businessOutboundPanel() {
  const payload = state.businessOutbound;
  const upload = isAdmin()
    ? `<form id="business-outbound-upload-form" class="order-upload-form business-outbound-upload"><label class="file-picker"><span>上传商智批发单明细（.xlsx）</span><input id="business-outbound-upload-file" type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label><button class="button button-primary" type="submit">更新商智出库</button></form>`
    : `<p class="import-help">当前账户仅可查看商智出库数据，上传更新需管理员权限。</p>`;
  const message = state.businessOutboundMessage ? `<p class="order-import-message">${escapeHtml(state.businessOutboundMessage)}</p>` : "";
  if (!payload?.available) {
    return `<section class="panel business-outbound-panel"><div class="panel-head"><div><h3>商智出库</h3><span>独立数据源 · 通过上传商智批发单明细更新，不参与 API 库存同步</span></div></div>${upload}${message}<div class="empty-panel compact-empty"><strong>尚未上传商智出库明细</strong><span>上传后会按审核时间汇总批发、批退和净出库，原始 Excel 不会保存在服务器。</span></div></section>`;
  }
  const summary = payload.summary || {};
  const source = payload.source || {};
  const metrics = [
    ["净出库数量", whole(summary.net_outbound_quantity), `批发 ${whole(summary.wholesale_quantity)} · 批退 ${whole(summary.return_quantity)}`],
    ["净销售金额", settlementMoney(summary.net_sales_amount), `批发 ${settlementMoney(summary.wholesale_sales_amount)} · 批退 ${settlementMoney(summary.return_sales_amount)}`],
    ["毛利额", settlementMoney(summary.gross_profit), summary.gross_margin === null || summary.gross_margin === undefined ? "净销售额为 0，暂不计算毛利率" : `毛利率 ${(number(summary.gross_margin) * 100).toFixed(2)}%`],
    ["单据 / SKU", `${whole(summary.document_count)} / ${whole(summary.sku_count)}`, `${whole(summary.warehouse_count)} 个仓库 · ${whole(summary.row_count)} 条明细`],
  ];
  const trendRows = [...(payload.trend || [])].slice(-14).reverse().map((item: AnyRecord) => [escapeHtml(item.date), whole(item.quantity), settlementMoney(item.sales_amount)]);
  const warehouseRows = (payload.warehouses || []).map((item: AnyRecord) => [escapeHtml(item.name), whole(item.quantity), settlementMoney(item.sales_amount), settlementMoney(item.gross_profit)]);
  const detailRows = (payload.rows || []).map((item: AnyRecord) => [escapeHtml(item.date), escapeHtml(item.document_type), escapeHtml(item.document_no), escapeHtml(item.warehouse || "—"), `<span class="table-primary">${escapeHtml(item.product_name || item.sku)}</span><small>${escapeHtml(item.sku)}</small>`, whole(item.quantity), settlementMoney(item.sales_amount)]);
  return `<section class="panel business-outbound-panel"><div class="panel-head"><div><h3>商智出库</h3><span>批发、批退按审核时间汇总；批退已作为负向冲减</span></div><span class="chart-semantic">${escapeHtml(summary.earliest_date || "—")} 至 ${escapeHtml(summary.latest_date || "—")}</span></div>${upload}${message}<div class="metric-grid four business-outbound-metrics">${metrics.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("")}</div><div class="chart-grid"><section class="panel"><div class="panel-head"><div><h3>近 14 个审核日出库</h3><span>净出库数量与净销售金额</span></div></div>${businessOutboundTable(["审核日期", "净出库数量", "净销售金额"], trendRows, "暂无近期审核日数据")}</section><section class="panel"><div class="panel-head"><div><h3>仓库出库分布</h3><span>按净销售金额排序</span></div></div>${businessOutboundTable(["仓库", "净出库数量", "净销售金额", "毛利额"], warehouseRows, "暂无仓库数据")}</section></div><details class="detail-table-disclosure"><summary><span>商智出库明细</span><small>最近 ${whole((payload.rows || []).length)} 条 · 文件：${escapeHtml(source.file_name || "—")} · 更新于 ${escapeHtml(importTime(source.updated_at))}</small></summary><div class="detail-table-content">${businessOutboundTable(["审核日期", "类型", "单据编号", "仓库", "商品", "数量", "销售金额"], detailRows, "暂无明细")}</div></details></section>`;
}

async function uploadBusinessOutbound(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const file = new FormData(form).get("file");
  if (!(file instanceof File)) return;
  const button = $("button", form);
  button.disabled = true;
  button.textContent = "正在解析并更新…";
  state.businessOutboundMessage = "";
  try {
    const payload = await request<{ dashboard: AnyRecord }>("/api/inventory/business-outbound/upload", { method: "POST", body: new FormData(form) });
    state.businessOutbound = payload.dashboard;
    state.businessOutboundMessage = `已更新商智出库：${whole(payload.dashboard?.summary?.row_count)} 条有效明细。`;
    showToast(state.businessOutboundMessage, "success");
  } catch (error) {
    state.businessOutboundMessage = errorMessage(error, "商智出库文件解析失败，请检查列名与文件格式。");
    showToast(state.businessOutboundMessage, "error");
  }
  if (state.inventory) renderInventory(state.inventory);
}

export function renderInventory(
  payload: AnyRecord | null,
  view: InventoryView = state.inventoryView,
) {
  if (!payload) return;
  state.inventory = payload;
  state.inventoryView = view;
  const rows = inventoryFilteredRows(payload);
  const analysisRows = state.inventoryWarehouse
    ? rows
    : rows.filter((item) => !item.is_rollup);
  const summary = inventorySummary(analysisRows);
  const warehouses = inventoryGroup(rows, "warehouse_name");
  const health = inventoryHealth(analysisRows);
  const salesTrend = inventorySalesTrend(payload);
  const inventoryCapturedAt = payload.captured_at;
  const analyticsCapturedAt =
    payload.analytics_captured_at || inventoryCapturedAt;
  $("#inventory-freshness").textContent = inventoryCapturedAt
    ? analyticsCapturedAt && analyticsCapturedAt !== inventoryCapturedAt
      ? `库存 · ${inventoryCapturedAt} · 出入库分析 · ${analyticsCapturedAt}`
      : `库存与分析 · ${inventoryCapturedAt}`
    : "本地快照";
  const costCoverage =
    summary.cost_coverage_rate === null
      ? "暂无库存记录"
      : `成本已维护：${whole(summary.cost_covered_records)}/${whole(summary.sku_records)} 条（${(summary.cost_coverage_rate * 100).toFixed(1)}%）`;
  const primaryMetrics = [
    [
      "可发库存数量",
      whole(summary.available_num),
      `可售 SKU：${whole(summary.salable_skus)}`,
    ],
    [
      "可发库存金额",
      summaryCostMoney(summary.available_cost_amount),
      costCoverage,
      summary.cost_coverage_rate !== 1 ? "attention" : "",
    ],
    ["近 7 天出库数量", whole(summary.sales_7d), "用于估算近期日均需求"],
    ["近 7 天出库金额", "—", "当前出库明细未提供金额口径"],
    [
      "预计可售天数",
      inventoryDays(summary.turnover_days),
      "整体可发库存 ÷ 日均出库",
    ],
    [
      "库存周转天数",
      inventoryDays(summary.inventory_turnover_days),
      "总库存 ÷ 近 7 天日均出库",
    ],
  ];
  const riskMetrics = [
    ["需补货记录", whole(summary.replenishment_records), "已缺货、紧急补货与需补货", "attention"],
    ["偏高 / 积压", whole(summary.overstock_records), "可售超过 45 天的动销记录", "attention"],
    ["近 7 日未动销", whole(summary.no_movement_records), "有可发库存、近 7 日无出库", "attention"],
  ];
  const metricCard = ([label, value, note, status]: string[]) =>
    `<article class="metric-card"><div class="metric-label">${label}</div>${status ? `<span class="metric-status ${status}">需关注</span>` : ""}<div class="metric-value">${value}</div><div class="metric-delta ${status || ""}">${note}</div></article>`;
  const cards = `<div class="metric-grid inventory-summary-grid">${primaryMetrics.map(metricCard).join("")}</div><section class="inventory-risk-overview" aria-labelledby="inventory-risk-title"><div class="inventory-risk-heading"><div><p class="eyebrow">ACTION REQUIRED</p><h3 id="inventory-risk-title">库存风险概览</h3></div><p>优先处理补货、积压与近 7 日未动销。</p></div><div class="metric-grid inventory-risk-metrics">${riskMetrics.map(metricCard).join("")}</div></section>`;
  const replenishment = analysisRows.filter((item) =>
    ["out_of_stock", "urgent", "replenish"].includes(item.health_key),
  );
  const overstock = analysisRows.filter((item) =>
    ["high", "overstock", "no_movement"].includes(item.health_key),
  );
  const overview = `${cards}<div class="chart-grid"><div class="chart-stack">${healthDistribution(health)}${salesTrendPanel(salesTrend)}</div><div class="chart-stack">${warehouseDistributionPanel(warehouses)}${inventoryBarPanel(warehouses, "仓库可发库存排行", "available_num")}</div></div><h3 class="section-title">补货清单 <small>先补货，再处理库存偏高与未动销</small></h3>${inventoryTable(replenishment, "replenish")}`;
  const content =
    view === "replenish"
      ? `<h3 class="section-title inventory-first-title">补货优先级 <small>按缺货与预计可售天数排序，显示前 200 条</small></h3>${inventoryTable(replenishment, "replenish")}`
      : view === "overstock"
        ? `<h3 class="section-title inventory-first-title">积压 / 未动销清单 <small>“未动销”仅基于近 7 天销售出库</small></h3>${inventoryTable(overstock)}`
        : view === "detail"
          ? `<h3 class="section-title inventory-first-title">单品维度<small>按风险优先级排序，显示前 200 条</small></h3>${inventoryTable(rows)}`
          : overview;
  $("#inventory-content").innerHTML =
    `${inventoryWarehouseFilter(payload)}${inventoryTabs(view)}${content}${businessOutboundPanel()}`;
  $('[data-inventory-filter="warehouse"]')?.addEventListener(
    "change",
    (event: Event) => {
      state.inventoryWarehouse = (
        event.currentTarget as HTMLSelectElement
      ).value;
      renderInventory(payload);
    },
  );
  $('[data-inventory-filter="brand"]')?.addEventListener(
    "change",
    (event: Event) => {
      state.inventoryBrand = (event.currentTarget as HTMLSelectElement).value;
      renderInventory(payload);
    },
  );
  $("[data-reset-inventory-filters]")?.addEventListener("click", () => {
    state.inventoryWarehouse = "";
    state.inventoryBrand = "";
    renderInventory(payload);
  });
  $$("[data-inventory-view]").forEach((button) =>
    button.addEventListener("click", () =>
      renderInventory(payload, button.dataset.inventoryView as InventoryView),
    ),
  );
  $("#business-outbound-upload-form")?.addEventListener("submit", uploadBusinessOutbound);
}

export async function loadInventory() {
  const target = $("#inventory-content");
  try {
    const [payload, businessOutbound] = await Promise.all([
      request<AnyRecord>("/api/inventory"),
      request<AnyRecord>("/api/inventory/business-outbound").catch(() => null),
    ]);
    state.businessOutbound = businessOutbound;
    renderInventory(payload);
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    const message = errorMessage(error, "请在服务器侧运行只读库存同步");
    target.innerHTML = `<div class="empty-panel"><strong>库存快照暂不可用</strong><span>${escapeHtml(message)}</span></div>`;
  }
}
