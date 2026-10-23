import { describe, expect, it } from "vitest";
import type { GithubRepo } from "./api";
import { filterRepos, repoUrl, validFolder } from "./github";

const repo = (fullName: string, extra: Partial<GithubRepo> = {}): GithubRepo => ({
  fullName,
  name: fullName.split("/")[1],
  owner: fullName.split("/")[0],
  private: false,
  defaultBranch: "main",
  pushedAt: null,
  openIssues: 0,
  description: null,
  fork: false,
  archived: false,
  ...extra,
});

describe("page GitHub", () => {
  it("lien github.com uniquement", () => {
    expect(repoUrl("octo", "app.v2")).toBe("https://github.com/octo/app.v2");
    expect(repoUrl("octo", "..")).toBeNull();
    expect(repoUrl("octo/evil", "x")).toBeNull();
    expect(repoUrl("octo", "a b")).toBeNull();
  });

  it("dossier distant", () => {
    expect(validFolder("/srv/apps")).toBe(true);
    for (const bad of ["srv", "/", "/srv/../x", "/srv/a\nb", "~/x", ""]) expect(validFolder(bad)).toBe(false);
  });

  it("recherche par mots", () => {
    const all = [repo("octo/api", { private: true }), repo("octo/site", { description: "Vitrine" }), repo("me/api-old", { archived: true })];
    expect(filterRepos(all, "")).toHaveLength(3);
    expect(filterRepos(all, "api").map((r) => r.fullName)).toEqual(["octo/api", "me/api-old"]);
    expect(filterRepos(all, "api privé").map((r) => r.fullName)).toEqual(["octo/api"]);
    expect(filterRepos(all, "vitrine")).toHaveLength(1);
    expect(filterRepos(all, "archivé").map((r) => r.fullName)).toEqual(["me/api-old"]);
  });
});
