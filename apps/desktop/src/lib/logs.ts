// Logique partagée des journaux (page Journaux et tiroir de logs) : niveaux, filtre, étiquettes,
// liens « Ouvrir dans Journaux ».
import type { LogSource } from "./api";

/** Couleurs des étiquettes de source (texte des lignes toujours en couleur neutre). */
export const TAG_COLORS = ["#3987e5", "#d95926", "#1baf7a", "#c98500", "#d55181", "#9085e9", "#e66767", "#39c5cf"];
const ERROR_RE = /\b(error|err|fatal|crit|critical|emerg|alert|panic|exception|failed|échec)\b|\s5\d\d\s/i;
const WARN_RE = /\b(warn|warning|avertissement)\b|\s4\d\d\s/i;

export type Level = "all" | "warn" | "error";

export interface Line {
  id: number;
  /** Étiquette figée à la réception : elle reste juste même si la sélection change ensuite. */
  tag: string;
  color: string;
  text: string;
  at: number;
  level: 0 | 1 | 2;
  /** Ligne insérée par Zenytt (relance du flux), pas par le serveur. */
  marker?: boolean;
}

export const same = (a: LogSource, b: LogSource) => a.kind === b.kind && a.name === b.name;
export const label = (s: LogSource) => (s.kind === "file" ? s.name.replace("/var/log/", "") : s.kind === "unit" ? s.name.replace(/\.service$/, "") : s.name);
/** Couleur stable par source : une même source garde sa teinte d'une relance à l'autre. */
export const colorOf = (s: LogSource) => {
  let h = 0;
  for (const c of s.kind + s.name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
};
export const levelOf = (text: string): 0 | 1 | 2 => (ERROR_RE.test(text) ? 2 : WARN_RE.test(text) ? 1 : 0);
export const time = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Filtre saisi : regex insensible à la casse, ou simple texte si la regex est invalide. */
export function matcherOf(filter: string): { test: (s: string) => boolean } | null {
  if (!filter) return null;
  try {
    return new RegExp(filter, "i");
  } catch {
    const f = filter.toLowerCase();
    return { test: (s: string) => s.toLowerCase().includes(f) };
  }
}

export function countLevels(lines: Line[]) {
  let warn = 0;
  let error = 0;
  for (const l of lines) {
    if (l.level === 2) error++;
    else if (l.level === 1) warn++;
  }
  return { warn, error };
}

/** Lignes affichées : niveau minimal et filtre (les repères de relance restent), les `shown` dernières. */
export function visibleLines(lines: Line[], matcher: { test: (s: string) => boolean } | null, level: Level, shown: number) {
  const min = level === "error" ? 2 : level === "warn" ? 1 : 0;
  return lines.filter((l) => l.marker || (l.level >= min && (!matcher || matcher.test(l.text)))).slice(-shown);
}

/** Texte exporté : une ligne par entrée, horodatée, avec sa source. */
export const exportText = (lines: Line[]) =>
  lines
    .filter((l) => !l.marker)
    .map((l) => `${new Date(l.at).toISOString()} [${l.tag}] ${l.text}`)
    .join("\n");

const KINDS: LogSource["kind"][] = ["docker", "unit", "file"];

/** Lien vers la page Journaux : `docker:a,docker:b` (les noms acceptés ne contiennent pas de virgule). */
export const logLink = (sources: LogSource[]) => sources.map((s) => `${s.kind}:${s.name}`).join(",");

/** Inverse de `logLink` ; accepte l'ancien `unit:<nom>`. Les morceaux inconnus sont ignorés. */
export function parseLogLink(raw: string): LogSource[] {
  const out: LogSource[] = [];
  for (const part of raw.split(",")) {
    const i = part.indexOf(":");
    const kind = part.slice(0, i) as LogSource["kind"];
    const name = part.slice(i + 1);
    if (i > 0 && name && KINDS.includes(kind)) out.push({ kind, name });
  }
  return out;
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : le réglage vaut pour la session */
  }
}
