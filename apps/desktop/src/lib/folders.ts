// Dossiers de classement propres à ce PC, par serveur : conteneurs Docker et machines virtuelles.
// Rien ne change sur le serveur ; l'état est gardé avec l'espace de travail (zenytt.json).
import { projectDir } from "./compose";
import { useApp, type Folders } from "./store";

/** Où vivent les dossiers de chaque sorte d'élément dans l'état sauvegardé. */
const KEYS = {
  containers: { items: "containers", created: "containerFolders" },
  vms: { items: "vms", created: "vmFolders" },
  // Les « dossiers » des sites et des projets compose sont des clients.
  sites: { items: "sites", created: "siteFolders" },
  compose: { items: "compose", created: "composeFolders" },
} as const satisfies Record<string, { items: keyof Folders; created: keyof Folders }>;

export type FolderKind = keyof typeof KEYS;

const EMPTY_ITEMS: Record<string, string> = {};
const EMPTY_NAMES: string[] = [];

/**
 * Dossiers d'un serveur pour une sorte d'élément (clé : nom du conteneur, UUID de la VM) : ceux
 * créés, même vides, et ceux déjà attribués.
 */
export function useItemFolders(kind: FolderKind, serverId: string) {
  const { items, created: createdKey } = KEYS[kind];
  const assigned = useApp((s) => (s.folders[items] as Record<string, Record<string, string>> | undefined)?.[serverId]) ?? EMPTY_ITEMS;
  const created = useApp((s) => (s.folders[createdKey] as Record<string, string[]> | undefined)?.[serverId]) ?? EMPTY_NAMES;
  const setFolders = useApp((s) => s.setFolders);
  const names = [...new Set([...created, ...Object.values(assigned)])].filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));

  /** Applique `edit` aux attributions et aux dossiers créés de ce serveur. */
  const update = (edit: (map: Record<string, string>, list: string[]) => [Record<string, string>, string[]]) =>
    setFolders((f) => {
      const allItems = (f[items] ?? {}) as Record<string, Record<string, string>>;
      const allCreated = (f[createdKey] ?? {}) as Record<string, string[]>;
      const [map, list] = edit({ ...(allItems[serverId] ?? {}) }, [...(allCreated[serverId] ?? [])]);
      return { ...f, [items]: { ...allItems, [serverId]: map }, [createdKey]: { ...allCreated, [serverId]: list } };
    });

  // Un client n'existe que tant qu'un élément le porte : retiré du dernier, il disparaît des filtres.
  const prune = kind === "sites" || kind === "compose";
  const move = (keys: string[], folder: string | null) => update((map, list) => moveItems(map, list, keys, folder, prune));
  const create = (name: string) => update((map, list) => [map, [...new Set([...list, name])]]);
  const rename = (from: string, to: string) => update((map, list) => renameFolder(map, list, from, to));
  const remove = (name: string) => update((map, list) => removeFolder(map, list, name));

  return { names, folderOf: (key: string) => assigned[key] ?? "", move, create, rename, remove };
}

type FolderState = [Record<string, string>, string[]];

/** Range `keys` dans `folder` (ou les en sort si `null`/vide). `prune` oublie les dossiers devenus vides. */
export function moveItems(map: Record<string, string>, list: string[], keys: string[], folder: string | null, prune = false): FolderState {
  const next = { ...map };
  const name = folder?.trim() ?? "";
  for (const k of keys) {
    if (name) next[k] = name;
    else delete next[k];
  }
  const used = new Set(Object.values(next));
  const names = name ? [...new Set([...list, name])] : list;
  return [next, prune ? names.filter((n) => used.has(n)) : names];
}

/** Renomme un dossier pour tous ses éléments (fusionne s'il existe déjà un dossier `to`). */
export function renameFolder(map: Record<string, string>, list: string[], from: string, to: string): FolderState {
  const name = to.trim();
  if (!name || name === from) return [map, list];
  return [Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === from ? name : v])), [...new Set([...list.filter((x) => x !== from), name])]];
}

/** Supprime un dossier : ses éléments redeviennent « sans dossier ». */
export function removeFolder(map: Record<string, string>, list: string[], name: string): FolderState {
  return [Object.fromEntries(Object.entries(map).filter(([, v]) => v !== name)), list.filter((x) => x !== name)];
}

/** Clé de verrou d'un site (par domaine) ou d'un projet compose (par dossier). */
export const lockKey = (kind: "site" | "compose", id: string) => `${kind}:${id}`;

/** Clé de verrou d'un projet compose : son dossier, ou son nom quand aucun fichier n'est connu (sinon tous partageraient `compose:/`). */
export const composeLockKey = (p: { name: string; configFiles: string }) => (p.configFiles.trim() ? lockKey("compose", projectDir(p)) : `compose:name:${p.name}`);

const NO_LOCKS: string[] = [];

/** Verrous d'un serveur : un élément verrouillé échappe aux actions groupées et demande de retaper son nom pour les actions destructrices. */
export function useLocks(serverId: string) {
  const locked = useApp((s) => s.folders.locks?.[serverId]) ?? NO_LOCKS;
  const setFolders = useApp((s) => s.setFolders);
  const toggle = (key: string) =>
    setFolders((f) => {
      const all = f.locks ?? {};
      const cur = all[serverId] ?? [];
      return { ...f, locks: { ...all, [serverId]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] } };
    });
  return { isLocked: (key: string) => locked.includes(key), toggle };
}

/**
 * Confirmation d'une action destructrice : sur un élément verrouillé, il faut retaper son nom.
 * Renvoie `true` si l'action peut continuer.
 */
export async function confirmDestructive(opts: { title: string; body: string; confirmLabel: string; name: string; locked: boolean; danger?: boolean }): Promise<boolean> {
  const ask = useApp.getState().ask;
  if (!opts.locked) return (await ask({ title: opts.title, body: opts.body, confirmLabel: opts.confirmLabel, danger: opts.danger ?? true })) === true;
  const v = await ask({
    title: opts.title,
    body: `${opts.body}

Cet élément est verrouillé.`,
    input: { label: `Retape « ${opts.name} » pour confirmer`, initial: "" },
    confirmLabel: opts.confirmLabel,
    danger: true,
  });
  return typeof v === "string" && v.trim() === opts.name;
}

/** Valeur du filtre « Sans client » (la valeur vide désigne « Tous »). */
export const NO_CLIENT = "__none";

/**
 * Éléments filtrés par client puis regroupés : les clients par ordre alphabétique, « Sans client »
 * (clé vide) en dernier. L'ordre des éléments dans un groupe est conservé.
 */
export function groupByClient<T>(items: T[], clientOf: (item: T) => string, filter: string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const c = clientOf(it);
    if (filter === NO_CLIENT ? c : filter && c !== filter) continue;
    groups.set(c, [...(groups.get(c) ?? []), it]);
  }
  return [...groups].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "fr")));
}
