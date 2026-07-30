import { $, $$ } from "../dom";
import { apiFetch as fetch } from "../api";
import { showToast } from "../feedback";
import { escapeHtml, importTime } from "../format";
import { isAdmin, state } from "../state";
import type { User } from "../types";

export function renderAccount() {
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
  $$('[data-delete-user]').forEach((button) => button.addEventListener("click", () => deleteUser(button.dataset.deleteUser)));
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  showLogin();
}

export async function loadUsers() {
  if (!isAdmin()) return;
  const response = await fetch("/api/users");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    state.accountMessage = payload.error || "用户列表读取失败。";
  } else {
    state.users = payload.users || [];
  }
  renderAccount();
}

async function changePassword(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const response = await fetch("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  const payload = await response.json().catch(() => ({}));
  state.accountMessage = response.ok ? (payload.message || "密码已更新。") : (payload.error || "密码更新失败。");
  showToast(state.accountMessage, response.ok ? "success" : "error");
  if (response.ok) form.reset();
  renderAccount();
}

async function createUser(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const response = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  const payload = await response.json().catch(() => ({}));
  state.accountMessage = response.ok ? `已新增用户 ${payload.user?.username || ""}。` : (payload.error || "新增用户失败。");
  showToast(state.accountMessage, response.ok ? "success" : "error");
  if (response.ok) form.reset();
  await loadUsers();
}

async function deleteUser(username: string | undefined) {
  if (!username || !window.confirm(`确定删除用户“${username}”吗？该用户的登录会话会立即失效。`)) return;
  const response = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
  const payload = await response.json().catch(() => ({}));
  state.accountMessage = response.ok ? `已删除用户 ${payload.deleted || username}。` : (payload.error || "删除用户失败。");
  showToast(state.accountMessage, response.ok ? "success" : "error");
  await loadUsers();
}

export function showLogin() {
  state.currentUser = null;
  state.users = [];
  state.accountMessage = "";
  state.orderPreview = null;
  $("#login-layer").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
}

export function showApp(user: User) {
  state.currentUser = { username: user.username, role: user.role };
  $("#login-layer").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  renderAccount();
  if (isAdmin()) loadUsers();
}
