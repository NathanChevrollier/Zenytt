// Page GitHub : fonctions pures (filtre, tri, lien, état d'un clone) séparées de la vue pour être testées.
import { formatAgo, type GithubAlert, type GithubCiRun, type GithubClone, type GithubDeployment, type GithubRepo } from "./api";

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

/** Nom seul de l'ancien `owner/name` resté dans `origin` d'un clone (« helm » pour « nathanchevrollier/helm »). */
export const oldRemoteName = (old: string) => old.slice(old.indexOf("/") + 1) || old;

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

// ---- Informations d'un dépôt (Actions, PR, tickets, Dependabot, déploiements GitHub) --------------

/** Données qui demandent chacune une permission du jeton. */
export type InsightKind = "ci" | "pulls" | "issues" | "alerts" | "deployments" | "release";

const PERMISSIONS: Record<InsightKind, string> = { ci: "Actions", pulls: "Pull requests", issues: "Issues", alerts: "Dependabot alerts", deployments: "Deployments", release: "Contents" };

/**
 * Lecture d'une erreur de section : permission refusée (403 « not accessible », 404 sur un dépôt déjà listé, alertes désactivées)
 * donne une note discrète ; le reste (limite de requêtes, réseau) garde son message.
 */
export function insightError(kind: InsightKind, message: string): { permission: boolean; text: string } {
  const m = message.toLowerCase();
  if (m.includes("permission manquante") || m.includes("introuvable (404)")) {
    const off = kind === "alerts" && m.includes("disabled");
    return {
      permission: true,
      text: off
        ? "Alertes Dependabot désactivées pour ce dépôt."
        : `Permission « ${PERMISSIONS[kind]} » non accordée au jeton. Ajoute-la en lecture sur github.com (Settings, Developer settings, jeton fine-grained) pour voir cette section.`,
    };
  }
  return { permission: false, text: githubError(message).hint };
}

/** Pastille de CI d'un run : en cours, réussi, en échec, annulé… */
export function ciState(run: Pick<GithubCiRun, "status" | "conclusion"> | undefined): { tone: SyncTone | "danger"; label: string; running: boolean } {
  if (!run) return { tone: "muted", label: "aucune exécution", running: false };
  if (run.status !== "completed") return { tone: "accent", label: run.status === "queued" ? "en attente" : "en cours", running: true };
  switch (run.conclusion) {
    case "success":
      return { tone: "ok", label: "réussi", running: false };
    case "failure":
    case "startup_failure":
      return { tone: "danger", label: "échec", running: false };
    case "timed_out":
      return { tone: "danger", label: "délai dépassé", running: false };
    case "cancelled":
      return { tone: "warn", label: "annulé", running: false };
    case "skipped":
    case "neutral":
      return { tone: "muted", label: "ignoré", running: false };
    default:
      return { tone: "warn", label: run.conclusion ?? "terminé", running: false };
  }
}

/** Durée d'un run terminé (« 4 min 30 s »), « — » sinon. */
export function runDuration(run: Pick<GithubCiRun, "status" | "startedAt" | "updatedAt">): string {
  const a = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const b = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  if (run.status !== "completed" || Number.isNaN(a) || Number.isNaN(b) || b < a) return "—";
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min${s % 60 ? ` ${s % 60} s` : ""}` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEVERITY_LABEL: Record<string, string> = { critical: "critique", high: "haute", medium: "moyenne", low: "basse" };
export const severityLabel = (s: string) => SEVERITY_LABEL[s] ?? s;
export const severityTone = (s: string): "danger" | "warn" | "muted" => (s === "critical" || s === "high" ? "danger" : s === "medium" ? "warn" : "muted");

/** Nombre d'alertes par gravité, de la plus grave à la moins grave (les gravités à zéro sont omises). */
export function alertCounts(alerts: Pick<GithubAlert, "severity">[]): { severity: string; count: number }[] {
  return SEVERITIES.map((severity) => ({ severity, count: alerts.filter((a) => a.severity === severity).length })).filter((c) => c.count > 0);
}

/** Alertes critiques ou hautes : celles qui méritent un badge dans la liste. */
export const urgentAlerts = (alerts: Pick<GithubAlert, "severity">[] | undefined) => (alerts ?? []).filter((a) => a.severity === "critical" || a.severity === "high").length;

/** Ton de l'état du dernier statut d'un déploiement GitHub. */
export function deployStateTone(state: string | null): SyncTone | "danger" {
  switch (state) {
    case "success":
      return "ok";
    case "failure":
    case "error":
      return "danger";
    case "in_progress":
    case "queued":
    case "pending":
      return "accent";
    default:
      return "muted";
  }
}

const DEPLOY_STATE_LABEL: Record<string, string> = { success: "réussi", failure: "échec", error: "erreur", in_progress: "en cours", queued: "en attente", pending: "en attente", inactive: "remplacé" };
export const deployStateLabel = (state: string | null) => (state ? (DEPLOY_STATE_LABEL[state] ?? state) : "sans statut");

/** Couleur d'étiquette sûre pour un style : 6 hexadécimaux, sinon null. */
export const labelColor = (c: string) => (/^[0-9a-fA-F]{6}$/.test(c) ? `#${c}` : null);

/** Lien d'une page de dépôt sur github.com, ou null si le nom n'est pas valide. */
export function repoPageUrl(owner: string, name: string, page: "actions" | "pulls" | "issues" | "security/dependabot" | "deployments" | "releases"): string | null {
  const base = repoUrl(owner, name);
  return base && `${base}/${page}`;
}
