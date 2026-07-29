import { $ } from "./dom";

type ToastTone = "success" | "error" | "info";

let toastTimer: number | undefined;

export function showToast(message: string, tone: ToastTone = "info") {
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
