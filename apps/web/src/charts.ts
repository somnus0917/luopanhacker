import { $, $$ } from "./dom";
import { escapeHtml, metricText, money, number, whole } from "./format";
import type { OperationRecord } from "./state";

const COLORS = ["#3da7f5", "#31d380", "#a461d2", "#f18a21", "#f7c91b", "#e84d8a", "#2cced2", "#8b9dc3"];
const METRIC_SEMANTICS: Record<string, { label: string; color: string }> = {
  income_amt: { label: "增长指标", color: "#c5f36b" },
  pay_amt: { label: "增长指标", color: "#c5f36b" },
  pay_cnt: { label: "经营量", color: "#b8d8ff" },
  product_show_ucnt: { label: "流量指标", color: "#b8d8ff" },
  organic_search: { label: "自然流量", color: "#b8d8ff" },
  recommendation: { label: "推荐流量", color: "#d4c3ff" },
  ad_cost_amt: { label: "成本指标", color: "#f1bf77" },
  ad_roi: { label: "效率指标", color: "#c5f36b" },
};

function metricSemantic(metricKey) {
  return METRIC_SEMANTICS[metricKey] || { label: "经营指标", color: "#b8d8ff" };
}

export function seriesColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
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
  const indexes = new Set<number>();
  for (let step = 0; step < maxLabels; step += 1) {
    indexes.add(Math.round(step * (dates.length - 1) / (maxLabels - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => ({ date: dates[index], index }));
}

function latestRecords(records: OperationRecord[]) {
  const dates = [...new Set(records.map((item) => item.date))].sort();
  const latest = dates.at(-1);
  return { date: latest, records: records.filter((item) => item.date === latest) };
}

export function lineChart(records: OperationRecord[], metricKey, title) {
  const semantic = metricSemantic(metricKey);
  const dates = [...new Set(records.map((item) => item.date))].sort();
  const shops = [...new Set<string>(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const values = shops.map((shop) => dates.map((date) => {
    const value = records.find((item) => item.date === date && item.shop_name === shop)?.metrics?.[metricKey];
    return metricKey === "ad_roi" && (value === null || value === undefined) ? null : number(value);
  }));
  const totals = dates.map((date, index) => values.reduce((sum, series) => sum + number(series[index]), 0));
  const max = Math.max(...totals, ...values.flat().filter((value) => value !== null).map(number), 1) * 1.08;
  const width = 760, height = 252, pad = { l: 68, r: 16, t: 15, b: 38 };
  const point = (value, index) => [pad.l + index * ((width - pad.l - pad.r) / Math.max(dates.length - 1, 1)), height - pad.b - (value / max) * (height - pad.t - pad.b)];
  const path = (series) => {
    let previousMissing = true;
    return series.map((value, index) => {
      if (value === null) { previousMissing = true; return ""; }
      const command = previousMissing ? "M" : "L";
      previousMissing = false;
      return `${command}${point(value, index).map((n) => n.toFixed(1)).join(" ")}`;
    }).join(" ");
  };
  const levels = [0.25, 0.5, 0.75, 1];
  const grid = levels.map((level) => { const y = height - pad.b - level * (height - pad.t - pad.b); return `<line class="chart-gridline" x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}"/>`; }).join("");
  const yAxis = levels.map((level) => { const y = height - pad.b - level * (height - pad.t - pad.b); return `<span style="top:${(y / height * 100).toFixed(3)}%">${chartAxisValue(metricKey, max * level)}</span>`; }).join("");
  const xAxis = chartDateTicks(dates).map(({ date, index }) => `<span style="left:${(point(0, index)[0] / width * 100).toFixed(3)}%">${date.slice(5)}</span>`).join("");
  const series = shops.map((shop, index) => `<path class="chart-line" stroke="${seriesColor(shop)}" d="${path(values[index])}"/>`).join("");
  const legend = shops.map((shop) => `<span><i style="background:${seriesColor(shop)}"></i>${escapeHtml(shop)}</span>`).join("");
  return `<section class="panel chart-panel" style="--chart-accent:${semantic.color}"><div class="panel-head"><div><h3>${title}</h3></div><span class="chart-semantic">${semantic.label}</span></div><div class="chart-frame"><svg class="chart" data-metric="${metricKey}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}">${grid}${series}<line class="chart-hover-line" visibility="hidden" y1="${pad.t}" y2="${height - pad.b}"/><rect class="chart-hit-area" x="${pad.l}" y="${pad.t}" width="${width - pad.l - pad.r}" height="${height - pad.b}" /></svg><div class="chart-y-axis" aria-hidden="true">${yAxis}</div><div class="chart-x-axis" aria-hidden="true">${xAxis}</div></div><div class="chart-tooltip hidden" role="status"></div><div class="legend">${legend}</div></section>`;
}

export function bindLineChartHover(records: OperationRecord[]) {
  $$(".chart[data-metric]").forEach((chart) => {
    const metricKey = chart.dataset.metric;
    const panel = chart.closest(".chart-panel");
    const tooltip = $(".chart-tooltip", panel);
    const hoverLine = $(".chart-hover-line", chart);
    const dates = [...new Set<string>(records.map((item) => item.date))].sort();
    const shops = [...new Set<string>(records.map((item) => item.shop_name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const width = 760, leftPadding = 68, rightPadding = 16;

    const hide = () => {
      tooltip.classList.add("hidden");
      hoverLine.setAttribute("visibility", "hidden");
    };
    const move = (event) => {
      const bounds = chart.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * width;
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

export function barPanel(records, metricKey, title) {
  const semantic = metricSemantic(metricKey);
  const { date, records: latest } = latestRecords(records);
  const items = latest.map((item) => ({ name: item.shop_name, value: number(item.metrics?.[metricKey]) })).sort((a, b) => b.value - a.value);
  const max = Math.max(...items.map((item) => item.value), 1);
  const bars = items.map((item) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, item.value / max * 100)}%"></div></div><span class="bar-value">${metricText(metricKey, item.value)}</span></div>`).join("");
  return `<section class="panel metric-panel" style="--chart-accent:${semantic.color}"><div class="panel-head"><div><h3>${title}</h3><span>${date || "—"} · 最新日</span></div><span class="chart-semantic">${semantic.label}</span></div>${bars || "<span class='metric-delta'>暂无数据</span>"}</section>`;
}
