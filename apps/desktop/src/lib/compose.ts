// Fichiers docker compose ouverts depuis l'explorateur : reconnaissance du fichier et actions
// proposées selon ce que Docker fait déjà du projet.
import type { ComposeFileInfo } from "./api";

/** Noms de fichiers que `docker compose` lit par défaut. */
const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export function isComposeFile(name: string): boolean {
  return COMPOSE_NAMES.includes(name.toLowerCase());
}

/** Fichier compose d'un dossier, d'après son contenu (le premier nom reconnu par Docker). */
export function composeFileIn(names: string[]): string | undefined {
  return COMPOSE_NAMES.find((n) => names.includes(n));
}

export type ComposeChoice =
  | "launch"
  | "launchBuild"
  | "restart"
  | "update"
  | "rebuild"
  | "stop"
  | "start"
  | "down"
  | "logs"
  | "replace"
  | "launchAs";

/** Actions proposées, dans l'ordre d'affichage, selon la situation du fichier. */
export function composeChoices(info: ComposeFileInfo): ComposeChoice[] {
  const build = info.hasBuild;
  switch (info.state.kind) {
    case "invalid":
      return [];
    case "notRunning":
      return build ? ["launch", "launchBuild"] : ["launch"];
    case "same":
      return info.state.running
        ? ["restart", "update", "rebuild", "logs", "stop"]
        : [build ? "launchBuild" : "start", "down"];
    case "conflict":
      return ["replace", "launchAs"];
  }
}

/** Identifiant stable d'un conteneur, même règle que le moteur : `projet/service`, sinon son nom. */
export function containerKey(c: { name: string; composeProject?: string | null; composeService?: string | null }): string {
  return c.composeProject && c.composeService ? `${c.composeProject}/${c.composeService}` : c.name;
}

/**
 * Compteurs d'un projet compose. Les conteneurs ponctuels (tâches qui s'arrêtent normalement) ne
 * comptent pas : un projet dont seul le « migrator » est arrêté est complet.
 */
export function projectCounts(
  services: { name: string; state: string; composeProject?: string | null; composeService?: string | null }[],
  occasional: Set<string>,
): { running: number; expected: number; occasional: number } {
  const expected = services.filter((c) => !occasional.has(containerKey(c)));
  return {
    running: expected.filter((c) => c.state === "running").length,
    expected: expected.length,
    occasional: services.length - expected.length,
  };
}

/** Dossier du fichier compose d'un projet (premier fichier de `configFiles`). */
export function projectDir(p: { configFiles: string }): string {
  const file = p.configFiles.split(",")[0];
  return file.slice(0, Math.max(file.lastIndexOf("/"), 0)) || "/";
}

/**
 * Nom de projet compose proposé pour un dossier : dernier segment du chemin, en minuscules, réduit à
 * `[a-z0-9_-]` (40 caractères au plus, commençant par un caractère alphanumérique). Vide si rien n'en sort.
 */
export function projectNameFromPath(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return last
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** Mémoire utilisée lue dans `docker stats` (« 12.5MiB / 1.9GiB » → octets de la partie gauche), 0 si illisible. */
export function memBytes(memUsage: string): number {
  const m = /^\s*([\d.]+)\s*([a-z]+)/i.exec(memUsage);
  return m ? Number(m[1]) * (SIZE_UNITS[m[2].toLowerCase()] ?? 0) : 0;
}
