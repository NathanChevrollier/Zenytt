// Dossiers de classement propres à ce PC, par serveur : conteneurs Docker et machines virtuelles.
// Rien ne change sur le serveur ; l'état est gardé avec l'espace de travail (zenytt.json).
import { useApp, type Folders } from "./store";

/** Où vivent les dossiers de chaque sorte d'élément dans l'état sauvegardé. */
const KEYS = {
  containers: { items: "containers", created: "containerFolders" },
  vms: { items: "vms", created: "vmFolders" },
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

  const move = (keys: string[], folder: string | null) =>
    update((map, list) => {
      for (const k of keys) {
        if (folder) map[k] = folder;
        else delete map[k];
      }
      return [map, folder ? [...new Set([...list, folder])] : list];
    });
  const create = (name: string) => update((map, list) => [map, [...new Set([...list, name])]]);
  const rename = (from: string, to: string) =>
    update((map, list) => [Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === from ? to : v])), [...new Set([...list.filter((x) => x !== from), to])]]);
  const remove = (name: string) => update((map, list) => [Object.fromEntries(Object.entries(map).filter(([, v]) => v !== name)), list.filter((x) => x !== name)]);

  return { names, folderOf: (key: string) => assigned[key] ?? "", move, create, rename, remove };
}
