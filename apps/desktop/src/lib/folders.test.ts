import { describe, expect, it } from "vitest";
import { composeLockKey, groupByClient, NO_CLIENT } from "./folders";

const clients: Record<string, string> = { a: "Zoé", b: "Alice", c: "Zoé" };
const clientOf = (k: string) => clients[k] ?? "";

describe("groupByClient", () => {
  it("regroupe par client, « Sans client » en dernier", () => {
    expect(groupByClient(["d", "a", "b", "c"], clientOf, "")).toEqual([
      ["Alice", ["b"]],
      ["Zoé", ["a", "c"]],
      ["", ["d"]],
    ]);
  });
  it("filtre par client ou sans client", () => {
    expect(groupByClient(["a", "b", "d"], clientOf, "Zoé")).toEqual([["Zoé", ["a"]]]);
    expect(groupByClient(["a", "b", "d"], clientOf, NO_CLIENT)).toEqual([["", ["d"]]]);
  });
});

describe("composeLockKey", () => {
  it("utilise le dossier du fichier compose, le même pour un même dossier", () => {
    expect(composeLockKey({ name: "a", configFiles: "/opt/app/compose.yml" })).toBe("compose:/opt/app");
    expect(composeLockKey({ name: "b", configFiles: "/opt/app/docker-compose.yml,/opt/app/o.yml" })).toBe("compose:/opt/app");
  });
  it("sans fichier, retombe sur le nom du projet (pas de collision sur `/`)", () => {
    expect(composeLockKey({ name: "a", configFiles: "" })).toBe("compose:name:a");
    expect(composeLockKey({ name: "b", configFiles: "" })).not.toBe(composeLockKey({ name: "a", configFiles: "" }));
  });
});
