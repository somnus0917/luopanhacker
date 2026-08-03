import "./style.css";
import { $, $$ } from "./dom";
import { escapeHtml } from "./format";
import { errorMessage, request } from "./api";
import { showToast } from "./feedback";
import { state } from "./state";
import type { PageName } from "./types";
import { loadUsers, showApp, showLogin } from "./pages/account";
import {
  loadCompass, loadOrderImports,
} from "./pages/operations";
import { loadInventory, renderInventory } from "./pages/inventory";
import { loadSettlement } from "./pages/settlement";
import {
  loadCollectionShops, refreshCollectionStatus, stopCollectionStatusRefresh,
} from "./pages/collection";

function buildPlaceholders() {
  $$('[data-placeholder]').forEach((grid: HTMLElement) => {
    grid.innerHTML = (grid.dataset.placeholder ?? "").split("|").map((label) => `<article class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">—</div><div class="metric-delta">等待数据接入</div></article>`).join("");
  });
}

window.addEventListener("luopan-api-fallback", () => {
  showToast("SQLite 数据暂不可用，当前展示的是 JSON 回退数据。", "error");
});
window.addEventListener("luopan-jd-imported", () => { loadCompass(); loadInventory(); });

function activatePage(name: PageName) {
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

function setTableDensity(density: string) {
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
  const pageNames: PageName[] = ["inventory", "operations", "settlement", "collection", "account"];
  activatePage(desired === "channel" ? "operations" : pageNames.includes(desired as PageName) ? desired as PageName : "operations");
  $$(".nav-tab[data-page], .topbar-action[data-page]").forEach((tab: HTMLElement) => tab.addEventListener("click", () => activatePage((tab.dataset.page as PageName | undefined) ?? "operations")));
  setTableDensity(localStorage.getItem("luopan-table-density") || "comfortable");
  $("#table-density-toggle")?.addEventListener("click", () => setTableDensity(document.body.dataset.tableDensity === "compact" ? "comfortable" : "compact"));
  $("#filter-quick-action")?.addEventListener("click", () => {
    const panel = $(".dashboard-page.active .table-filter-panel");
    if (!panel) return;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => $("select, summary, button", panel)?.focus(), 280);
  });
  $("#inventory-content").addEventListener("click", (event: MouseEvent) => {
    const th = (event.target as Element).closest<HTMLElement>("[data-sort-key]");
    if (!th) return;
    const key = th.dataset.sortKey;
    state.inventorySortDir = state.inventorySortKey === key && state.inventorySortDir === "desc" ? "asc" : "desc";
    state.inventorySortKey = key ?? "";
    renderInventory(state.inventory);
  });
  $("#login-form").addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const user = await request<{ username: string; role: "admin" | "viewer" }>("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
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
    const me = await request<{ authenticated: boolean; username?: string; role?: "admin" | "viewer" }>("/api/me");
    if (me.authenticated && me.username && me.role) { showApp({ username: me.username, role: me.role }); loadCompass(); loadOrderImports(); loadInventory(); loadSettlement(); loadCollectionShops().then(refreshCollectionStatus); } else showLogin();
  } catch {
    showLogin();
  }
}

initialise();
