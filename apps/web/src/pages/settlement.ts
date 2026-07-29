import { $, $$ } from "../dom";
import {
  escapeHtml, number, settlementMoney, settlementMoneyOrDash, whole,
} from "../format";
import { isAdmin, state } from "../state";
import { showLogin } from "./account";

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
  if (!isAdmin()) return "";
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

export function renderSettlement(payload) {
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
    if (state.settlement) renderSettlement(state.settlement);
    return;
  }
  const uploaded = payload.upload?.file || {};
  state.settlementShop = uploaded.shop_name || state.settlementShop;
  state.settlementUploadMessage = `已导入 ${uploaded.original_name || uploaded.name || "结算 CSV"}，解析 ${whole(uploaded.rows)} 行。`;
  renderSettlement(payload.dashboard || state.settlement || {});
}

export async function loadSettlement() {
  const target = $("#settlement-content");
  try {
    const query = state.settlementShop ? `?shop=${encodeURIComponent(state.settlementShop)}` : "";
    const response = await fetch(`/api/settlement${query}`);
    if (response.status === 401) return showLogin();
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "结算数据不可用");
    renderSettlement(payload);
  } catch (error) {
    target.innerHTML = `<div class="empty-panel"><strong>结算数据暂不可用</strong><span>${escapeHtml(error.message || "请检查 Rust API 与 output/settlement 目录")}</span></div>`;
  }
}
