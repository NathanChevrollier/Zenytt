import type { TermTab } from "./store";

/** Groupe de la liste verticale des terminaux : un serveur, les grilles multi-serveurs, ou les partages reçus. */
export interface TabGroup {
  /** Identifiant du serveur, ou « grid » / « join ». */
  id: string;
  tabs: TermTab[];
}

/** Regroupe les onglets par serveur, dans l'ordre de première apparition (l'ordre des onglets est conservé dans chaque groupe). */
export function groupTabsByServer(tabs: TermTab[]): TabGroup[] {
  const groups = new Map<string, TermTab[]>();
  for (const t of tabs) {
    const id = t.join ? "join" : t.grid ? "grid" : t.serverId;
    groups.set(id, [...(groups.get(id) ?? []), t]);
  }
  return [...groups].map(([id, list]) => ({ id, tabs: list }));
}
