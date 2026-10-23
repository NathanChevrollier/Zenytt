// Page GitHub : fonctions pures (filtre, lien) séparées de la vue pour être testées.
import type { GithubRepo } from "./api";

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
