import { Lock, LockOpen, Tag, X } from "lucide-react";
import { useApp } from "../lib/store";
import { NO_CLIENT, type useItemFolders } from "../lib/folders";
import { Select, type MenuItem } from "./ui";

/** Entrées de menu communes aux sites et projets compose : client et verrou d'un élément. */
export function clientMenuItems(clients: ReturnType<typeof useItemFolders>, key: string, locked: boolean, toggleLock: () => void): MenuItem[] {
  const current = clients.folderOf(key);
  return [
    {
      label: current ? `Client : ${current}…` : "Définir le client…",
      icon: <Tag size={14} />,
      onClick: async () => {
        const v = await useApp.getState().ask({
          title: "Client",
          body: "Étiquette libre, propre à ce PC : elle sert à trier et filtrer.",
          input: { label: "Nom du client", initial: current },
          confirmLabel: "Valider",
        });
        if (typeof v === "string" && v.trim()) clients.move([key], v.trim());
      },
    },
    ...clients.names.filter((n) => n !== current).map((n) => ({ label: n, icon: <Tag size={14} />, onClick: () => clients.move([key], n) })),
    ...(current ? [{ label: "Retirer le client", icon: <X size={14} />, onClick: () => clients.move([key], null) }] : []),
    { label: locked ? "Déverrouiller" : "Verrouiller", icon: locked ? <LockOpen size={14} /> : <Lock size={14} />, onClick: toggleLock },
  ];
}

/** Sélecteur de client (visible dès qu'il existe au moins un client). */
export function ClientFilter({ names, value, onChange }: { names: string[]; value: string; onChange: (v: string) => void }) {
  if (names.length === 0) return null;
  return (
    <Select
      className="w-48"
      size="sm"
      title="Filtrer par client"
      value={value}
      onChange={onChange}
      options={[{ value: "", label: "Tous les clients" }, ...names.map((n) => ({ value: n, label: n })), { value: NO_CLIENT, label: "Sans client" }]}
    />
  );
}
