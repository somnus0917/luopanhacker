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
  $$(".nav-tab, .topbar-action").forEach((tab) => tab.classList.toggle("active", tab.dataset.page === name));
  history.replaceState(null, "", `#${name}`);
  if (name === "collection" && state.currentUser) refreshCollectionStatus();
  else stopCollectionStatusRefresh();
}

async function initialise() {
  buildPlaceholders();
  const desired = location.hash.slice(1);
  activatePage(desired === "channel" ? "operations" : ["inventory", "operations", "settlement", "collection", "account"].includes(desired) ? desired : "operations");
  $$(".nav-tab, .topbar-action").forEach((tab) => tab.addEventListener("click", () => activatePage(tab.dataset.page)));
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
