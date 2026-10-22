import { describe, expect, it } from "vitest";
import { ago, formatBytes, formatUptime, percent } from "./format";

describe("format", () => {
  it("tailles", () => {
    expect(formatBytes(500)).toBe("500 o");
    expect(formatBytes(1536)).toBe("1.5 Ko");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 Go");
  });

  it("durées", () => {
    expect(formatUptime(90_000)).toBe("1 j 1 h");
    expect(formatUptime(7_500)).toBe("2 h 5 min");
    expect(formatUptime(120)).toBe("2 min");
  });

  it("pourcentage et ancienneté", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 0)).toBe(0);
    expect(ago(0, 30_000)).toBe("à l'instant");
    expect(ago(0, 5 * 60_000)).toBe("il y a 5 min");
    expect(ago(0, 3 * 86400_000)).toBe("il y a 3 j");
  });
});
