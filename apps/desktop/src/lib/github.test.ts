import { describe, expect, it } from "vitest";
import type { GithubDeployment, GithubRepo } from "./api";
import {
  agoOf, alertCounts, browseRepos, certainDeployments, ciState, clonePath, cloneSync, containerTone, deployStateTone, filterRepos, githubError, insightError, labelColor, otherDeployments, repoPageUrl, repoUrl, runDuration, urgentAlerts, validFolder, validToken,
} from "./github";

describe("déploiements", () => {
  const dep = (repo: string, kind: GithubDeployment["kind"], certain: boolean): GithubDeployment => ({ repo, kind, certain, path: null, project: null, containers: [] });
  const list = [dep("Octo/App", "clone", true), dep("Octo/App", "image", true), dep("Octo/App", "compose-dir", false), dep("Octo/Other", "image", true)];
  it("compte les certains et sépare les non-clones, sans tenir compte de la casse", () => {
    expect(certainDeployments(list, "octo/app")).toHaveLength(2);
    expect(otherDeployments(list, "Octo/App").map((d) => d.kind)).toEqual(["image", "compose-dir"]);
    expect(certainDeployments(undefined, "a/b")).toEqual([]);
  });
  it("tons d'état et erreur de permission", () => {
    expect(containerTone("running")).toBe("ok");
    expect(containerTone("exited")).toBe("muted");
    expect(githubError("permission manquante (403) : …").kind).toBe("permission");
    expect(githubError("limite de requêtes GitHub atteinte (403, rate limit)").kind).toBe("rate");
  });
});

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

describe("informations du dépôt", () => {
  it("état de CI et durée", () => {
    expect(ciState(undefined).label).toBe("aucune exécution");
    expect(ciState({ status: "queued", conclusion: null })).toMatchObject({ tone: "accent", running: true, label: "en attente" });
    expect(ciState({ status: "in_progress", conclusion: null }).label).toBe("en cours");
    expect(ciState({ status: "completed", conclusion: "success" }).tone).toBe("ok");
    expect(ciState({ status: "completed", conclusion: "failure" }).tone).toBe("danger");
    expect(ciState({ status: "completed", conclusion: "cancelled" }).tone).toBe("warn");
    const run = { status: "completed", startedAt: "2026-10-23T10:00:00Z", updatedAt: "2026-10-23T10:04:30Z" };
    expect(runDuration(run)).toBe("4 min 30 s");
    expect(runDuration({ ...run, updatedAt: "2026-10-23T10:00:12Z" })).toBe("12 s");
    expect(runDuration({ ...run, updatedAt: "2026-10-23T11:05:00Z" })).toBe("1 h 5 min");
    expect(runDuration({ ...run, status: "in_progress" })).toBe("—");
    expect(runDuration({ status: "completed", startedAt: null, updatedAt: null })).toBe("—");
  });
  it("permission refusée : note discrète, le reste garde son message", () => {
    const perm = insightError("ci", "permission manquante (403) : … — GitHub : Resource not accessible by personal access token");
    expect(perm.permission).toBe(true);
    expect(perm.text).toContain("Permission « Actions » non accordée au jeton");
    expect(insightError("alerts", "introuvable (404) : dépôt inexistant").text).toContain("Dependabot alerts");
    expect(insightError("alerts", "permission manquante (403) … Dependabot alerts are disabled for this repository.").text).toContain("désactivées");
    const rate = insightError("pulls", "limite de requêtes GitHub atteinte (429, rate limit)");
    expect(rate.permission).toBe(false);
    expect(rate.text).toContain("Réessaie");
  });
  it("alertes par gravité", () => {
    const a = ["low", "critical", "high", "high"].map((severity) => ({ severity }));
    expect(alertCounts(a)).toEqual([{ severity: "critical", count: 1 }, { severity: "high", count: 2 }, { severity: "low", count: 1 }]);
    expect(urgentAlerts(a)).toBe(3);
    expect(urgentAlerts(undefined)).toBe(0);
  });
  it("déploiements, étiquettes et liens", () => {
    expect(deployStateTone("success")).toBe("ok");
    expect(deployStateTone("failure")).toBe("danger");
    expect(deployStateTone(null)).toBe("muted");
    expect(labelColor("a2eeef")).toBe("#a2eeef");
    expect(labelColor("red;}")).toBeNull();
    expect(repoPageUrl("octo", "app", "security/dependabot")).toBe("https://github.com/octo/app/security/dependabot");
    expect(repoPageUrl("o/x", "app", "issues")).toBeNull();
  });
});
