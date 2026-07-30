import { describe, expect, it } from "vitest";
import { metricText, money, ratio } from "./format";

describe("formatters", () => {
  it("formats money and ratios deterministically", () => {
    expect(money(123456)).toBe("¥1,234.56");
    expect(ratio(0.125)).toBe("12.50%");
  });

  it("formats ROI and preserves missing values", () => {
    expect(metricText("ad_roi", 2.345)).toBe("2.35×");
    expect(metricText("ad_roi", null)).toBe("—");
  });
});
