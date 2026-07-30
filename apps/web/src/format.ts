type Scalar = string | number | boolean | null | undefined;

export const escapeHtml = (value: Scalar) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

export const number = (value: Scalar) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const money = (cents: Scalar) => `¥${(number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const whole = (value: Scalar) => Math.round(number(value)).toLocaleString("zh-CN");

export const ratio = (value: Scalar) => `${(number(value) * 100).toFixed(2)}%`;

export const metricText = (key: string, value: Scalar) => key === "ad_roi" ? hasValue(value) ? `${number(value).toFixed(2)}×` : "—" : key.endsWith("_amt") || ["income_amt", "pay_amt", "per_usr_pay_amt", "settlement_amt_pay_time", "expense_amt"].includes(key) ? money(value) : key.endsWith("_ratio") || key.endsWith("_rate") ? ratio(value) : whole(value);

export const hasValue = (value: Scalar) => value !== null && value !== undefined && value !== "";

export const moneyOrDash = (value: Scalar) => hasValue(value) ? money(value) : "—";

export const settlementMoney = (yuan: Scalar) => `¥${number(yuan).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const settlementMoneyOrDash = (value: Scalar) => hasValue(value) ? settlementMoney(value) : "—";

export const wholeOrDash = (value: Scalar) => hasValue(value) ? whole(value) : "—";

export const ratioOrDash = (value: Scalar) => hasValue(value) ? ratio(value) : "—";

export function importTime(value: Scalar) {
  if (!value) return "—";
  const text = String(value);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
