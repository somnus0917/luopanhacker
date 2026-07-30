(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) return;
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) processPreload(link);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      for (const node of mutation.addedNodes) if (node.tagName === "LINK" && node.rel === "modulepreload") processPreload(node);
    }
  }).observe(document, {
    childList: true,
    subtree: true
  });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials") fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep) return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (cents) => `¥${(number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (value) => Math.round(number(value)).toLocaleString("zh-CN");
const ratio = (value) => `${(number(value) * 100).toFixed(2)}%`;
const metricText = (key, value) => key === "ad_roi" ? hasValue(value) ? `${number(value).toFixed(2)}×` : "—" : key.endsWith("_amt") || ["income_amt", "pay_amt", "per_usr_pay_amt", "settlement_amt_pay_time", "expense_amt"].includes(key) ? money(value) : key.endsWith("_ratio") || key.endsWith("_rate") ? ratio(value) : whole(value);
const hasValue = (value) => value !== null && value !== void 0 && value !== "";
const moneyOrDash = (value) => hasValue(value) ? money(value) : "—";
const settlementMoney = (yuan) => `¥${number(yuan).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const settlementMoneyOrDash = (value) => hasValue(value) ? settlementMoney(value) : "—";
const wholeOrDash = (value) => hasValue(value) ? whole(value) : "—";
const ratioOrDash = (value) => hasValue(value) ? ratio(value) : "—";
function importTime(value) {
  if (!value) return "—";
  const text = String(value);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
class ApiRequestError extends Error {
  constructor(message, status, code = "REQUEST_FAILED", requestId) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.name = "ApiRequestError";
  }
  status;
  code;
  requestId;
}
function isEnvelope(payload) {
  return Boolean(payload && typeof payload === "object" && "data" in payload && "error" in payload && "meta" in payload);
}
function errorMessage(error, fallback) {
  return error instanceof ApiRequestError ? error.message : fallback;
}
function isApiRequestError(error) {
  return error instanceof ApiRequestError;
}
async function request(input, init) {
  const response = await window.fetch(input, init);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError("服务器返回了无效响应", response.status);
  }
  if (!isEnvelope(payload)) {
    throw new ApiRequestError("服务器返回了未知响应格式", response.status);
  }
  if (payload.meta.fallback) {
    window.dispatchEvent(new CustomEvent("luopan-api-fallback", { detail: payload.meta }));
  }
  if (!response.ok || payload.error) {
    throw new ApiRequestError(
      payload.error?.message ?? "请求失败",
      response.status,
      payload.error?.code,
      payload.meta.request_id
    );
  }
  return payload.data;
}
let toastTimer;
function showToast(message, tone = "info") {
  const region = $("#toast-region");
  if (!region || !message) return;
  window.clearTimeout(toastTimer);
  const toast = document.createElement("div");
  toast.className = `toast toast-${tone}`;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");
  toast.textContent = message;
  region.replaceChildren(toast);
  toastTimer = window.setTimeout(() => region.replaceChildren(), tone === "error" ? 5200 : 3600);
}
let COLLECTION_SHOPS = [];
function setCollectionShops(shops) {
  COLLECTION_SHOPS = [...new Set(shops.filter(Boolean))];
  state.collectionBackfillShops = new Set(COLLECTION_SHOPS);
}
const localDateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const currentLocalMonthStart = () => {
  const date = /* @__PURE__ */ new Date();
  date.setDate(1);
  return localDateValue(date);
};
const previousLocalDate = () => {
  const date = /* @__PURE__ */ new Date();
  date.setDate(date.getDate() - 1);
  return localDateValue(date);
};
const latestBackfillDate = () => previousLocalDate() >= currentLocalMonthStart() ? previousLocalDate() : "";
const backfillDateAllowed = (value) => Boolean(value && value >= currentLocalMonthStart() && value <= previousLocalDate());
const state = { currentUser: null, users: [], accountMessage: "", records: [], operationDates: /* @__PURE__ */ new Set(), operationPlatforms: /* @__PURE__ */ new Set(), operationShops: /* @__PURE__ */ new Set(), operationSources: /* @__PURE__ */ new Set(), operationFilterOpen: /* @__PURE__ */ new Set(), operationCalendarOpen: false, operationCalendarCursor: "", operationCalendarRangeStart: "", tablePlatform: "", tableShop: "", operationSection: "overview", status: null, collectionModules: /* @__PURE__ */ new Set(["operations", "channel"]), collectionBackfillDate: latestBackfillDate(), collectionBackfillShops: new Set(COLLECTION_SHOPS), collectionMessage: "", page: "operations", inventory: null, inventoryView: "overview", inventoryWarehouse: "", inventoryBrand: "", inventorySortKey: "", inventorySortDir: "desc", settlement: null, settlementShop: "", settlementAvailableDates: [], settlementStartDate: "", settlementEndDate: "", settlementCalendarOpen: false, settlementCalendarCursor: "", settlementCalendarRangeStart: "", settlementUploadMessage: "", orderImports: { batches: [], summary: {} }, orderPreview: null, orderImportMessage: "", channel: null };
const isAdmin = () => state.currentUser?.role === "admin";
function renderAccount() {
  const target = $("#account-content");
  if (!target || !state.currentUser) return;
  const message = state.accountMessage ? `<p class="order-import-message">${escapeHtml(state.accountMessage)}</p>` : "";
  const roleLabel = state.currentUser.role === "admin" ? "管理员" : "只读用户";
  const sessionPanel = `<section class="panel account-session-panel"><div><small>当前登录账户</small><strong>${escapeHtml(state.currentUser.username)}</strong><span>${roleLabel}</span></div><button id="account-logout-button" class="button" type="button">退出当前账户</button></section>`;
  const passwordPanel = `<section class="panel account-panel"><div class="panel-head"><div><h3>修改密码</h3><span>更新后其他设备上的登录会话将失效</span></div></div><form id="password-change-form" class="account-form"><label>当前密码<input name="current_password" type="password" autocomplete="current-password" required /></label><label>新密码<input name="new_password" type="password" autocomplete="new-password" minlength="12" required /></label><button class="button button-primary" type="submit">更新密码</button></form></section>`;
  const userRows = state.users.map((user) => `<div class="user-row"><div><strong>${escapeHtml(user.username)}</strong><span>${user.role === "admin" ? "管理员" : "只读用户"} · 创建于 ${escapeHtml(importTime(user.created_at))}</span></div>${user.username === state.currentUser?.username ? `<small>当前账户</small>` : `<button class="text-button import-delete" type="button" data-delete-user="${escapeHtml(user.username)}">删除</button>`}</div>`).join("");
  const adminPanel = isAdmin() ? `<section class="panel account-panel"><div class="panel-head"><div><h3>用户管理</h3><span>管理员可新增账户；viewer 只能读取看板</span></div></div><form id="user-create-form" class="account-form account-form-user"><label>用户名<input name="username" maxlength="64" required /></label><label>初始密码<input name="password" type="password" autocomplete="new-password" minlength="12" required /></label><label>角色<select name="role"><option value="viewer">viewer · 只读</option><option value="admin">admin · 管理员</option></select></label><button class="button" type="submit">新增用户</button></form><div class="user-list">${userRows || `<p class="import-help">正在读取用户列表…</p>`}</div></section>` : `<section class="panel account-panel"><div class="panel-head"><div><h3>账户权限</h3><span>viewer · 只读</span></div></div><p class="import-help">你可以查看经营、库存和结算数据；上传、撤销、补采及用户管理由管理员执行。</p></section>`;
  target.innerHTML = `${message}${sessionPanel}<div class="account-grid">${passwordPanel}${adminPanel}</div>`;
  $("#account-logout-button")?.addEventListener("click", logout);
  $("#password-change-form")?.addEventListener("submit", changePassword);
  $("#user-create-form")?.addEventListener("submit", createUser);
  $$("[data-delete-user]").forEach((button) => button.addEventListener("click", () => deleteUser(button.dataset.deleteUser)));
}
async function logout() {
  await request("/api/logout", { method: "POST" }).catch(() => void 0);
  showLogin();
}
async function loadUsers() {
  if (!isAdmin()) return;
  try {
    const payload = await request("/api/users");
    state.users = payload.users ?? [];
  } catch (error) {
    state.accountMessage = errorMessage(error, "用户列表读取失败。");
  }
  renderAccount();
}
async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = await request("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    state.accountMessage = payload.message ?? "密码已更新。";
    showToast(state.accountMessage, "success");
    form.reset();
  } catch (error) {
    state.accountMessage = errorMessage(error, "密码更新失败。");
    showToast(state.accountMessage, "error");
  }
  renderAccount();
}
async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = await request("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    state.accountMessage = `已新增用户 ${payload.user?.username ?? ""}。`;
    showToast(state.accountMessage, "success");
    form.reset();
  } catch (error) {
    state.accountMessage = errorMessage(error, "新增用户失败。");
    showToast(state.accountMessage, "error");
  }
  await loadUsers();
}
async function deleteUser(username) {
  if (!username || !window.confirm(`确定删除用户“${username}”吗？该用户的登录会话会立即失效。`)) return;
  try {
    const payload = await request(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    state.accountMessage = `已删除用户 ${payload.deleted ?? username}。`;
    showToast(state.accountMessage, "success");
  } catch (error) {
    state.accountMessage = errorMessage(error, "删除用户失败。");
    showToast(state.accountMessage, "error");
  }
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
  renderAccount();
  if (isAdmin()) loadUsers();
}
const COLORS = ["#3da7f5", "#31d380", "#a461d2", "#f18a21", "#f7c91b", "#e84d8a", "#2cced2", "#8b9dc3"];
const METRIC_SEMANTICS = {
  income_amt: { label: "增长指标", color: "#c5f36b" },
  pay_amt: { label: "增长指标", color: "#c5f36b" },
  pay_cnt: { label: "经营量", color: "#b8d8ff" },
  product_show_ucnt: { label: "流量指标", color: "#b8d8ff" },
  organic_search: { label: "自然流量", color: "#b8d8ff" },
  recommendation: { label: "推荐流量", color: "#d4c3ff" },
  ad_cost_amt: { label: "成本指标", color: "#f1bf77" },
  ad_roi: { label: "效率指标", color: "#c5f36b" }
};
function metricSemantic(metricKey) {
  return METRIC_SEMANTICS[metricKey] || { label: "经营指标", color: "#b8d8ff" };
}
function seriesColor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = hash * 31 + key.charCodeAt(i) >>> 0;
  return COLORS[hash % COLORS.length];
}
function compactMoney(cents) {
  const yuan = number(cents) / 100;
  const abs = Math.abs(yuan);
  if (abs >= 1e8) return `¥${(yuan / 1e8).toFixed(abs >= 1e9 ? 1 : 2)}亿`;
  if (abs >= 1e4) return `¥${(yuan / 1e4).toFixed(abs >= 1e5 ? 1 : 2)}万`;
  return `¥${Math.round(yuan).toLocaleString("zh-CN")}`;
}
function chartAxisValue(metricKey, value) {
  if (metricKey === "ad_roi") return `${number(value).toFixed(2)}×`;
  return metricKey.endsWith("_amt") ? compactMoney(value) : Math.round(number(value)).toLocaleString("zh-CN");
}
function chartDateTicks(dates, maxLabels = 6) {
  if (dates.length <= maxLabels) return dates.map((date, index) => ({ date, index }));
  const indexes = /* @__PURE__ */ new Set();
  for (let step = 0; step < maxLabels; step += 1) {
    indexes.add(Math.round(step * (dates.length - 1) / (maxLabels - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => ({ date: dates[index], index }));
}
function latestRecords(records) {
  const dates = [...new Set(records.map((item) => item.date))].sort();
  const latest = dates.at(-1);
  return { date: latest, records: records.filter((item) => item.date === latest) };
}
function lineChart(records, metricKey, title) {
  const semantic = metricSemantic(metricKey);
  const dates = [...new Set(records.map((item) => item.date))].sort();
  const shops = [...new Set(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const values = shops.map((shop) => dates.map((date) => {
    const value = records.find((item) => item.date === date && item.shop_name === shop)?.metrics?.[metricKey];
    return metricKey === "ad_roi" && (value === null || value === void 0) ? null : number(value);
  }));
  const totals = dates.map((date, index) => values.reduce((sum, series2) => sum + number(series2[index]), 0));
  const max = Math.max(...totals, ...values.flat().filter((value) => value !== null).map(number), 1) * 1.08;
  const width = 760, height = 252, pad = { l: 68, r: 16, t: 15, b: 38 };
  const point = (value, index) => [pad.l + index * ((width - pad.l - pad.r) / Math.max(dates.length - 1, 1)), height - pad.b - value / max * (height - pad.t - pad.b)];
  const path = (series2) => {
    let previousMissing = true;
    return series2.map((value, index) => {
      if (value === null) {
        previousMissing = true;
        return "";
      }
      const command = previousMissing ? "M" : "L";
      previousMissing = false;
      return `${command}${point(value, index).map((n) => n.toFixed(1)).join(" ")}`;
    }).join(" ");
  };
  const levels = [0.25, 0.5, 0.75, 1];
  const grid = levels.map((level) => {
    const y = height - pad.b - level * (height - pad.t - pad.b);
    return `<line class="chart-gridline" x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}"/>`;
  }).join("");
  const yAxis = levels.map((level) => {
    const y = height - pad.b - level * (height - pad.t - pad.b);
    return `<span style="top:${(y / height * 100).toFixed(3)}%">${chartAxisValue(metricKey, max * level)}</span>`;
  }).join("");
  const xAxis = chartDateTicks(dates).map(({ date, index }) => `<span style="left:${(point(0, index)[0] / width * 100).toFixed(3)}%">${date.slice(5)}</span>`).join("");
  const series = shops.map((shop, index) => `<path class="chart-line" stroke="${seriesColor(shop)}" d="${path(values[index])}"/>`).join("");
  const legend = shops.map((shop) => `<span><i style="background:${seriesColor(shop)}"></i>${escapeHtml(shop)}</span>`).join("");
  return `<section class="panel chart-panel" style="--chart-accent:${semantic.color}"><div class="panel-head"><div><h3>${title}</h3></div><span class="chart-semantic">${semantic.label}</span></div><div class="chart-frame"><svg class="chart" data-metric="${metricKey}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}">${grid}${series}<line class="chart-hover-line" visibility="hidden" y1="${pad.t}" y2="${height - pad.b}"/><rect class="chart-hit-area" x="${pad.l}" y="${pad.t}" width="${width - pad.l - pad.r}" height="${height - pad.b}" /></svg><div class="chart-y-axis" aria-hidden="true">${yAxis}</div><div class="chart-x-axis" aria-hidden="true">${xAxis}</div></div><div class="chart-tooltip hidden" role="status"></div><div class="legend">${legend}</div></section>`;
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
      const x = (event.clientX - bounds.left) / bounds.width * width;
      const step = (width - leftPadding - rightPadding) / Math.max(dates.length - 1, 1);
      const index = Math.max(0, Math.min(dates.length - 1, Math.round((x - leftPadding) / step)));
      const date = dates[index];
      const chartX = leftPadding + index * step;
      const rows = shops.map((shop) => {
        const record = records.find((item) => item.date === date && item.shop_name === shop);
        return `<div><i style="background:${seriesColor(shop)}"></i><span>${escapeHtml(shop)}</span><strong>${metricText(metricKey, record?.metrics?.[metricKey])}</strong></div>`;
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
  const semantic = metricSemantic(metricKey);
  const { date, records: latest } = latestRecords(records);
  const items = latest.map((item) => ({ name: item.shop_name, value: number(item.metrics?.[metricKey]) })).sort((a, b) => b.value - a.value);
  const max = Math.max(...items.map((item) => item.value), 1);
  const bars = items.map((item) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, item.value / max * 100)}%"></div></div><span class="bar-value">${metricText(metricKey, item.value)}</span></div>`).join("");
  return `<section class="panel metric-panel" style="--chart-accent:${semantic.color}"><div class="panel-head"><div><h3>${title}</h3><span>${date || "—"} · 最新日</span></div><span class="chart-semantic">${semantic.label}</span></div>${bars || "<span class='metric-delta'>暂无数据</span>"}</section>`;
}
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
  if (explicit) return String(explicit);
  if (item.source !== "external_orders") return "抖音";
  const source = `${item.source_key || ""} ${item.source_label || ""} ${item.shop_name || ""}`.toLowerCase();
  if (/(jingdong|\bjd\b|京东)/.test(source)) return "京东";
  if (/(pinduoduo|\bpdd\b|拼多多)/.test(source)) return "拼多多";
  if (/(tmall|taobao|天猫|喵速达|优品|国际)/.test(source)) return "天猫";
  return "其他";
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
  if (!sorted.length) return /* @__PURE__ */ new Set();
  const span = sorted.length;
  const earliestIndex = allDates.indexOf(sorted[0]);
  const prevSlice = allDates.slice(Math.max(0, earliestIndex - span), earliestIndex);
  return new Set(prevSlice);
}
function deltaNote(current, previous, formatter = whole) {
  if (!previous) return "环比：无上期数据";
  const change = (current - previous) / previous;
  const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
  return `${arrow} ${Math.abs(change * 100).toFixed(1)}% 环比 ${formatter(previous)}`;
}
function deltaTrend(current, previous) {
  if (!previous) return "";
  return current > previous ? "up" : current < previous ? "down" : "";
}
function operationFilteredRecords() {
  return state.records.filter((item) => state.operationDates.has(item.date) && state.operationPlatforms.has(recordPlatform(item)) && state.operationShops.has(item.shop_name) && state.operationSources.has(recordSourceLabel(item)));
}
function operationFilterSet(kind) {
  return kind === "date" ? state.operationDates : kind === "platform" ? state.operationPlatforms : kind === "shop" ? state.operationShops : state.operationSources;
}
function operationFilterItems(kind, records = state.records) {
  const channelRecords = state.channel?.records || [];
  if (kind === "date") return [.../* @__PURE__ */ new Set([...records.map((item) => item.date), ...channelRecords.map((item) => item.date)])].sort((a, b) => b.localeCompare(a));
  if (kind === "platform") return [.../* @__PURE__ */ new Set([...records.map(recordPlatform), ...channelRecords.length ? ["抖音"] : []])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (kind === "shop") {
    const operationShops = records.filter((item) => state.operationPlatforms.has(recordPlatform(item))).map((item) => item.shop_name);
    const channelShops = state.operationPlatforms.has("抖音") ? channelRecords.map((item) => item.shop_name) : [];
    return [.../* @__PURE__ */ new Set([...operationShops, ...channelShops])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }
  return [...new Set(records.map(recordSourceLabel))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
function operationSingleFilterValue(kind) {
  const selected = [...operationFilterSet(kind)];
  return selected.length === 1 ? selected[0] : "";
}
function operationScopeTags() {
  const describe = (kind, allLabel, oneLabel) => {
    const items = operationFilterItems(kind);
    const selected = operationFilterSet(kind);
    if (selected.size === items.length) return allLabel;
    if (selected.size === 1) return `${oneLabel}：${[...selected][0]}`;
    return `${oneLabel}：${selected.size} 项`;
  };
  return [operationDateLabel(), describe("platform", "全部平台", "平台"), describe("shop", "全部店铺", "店铺")];
}
function resetOperationFilters() {
  ["date", "platform", "shop", "source"].forEach((kind) => {
    const selected = operationFilterSet(kind);
    selected.clear();
    operationFilterItems(kind).forEach((item) => selected.add(item));
  });
  state.operationCalendarRangeStart = "";
  state.operationCalendarOpen = false;
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
  const sources = operationFilterItems("source");
  const openAttr = (kind) => state.operationFilterOpen.has(kind) ? " open" : "";
  const buildGroup = (title, items, selected, kind) => `<details class="filter-disclosure" data-filter-kind="${kind}"${openAttr(kind)}><summary><span>${title}</span><small>已选择 ${selected.size} 个</small></summary><div class="chip-list">${items.map((item) => `<button class="chip ${selected.has(item) ? "selected" : ""}" type="button" data-operation-filter="${kind}" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div></details>`;
  return `<div class="filter-accordion filter-accordion-compact">${buildGroup("数据来源", sources, state.operationSources, "source")}</div>`;
}
function bindOperationsFilterEvents() {
  $$("[data-operation-filter]").forEach((control) => control.addEventListener(control.type === "checkbox" ? "change" : "click", () => {
    const selected = operationFilterSet(control.dataset.operationFilter);
    const value = control.dataset.value;
    const shouldSelect = control.type === "checkbox" ? control.checked : !selected.has(value);
    if (!shouldSelect && selected.size <= 1) {
      control.checked = true;
      return;
    }
    if (shouldSelect) selected.add(value);
    else selected.delete(value);
    if (control.dataset.operationFilter === "platform") resetOperationShopsForPlatforms();
    renderOperations();
  }));
  $$("[data-operation-select-all]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.operationSelectAll;
    const items = operationFilterItems(kind);
    const selected = operationFilterSet(kind);
    items.forEach((item) => selected.add(item));
    if (kind === "platform") resetOperationShopsForPlatforms();
    renderOperations();
  }));
  $$("[data-operation-clear]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.operationClear;
    const items = operationFilterItems(kind);
    const selected = operationFilterSet(kind);
    selected.clear();
    if (items.length) selected.add(items[0]);
    if (kind === "platform") resetOperationShopsForPlatforms();
    renderOperations();
  }));
  $$("[data-filter-kind]").forEach((details) => details.addEventListener("toggle", () => {
    const kind = details.dataset.filterKind;
    if (details.open) state.operationFilterOpen.add(kind);
    else state.operationFilterOpen.delete(kind);
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
  const history2 = batches.length ? `<div class="import-history"><div class="import-history-head"><strong>导入历史</strong><span>累计 ${whole(summary.orders)} 单 · ${money(summary.pay_amt)}</span></div>${batches.map((batch) => `<div class="import-history-row"><div><strong>${escapeHtml((batch.source_labels || []).join("、"))}</strong><span>${escapeHtml(importTime(batch.created_at))} · ${escapeHtml(importDateRange(batch.date_range))} · 新增 ${whole(batch.added_orders)} 单</span></div>${isAdmin() ? `<button class="text-button import-delete" type="button" data-delete-order-import="${escapeHtml(batch.id)}">撤销</button>` : ""}</div>`).join("")}</div>` : `<p class="import-help">暂无线上导入批次。${isAdmin() ? "可上传喵速达、天猫订单明细；" : ""}抖店罗盘继续由现有采集任务更新。</p>`;
  const uploadForm = isAdmin() ? `<form id="order-upload-form" class="order-upload-form"><label class="file-picker"><span>选择订单明细（.xlsx，可多选）</span><input id="order-upload-files" type="file" name="files" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple required /></label><button class="button" type="submit">解析并预览</button></form>` : `<p class="import-help">当前为只读账户，可查看导入历史，不能上传或撤销订单数据。</p>`;
  target.innerHTML = `<details class="panel order-import-panel"><summary><span>订单数据导入</span><small>${isAdmin() ? "上传 Excel → 预览去重 → 确认写入" : "导入历史（只读）"}</small></summary><div class="order-import-body">${uploadForm}${message}${previewBlock}${history2}<p class="import-help">同一文件按指纹跳过；可匹配的相同订单按不可逆指纹跳过。订单号、买家、地址与原始文件不会保存。</p></div></details>`;
  $("#order-upload-form")?.addEventListener("submit", previewOrderImport);
  $("[data-commit-order-import]")?.addEventListener("click", commitOrderImport);
  $("[data-cancel-order-preview]")?.addEventListener("click", () => {
    state.orderPreview = null;
    state.orderImportMessage = "已取消本次预览，尚未写入任何数据。";
    renderOrderImportPanel();
  });
  $$("[data-delete-order-import]").forEach((button) => button.addEventListener("click", () => deleteOrderImport(button.dataset.deleteOrderImport)));
}
async function loadOrderImports() {
  try {
    state.orderImports = await request("/api/orders/imports");
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    state.orderImportMessage = errorMessage(error, "订单导入记录读取失败。");
  }
  renderOrderImportPanel();
}
async function previewOrderImport(event) {
  event.preventDefault();
  const files = $("#order-upload-files")?.files;
  if (!files?.length) return;
  const button = $("#order-upload-form button");
  button.disabled = true;
  button.textContent = "正在解析…";
  state.orderPreview = null;
  state.orderImportMessage = "";
  try {
    state.orderPreview = await request("/api/orders/preview", { method: "POST", body: new FormData(event.currentTarget) });
    state.orderImportMessage = "预览完成，请核对新增与重复数量后确认写入。";
    showToast(state.orderImportMessage, "success");
  } catch (error) {
    state.orderPreview = null;
    state.orderImportMessage = errorMessage(error, "文件解析失败，请检查格式后重试。");
    showToast(state.orderImportMessage, "error");
  }
  renderOrderImportPanel();
}
async function commitOrderImport() {
  if (!state.orderPreview?.preview_token) return;
  try {
    const payload = await request("/api/orders/imports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview_token: state.orderPreview.preview_token }) });
    state.orderPreview = null;
    state.orderImportMessage = `已写入 ${whole(payload.batch?.added_orders)} 单订单汇总。`;
    showToast(state.orderImportMessage, "success");
    await Promise.all([loadCompass(), loadOrderImports()]);
  } catch (error) {
    state.orderImportMessage = errorMessage(error, "写入失败，请重新预览。");
    showToast(state.orderImportMessage, "error");
    renderOrderImportPanel();
  }
}
async function deleteOrderImport(batchId) {
  if (!batchId || !window.confirm("撤销后，该批次导入的数据将从经营看板移除。确定继续吗？")) return;
  try {
    const payload = await request(`/api/orders/imports/${encodeURIComponent(batchId)}`, { method: "DELETE" });
    state.orderImportMessage = `已撤销 ${whole(payload.deleted?.added_orders)} 单导入数据。`;
    showToast(state.orderImportMessage, "success");
  } catch (error) {
    state.orderImportMessage = errorMessage(error, "撤销失败，请稍后重试。");
    showToast(state.orderImportMessage, "error");
  }
  await Promise.all([loadCompass(), loadOrderImports()]);
}
function operatingRatio(value) {
  return value === null || value === void 0 ? "—" : `${number(value).toFixed(2)}×`;
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
  if (!selected.length) return "请选择日期";
  if (selected.length === available.length && available.every((date) => state.operationDates.has(date))) return "全部日期";
  if (selected.length === 1) return selected[0];
  const isRange = available.filter((date) => date >= (selected[0] ?? "") && date <= (selected.at(-1) ?? "")).every((date) => state.operationDates.has(date));
  return isRange ? `${selected[0]} 至 ${selected.at(-1)}` : `已选择 ${selected.length} 天`;
}
function calendarMonthMarkup(monthValue, availableDates, rangeStart, rangeEnd) {
  const cursor = calendarMonthStart(monthValue);
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth() + 1;
  const firstWeekday = cursor.getUTCDay() || 7;
  const gridStart = new Date(Date.UTC(year, month - 1, 2 - firstWeekday));
  const today = calendarDate((/* @__PURE__ */ new Date()).getFullYear(), (/* @__PURE__ */ new Date()).getMonth() + 1, (/* @__PURE__ */ new Date()).getDate());
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
  const tags = operationScopeTags().map((tag) => `<span class="filter-summary-tag">${escapeHtml(tag)}</span>`).join("");
  return `<section class="table-filter-panel" aria-label="经营范围筛选"><div><strong>经营范围</strong></div><div class="filter-summary" aria-live="polite"><span class="filter-summary-label">当前范围</span>${tags}<button class="filter-reset" type="button" data-reset-operation-filters>重置</button></div>${operationCalendarMarkup()}<label>平台<select data-table-filter="platform">${options(platforms, state.tablePlatform, "全部平台")}</select></label><label>店铺<select data-table-filter="shop">${options(shops, state.tableShop, "全部店铺")}</select></label></section>`;
}
function bindDetailTableFilters() {
  $$("[data-table-filter]").forEach((select) => select.addEventListener("change", () => {
    const kind = select.dataset.tableFilter;
    if (kind === "platform") state.tablePlatform = select.value;
    else state.tableShop = select.value;
    applySingleOperationFilter(kind, select.value);
    renderOperations();
  }));
  $("[data-reset-operation-filters]")?.addEventListener("click", () => {
    resetOperationFilters();
    renderOperations();
  });
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
      state.operationDates = /* @__PURE__ */ new Set([value]);
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
  return `<div class="table-wrap"><table class="table-freeze-leading"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function channelTrendRecords(records) {
  return records.map((record) => ({
    date: record.date,
    shop_name: record.shop_name,
    metrics: {
      organic_search: number(record.traffic?.groups?.organic_search?.value),
      recommendation: number(record.traffic?.groups?.recommendation?.value)
    }
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
    ["短视频观看", whole(shortVideoViews), `短视频支付 ${money(shortVideoPay)}`]
  ];
  const cardHtml = `<div class="metric-grid four">${cards.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("")}</div>`;
  const sourceMap = /* @__PURE__ */ new Map();
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
  const productRows = records.flatMap((record) => (record.products || []).map((product) => ({ ...product, shop_name: record.shop_name }))).sort((a, b) => number(b.pay_amt) - number(a.pay_amt) || number(b.show_ucnt) - number(a.show_ucnt)).slice(0, 30).map((product) => [escapeHtml(product.shop_name), `<span class="table-primary">${escapeHtml(product.product_name || product.product_id)}</span><small>${escapeHtml(product.product_id)}</small>`, moneyOrDash(product.pay_amt), wholeOrDash(product.show_ucnt), wholeOrDash(product.click_ucnt), ratioOrDash(product.click_rate), ratioOrDash(product.click_pay_rate), ratioOrDash(product.show_ucnt_change)]);
  const searchSourceRows = records.flatMap((record) => (record.search?.sources || []).map((source) => ({ ...source, shop_name: record.shop_name }))).map((source) => [escapeHtml(source.shop_name), escapeHtml(source.name), wholeOrDash(source.show_ucnt), ratioOrDash(source.show_ucnt_change), moneyOrDash(source.pay_amt), moneyOrDash(source.pay_amt_benchmark)]);
  const searchTermRows = records.flatMap((record) => (record.search?.shop_terms || []).map((term) => ({ ...term, shop_name: record.shop_name }))).sort((a, b) => number(a.rank) - number(b.rank)).map((term) => [escapeHtml(term.shop_name), wholeOrDash(term.rank), escapeHtml(term.word), wholeOrDash(term.show_ucnt), ratioOrDash(term.show_ucnt_change), moneyOrDash(term.pay_amt)]);
  const periods = [...new Set(records.map((record) => {
    const period = record.search?.period || {};
    return period.begin_date && period.end_date ? `${period.begin_date} 至 ${period.end_date}` : "";
  }).filter(Boolean))];
  const searchPeriodLabel = periods.length ? `搜索：${whole(periods.length)} 个周周期` : "搜索：暂无周期";
  const searchPeriodDetails = periods.length ? periods.map((period) => `<li>${escapeHtml(period)}</li>`).join("") : "<li>当前范围暂无搜索周期</li>";
  const context = `<section class="section-context channel-context"><div class="section-context-title"><strong>抖音流量拆解</strong><small>自然搜索、推荐、广告和短视频</small></div><div class="channel-context-meta"><span class="channel-context-chip">${whole(records.length)} 个店铺日</span><details class="channel-context-details"><summary aria-label="查看搜索数据口径"><b>${searchPeriodLabel}</b><i aria-hidden="true">i</i></summary><div class="channel-context-popover"><strong>搜索数据口径</strong><p>按罗盘独立周口径统计，可能与经营日维度不完全一致。</p><ul>${searchPeriodDetails}</ul></div></details></div></section>`;
  const trendSource = channelTrendRecords(records);
  const charts = `<div class="chart-grid"><div class="chart-stack">${lineChart(trendSource, "organic_search", "自然搜索曝光趋势")}${lineChart(trendSource, "recommendation", "推荐流量曝光趋势")}</div><div class="chart-stack"><section class="panel"><div class="panel-head"><div><h3>商品卡流量来源</h3><span>按罗盘商品曝光人数口径</span></div></div>${simpleTable(["来源", "曝光人数", "占比"], sourceRows)}</section><section class="panel operations-note"><h3>渠道口径</h3><p>自然搜索对应“非投放时段-搜索”；推荐流量包含“猜你喜欢”和“顶Tab推荐”；广告流量包含全域投广及标准/品牌投放。</p><p>搜索模块采用罗盘独立周口径，日期可能晚于经营数据更新。</p></section></div></div>`;
  const details = `<div class="detail-table-stack"><details class="detail-table-disclosure" open><summary><span>商品表现</span><small>商品卡TOP商品 · ${whole(productRows.length)} 条</small></summary><div class="detail-table-content">${simpleTable(["店铺", "商品", "支付金额", "曝光", "点击", "点击率", "点击成交率", "曝光变化"], productRows)}</div></details><details class="detail-table-disclosure"><summary><span>搜索渠道</span><small>商品卡、直播、短视频与图文搜索</small></summary><div class="detail-table-content">${simpleTable(["店铺", "搜索渠道", "曝光人数", "环比", "支付金额", "同行基准"], searchSourceRows)}</div></details><details class="detail-table-disclosure"><summary><span>本店搜索词</span><small>罗盘搜索周报TOP词</small></summary><div class="detail-table-content">${simpleTable(["店铺", "排名", "搜索词", "曝光人数", "环比", "支付金额"], searchTermRows)}</div></details></div>`;
  return `${context}${cardHtml}${charts}${details}`;
}
function metricCards(metrics, columns = "six") {
  return `<div class="metric-grid ${columns}">${metrics.map(([label, value, note, trend]) => {
    const status = trend === "up" ? "positive" : trend === "down" ? "negative" : "";
    const statusText = trend === "up" ? "环比上升" : trend === "down" ? "环比下降" : "";
    return `<article class="metric-card"><div class="metric-label">${label}</div>${status ? `<span class="metric-status ${status}">${statusText}</span>` : ""}<div class="metric-value">${value}</div><div class="metric-delta ${status}">${note}</div></article>`;
  }).join("")}</div>`;
}
function attributedAdMetrics(records) {
  const platforms = new Set(records.filter((record) => number(record.metrics?.ad_cost_amt) > 0).map(recordPlatform));
  const scoped = records.filter((record) => platforms.has(recordPlatform(record)));
  return {
    spend: scoped.reduce((sum, record) => sum + number(record.metrics?.ad_cost_amt), 0),
    pay: scoped.reduce((sum, record) => sum + number(record.metrics?.pay_amt), 0),
    platforms
  };
}
function adsTrendRecords(records) {
  const groups = /* @__PURE__ */ new Map();
  records.forEach((record) => {
    const platform = recordPlatform(record);
    const key = [record.date, platform, record.shop_name].join("\0");
    const group = groups.get(key) || { date: record.date, platform, shop_name: record.shop_name, spend: 0, pay: 0 };
    group.spend += number(record.metrics?.ad_cost_amt);
    group.pay += number(record.metrics?.pay_amt);
    groups.set(key, group);
  });
  return [...groups.values()].map((item) => ({
    date: item.date,
    shop_name: item.shop_name,
    metrics: {
      ad_cost_amt: item.spend,
      pay_amt: item.pay,
      ad_roi: item.spend ? item.pay / item.spend : null
    }
  }));
}
function operationTabsMarkup() {
  const tabs = [["overview", "经营总览", "跨模块概览"], ["sales", "销售", "成交与退款"], ["traffic", "流量", "曝光、商品与搜索"], ["ads", "投放", "消耗与投产"]];
  return `<div class="operations-tabs" role="tablist" aria-label="经营分类">${tabs.map(([key, label, note]) => `<button class="operations-tab ${state.operationSection === key ? "active" : ""}" type="button" data-operation-section="${key}" role="tab" aria-selected="${state.operationSection === key}"><span>${label}</span><small>${note}</small></button>`).join("")}</div>`;
}
function platformMatrixMarkup(records, channelRecords) {
  const groups = /* @__PURE__ */ new Map();
  records.forEach((record) => {
    const platform = recordPlatform(record);
    const shops = groups.get(platform) || /* @__PURE__ */ new Set();
    shops.add(record.shop_name);
    groups.set(platform, shops);
  });
  channelRecords.forEach((record) => {
    const shops = groups.get("抖音") || /* @__PURE__ */ new Set();
    shops.add(record.shop_name);
    groups.set("抖音", shops);
  });
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([platform, shops]) => [
    `<span class="platform-pill">${escapeHtml(platform)}</span>`,
    whole(shops.size),
    escapeHtml([...shops].sort((a, b) => a.localeCompare(b, "zh-CN")).join("、"))
  ]);
  return `<section class="panel"><div class="panel-head"><div><h3>店铺矩阵</h3><span>平台 → 店铺的经营范围</span></div></div>${simpleTable(["平台", "店铺数", "已接入店铺"], rows, "当前范围没有店铺")}</section>`;
}
function overviewSectionMarkup(records, channelRecords) {
  const totals = aggregate(records);
  const organic = channelGroup(channelRecords, "organic_search");
  const ads = attributedAdMetrics(records);
  const allDates = operationFilterItems("date");
  const prevDates = previousPeriodDates(state.operationDates, allDates);
  const prevRecords = state.records.filter(
    (item) => prevDates.has(item.date) && state.operationPlatforms.has(recordPlatform(item)) && state.operationShops.has(item.shop_name) && state.operationSources.has(recordSourceLabel(item))
  );
  const prevTotals = aggregate(prevRecords);
  const prevChannelRecords = channelRecords.length ? (state.channel?.records || []).filter((record) => prevDates.has(record.date) && state.operationShops.has(record.shop_name)) : [];
  const prevOrganic = channelGroup(prevChannelRecords, "organic_search");
  attributedAdMetrics(prevRecords);
  const metrics = [
    ["成交金额", money(totals.income_amt), deltaNote(totals.income_amt, prevTotals.income_amt, money), deltaTrend(totals.income_amt, prevTotals.income_amt)],
    ["去退后成交", money(Math.max(totals.income_amt - totals.refund_amt, 0)), deltaNote(Math.max(totals.income_amt - totals.refund_amt, 0), Math.max(prevTotals.income_amt - prevTotals.refund_amt, 0), money), deltaTrend(Math.max(totals.income_amt - totals.refund_amt, 0), Math.max(prevTotals.income_amt - prevTotals.refund_amt, 0))],
    ["成交订单", whole(totals.pay_cnt), deltaNote(totals.pay_cnt, prevTotals.pay_cnt, whole), deltaTrend(totals.pay_cnt, prevTotals.pay_cnt)],
    ["商品曝光人数", whole(totals.product_show_ucnt), deltaNote(totals.product_show_ucnt, prevTotals.product_show_ucnt, whole), deltaTrend(totals.product_show_ucnt, prevTotals.product_show_ucnt)],
    ["自然搜索曝光", wholeOrDash(organic.value), deltaNote(number(organic.value), number(prevOrganic.value), whole), deltaTrend(number(organic.value), number(prevOrganic.value))],
    ["投放 ROI", operatingRatio(ads.spend ? ads.pay / ads.spend : null), ads.spend ? `${[...ads.platforms].join("、")} · 投放消耗 ${money(ads.spend)}` : "尚无投放消耗口径"]
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
    ["客单价", money(totals.per_usr_pay_amt), `成交人数 ${whole(totals.pay_ucnt)}`]
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
    ["自然 / 推荐曝光", `${wholeOrDash(organic.value)} / ${wholeOrDash(recommendation.value)}`, "抖音渠道下钻"]
  ];
  return `${metricCards(metrics)}${channelInsightsMarkup(channelRecords)}`;
}
function adsSectionMarkup(records, channelRecords) {
  const totals = aggregate(records);
  const paid = channelGroup(channelRecords, "paid");
  const ads = attributedAdMetrics(records);
  const adSpend = ads.spend;
  const trendRecords = adsTrendRecords(records);
  const metrics = [
    ["投放金额", adSpend ? money(adSpend) : "—", adSpend ? "投放消耗（店铺被投）" : "当前范围未采到投放消耗"],
    ["广告曝光", wholeOrDash(paid.value), "抖音全域、标准及品牌投放来源"],
    ["广告点击", "—", "当前采集接口未提供广告点击"],
    ["广告点击率", "—", "等待广告点击口径接入"],
    ["投放 ROI", operatingRatio(adSpend ? ads.pay / adSpend : null), adSpend ? `${[...ads.platforms].join("、")}支付金额 ÷ 投放金额` : "暂无可计算的投放金额"],
    ["经营支出金额", totals.expense_amt ? money(totals.expense_amt) : "—", "仅作参照，不等同投放金额"]
  ];
  const charts = trendRecords.length ? `<div class="chart-grid"><div class="chart-stack">${lineChart(trendRecords, "ad_cost_amt", "投放消耗趋势")}${lineChart(trendRecords, "pay_amt", "支付金额趋势")}</div><div class="chart-stack">${lineChart(trendRecords, "ad_roi", "投放 ROI 趋势")}${barPanel(trendRecords, "ad_cost_amt", "店铺投放消耗对比")}</div></div>` : "";
  return `${metricCards(metrics)}${charts}`;
}
function renderOperations() {
  const records = operationFilteredRecords();
  const channelRecords = channelSelectedRecords();
  const target = $("#operations-content");
  const detailFiltersTarget = $("#detail-filters");
  const allDates = [.../* @__PURE__ */ new Set([...records.map((item) => item.date), ...channelRecords.map((item) => item.date)])].sort();
  if (detailFiltersTarget) {
    detailFiltersTarget.innerHTML = detailTableFilters();
    bindDetailTableFilters();
  }
  renderOrderImportPanel();
  $("#operations-freshness").textContent = allDates.length ? `数据覆盖至 ${allDates.at(-1)}` : "暂无数据";
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
  target.innerHTML = `${operationTabsMarkup()}${content}<details class="advanced-filter"><summary>高级筛选</summary><p>日期、平台和店铺在上方筛选；这里可进一步按数据来源缩小范围。</p>${operationsFiltersMarkup()}</details>`;
  $$("[data-operation-section]").forEach((button) => button.addEventListener("click", () => {
    state.operationSection = button.dataset.operationSection;
    renderOperations();
  }));
  bindOperationsFilterEvents();
  const hoverRecords = state.operationSection === "traffic" ? channelTrendRecords(channelRecords) : state.operationSection === "ads" ? adsTrendRecords(records) : records;
  if (hoverRecords.length) bindLineChartHover(hoverRecords);
}
async function loadChannel() {
  try {
    state.channel = await request("/api/channel");
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    state.channel = { records: [] };
    showToast(errorMessage(error, "渠道数据读取失败。"), "error");
  }
  operationFilterItems("date").forEach((item) => state.operationDates.add(item));
  operationFilterItems("platform").forEach((item) => state.operationPlatforms.add(item));
  operationFilterItems("shop").forEach((item) => state.operationShops.add(item));
  renderOperations();
}
function renderTable(records, content = false) {
  const headers = content ? ["日期", "店铺", "来源", "直播", "商品卡", "图文/短视频", "短视频", "其他内容"] : ["日期", "店铺", "来源", "成交金额", "支付金额", "结算金额", "成交订单", "成交人数", "客单价", "曝光人数", "点击人数", "点击支付率", "退款率"];
  const rows = [...records].sort((a, b) => `${b.date}${b.shop_name}`.localeCompare(`${a.date}${a.shop_name}`, "zh-CN")).map((item) => {
    const metrics = item.metrics || {}, source = item.content || {};
    const cells = content ? [item.date, item.shop_name, recordSourceLabel(item), moneyOrDash(source.live), moneyOrDash(source.product_card), moneyOrDash(source.artc_video), moneyOrDash(source.video), moneyOrDash(source.other_content)] : [item.date, item.shop_name, recordSourceLabel(item), moneyOrDash(metrics.income_amt), moneyOrDash(metrics.pay_amt), moneyOrDash(metrics.settlement_amt_pay_time), wholeOrDash(metrics.pay_cnt), wholeOrDash(metrics.pay_ucnt), moneyOrDash(metrics.per_usr_pay_amt), wholeOrDash(metrics.product_show_ucnt), wholeOrDash(metrics.product_click_ucnt), ratioOrDash(metrics.product_click_pay_ucnt_ratio), ratioOrDash(metrics.refund_amt_rate)];
    return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="table-freeze-leading"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}">暂无数据</td></tr>`}</tbody></table></div>`;
}
async function loadCompass() {
  try {
    const payload = await request("/api/compass");
    state.records = (Array.isArray(payload.records) ? payload.records : []).map((record) => canonicalOperationRecord(record));
    state.channel = payload.channel ?? null;
    state.operationDates = new Set(operationFilterItems("date"));
    state.operationCalendarCursor = operationFilterItems("date")[0] ? `${operationFilterItems("date")[0].slice(0, 7)}-01` : "";
    state.operationCalendarRangeStart = "";
    state.operationCalendarOpen = false;
    state.operationPlatforms = new Set(operationFilterItems("platform"));
    state.operationShops = new Set(operationFilterItems("shop"));
    state.operationSources = new Set(state.records.map(recordSourceLabel));
    if (!payload.channel) return loadChannel();
    renderOperations();
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    const target = $("#operations-content");
    target.innerHTML = `<div class="empty-panel"><strong>经营数据暂不可用</strong><span>${escapeHtml(errorMessage(error, "请检查 API 服务与数据同步状态。"))}</span></div>`;
  }
}
function sortRows(rows, key, dir) {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const av = number(a[key]), bv = number(b[key]);
    return dir === "asc" ? av - bv : bv - av;
  });
}
function inventoryDays(value) {
  return value === null || value === void 0 ? "—" : `${number(value).toFixed(1)} 天`;
}
function coverageDays(value) {
  return value === null || value === void 0 ? "—" : `${Math.ceil(number(value))} 天`;
}
function costMoney(value) {
  return value === null || value === void 0 ? "—" : settlementMoney(value);
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
  unavailable: "暂无可售"
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
  if (state.inventoryWarehouse && !warehouses.includes(state.inventoryWarehouse)) state.inventoryWarehouse = "";
  if (state.inventoryBrand && !brands.includes(state.inventoryBrand)) state.inventoryBrand = "";
  return (payload.rows || []).filter((item) => {
    const warehouseMatch = !state.inventoryWarehouse || (item.warehouse_name || "未命名仓库") === state.inventoryWarehouse;
    const brandMatch = !state.inventoryBrand || (item.brand_name || "未归类品牌") === state.inventoryBrand;
    return warehouseMatch && brandMatch;
  });
}
function inventoryGroup(rows, keyName) {
  const groups = /* @__PURE__ */ new Map();
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
    turnover_days: group.sales_7d ? group.available_num / (group.sales_7d / 7) : null
  })).sort((a, b) => number(b.available_num) - number(a.available_num));
}
function inventoryHealth(rows) {
  return INVENTORY_HEALTH_ORDER.map((key) => {
    const members = rows.filter((row) => row.health_key === key);
    return {
      key,
      name: INVENTORY_HEALTH_NAMES[key],
      sku_records: members.length,
      available_num: members.reduce((sum, row) => sum + number(row.available_num), 0)
    };
  });
}
function inventorySummary(rows) {
  const coverageRows = rows.filter((row) => row.coverage_days !== null && row.coverage_days !== void 0 && number(row.sales_7d) > 0);
  const available = rows.reduce((sum, row) => sum + number(row.available_num), 0);
  const sales7d = rows.reduce((sum, row) => sum + number(row.sales_7d), 0);
  const costRows = rows.filter((row) => row.cost_covered);
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
    inventory_turnover_days: sales7d ? rows.reduce((sum, row) => sum + number(row.stock_num), 0) / (sales7d / 7) : null,
    average_coverage_days: coverageRows.length ? coverageRows.reduce((sum, row) => sum + number(row.coverage_days), 0) / coverageRows.length : null,
    replenishment_records: rows.filter((row) => ["out_of_stock", "urgent", "replenish"].includes(row.health_key)).length,
    no_movement_records: rows.filter((row) => row.health_key === "no_movement").length,
    overstock_records: rows.filter((row) => ["overstock", "high"].includes(row.health_key)).length,
    cost_covered_records: costRows.length,
    cost_coverage_rate: rows.length ? costRows.length / rows.length : null,
    stock_cost_amount: costRows.length ? costRows.reduce((sum, row) => sum + number(row.stock_cost_amount), 0) : null,
    available_cost_amount: costRows.length ? costRows.reduce((sum, row) => sum + number(row.available_cost_amount), 0) : null
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
  const tags = [state.inventoryWarehouse ? `仓库：${state.inventoryWarehouse}` : "全部仓库", state.inventoryBrand ? `品牌：${state.inventoryBrand}` : "全部品牌"].map((tag) => `<span class="filter-summary-tag">${escapeHtml(tag)}</span>`).join("");
  return `<section class="table-filter-panel inventory-filter" aria-label="库存筛选"><div><strong>库存筛选</strong></div><div class="filter-summary" aria-live="polite"><span class="filter-summary-label">当前范围</span>${tags}<button class="filter-reset" type="button" data-reset-inventory-filters>重置</button></div><label>仓库<select data-inventory-filter="warehouse">${warehouseOptions}</select></label><label>品牌<select data-inventory-filter="brand">${brandOptions}</select></label></section>`;
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
  const rowsWithTurnover = rows.map((item) => ({
    ...item,
    inventory_turnover_days: number(item.sales_7d) ? number(item.stock_num) / (number(item.sales_7d) / 7) : null
  }));
  const columnConfigs = mode === "replenish" ? [{ label: "状态", key: "" }, { label: "仓库", key: "" }, { label: "货品", key: "" }, { label: "商家编码", key: "" }, { label: "可发库存", key: "available_num" }, { label: "近 7 天出库", key: "sales_7d" }, { label: "预计可售", key: "coverage_days" }, { label: "建议补货", key: "replenish_qty" }, { label: "近 30 天入库", key: "inbound_30d" }] : [{ label: "状态", key: "" }, { label: "仓库", key: "" }, { label: "品牌", key: "" }, { label: "货品", key: "" }, { label: "商家编码", key: "" }, { label: "可发库存", key: "available_num" }, { label: "成本单价", key: "cost_price" }, { label: "库存成本", key: "stock_cost_amount" }, { label: "可售库存成本", key: "available_cost_amount" }, { label: "近 7 天出库", key: "sales_7d" }, { label: "预计可售", key: "coverage_days" }, { label: "周转天数", key: "inventory_turnover_days" }, { label: "近 30 天入库", key: "inbound_30d" }, { label: "最后出入库", key: "" }];
  const sorted = sortRows(rowsWithTurnover, state.inventorySortKey, state.inventorySortDir);
  const visible = sorted.slice(0, 200);
  const body = visible.map((item) => {
    const shared = [healthPill(item), item.warehouse_name, item.goods_name, item.spec_no, whole(item.available_num), whole(item.sales_7d), coverageDays(item.coverage_days), whole(item.replenish_qty), whole(item.inbound_30d)];
    const cells = mode === "replenish" ? shared : [healthPill(item), item.warehouse_name, item.brand_name, item.goods_name, item.spec_no, whole(item.available_num), item.cost_covered ? costMoney(item.cost_price) : "—", costMoney(item.stock_cost_amount), costMoney(item.available_cost_amount), whole(item.sales_7d), coverageDays(item.coverage_days), inventoryDays(item.inventory_turnover_days), whole(item.inbound_30d), item.last_inout_time || "—"];
    return `<tr class="${number(item.available_num) < 0 ? "inventory-alert" : ""}">${cells.map((cell, index) => `<td>${index === 0 ? cell : escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("");
  const notice = total > 200 ? `<p class="table-truncate-note">共 ${whole(total)} 条，当前显示前 200 条，可通过筛选缩小范围</p>` : "";
  const headerCells = columnConfigs.map((col) => `<th ${col.key ? `data-sort-key="${col.key}"` : ""} class="${state.inventorySortKey === col.key ? "sorted-" + state.inventorySortDir : ""}">${col.label}</th>`).join("");
  return `${notice}<div class="table-wrap"><table class="table-freeze-leading"><thead><tr>${headerCells}</tr></thead><tbody>${body || `<tr><td colspan="${columnConfigs.length}">暂无符合条件的库存记录</td></tr>`}</tbody></table></div>`;
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
  const tabs = [["overview", "总览"], ["replenish", "补货清单"], ["overstock", "积压 / 未动销"], ["detail", "单品维度"]];
  return `<div class="inventory-tabs" role="tablist">${tabs.map(([key, label]) => `<button class="inventory-tab ${view === key ? "active" : ""}" type="button" data-inventory-view="${key}" role="tab" aria-selected="${view === key}">${label}</button>`).join("")}</div>`;
}
function renderInventory(payload, view = state.inventoryView) {
  if (!payload) return;
  state.inventory = payload;
  state.inventoryView = view;
  const rows = inventoryFilteredRows(payload);
  const summary = inventorySummary(rows);
  const warehouses = inventoryGroup(rows, "warehouse_name");
  const health = inventoryHealth(rows);
  const salesTrend = inventorySalesTrend(payload);
  $("#inventory-freshness").textContent = payload.captured_at ? `快照 · ${payload.captured_at}` : "本地快照";
  const costCoverage = summary.cost_coverage_rate === null ? "暂无库存记录" : `成本已维护：${whole(summary.cost_covered_records)}/${whole(summary.sku_records)} 条（${(summary.cost_coverage_rate * 100).toFixed(1)}%）`;
  const metrics = [
    ["可发库存", whole(summary.available_num), `可售 SKU：${whole(summary.salable_skus)}`],
    ["已覆盖库存成本", costMoney(summary.stock_cost_amount), costCoverage, summary.cost_coverage_rate !== 1 ? "attention" : ""],
    ["近 7 天出库", whole(summary.sales_7d), "用于估算近期日均需求"],
    ["预计可售天数", inventoryDays(summary.turnover_days), "整体可发库存 ÷ 日均出库"],
    ["库存周转天数", inventoryDays(summary.inventory_turnover_days), "总库存 ÷ 近 7 天日均出库"],
    ["需补货记录", whole(summary.replenishment_records), "已缺货、紧急补货与需补货", "attention"],
    ["偏高 / 积压", whole(summary.overstock_records), "可售超过 45 天的动销记录", "attention"],
    ["近 7 日未动销", whole(summary.no_movement_records), "有可发库存、近 7 日无出库", "attention"]
  ];
  const cards = `<div class="metric-grid eight">${metrics.map(([label, value, note, status]) => `<article class="metric-card"><div class="metric-label">${label}</div>${status ? `<span class="metric-status ${status}">需关注</span>` : ""}<div class="metric-value">${value}</div><div class="metric-delta ${status || ""}">${note}</div></article>`).join("")}</div>`;
  const replenishment = rows.filter((item) => ["out_of_stock", "urgent", "replenish"].includes(item.health_key));
  const overstock = rows.filter((item) => ["high", "overstock", "no_movement"].includes(item.health_key));
  const overview = `${cards}<div class="chart-grid"><div class="chart-stack">${healthDistribution(health)}${salesTrendPanel(salesTrend)}</div><div class="chart-stack">${inventoryBarPanel(warehouses, "仓库可发库存排行", "available_num")}</div></div><h3 class="section-title">优先处理 <small>先补货，再处理库存偏高与未动销</small></h3>${inventoryTable(replenishment, "replenish")}`;
  const content = view === "replenish" ? `<h3 class="section-title inventory-first-title">补货优先级 <small>按缺货与预计可售天数排序，显示前 200 条</small></h3>${inventoryTable(replenishment, "replenish")}` : view === "overstock" ? `<h3 class="section-title inventory-first-title">积压 / 未动销清单 <small>“未动销”仅基于近 7 天销售出库</small></h3>${inventoryTable(overstock)}` : view === "detail" ? `<h3 class="section-title inventory-first-title">单品维度<small>按风险优先级排序，显示前 200 条</small></h3>${inventoryTable(rows)}` : overview;
  $("#inventory-content").innerHTML = `${inventoryWarehouseFilter(payload)}${inventoryTabs(view)}${content}`;
  $('[data-inventory-filter="warehouse"]')?.addEventListener("change", (event) => {
    state.inventoryWarehouse = event.currentTarget.value;
    renderInventory(payload);
  });
  $('[data-inventory-filter="brand"]')?.addEventListener("change", (event) => {
    state.inventoryBrand = event.currentTarget.value;
    renderInventory(payload);
  });
  $("[data-reset-inventory-filters]")?.addEventListener("click", () => {
    state.inventoryWarehouse = "";
    state.inventoryBrand = "";
    renderInventory(payload);
  });
  $$("[data-inventory-view]").forEach((button) => button.addEventListener("click", () => renderInventory(payload, button.dataset.inventoryView)));
}
async function loadInventory() {
  const target = $("#inventory-content");
  try {
    const payload = await request("/api/inventory");
    renderInventory(payload);
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    const message = errorMessage(error, "请在服务器侧运行只读库存同步");
    target.innerHTML = `<div class="empty-panel"><strong>库存快照暂不可用</strong><span>${escapeHtml(message)}</span></div>`;
  }
}
function settlementGroupTable(title, groups) {
  const rows = [...groups || []].sort((a, b) => number(b.settlement_amount) - number(a.settlement_amount)).map((item) => `<tr><td>${escapeHtml(item.name || "未标注")}</td><td>${settlementMoney(item.settlement_amount)}</td><td>${settlementMoney(item.income_total)}</td><td>${settlementMoney(item.expense_total)}</td><td>${whole(item.order_count)}</td><td>${whole(item.row_count)}</td></tr>`).join("");
  return `<section class="panel"><div class="panel-head"><div><h3>${title}</h3><span>按结算金额排序</span></div></div><div class="table-wrap"><table class="table-freeze-leading"><thead><tr><th>维度</th><th>结算金额</th><th>收入合计</th><th>支出合计</th><th>订单数</th><th>明细行</th></tr></thead><tbody>${rows || `<tr><td colspan="6">暂无结算数据</td></tr>`}</tbody></table></div></section>`;
}
function settlementDates(payload = state.settlement) {
  return [...new Set(payload?.available_dates || state.settlementAvailableDates || [])].filter(Boolean).sort((a, b) => b.localeCompare(a));
}
function settlementCalendarDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function settlementCalendarMonthStart(value) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}
function shiftSettlementCalendarMonth(value, amount) {
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
function settlementCalendarMonthMarkup(monthValue, availableDates, rangeStart, rangeEnd) {
  const cursor = settlementCalendarMonthStart(monthValue);
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth() + 1;
  const firstWeekday = cursor.getUTCDay() || 7;
  const gridStart = new Date(Date.UTC(year, month - 1, 2 - firstWeekday));
  const today = settlementCalendarDate((/* @__PURE__ */ new Date()).getFullYear(), (/* @__PURE__ */ new Date()).getMonth() + 1, (/* @__PURE__ */ new Date()).getDate());
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
function settlementCalendarMarkup(payload) {
  const dates = settlementDates(payload);
  if (!dates.length) return `<div class="date-filter-field"><span>结算日期</span><button class="date-picker-trigger" type="button" disabled>暂无日期</button></div>`;
  const availableDates = new Set(dates);
  const cursor = state.settlementCalendarCursor || `${dates[0].slice(0, 7)}-01`;
  const rangeStart = state.settlementCalendarRangeStart || state.settlementStartDate;
  const rangeEnd = state.settlementCalendarRangeStart ? state.settlementCalendarRangeStart : state.settlementEndDate;
  const selectedCount = state.settlementStartDate || state.settlementEndDate ? dates.filter((date) => (!state.settlementStartDate || date >= state.settlementStartDate) && (!state.settlementEndDate || date <= state.settlementEndDate)).length : dates.length;
  const hint = state.settlementCalendarRangeStart ? `已选择 ${state.settlementCalendarRangeStart}，可再选结束日期或直接确定单日` : "点击一天选择单日，或依次点击开始和结束日期";
  return `<div class="date-filter-field"><span>结算日期</span><details class="date-range-picker" ${state.settlementCalendarOpen ? "open" : ""}><summary class="date-picker-trigger"><span>${escapeHtml(settlementDateLabel())}</span><i aria-hidden="true"></i></summary><div class="calendar-popover"><div class="calendar-toolbar"><button type="button" data-settlement-calendar-shift="-12" aria-label="上一年">«</button><button type="button" data-settlement-calendar-shift="-1" aria-label="上个月">‹</button><span>${escapeHtml(hint)}</span><button type="button" data-settlement-calendar-shift="1" aria-label="下个月">›</button><button type="button" data-settlement-calendar-shift="12" aria-label="下一年">»</button></div><div class="calendar-months">${settlementCalendarMonthMarkup(cursor, availableDates, rangeStart, rangeEnd)}${settlementCalendarMonthMarkup(shiftSettlementCalendarMonth(cursor, 1), availableDates, rangeStart, rangeEnd)}</div><div class="calendar-footer"><span>${selectedCount} 个结算日</span><div><button type="button" data-settlement-calendar-all>全部日期</button><button class="calendar-confirm" type="button" data-settlement-calendar-confirm>确定</button></div></div></div></details></div>`;
}
function settlementFiltersMarkup(payload) {
  const shops = payload.shops || [];
  const selected = payload.selected_shop || state.settlementShop || "";
  const options = `<option value="">全部店铺</option>${shops.map((name) => `<option value="${escapeHtml(name)}" ${selected === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  const tags = [settlementDateLabel(), selected ? `店铺：${selected}` : "全部店铺"].map((tag) => `<span class="filter-summary-tag">${escapeHtml(tag)}</span>`).join("");
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
function renderSettlementFilters(payload) {
  const target = $("#settlement-filters");
  if (!target) return;
  target.innerHTML = settlementFiltersMarkup(payload);
  $('[data-settlement-filter="shop"]', target)?.addEventListener("change", (event) => {
    state.settlementShop = event.currentTarget.value;
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
function settlementDetailTable(rows) {
  const body = [...rows || []].map((item) => {
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
      settlementMoney(governmentSubsidy)
    ];
    return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("");
  return `<details class="detail-table-disclosure" open><summary><span>结算明细</span><small>最多显示前 ${whole(rows?.length || 0)} 条</small></summary><div class="detail-table-content"><div class="table-wrap"><table class="table-freeze-leading"><thead><tr><th>店铺</th><th>结算时间</th><th>订单号</th><th>商品</th><th>业务类型</th><th>结算金额</th><th>用户实付</th><th>收入合计</th><th>支出合计</th><th>平台服务费</th><th>政府补贴</th></tr></thead><tbody>${body || `<tr><td colspan="11">暂无结算明细</td></tr>`}</tbody></table></div></div></details>`;
}
function renderSettlement(payload) {
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
  const fileNames = (payload.files || []).map((file) => file.name).filter(Boolean);
  $("#settlement-freshness").textContent = state.settlementAvailableDates.length ? `结算至 ${state.settlementAvailableDates[0]}` : "暂无数据";
  const governmentSubsidy = number(summary.government_merchant) + number(summary.government_platform);
  const metrics = [
    ["结算净额", settlementMoney(summary.settlement_amount), `明细行：${whole(summary.row_count)}`],
    ["收入合计", settlementMoney(summary.income_total), `用户实付：${settlementMoney(summary.user_paid)}`],
    ["支出合计", settlementMoney(summary.expense_total), `平台服务费：${settlementMoney(summary.service_fee)}`],
    ["订单数", whole(summary.order_count), "按订单号去重"],
    ["平台补贴", settlementMoney(summary.platform_subsidy), "平台、其他平台与运费补贴"],
    ["政府补贴", settlementMoney(governmentSubsidy), "商家垫资 + 平台垫资"]
  ];
  $("#settlement-summary-cards").innerHTML = metrics.map(([label, value, note]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-delta">${note}</div></article>`).join("");
  const hasActiveFilter = Boolean(state.settlementShop || state.settlementStartDate || state.settlementEndDate);
  const emptyMessage = hasActiveFilter ? "当前筛选范围暂无结算数据，请调整结算日期或店铺。" : "请上传结算 CSV 或把文件放入服务器 output/settlement/ 目录后刷新页面。";
  $("#settlement-content").innerHTML = summary.row_count ? `${settlementUploadPanel()}<section class="panel operations-note"><h3>数据来源</h3><p>读取服务器本地 <code>output/settlement/</code> 目录下的抖音结算 CSV；金额按 CSV 原始元单位展示，不做分转元转换。</p><p>已读取文件：${escapeHtml(fileNames.join("、") || "—")}</p></section><div class="chart-grid"><div class="chart-stack">${settlementGroupTable("按结算月份", payload.months)}${settlementGroupTable("按店铺", payload.shop_groups)}</div><div class="chart-stack">${settlementGroupTable("按商户主体", payload.subjects)}${settlementGroupTable("按业务类型", payload.business_types)}</div></div>${settlementDetailTable(payload.rows)}` : `${settlementUploadPanel()}<div class="empty-panel"><strong>暂无结算数据</strong><span>${emptyMessage}</span></div>`;
  $("#settlement-upload-form")?.addEventListener("submit", uploadSettlement);
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
    showToast(state.settlementUploadMessage, "error");
    if (state.settlement) renderSettlement(state.settlement);
    return;
  }
  button.disabled = true;
  button.textContent = "正在上传…";
  state.settlementUploadMessage = "";
  const content = await uploadFile.text();
  try {
    const payload = await request("/api/settlement/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop_name: shopName, file_name: uploadFile.name, content })
    });
    const uploaded = payload.upload?.file;
    state.settlementShop = String(uploaded?.shop_name ?? state.settlementShop);
    state.settlementUploadMessage = `已导入 ${uploaded?.original_name || uploaded?.name || "结算 CSV"}，解析 ${whole(uploaded?.rows)} 行。`;
    showToast(state.settlementUploadMessage, "success");
    await loadSettlement();
  } catch (error) {
    state.settlementUploadMessage = isApiRequestError(error) && error.status === 413 ? "结算 CSV 超过 32MB 上传上限，请拆分文件后重试。" : errorMessage(error, "结算 CSV 上传失败，请检查文件格式。");
    showToast(state.settlementUploadMessage, "error");
    if (state.settlement) renderSettlement(state.settlement);
  }
}
async function loadSettlement() {
  const target = $("#settlement-content");
  try {
    const query = new URLSearchParams();
    if (state.settlementShop) query.set("shop", state.settlementShop);
    if (state.settlementStartDate) query.set("start_date", state.settlementStartDate);
    if (state.settlementEndDate) query.set("end_date", state.settlementEndDate);
    const payload = await request(`/api/settlement${query.size ? `?${query}` : ""}`);
    renderSettlement(payload);
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    const message = errorMessage(error, "请检查 Rust API 与 output/settlement 目录");
    target.innerHTML = `<div class="empty-panel"><strong>结算数据暂不可用</strong><span>${escapeHtml(message)}</span></div>`;
  }
}
let statusRefreshTimer = null;
let previousTerminalOutput = "";
let terminalUnreadLines = 0;
function terminalOutput(status) {
  return typeof status?.terminal_output === "string" ? status.terminal_output : "";
}
function terminalAtBottom(terminal) {
  return terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 24;
}
function terminalViewport() {
  const terminal = $("[data-collection-terminal]");
  if (!terminal) return null;
  return { scrollTop: terminal.scrollTop, atBottom: terminalAtBottom(terminal) };
}
function addedTerminalLines(previous, next) {
  if (!previous || !next || previous === next) return 0;
  const appended = next.startsWith(previous) ? next.slice(previous.length) : next;
  return appended.split("\n").filter(Boolean).length;
}
function statusTerminal(status, logMessage) {
  const output = terminalOutput(status);
  if (output) {
    const lineCount = output.split("\n").length;
    const follow = terminalUnreadLines ? `<button class="status-log-follow" type="button" data-terminal-follow>有 ${escapeHtml(String(terminalUnreadLines))} 条新输出 · 回到底部</button>` : "";
    return `<div class="status-log"><div class="status-log-head"><span>采集终端输出</span><div class="status-log-meta"><small>最近 ${escapeHtml(String(lineCount))} 行</small>${follow}</div></div><pre data-collection-terminal>${escapeHtml(output)}</pre></div>`;
  }
  return `<p class="status-log-empty">${escapeHtml(logMessage || "当前还没有采集终端输出。")}</p>`;
}
function restoreTerminalViewport(viewport) {
  const terminal = $("[data-collection-terminal]");
  if (!terminal) return;
  if (!viewport || viewport.atBottom) terminal.scrollTop = terminal.scrollHeight;
  else terminal.scrollTop = Math.min(viewport.scrollTop, Math.max(0, terminal.scrollHeight - terminal.clientHeight));
  terminal.addEventListener("scroll", () => {
    if (terminalAtBottom(terminal)) {
      terminalUnreadLines = 0;
      $("[data-terminal-follow]")?.remove();
    }
  });
  $("[data-terminal-follow]")?.addEventListener("click", () => {
    terminalUnreadLines = 0;
    terminal.scrollTop = terminal.scrollHeight;
    $("[data-terminal-follow]")?.remove();
  });
}
function collectionModuleCard(name, title, description, status) {
  const result = status.modules?.[name] || {};
  const selected = state.collectionModules.has(name);
  const finished = number(result.success_count) + number(result.error_count);
  const resultLabel = finished ? `${whole(result.success_count)} 个成功 · ${whole(result.error_count)} 个异常` : "等待下一次采集";
  return `<label class="collection-module ${selected ? "selected" : ""}">
    <input type="checkbox" data-collection-module="${name}" ${selected ? "checked" : ""} ${isAdmin() ? "" : "disabled"} />
    <span class="collection-module-check">${selected ? "✓" : ""}</span>
    <span class="collection-module-copy"><strong>${title}</strong><small>${description}</small><em>${resultLabel}</em></span>
  </label>`;
}
function collectionStateLabel(status) {
  const labels = { unknown: "等待首次运行", manual_requested: "请求已排队", waiting_random: "等待启动", running: "采集中", success: "采集成功", partial_success: "部分成功", failed: "采集失败", skipped: "已跳过" };
  return labels[status.state ?? ""] || status.state || "未知";
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
  if (!slot) return;
  const viewport = terminalViewport();
  const output = terminalOutput(status);
  const newLines = addedTerminalLines(previousTerminalOutput, output);
  if (!output) terminalUnreadLines = 0;
  else if (!viewport || viewport.atBottom) terminalUnreadLines = 0;
  else terminalUnreadLines += newLines;
  previousTerminalOutput = output;
  state.status = status;
  const online = Boolean(status.collector_online);
  const busy = Boolean(status.job_running || status.request_pending) || ["manual_requested", "waiting_random", "running"].includes(status.state ?? "");
  const health = online ? "采集服务在线" : "采集服务离线";
  const request2 = status.request_pending ? "有任务等待或执行中" : "队列为空";
  const feedback = state.collectionMessage ? `<p class="collection-feedback">${escapeHtml(state.collectionMessage)}</p>` : "";
  const permission = isAdmin() ? "选择本次要更新的数据；模块异常互不影响。" : "当前账户为只读权限，可查看状态但不能提交任务。";
  const backfillReady = Boolean(backfillDateAllowed(state.collectionBackfillDate) && state.collectionBackfillShops.size);
  slot.innerHTML = `${feedback}
    <div class="collection-health-grid">
      <article class="collection-health"><span class="health-indicator ${online ? "online" : "offline"}"></span><small>服务状态</small><strong>${health}</strong></article>
      <article class="collection-health"><small>任务状态</small><strong>${escapeHtml(collectionStateLabel(status))}</strong><span>${escapeHtml(status.message || "暂无采集记录")}</span></article>
      <article class="collection-health"><small>任务队列</small><strong>${request2}</strong><span>最近成功：${escapeHtml(status.last_success_at || "—")}</span></article>
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
      ${isAdmin() ? `<div class="status-actions"><button id="collection-clear-terminal-button" class="button" type="button">清除终端数据</button></div>` : ""}
    </div></details>`;
  restoreTerminalViewport(viewport);
  $$("[data-collection-module]", slot).forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.collectionModules.add(input.dataset.collectionModule);
    else state.collectionModules.delete(input.dataset.collectionModule);
    renderCollectionCenter(state.status || {});
  }));
  $$("[data-backfill-shop]", slot).forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.collectionBackfillShops.add(input.dataset.backfillShop);
    else state.collectionBackfillShops.delete(input.dataset.backfillShop);
    renderCollectionCenter(state.status || {});
  }));
  $("#collection-backfill-date")?.addEventListener("change", (event) => {
    state.collectionBackfillDate = event.currentTarget.value;
    renderCollectionCenter(state.status || {});
  });
  $("#collection-run-button")?.addEventListener("click", startCollection);
  $("#collection-backfill-button")?.addEventListener("click", startHistoricalCollection);
  $("#collection-clear-terminal-button")?.addEventListener("click", clearCollectionTerminal);
}
async function refreshCollectionStatus() {
  window.clearTimeout(statusRefreshTimer ?? void 0);
  try {
    const status = await request("/api/collection/status", { cache: "no-store" });
    renderCollectionCenter(status);
    const busy = Boolean(status.job_running || status.request_pending) || ["manual_requested", "waiting_random", "running"].includes(status.state ?? "");
    if (state.page === "collection") statusRefreshTimer = window.setTimeout(refreshCollectionStatus, busy ? 5e3 : 15e3);
  } catch {
    if (state.status) renderCollectionCenter(state.status, { logMessage: "暂时无法读取采集服务状态，请稍后重试。" });
  }
}
async function loadCollectionShops() {
  try {
    const payload = await request("/api/collection/shops");
    setCollectionShops(Array.isArray(payload.shops) ? payload.shops : []);
  } catch {
  }
}
async function startCollection() {
  const button = $("#collection-run-button");
  const modules = [...state.collectionModules];
  if (!modules.length) {
    state.collectionMessage = "请至少选择一个采集模块。";
    showToast(state.collectionMessage, "error");
    renderCollectionCenter(state.status || {});
    return;
  }
  button.disabled = true;
  button.textContent = "正在提交…";
  try {
    const payload = await request("/api/collection/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modules }) });
    state.collectionMessage = payload.message ?? "请求已发送";
    showToast(state.collectionMessage, "success");
    if (payload.status) renderCollectionCenter(payload.status);
  } catch (error) {
    state.collectionMessage = errorMessage(error, "提交失败");
    showToast(state.collectionMessage, "error");
  }
  window.setTimeout(refreshCollectionStatus, 700);
}
async function startHistoricalCollection() {
  const button = $("#collection-backfill-button");
  const date = state.collectionBackfillDate;
  const shops = COLLECTION_SHOPS.filter((shop) => state.collectionBackfillShops.has(shop));
  if (!backfillDateAllowed(date) || !shops.length) {
    state.collectionMessage = "请选择本月 1 日至昨天之间的日期，并至少选择一家店铺。";
    showToast(state.collectionMessage, "error");
    renderCollectionCenter(state.status || {});
    return;
  }
  button.disabled = true;
  button.textContent = "正在提交补采…";
  try {
    const payload = await request("/api/collection/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: ["operations"], date, shops })
    });
    state.collectionMessage = payload.message ?? `已提交 ${date} 补采`;
    showToast(state.collectionMessage, "success");
    if (payload.status) renderCollectionCenter(payload.status);
  } catch (error) {
    state.collectionMessage = errorMessage(error, "补采提交失败");
    showToast(state.collectionMessage, "error");
  }
  window.setTimeout(refreshCollectionStatus, 700);
}
async function clearCollectionTerminal() {
  if (!window.confirm("确定清除采集终端数据吗？这不会影响已经采集的数据或任务状态；任务运行中时，后续输出仍会继续写入。")) return;
  const button = $("#collection-clear-terminal-button");
  button.disabled = true;
  button.textContent = "正在清除…";
  try {
    const payload = await request("/api/collection/terminal", { method: "DELETE" });
    previousTerminalOutput = "";
    terminalUnreadLines = 0;
    state.collectionMessage = payload.message ?? "采集终端数据已清除";
    showToast(state.collectionMessage, "success");
    renderCollectionCenter(payload.status || {});
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return showLogin();
    state.collectionMessage = errorMessage(error, "终端数据清除失败");
    showToast(state.collectionMessage, "error");
    renderCollectionCenter(state.status || {});
  }
}
function stopCollectionStatusRefresh() {
  window.clearTimeout(statusRefreshTimer ?? void 0);
}
function buildPlaceholders() {
  $$("[data-placeholder]").forEach((grid) => {
    grid.innerHTML = (grid.dataset.placeholder ?? "").split("|").map((label) => `<article class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">—</div><div class="metric-delta">等待数据接入</div></article>`).join("");
  });
}
window.addEventListener("luopan-api-fallback", () => {
  showToast("SQLite 数据暂不可用，当前展示的是 JSON 回退数据。", "error");
});
function activatePage(name) {
  state.page = name;
  $$(".dashboard-page").forEach((page) => page.classList.toggle("active", page.dataset.page === name));
  $$(".nav-tab[data-page], .topbar-action[data-page]").forEach((tab) => {
    const active = tab.dataset.page === name;
    tab.classList.toggle("active", active);
    if (tab.dataset.page) tab.setAttribute("aria-current", active ? "page" : "false");
  });
  $("#filter-quick-action")?.classList.toggle("hidden", !["inventory", "operations", "settlement"].includes(name));
  history.replaceState(null, "", `#${name}`);
  if (name === "collection" && state.currentUser) refreshCollectionStatus();
  else stopCollectionStatusRefresh();
}
function setTableDensity(density) {
  const compact = density === "compact";
  document.body.dataset.tableDensity = compact ? "compact" : "comfortable";
  const toggle = $("#table-density-toggle");
  toggle?.setAttribute("aria-pressed", String(compact));
  const label = $("span", toggle);
  if (label) label.textContent = compact ? "表格：紧凑" : "表格：舒适";
  localStorage.setItem("luopan-table-density", compact ? "compact" : "comfortable");
}
async function initialise() {
  buildPlaceholders();
  const desired = location.hash.slice(1);
  const pageNames = ["inventory", "operations", "settlement", "collection", "account"];
  activatePage(desired === "channel" ? "operations" : pageNames.includes(desired) ? desired : "operations");
  $$(".nav-tab[data-page], .topbar-action[data-page]").forEach((tab) => tab.addEventListener("click", () => activatePage(tab.dataset.page ?? "operations")));
  setTableDensity(localStorage.getItem("luopan-table-density") || "comfortable");
  $("#table-density-toggle")?.addEventListener("click", () => setTableDensity(document.body.dataset.tableDensity === "compact" ? "comfortable" : "compact"));
  $("#filter-quick-action")?.addEventListener("click", () => {
    const panel = $(".dashboard-page.active .table-filter-panel");
    if (!panel) return;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => $("select, summary, button", panel)?.focus(), 280);
  });
  $("#inventory-content").addEventListener("click", (event) => {
    const th = event.target.closest("[data-sort-key]");
    if (!th) return;
    const key = th.dataset.sortKey;
    state.inventorySortDir = state.inventorySortKey === key && state.inventorySortDir === "desc" ? "asc" : "desc";
    state.inventorySortKey = key ?? "";
    renderInventory(state.inventory);
  });
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const user = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
      $("#login-error").textContent = "";
      showApp(user);
      loadCompass();
      loadOrderImports();
      loadInventory();
      loadSettlement();
      loadCollectionShops().then(refreshCollectionStatus);
    } catch (error) {
      $("#login-error").textContent = errorMessage(error, "登录失败");
    }
  });
  try {
    const me = await request("/api/me");
    if (me.authenticated && me.username && me.role) {
      showApp({ username: me.username, role: me.role });
      loadCompass();
      loadOrderImports();
      loadInventory();
      loadSettlement();
      loadCollectionShops().then(refreshCollectionStatus);
    } else showLogin();
  } catch {
    showLogin();
  }
}
initialise();
