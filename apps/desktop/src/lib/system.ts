// Aides pures de la page Système : regroupement des mises à jour et des images, validation.
import type { ContainerImage, Finding, Severity, SystemUpdate } from "./api";

export type UpdateGroup = "kernel" | "libs" | "apps";
export const UPDATE_GROUP_LABEL: Record<UpdateGroup, string> = { kernel: "Noyau et démarrage", libs: "Bibliothèques", apps: "Applications et outils" };
const ORDER: UpdateGroup[] = ["kernel", "libs", "apps"];

/** Famille d'un paquet (apt : `linux-image-…`, dnf : `kernel-core.x86_64`). */
export function updateGroup(name: string): UpdateGroup {
  if (/^(linux-(image|headers|modules|generic|firmware)|kernel|grub|shim|firmware|initramfs|dracut)/.test(name)) return "kernel";
  if (/^lib/.test(name)) return "libs";
  return "apps";
}

/** Mises à jour triées par famille (noyau d'abord) puis par nom : `DataTable.groupBy` suit cet ordre. */
export function sortUpdates(list: SystemUpdate[]): SystemUpdate[] {
  return [...list].sort((a, b) => ORDER.indexOf(updateGroup(a.name)) - ORDER.indexOf(updateGroup(b.name)) || a.name.localeCompare(b.name));
}

/** Images triées par projet compose (conteneurs isolés à la fin) puis par service. */
export function sortImages(list: ContainerImage[]): ContainerImage[] {
  return [...list].sort((a, b) => (a.project ?? "￿").localeCompare(b.project ?? "￿") || (a.service ?? a.container).localeCompare(b.service ?? b.container));
}

/** Nom d'hôte valide (RFC 1123, une seule étiquette) : lettres, chiffres, tirets, 63 caractères au plus. */
export function validHostname(name: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name);
}

/** « 14:30 » aujourd'hui, « 24/10 14:30 » un autre jour. */
export function formatAt(unixSecs: number, now = new Date()): string {
  const d = new Date(unixSecs * 1000);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time}`;
}

/** Points retirés au score de sécurité par constat, selon sa gravité. */
export const PENALTY: Record<Severity, number> = { critical: 30, high: 15, medium: 6, low: 2, ok: 0 };

/** Constats à traiter (hors ignorés), conformes, prioritaires et score sur 100. */
export function auditSummary(findings: Finding[], ignoredIds: string[]) {
  const problems = findings.filter((f) => f.severity !== "ok" && !ignoredIds.includes(f.id));
  const ok = findings.filter((f) => f.severity === "ok");
  const serious = problems.filter((f) => f.severity === "critical" || f.severity === "high").length;
  const score = Math.max(0, 100 - problems.reduce((n, f) => n + PENALTY[f.severity], 0));
  return { problems, ok, serious, score };
}

export function scoreVerdict(score: number): string {
  return score >= 90 ? "Serveur bien protégé" : score >= 70 ? "Quelques points à renforcer" : score >= 40 ? "Des failles à corriger" : "Serveur exposé";
}

/** Onglet demandé à la page Système : « security/fail2ban » ouvre Sécurité sur son sous-onglet. */
export function splitTab(tab: string): [string, string | null] {
  const i = tab.indexOf("/");
  return i < 0 ? [tab, null] : [tab.slice(0, i), tab.slice(i + 1)];
}

export type SystemTab = "overview" | "security" | "software" | "provider";

/**
 * Onglet demandé (lien, palette, aide, ancienne version) → onglet actuel. « updates » et « inventory »
 * sont devenus « software » ; l'audit vit dans la vue d'ensemble : « security » seul ou « security/audit »
 * y mènent (`audit`), « security/firewall » ouvre toujours Sécurité sur son sous-onglet.
 */
export function resolveSystemTab(raw: string): { tab: SystemTab; sub: string | null; audit: boolean } {
  const [main, sub] = splitTab(raw);
  if (main === "updates" || main === "inventory" || main === "software") return { tab: "software", sub: null, audit: false };
  if (main === "security") return sub && sub !== "audit" ? { tab: "security", sub, audit: false } : { tab: "overview", sub: null, audit: true };
  return { tab: main === "provider" ? "provider" : "overview", sub: null, audit: false };
}
