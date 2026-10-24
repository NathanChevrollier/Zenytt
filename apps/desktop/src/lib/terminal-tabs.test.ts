import { describe, expect, it } from "vitest";
import { groupTabsByServer } from "./terminal-tabs";
import type { TermTab } from "./store";

const tab = (key: string, serverId: string, extra: Partial<TermTab> = {}): TermTab => ({ key, serverId, title: key, ...extra });

describe("groupTabsByServer", () => {
  it("regroupe par serveur dans l'ordre de première apparition", () => {
    const groups = groupTabsByServer([tab("a", "s1"), tab("b", "s2"), tab("c", "s1")]);
    expect(groups.map((g) => [g.id, g.tabs.map((t) => t.key)])).toEqual([
      ["s1", ["a", "c"]],
      ["s2", ["b"]],
    ]);
  });

  it("met les grilles et les partages reçus à part", () => {
    const groups = groupTabsByServer([tab("g", "s1", { grid: [{ serverId: "s1" }, { serverId: "s2" }] }), tab("j", "", { join: "zenytt-term:x" }), tab("a", "s1")]);
    expect(groups.map((g) => g.id)).toEqual(["grid", "join", "s1"]);
  });

  it("rend une liste vide sans onglet", () => {
    expect(groupTabsByServer([])).toEqual([]);
  });
});
