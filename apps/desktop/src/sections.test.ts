import { describe, expect, it } from "vitest";
import { MOVED_SETTINGS_TABS } from "./sections";

describe("rubriques des réglages fusionnées", () => {
  it("Sécurité de l'app et Maintenance mènent à Général, Accès IA à IA", () => {
    expect(MOVED_SETTINGS_TABS.lock).toBe("general");
    expect(MOVED_SETTINGS_TABS.maintenance).toBe("general");
    expect(MOVED_SETTINGS_TABS.mcp).toBe("ai");
    expect(MOVED_SETTINGS_TABS.general).toBeUndefined();
  });
});
