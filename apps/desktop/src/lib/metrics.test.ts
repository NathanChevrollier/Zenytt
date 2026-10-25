import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const metrics = vi.fn(async () => ({ timestamp: Date.now(), cpuPercent: 1 }));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: { metrics } }));
vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn() });

const { subscribeMetrics, useMetricsStore, diskTone } = await import("./metrics");

describe("relevé partagé", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    metrics.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("un seul poller au plus petit intervalle, arrêté au dernier désabonnement", async () => {
    const a = subscribeMetrics("s1", 5000);
    const b = subscribeMetrics("s1", 2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(metrics).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(metrics).toHaveBeenCalledTimes(2);
    b();
    await vi.advanceTimersByTimeAsync(2000);
    expect(metrics).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(metrics).toHaveBeenCalledTimes(3);
    a();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(metrics).toHaveBeenCalledTimes(3);
    expect(useMetricsStore.getState().byServer.s1.samples).toHaveLength(3);
  });

  it("jamais deux requêtes en même temps", async () => {
    let release = () => {};
    metrics.mockImplementationOnce(() => new Promise((r) => (release = () => r({ timestamp: 0, cpuPercent: 0 }))));
    const stop = subscribeMetrics("s2", 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(metrics).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(metrics).toHaveBeenCalledTimes(2);
    stop();
  });

  it("teinte des disques alignée sur la règle de l'agent", () => {
    expect(diskTone(86, 85)).toBe("danger");
    expect(diskTone(76, 85)).toBe("warn");
    expect(diskTone(86)).toBe("warn");
    expect(diskTone(91)).toBe("danger");
  });
});
