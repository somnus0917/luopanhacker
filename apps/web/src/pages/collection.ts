import { $, $$ } from "../dom";
import { errorMessage, isApiRequestError, request } from "../api";
import { showToast } from "../feedback";
import { escapeHtml, number, whole } from "../format";
import {
  backfillDateAllowed, COLLECTION_SHOPS, currentLocalMonthStart, isAdmin,
  previousLocalDate, setCollectionShops, state,
} from "../state";
import { showLogin } from "./account";
import type { CollectionStatus } from "../types";

let statusRefreshTimer: number | null = null;
let previousTerminalOutput = "";
let terminalUnreadLines = 0;

function terminalOutput(status: CollectionStatus | null) {
  return typeof status?.terminal_output === "string" ? status.terminal_output : "";
}

function terminalAtBottom(terminal: HTMLElement) {
  return terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 24;
}

function terminalViewport() {
  const terminal = $("[data-collection-terminal]");
  if (!terminal) return null;
  return { scrollTop: terminal.scrollTop, atBottom: terminalAtBottom(terminal) };
}

function addedTerminalLines(previous: string, next: string) {
  if (!previous || !next || previous === next) return 0;
  const appended = next.startsWith(previous) ? next.slice(previous.length) : next;
  return appended.split("\n").filter(Boolean).length;
}

function statusTerminal(status: CollectionStatus | null, logMessage: string) {
  const output = terminalOutput(status);
  if (output) {
    const lineCount = output.split("\n").length;
    const follow = terminalUnreadLines ? `<button class="status-log-follow" type="button" data-terminal-follow>有 ${escapeHtml(String(terminalUnreadLines))} 条新输出 · 回到底部</button>` : "";
    return `<div class="status-log"><div class="status-log-head"><span>采集终端输出</span><div class="status-log-meta"><small>最近 ${escapeHtml(String(lineCount))} 行</small>${follow}</div></div><pre data-collection-terminal>${escapeHtml(output)}</pre></div>`;
  }
  return `<p class="status-log-empty">${escapeHtml(logMessage || "当前还没有采集终端输出。")}</p>`;
}

function restoreTerminalViewport(viewport: { scrollTop: number; atBottom: boolean } | null) {
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

function collectionModuleCard(name: string, title: string, description: string, status: CollectionStatus) {
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

function collectionStateLabel(status: CollectionStatus) {
  const labels: Record<string, string> = { unknown: "等待首次运行", manual_requested: "请求已排队", waiting_random: "等待启动", running: "采集中", success: "采集成功", partial_success: "部分成功", failed: "采集失败", skipped: "已跳过" };
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

export function renderCollectionCenter(status: CollectionStatus, { logMessage = "" }: { logMessage?: string } = {}) {
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
      ${isAdmin() ? `<div class="status-actions"><button id="collection-clear-terminal-button" class="button" type="button">清除终端数据</button></div>` : ""}
    </div></details>`;
  restoreTerminalViewport(viewport);
  $$('[data-collection-module]', slot).forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.collectionModules.add(input.dataset.collectionModule);
    else state.collectionModules.delete(input.dataset.collectionModule);
    renderCollectionCenter(state.status || {});
  }));
  $$("[data-backfill-shop]", slot).forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.collectionBackfillShops.add(input.dataset.backfillShop);
    else state.collectionBackfillShops.delete(input.dataset.backfillShop);
    renderCollectionCenter(state.status || {});
  }));
  $("#collection-backfill-date")?.addEventListener("change", (event: Event) => {
    state.collectionBackfillDate = (event.currentTarget as HTMLInputElement).value;
    renderCollectionCenter(state.status || {});
  });
  $("#collection-run-button")?.addEventListener("click", startCollection);
  $("#collection-backfill-button")?.addEventListener("click", startHistoricalCollection);
  $("#collection-clear-terminal-button")?.addEventListener("click", clearCollectionTerminal);
}

export async function refreshCollectionStatus() {
  window.clearTimeout(statusRefreshTimer ?? undefined);
  try {
    const status = await request<CollectionStatus>("/api/collection/status", { cache: "no-store" });
    renderCollectionCenter(status);
    const busy = Boolean(status.job_running || status.request_pending) || ["manual_requested", "waiting_random", "running"].includes(status.state ?? "");
    if (state.page === "collection") statusRefreshTimer = window.setTimeout(refreshCollectionStatus, busy ? 5000 : 15000);
  } catch {
    if (state.status) renderCollectionCenter(state.status, { logMessage: "暂时无法读取采集服务状态，请稍后重试。" });
  }
}

export async function loadCollectionShops() {
  try {
    const payload = await request<{ shops?: string[] }>("/api/collection/shops");
    setCollectionShops(Array.isArray(payload.shops) ? payload.shops : []);
  } catch { /* collection status remains usable without the selector */ }
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
    const payload = await request<{ message?: string; status?: CollectionStatus }>("/api/collection/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modules }) });
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
    const payload = await request<{ message?: string; status?: CollectionStatus }>("/api/collection/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: ["operations"], date, shops }),
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
    const payload = await request<{ message?: string; status?: CollectionStatus }>("/api/collection/terminal", { method: "DELETE" });
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

export function stopCollectionStatusRefresh() {
  window.clearTimeout(statusRefreshTimer ?? undefined);
}
