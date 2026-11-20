import { describe, expect, it } from "vitest";
import { decimalDiff, formatAmount } from "./decimal";

describe("decimal helpers", () => {
  it("diffs exactly where floats would not", () => {
    expect(decimalDiff("0.3", "0.1")).toBe("0.2");
    expect(decimalDiff("5480135", "5480135")).toBe("0");
    expect(decimalDiff("15534082", "10379128")).toBe("5154954");
    expect(decimalDiff("1", "2.5")).toBe("-1.5");
    expect(decimalDiff("-1", "-3")).toBe("2");
    expect(decimalDiff("12450.10", "0")).toBe("12450.1");
    expect(decimalDiff("9007199254740993", "1")).toBe("9007199254740992"); // beyond float precision
  });
  it("formats with grouping and tolerates junk", () => {
    expect(formatAmount("1234567.5")).toBe("1,234,567.5");
    expect(formatAmount("-1000")).toBe("-1,000");
    expect(formatAmount("0")).toBe("0");
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount("n/a")).toBe("n/a");
  });
});
