// Page GitHub : fonctions pures (filtre, tri, lien, état d'un clone) séparées de la vue pour être testées.
import { formatAgo, type GithubClone, type GithubDeployment, type GithubRepo } from "./api";

/** Même règle que le moteur : `^[A-Za-z0-9_.-]+$`, sans `.` ni `..`. */
const SLUG = /^[A-Za-z0-9_.-]+$/;
const validSlug = (s: string) => SLUG.test(s) && s !== "." && s !== "..";

/** Lien github.com d'un dépôt, ou null si le nom n'est pas valide (jamais d'autre hôte, jamais de http). */
export function repoUrl(owner: string, name: string): string | null {
  return validSlug(owner) && validSlug(name) ? `https://github.com/${owner}/${name}` : null;
}

/** Dossier distant absolu, sans `..` ni caractère de contrôle. */
export function validFolder(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  return p.startsWith("/") && p.length > 1 && !/[\u0000-\u001f\u007f]/.test(p) && !p.split("/").includes("..");
}

/** Filtre par mots (nom, description, visibilité « privé » / « public »). */
export function filterRepos(repos: GithubRepo[], query: string): GithubRepo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return repos;
  return repos.filter((r) => {
    const hay = `${r.fullName} ${r.description ?? ""} ${r.private ? "privé" : "public"} ${r.fork ? "fork" : ""} ${r.archived ? "archivé" : ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type RepoFilter = "all" | "private" | "public" | "deployed";
export type RepoSort = "pushed" | "name";

/** Recherche, filtre puis tri de la liste. `deployed` : le dépôt a-t-il un clone connu ? */
export function browseRepos(repos: GithubRepo[], query: string, filter: RepoFilter, sort: RepoSort, deployed: (fullName: string) => boolean): GithubRepo[] {
  const keep = (r: GithubRepo) => (filter === "private" ? r.private : filter === "public" ? !r.private : filter === "deployed" ? deployed(r.fullName) : true);
  const pushed = (r: GithubRepo) => (r.pushedAt ? Date.parse(r.pushedAt) || 0 : 0);
  return filterRepos(repos, query)
    .filter(keep)
    .sort((a, b) => (sort === "name" ? a.fullName.localeCompare(b.fullName) : pushed(b) - pushed(a)));
}

/** Même règle que le moteur (`valid_token`), vérifiée avant l'appel pour répondre tout de suite. */
export function validToken(t: string): boolean {
  const s = t.trim();
  return s.length > 0 && s.length <= 255 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Chemin du futur clone, `<dossier>/<dépôt>`, comme `clone_command`. */
export function clonePath(folder: string, name: string): string {
  return `${folder.trim().replace(/\/+$/, "")}/${name}`;
}

/** Âge d'une date ISO (« il y a 3 j »), « — » si elle manque ou est illisible. */
export function agoOf(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? "—" : formatAgo(Math.max(0, now - t));
}

export type SyncTone = "ok" | "warn" | "accent" | "muted";

/** État d'un clone en mots : synchronisation avec GitHub, puis modifications sur le serveur. */
export function cloneSync(c: Pick<GithubClone, "dirty" | "aheadBehind">): { tone: SyncTone; label: string }[] {
  const s = (n: number) => (n > 1 ? "s" : "");
  const out: { tone: SyncTone; label: string }[] = [];
  if (!c.aheadBehind) out.push({ tone: "muted", label: "aucune branche suivie" });
  else {
    const [ahead, behind] = c.aheadBehind;
    if (behind) out.push({ tone: "warn", label: `${behind} commit${s(behind)} en retard sur GitHub` });
    if (ahead) out.push({ tone: "accent", label: `${ahead} commit${s(ahead)} non poussé${s(ahead)}` });
    if (!ahead && !behind) out.push({ tone: "ok", label: "à jour" });
  }
  out.push(c.dirty ? { tone: "warn", label: `${c.dirty} fichier${s(c.dirty)} modifié${s(c.dirty)} sur le serveur` } : { tone: "ok", label: "aucune modification locale" });
  return out;
}

/** Déploiements certains (clone, image) d'un dépôt. Le dossier compose « probable » n'est pas compté. */
export function certainDeployments(list: GithubDeployment[] | undefined, fullName: string): GithubDeployment[] {
  const key = fullName.toLowerCase();
  return (list ?? []).filter((d) => d.certain && d.repo.toLowerCase() === key);
}

/** Déploiements d'un dépôt hors clones (ceux-ci ont leur carte détaillée). */
export function otherDeployments(list: GithubDeployment[] | undefined, fullName: string): GithubDeployment[] {
  const key = fullName.toLowerCase();
  return (list ?? []).filter((d) => d.kind !== "clone" && d.repo.toLowerCase() === key);
}

/** Ton de la pastille d'un état de conteneur Docker. */
export function containerTone(state: string): SyncTone {
  return state === "running" ? "ok" : state === "restarting" || state === "paused" ? "warn" : "muted";
}

/** Erreur GitHub reconnue : jeton à remplacer, ou incident passager à réessayer. */
export function githubError(message: string): { kind: "token" | "rate" | "permission" | "network" | "other"; hint: string } {
  const m = message.toLowerCase();
  if (m.includes("permission manquante"))
    return { kind: "permission", hint: `Permission manquante : Metadata et Contents en lecture (jeton fine-grained), ou « repo » (jeton classique). Pour un dépôt d'organisation, choisis l'organisation comme « Resource owner » à la création du jeton. (${message})` };
  if (m.includes("jeton refusé") || m.includes("aucun jeton")) return { kind: "token", hint: "Le jeton a expiré, a été révoqué ou n'a pas le droit de lecture. Colle un nouveau jeton." };
  if (m.includes("429") || m.includes("rate limit")) return { kind: "rate", hint: "GitHub limite le nombre de requêtes. Réessaie dans quelques minutes." };
  if (m.includes("injoignable")) return { kind: "network", hint: "GitHub ne répond pas : vérifie la connexion internet de ce poste." };
  return { kind: "other", hint: message };
}
