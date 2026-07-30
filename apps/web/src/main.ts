import "./style.css";
import { $, $$ } from "./dom";
import { escapeHtml } from "./format";
import { state } from "./state";
import { loadUsers, showApp, showLogin } from "./pages/account";
import {
  loadCompass, loadOrderImports,
} from "./pages/operations";
import { loadInventory, renderInventory } from "./pages/inventory";
import { loadSettlement } from "./pages/settlement";
import {
  refreshCollectionStatus, stopCollectionStatusRefresh,
} from "./pages/collection";

function buildPlaceholders() {
  $$('[data-placeholder]').forEach((grid) => {
    grid.innerHTML = grid.dataset.placeholder.split("|").map((label) => `<article class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">—</div><div class="metric-delta">等待数据接入</div></article>`).join("");
  });
}

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
  activatePage(desired === "channel" ? "operations" : ["inventory", "operations", "settlement", "collection", "account"].includes(desired) ? desired : "operations");
  $$(".nav-tab[data-page], .topbar-action[data-page]").forEach((tab) => tab.addEventListener("click", () => activatePage(tab.dataset.page)));
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
    state.inventorySortKey = key;
    renderInventory(state.inventory);
  });
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
    const payload = await response.json();
    if (!response.ok) { $("#login-error").textContent = payload.error || "登录失败"; return; }
    $("#login-error").textContent = "";
    showApp(payload);
    loadCompass();
    loadOrderImports();
    loadInventory();
    loadSettlement();
    refreshCollectionStatus();
  });
  const me = await fetch("/api/me").then((response) => response.json());
  if (me.authenticated) { showApp(me); loadCompass(); loadOrderImports(); loadInventory(); loadSettlement(); refreshCollectionStatus(); } else showLogin();
}

initialise();
