import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const { errorMessage, formatAgo, formatBytes, formatDuration, shellQuote } = await import("./api");

describe("formatage", () => {
  it("il y a X", () => {
    expect(formatAgo(30_000)).toBe("à l'instant");
    expect(formatAgo(5 * 60_000)).toBe("il y a 5 min");
    expect(formatAgo(3 * 3_600_000)).toBe("il y a 3 h");
    expect(formatAgo(2 * 86_400_000)).toBe("il y a 2 j");
  });

  it("durées", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3 h 5 min");
    expect(formatDuration(86400 * 2 + 3600)).toBe("2 j 1 h");
  });

  it("tailles", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(1536)).toBe("1.5 Ko");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 Go");
  });

  it("échappement shell", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("l'app; rm -rf /")).toBe("'l'\\''app; rm -rf /'");
  });

  it("messages d'erreur", () => {
    expect(errorMessage("texte")).toBe("texte");
    expect(errorMessage(new Error("boum"))).toBe("boum");
  });
});
