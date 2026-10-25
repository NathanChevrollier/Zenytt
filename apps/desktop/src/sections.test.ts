import { describe, expect, it } from "vitest";
import { MOVED_SECTIONS, MOVED_SETTINGS_TABS, SECTIONS } from "./sections";

describe("sections fusionnées", () => {
  it("chaque ancienne section mène à une section qui existe", () => {
    for (const { section } of Object.values(MOVED_SECTIONS)) expect(SECTIONS.some((s) => s.id === section)).toBe(true);
    expect(MOVED_SECTIONS.mesh).toEqual({ section: "network", tab: "mesh" });
    expect(SECTIONS.some((s) => (s.id as string) in MOVED_SECTIONS)).toBe(false);
  });
});

describe("rubriques des réglages fusionnées", () => {
  it("Sécurité de l'app et Maintenance mènent à Général, Accès IA à IA", () => {
    expect(MOVED_SETTINGS_TABS.lock).toBe("general");
    expect(MOVED_SETTINGS_TABS.maintenance).toBe("general");
    expect(MOVED_SETTINGS_TABS.mcp).toBe("ai");
    expect(MOVED_SETTINGS_TABS.general).toBeUndefined();
  });
});
