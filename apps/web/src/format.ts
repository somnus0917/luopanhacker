export const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

export const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const money = (cents) => `¥${(number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const whole = (value) => Math.round(number(value)).toLocaleString("zh-CN");

export const ratio = (value) => `${(number(value) * 100).toFixed(2)}%`;

export const metricText = (key, value) => key.endsWith("_amt") || ["income_amt", "pay_amt", "per_usr_pay_amt", "settlement_amt_pay_time", "expense_amt"].includes(key) ? money(value) : key.endsWith("_ratio") || key.endsWith("_rate") ? ratio(value) : whole(value);

export const hasValue = (value) => value !== null && value !== undefined && value !== "";

export const moneyOrDash = (value) => hasValue(value) ? money(value) : "—";

export const settlementMoney = (yuan) => `¥${number(yuan).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const settlementMoneyOrDash = (value) => hasValue(value) ? settlementMoney(value) : "—";

export const wholeOrDash = (value) => hasValue(value) ? whole(value) : "—";

export const ratioOrDash = (value) => hasValue(value) ? ratio(value) : "—";

export function importTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
