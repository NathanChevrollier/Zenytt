import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { attachmentPath, collectImages, MAX_ATTACHMENTS, precheck } from "../src/services/attachmentService.js";
import { formatIssueBody } from "../src/services/feedbackService.js";
import { GitHubService } from "../src/services/githubService.js";

const photo = new Uint8Array(readFileSync(new URL("./fixtures/photo.jpg", import.meta.url)));
const cdn = (name: string, size = 1000, contentType: string | null = "image/jpeg") => ({ name, url: `https://cdn.discordapp.com/ephemeral-attachments/1/2/${name}?ex=1`, size, contentType });
const ok = (data: Uint8Array) => vi.fn(async () => new Response(data, { status: 200 })) as unknown as typeof fetch;

describe("captures jointes aux retours", () => {
  it("refuse avant téléchargement : taille, format, adresse hors de Discord", () => {
    expect(precheck(cdn("a.jpg"))).toBeNull();
    expect(precheck(cdn("a.jpg", 9 * 1024 * 1024))).toMatch(/Mo/);
    expect(precheck(cdn("a.svg", 10, "image/svg+xml"))).toMatch(/format/);
    expect(precheck({ ...cdn("a.jpg"), url: "http://169.254.169.254/latest/meta-data" })).toMatch(/hors de Discord/);
  });

  it("range les images par mois sous un nom aléatoire", () => {
    expect(attachmentPath("jpeg", new Date(Date.UTC(2026, 9, 5)), "abc")).toBe("feedback/2026-10/abc.jpg");
  });

  it("télécharge, vérifie le contenu réel et retire les métadonnées", async () => {
    const { images, rejected } = await collectImages([cdn("photo.jpg")], ok(photo));
    expect(rejected).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0]!.path).toMatch(/^feedback\/\d{4}-\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(Buffer.from(images[0]!.content).toString("latin1")).not.toContain("SECRET");
  });

  it("refuse un faux fichier image et ce qui dépasse le nombre permis, sans bloquer les autres", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(String(url).includes("fake") ? new TextEncoder().encode("<html>") : photo)) as unknown as typeof fetch;
    const files = [cdn("fake.png", 10, "image/png"), ...Array.from({ length: MAX_ATTACHMENTS }, (_, i) => cdn(`p${i}.jpg`))];
    const { images, rejected } = await collectImages(files, fetchImpl);
    expect(images).toHaveLength(MAX_ATTACHMENTS - 1);
    expect(rejected.map((r) => r.name)).toEqual(["fake.png", `p${MAX_ATTACHMENTS - 1}.jpg`]);
  });

  it("affiche les captures dans l'issue et signale celles qui manquent", () => {
    const author = { id: "1", username: "u", avatarUrl: "https://cdn.discordapp.com/a.png" };
    const body = formatIssueBody({ kind: "bug", title: "t", description: "description", images: ["https://raw.githubusercontent.com/o/r/b/feedback/2026-10/x.jpg"], missingImages: 1 }, author);
    expect(body).toContain("## Captures\n\n![Capture 1](https://raw.githubusercontent.com/o/r/b/feedback/2026-10/x.jpg)");
    expect(body).toContain("1 capture(s) envoyée(s) mais non jointe(s)");
    expect(formatIssueBody({ kind: "bug", title: "t", description: "description" }, author)).not.toContain("## Captures");
  });
});

describe("archivage des captures sur GitHub", () => {
  /** Faux client Octokit : seules les méthodes Git utilisées. */
  function fakeGit(opts: { branchExists: boolean; raceOnce?: boolean }) {
    let raced = false;
    const git = {
      getRef: vi.fn(async () => {
        if (!opts.branchExists) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { object: { sha: "parent" } } };
      }),
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "base-tree" } } })),
      createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
      createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
      createCommit: vi.fn(async () => ({ data: { sha: "commit" } })),
      updateRef: vi.fn(async () => {
        if (opts.raceOnce && !raced) {
          raced = true;
          throw Object.assign(new Error("Update is not a fast forward"), { status: 422 });
        }
        return {};
      }),
      createRef: vi.fn(async () => ({})),
    };
    const service = new GitHubService("o", "r", "t", { bug: "bug", suggestion: "enhancement" });
    (service as unknown as { client: unknown }).client = { rest: { git } };
    return { service, git };
  }
  const file = { path: "feedback/2026-10/x.jpg", content: new Uint8Array([1, 2, 3]) };

  it("crée la branche au premier envoi (sans historique commun avec le code)", async () => {
    const { service, git } = fakeGit({ branchExists: false });
    const urls = await service.storeAttachments("feedback-attachments", [file], "[Bug] t");
    expect(urls).toEqual(["https://raw.githubusercontent.com/o/r/feedback-attachments/feedback/2026-10/x.jpg"]);
    expect(git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [] }));
    expect(git.createTree).toHaveBeenCalledWith(expect.not.objectContaining({ base_tree: expect.anything() }));
    expect(git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "refs/heads/feedback-attachments" }));
  });

  it("ajoute à la branche existante et réessaie si un autre envoi est passé entre-temps", async () => {
    const { service, git } = fakeGit({ branchExists: true, raceOnce: true });
    await service.storeAttachments("feedback-attachments", [file], "[Bug] t");
    expect(git.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: "base-tree" }));
    expect(git.updateRef).toHaveBeenCalledTimes(2);
    expect(git.updateRef).toHaveBeenLastCalledWith(expect.objectContaining({ force: false }));
  });
});
