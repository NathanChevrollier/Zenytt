import { describe, expect, it } from "vitest";
import { composeLockKey, groupByClient, moveItems, NO_CLIENT, removeFolder, renameFolder } from "./folders";

describe("moveItems / renameFolder / removeFolder", () => {
  const map = { "/a": "Zoé", "/b": "Zoé", "/c": "Alice" };
  const list = ["Alice", "Zoé"];
  it("retire le client d'un projet (null ou nom vide)", () => {
    expect(moveItems(map, list, ["/a"], null)[0]).toEqual({ "/b": "Zoé", "/c": "Alice" });
    expect(moveItems(map, list, ["/a"], "  ")[0]).toEqual({ "/b": "Zoé", "/c": "Alice" });
  });
  it("oublie un client retiré de son dernier projet seulement avec prune", () => {
    expect(moveItems(map, list, ["/c"], null, true)[1]).toEqual(["Zoé"]);
    expect(moveItems(map, list, ["/c"], null)[1]).toEqual(["Alice", "Zoé"]);
    expect(moveItems(map, list, ["/a"], null, true)[1]).toEqual(["Alice", "Zoé"]);
  });
  it("attribue un nouveau client (nom nettoyé)", () => {
    expect(moveItems(map, list, ["/d"], " Bob ", true)).toEqual([{ ...map, "/d": "Bob" }, ["Alice", "Zoé", "Bob"]]);
  });
  it("renomme un client pour tous ses projets, fusionne si le nom existe", () => {
    expect(renameFolder(map, list, "Zoé", "Zed")).toEqual([{ "/a": "Zed", "/b": "Zed", "/c": "Alice" }, ["Alice", "Zed"]]);
    expect(renameFolder(map, list, "Zoé", "Alice")).toEqual([{ "/a": "Alice", "/b": "Alice", "/c": "Alice" }, ["Alice"]]);
    expect(renameFolder(map, list, "Zoé", " ")).toEqual([map, list]);
  });
  it("supprime un client : ses projets n'en ont plus", () => {
    expect(removeFolder(map, list, "Zoé")).toEqual([{ "/c": "Alice" }, ["Alice"]]);
  });
});

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
