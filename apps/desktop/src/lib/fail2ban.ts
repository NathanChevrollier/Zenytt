import type { F2bEvent, F2bJail } from "./api";

/**
 * Durée fail2ban lisible : « 30 jours », « 1 jour 12 h », « 10 min », « définitif » (durée
 * négative). Les unités nulles sont omises (« 30 j 0 h » se lisait mal).
 */
export function banDurationText(secs: number): string {
  if (secs < 0) return "définitif";
  if (secs < 60) return `${Math.max(0, Math.round(secs))} s`;
  const units: [number, string, string][] = [
    [7 * 86400, "semaine", "semaines"],
    [86400, "jour", "jours"],
    [3600, "h", "h"],
    [60, "min", "min"],
  ];
  // Semaines seulement pour un compte rond (1 semaine, 5 semaines) : « 30 jours » se lit mieux que « 4 semaines 2 jours ».
  const parts: string[] = [];
  let rest = Math.round(secs);
  for (const [size, one, many] of units) {
    if (size === 7 * 86400 && rest % size !== 0) continue;
    const n = Math.floor(rest / size);
    if (!n) continue;
    parts.push(`${n} ${n > 1 ? many : one}`);
    rest -= n * size;
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/** Fin du bannissement en cours d'une adresse : date, `null` si définitif, `undefined` si inconnue (fail2ban < 0.11). */
export function banEnd(jail: F2bJail, ip: string): string | null | undefined {
  const b = jail.bans?.find((x) => x.ip === ip);
  if (b) return b.until;
  return jail.bantime < 0 ? null : undefined;
}

/** « jusqu'au 4 nov. 2026, 13:13 » / « définitif » ; `time` est l'heure du serveur. */
export function banEndText(until: string | null | undefined): string | null {
  if (until === undefined) return null;
  if (until === null) return "définitif";
  const d = new Date(until.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return `jusqu'au ${until}`;
  return `jusqu'au ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}, ${until.slice(11, 16)}`;
}

/** Adresses bannies au moins une fois, sans doublon (une même IP peut être dans plusieurs jails). */
export function bannedAddresses(jails: F2bJail[]): Set<string> {
  return new Set(jails.flatMap((j) => j.banned));
}

/** Adresse déjà bannie qui recommence. */
export interface Recidivist {
  ip: string;
  /** Bannissements dans le journal (hors rebannissements au redémarrage de fail2ban). */
  bans: number;
  /** Tentatives repérées après son dernier déblocage. */
  retriesSinceUnban: number;
  /** Heure de la dernière tentative. */
  lastSeen: string;
}

/**
 * Récidivistes du journal (du plus ancien au plus récent) : bannis au moins deux fois, ou qui
 * retentent après avoir été débloqués. Triés du plus insistant au moins insistant.
 */
export function recidivists(events: F2bEvent[]): Recidivist[] {
  const by = new Map<string, { bans: number; unbanned: boolean; retries: number; lastSeen: string }>();
  // Tentatives repérées depuis le dernier bannissement, par IP et jail : un bannissement
  // automatique en est toujours précédé, un bannissement manuel (depuis Zenytt ou
  // `fail2ban-client set … banip`) jamais. Seuls les premiers font un récidiviste.
  const foundSinceBan = new Set<string>();
  for (const e of events) {
    const s = by.get(e.ip) ?? { bans: 0, unbanned: false, retries: 0, lastSeen: "" };
    const key = `${e.jail}|${e.ip}`;
    if (e.kind === "ban") {
      const automatic = !e.jail.startsWith("zenytt-") && foundSinceBan.has(key);
      foundSinceBan.delete(key);
      if (!automatic) continue;
      s.bans += 1;
      s.unbanned = false;
      s.retries = 0;
    } else if (e.kind === "found") {
      foundSinceBan.add(key);
    }
    if (e.kind === "unban") {
      s.unbanned = true;
    } else if (e.kind === "found") {
      if (s.unbanned) s.retries += 1;
      s.lastSeen = e.time;
    }
    by.set(e.ip, s);
  }
  return [...by.entries()]
    .filter(([, s]) => s.bans >= 2 || (s.bans >= 1 && s.retries > 0))
    .map(([ip, s]) => ({ ip, bans: s.bans, retriesSinceUnban: s.retries, lastSeen: s.lastSeen }))
    .sort((a, b) => b.bans - a.bans || b.retriesSinceUnban - a.retriesSinceUnban);
}

/** Pourquoi une adresse a été débannie. */
export type UnbanKind = "expired" | "manual" | "restart" | "unknown";

/** « 2026-09-30 14:02:11 » → millisecondes (heure du serveur, seuls les écarts comptent). */
const at = (time: string) => Date.parse(time.replace(" ", "T"));

/**
 * Nature de chaque débannissement du journal (clé : index de l'événement). fail2ban écrit la même
 * ligne `Unban` dans tous les cas ; on la déduit donc du contexte :
 * - suivi d'un « Restore Ban » de la même adresse dans les secondes qui suivent : redémarrage de
 *   fail2ban (il lève tout à l'arrêt puis rebannit) ;
 * - arrivé à la fin de la durée du jail : fin normale ;
 * - arrivé nettement avant : débannissement manuel ;
 * - bannissement absent du journal ou durée inconnue : impossible à dire.
 */
export function unbanKinds(events: F2bEvent[], bantimes: Record<string, number>): Map<number, UnbanKind> {
  const out = new Map<number, UnbanKind>();
  const lastBan = new Map<string, number>();
  events.forEach((e, i) => {
    const key = `${e.jail}|${e.ip}`;
    if (e.kind === "ban") lastBan.set(key, at(e.time));
    if (e.kind !== "unban") return;
    const t = at(e.time);
    const restored = events.slice(i + 1, i + 20).some((n) => n.kind === "restore" && n.ip === e.ip && n.jail === e.jail && Math.abs(at(n.time) - t) <= 10_000);
    const banned = lastBan.get(key);
    const bantime = bantimes[e.jail];
    let kind: UnbanKind = "unknown";
    if (restored) kind = "restart";
    // Un bannissement définitif n'expire jamais : s'il est levé, c'est à la main.
    else if (bantime !== undefined && bantime < 0) kind = "manual";
    else if (banned !== undefined && bantime !== undefined && bantime > 0 && !Number.isNaN(t)) {
      // Deux minutes de marge : fail2ban lève les bannissements à sa prochaine vérification.
      kind = t - banned >= bantime * 1000 - 120_000 ? "expired" : "manual";
    }
    out.set(i, kind);
    if (!restored) lastBan.delete(key);
  });
  return out;
}

/**
 * En-tête de jour du journal : « Aujourd'hui », « Hier », « lundi 28 septembre » (année ajoutée
 * si ce n'est pas l'année en cours). `time` est l'heure du serveur, « 2026-09-28 21:12:10 ».
 */
export function dayLabel(time: string, now = new Date()): string {
  const [y, m, d] = time.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "Date inconnue";
  const day = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return "Hier";
  const label = day.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", ...(y !== now.getFullYear() ? { year: "numeric" } : {}) });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Heure seule d'un événement : « 21:12:10 ». */
export const timeOf = (time: string) => time.slice(11, 19) || time;

/** Regroupe des éléments par jour (dans l'ordre reçu), pour les afficher sous un en-tête de date. */
export function groupByDay<T extends { time: string }>(items: T[], now = new Date()): { day: string; items: T[] }[] {
  const out: { day: string; items: T[] }[] = [];
  for (const it of items) {
    const day = dayLabel(it.time, now);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}

let names: Intl.DisplayNames | null = null;

/** Nom du pays en français à partir de son code ISO (« US » → « États-Unis »). */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    names ??= new Intl.DisplayNames(["fr"], { type: "region" });
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
