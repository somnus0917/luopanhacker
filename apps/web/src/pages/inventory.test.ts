import { describe, expect, it } from "vitest";
import { inventoryHealth, inventorySummary, sortRows } from "./inventory";

const rows = [
  { spec_no: "sku-a", health_key: "urgent", available_num: 3, stock_num: 5, sales_7d: 7, inbound_30d: 1, coverage_days: 3, cost_covered: true, stock_cost_amount: 50, available_cost_amount: 30 },
  { spec_no: "sku-b", health_key: "out_of_stock", available_num: -1, stock_num: 0, sales_7d: 0, inbound_30d: 0, coverage_days: null, cost_covered: false },
];

describe("inventory calculations", () => {
  it("summarizes stock and replenishment risk", () => {
    const summary = inventorySummary(rows);
    expect(summary.available_num).toBe(2);
    expect(summary.replenishment_records).toBe(2);
    expect(summary.negative_available).toBe(1);
    expect(summary.cost_coverage_rate).toBe(0.5);
  });

  it("groups health states and sorts rows", () => {
    expect(inventoryHealth(rows).find((item) => item.key === "urgent")?.sku_records).toBe(1);
    expect(sortRows(rows, "available_num", "asc").map((row) => row.spec_no)).toEqual(["sku-b", "sku-a"]);
  });
});
