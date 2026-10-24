import { Lock, LockOpen, Pencil, Tag, Trash2, X } from "lucide-react";
import { useApp } from "../lib/store";
import { NO_CLIENT, type useItemFolders } from "../lib/folders";
import { Segmented, Select, type MenuItem } from "./ui";

type Clients = ReturnType<typeof useItemFolders>;

/** Renommer ou supprimer un client : s'applique à tous ses éléments (menu d'un en-tête de groupe). */
export function clientGroupItems(clients: Clients, name: string): MenuItem[] {
  const ask = () => useApp.getState().ask;
  return [
    {
      label: "Renommer le client…",
      icon: <Pencil size={14} />,
      onClick: async () => {
        const v = await ask()({ title: `Renommer « ${name} »`, body: "Le nouveau nom s'applique à tous ses éléments.", input: { label: "Nom du client", initial: name }, confirmLabel: "Renommer" });
        if (typeof v === "string") clients.rename(name, v);
      },
    },
    {
      label: "Supprimer le client…",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: async () => {
        const ok = await ask()({ title: `Supprimer le client « ${name} » ?`, body: "Ses éléments repassent « Sans client ». Rien ne change sur le serveur.", confirmLabel: "Supprimer", danger: true });
        if (ok === true) clients.remove(name);
      },
    },
  ];
}

/** Entrées de menu communes aux sites et projets compose : client et verrou d'un élément. */
export function clientMenuItems(clients: Clients, key: string, locked: boolean, toggleLock: () => void): MenuItem[] {
  const current = clients.folderOf(key);
  return [
    { heading: "Client" },
    {
      label: current ? "Changer le client…" : "Définir le client…",
      icon: <Tag size={14} />,
      onClick: async () => {
        const v = await useApp.getState().ask({
          title: "Client",
          body: "Étiquette libre, propre à ce PC : elle sert à trier et filtrer. Laisse vide pour retirer le client.",
          input: { label: "Nom du client", initial: current },
          confirmLabel: "Valider",
        });
        // Champ vidé : on retire le client (avant, la saisie vide était ignorée).
        if (typeof v === "string") clients.move([key], v.trim() || null);
      },
    },
    ...clients.names.map((n) => ({ label: n, checked: n === current, onClick: () => clients.move([key], n) })),
    ...(current ? [{ label: "Retirer le client", icon: <X size={14} />, onClick: () => clients.move([key], null) }, ...clientGroupItems(clients, current)] : []),
    "separator",
    { label: locked ? "Déverrouiller" : "Verrouiller", icon: locked ? <LockOpen size={14} /> : <Lock size={14} />, onClick: toggleLock },
  ];
}

/**
 * Filtre par client (visible dès qu'il existe au moins un client) : des puces « Tous · client… ·
 * Sans client » avec leur nombre d'éléments, ou une liste déroulante au-delà de 6 clients.
 */
export function ClientFilter({ names, value, onChange, counts }: { names: string[]; value: string; onChange: (v: string) => void; counts?: Record<string, number> }) {
  if (names.length === 0) return null;
  const n = (k: string) => (counts?.[k] ? ` · ${counts[k]}` : "");
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const options = [
    { value: "", label: `Tous${total ? ` · ${total}` : ""}` },
    ...names.map((c) => ({ value: c, label: `${c}${n(c)}` })),
    { value: NO_CLIENT, label: `Sans client${n("")}` },
  ];
  if (names.length > 6) return <Select className="w-56" size="sm" title="Filtrer par client" value={value} onChange={onChange} options={options} />;
  return <Segmented label="Filtrer par client" size="sm" value={value} onChange={onChange} options={options} />;
}
