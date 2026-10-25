import { describe, expect, it } from "vitest";
import { countLevels, exportText, levelOf, logLink, matcherOf, parseLogLink, visibleLines, type Line } from "./logs";

const L = (id: number, text: string, marker = false): Line => ({ id, tag: "api", color: "", text, at: 0, level: levelOf(text), marker });

describe("logs", () => {
  it("classe les lignes par niveau", () => {
    expect(levelOf("GET /api 200 4ms")).toBe(0);
    expect(levelOf("WARN db pool presque plein")).toBe(1);
    expect(levelOf("GET /x 404 2ms")).toBe(1);
    expect(levelOf("ERROR mangadex 429")).toBe(2);
    expect(levelOf("GET /x 502 2ms")).toBe(2);
  });

  it("filtre en regex, ou en texte si la regex est invalide", () => {
    expect(matcherOf("")).toBeNull();
    expect(matcherOf("^get .*200")!.test("GET /api 200")).toBe(true);
    expect(matcherOf("(oops")!.test("an (OOPS here")).toBe(true);
    expect(matcherOf("(oops")!.test("nothing")).toBe(false);
  });

  it("compte et garde les lignes du niveau choisi, repères compris", () => {
    const lines = [L(1, "ok"), L(2, "WARN a"), L(3, "error b"), L(4, "relance", true), L(5, "ok bis")];
    expect(countLevels(lines)).toEqual({ warn: 1, error: 1 });
    expect(visibleLines(lines, null, "warn", 100).map((l) => l.id)).toEqual([2, 3, 4]);
    expect(visibleLines(lines, null, "error", 100).map((l) => l.id)).toEqual([3, 4]);
    expect(visibleLines(lines, matcherOf("ok"), "all", 100).map((l) => l.id)).toEqual([1, 4, 5]);
    expect(visibleLines(lines, null, "all", 2).map((l) => l.id)).toEqual([4, 5]);
    expect(exportText([L(1, "a"), L(2, "m", true)])).toBe("1970-01-01T00:00:00.000Z [api] a");
  });

  it("aller-retour des liens vers la page Journaux", () => {
    const src = [
      { kind: "docker" as const, name: "infra-api-1" },
      { kind: "unit" as const, name: "user@1000.service" },
    ];
    expect(parseLogLink(logLink(src))).toEqual(src);
    expect(parseLogLink("unit:nginx.service")).toEqual([{ kind: "unit", name: "nginx.service" }]);
    expect(parseLogLink("")).toEqual([]);
    expect(parseLogLink("bad:x,docker:")).toEqual([]);
  });
});
