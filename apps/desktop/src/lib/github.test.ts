import { describe, expect, it } from "vitest";
import type { GithubRepo } from "./api";
import { agoOf, browseRepos, clonePath, cloneSync, filterRepos, githubError, repoUrl, validFolder, validToken } from "./github";

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

  it("filtre et tri de la liste", () => {
    const all = [
      repo("octo/b", { private: true, pushedAt: "2026-01-01T00:00:00Z" }),
      repo("octo/a", { pushedAt: "2026-03-01T00:00:00Z" }),
      repo("octo/c", { pushedAt: null }),
    ];
    const names = (f: Parameters<typeof browseRepos>[2], s: Parameters<typeof browseRepos>[3]) => browseRepos(all, "", f, s, (n) => n === "octo/c").map((r) => r.name);
    expect(names("all", "pushed")).toEqual(["a", "b", "c"]);
    expect(names("all", "name")).toEqual(["a", "b", "c"]);
    expect(names("private", "pushed")).toEqual(["b"]);
    expect(names("public", "name")).toEqual(["a", "c"]);
    expect(names("deployed", "pushed")).toEqual(["c"]);
    expect(all.map((r) => r.name)).toEqual(["b", "a", "c"]); // la liste d'origine n'est pas triée sur place
  });

  it("jeton, chemin du clone, âge", () => {
    expect(validToken(" github_pat_11AB-cd ")).toBe(true);
    for (const bad of ["", "   ", "ghp abc", "ghp_é", "x".repeat(256)]) expect(validToken(bad)).toBe(false);
    expect(clonePath(" /srv/ ", "app")).toBe("/srv/app");
    expect(clonePath("/opt/apps//", "app")).toBe("/opt/apps/app");
    expect(agoOf(null)).toBe("—");
    expect(agoOf("pas une date")).toBe("—");
    expect(agoOf("2026-01-02T00:00:00Z", Date.parse("2026-01-05T00:00:00Z"))).toBe("il y a 3 j");
  });

  it("état d'un clone en mots", () => {
    expect(cloneSync({ dirty: 0, aheadBehind: [0, 0] })).toEqual([
      { tone: "ok", label: "à jour" },
      { tone: "ok", label: "aucune modification locale" },
    ]);
    expect(cloneSync({ dirty: 2, aheadBehind: [1, 3] }).map((x) => x.label)).toEqual([
      "3 commits en retard sur GitHub",
      "1 commit non poussé",
      "2 fichiers modifiés sur le serveur",
    ]);
    expect(cloneSync({ dirty: 1, aheadBehind: null })[0]).toEqual({ tone: "muted", label: "aucune branche suivie" });
  });

  it("erreurs GitHub reconnues", () => {
    expect(githubError("jeton refusé par GitHub (401/403) : expiré").kind).toBe("token");
    expect(githubError("GitHub a répondu 429").kind).toBe("rate");
    expect(githubError("GitHub injoignable : timeout").kind).toBe("network");
    expect(githubError("autre chose")).toEqual({ kind: "other", hint: "autre chose" });
  });
});
