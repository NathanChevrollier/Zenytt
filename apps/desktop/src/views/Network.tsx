// Réseau : tunnels SSH depuis le PC et réseau privé entre serveurs, une page à deux onglets.
// Chaque onglet garde sa page (bouton principal, aide, filtres) ; seuls le titre et les onglets sont communs.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { peekCached } from "../lib/cache";
import { useTabIntent } from "../lib/shell";
import type { PageTab } from "../components/PageLayout";
import TunnelsView from "./Tunnels";
import MeshView from "./Mesh";

export type NetworkTab = "tunnels" | "mesh";

/** Ce que l'onglet passe à son PageLayout. */
export interface NetworkPage {
  tabs: PageTab<NetworkTab>[];
  activeTab: NetworkTab;
  onTab: (t: NetworkTab) => void;
  onCount: (n: number) => void;
}

export default function NetworkView() {
  const [tab, setTab] = useTabIntent<NetworkTab>("network", "tunnels");
  const [counts, setCounts] = useState<Record<NetworkTab, number | undefined>>(() => ({
    tunnels: peekCached<unknown[]>("tunnels:list")?.length,
    mesh: peekCached<unknown[]>("mesh:list")?.length,
  }));
  // L'onglet affiché tient son compteur à jour ; l'autre est lu une fois à l'arrivée.
  useEffect(() => {
    void api.tunnels().then((l) => setCounts((c) => ({ ...c, tunnels: l.length })), () => {});
    void api.meshList().then((l) => setCounts((c) => ({ ...c, mesh: l.length })), () => {});
  }, []);

  const page: NetworkPage = {
    tabs: [
      { id: "tunnels", label: "Tunnels SSH", count: counts.tunnels },
      { id: "mesh", label: "Réseau privé", count: counts.mesh },
    ],
    activeTab: tab,
    onTab: setTab,
    onCount: (n) => setCounts((c) => (c[tab] === n ? c : { ...c, [tab]: n })),
  };
  return tab === "mesh" ? <MeshView page={page} /> : <TunnelsView page={page} />;
}
