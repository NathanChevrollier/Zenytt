import { describe, expect, it } from "vitest";
import { groupByClient, NO_CLIENT } from "./folders";

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
