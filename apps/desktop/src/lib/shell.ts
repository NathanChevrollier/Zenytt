// État de la coque de l'application (ce qui entoure les pages) : sous-titre du fil d'Ariane,
// ouverture du sélecteur de serveur, de la palette et du centre de notifications.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { useApp } from "./store";
import type { SectionId } from "../sections";
import type { LogSource } from "./api";

/** Journaux ouverts dans le tiroir de logs (conteneur, projet compose ou service systemd). */
export interface LogTarget {
  serverId: string;
  /** « conteneur », « projet », « service » : affiché devant le nom. */
  kind: string;
  name: string;
  sources: LogSource[];
  /** Sources écartées au-delà de la limite d'un suivi (gros projet compose). */
  skipped?: number;
  /** Ancien suivi dans un onglet de terminal (menu ⋯). */
  terminal?: () => void;
}

interface ShellState {
  /** Sous-partie affichée par la page (onglet courant…), dernier maillon du fil d'Ariane. */
  crumb: string | null;
  setCrumb: (c: string | null) => void;
  switcherOpen: boolean;
  setSwitcherOpen: (v: boolean) => void;
  paletteOpen: boolean;
  /** Texte initial de la palette (préfixe de portée : `>`, `@`, `/`, `#`). */
  paletteQuery: string;
  openPalette: (query?: string) => void;
  closePalette: () => void;
  notificationsOpen: boolean;
  setNotificationsOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  /** Demande d'ouverture du formulaire « Nouveau serveur » (depuis le sélecteur ou l'accueil). */
  newServerRequested: boolean;
  requestNewServer: (v: boolean) => void;
  /** Onglet à ouvrir à l'arrivée sur une section (lien « Installer l'agent » → tiroir Alertes de Supervision…). */
  intent: { section: SectionId; tab: string } | null;
  /** Tiroir « Sessions ouvertes » à droite (retenu d'une session à l'autre). */
  machinesOpen: boolean;
  setMachinesOpen: (v: boolean) => void;
  logs: LogTarget | null;
}

const MACHINES_KEY = "zenytt.machines";
function readMachinesOpen(): boolean {
  try {
    return localStorage.getItem(MACHINES_KEY) === "open";
  } catch {
    return false;
  }
}

export const useShell = create<ShellState>((set) => ({
  crumb: null,
  setCrumb: (crumb) => set({ crumb }),
  switcherOpen: false,
  setSwitcherOpen: (switcherOpen) => set({ switcherOpen }),
  paletteOpen: false,
  paletteQuery: "",
  openPalette: (paletteQuery = "") => set({ paletteOpen: true, paletteQuery }),
  closePalette: () => set({ paletteOpen: false, paletteQuery: "" }),
  notificationsOpen: false,
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  newServerRequested: false,
  requestNewServer: (newServerRequested) => set({ newServerRequested }),
  intent: null,
  logs: null,
  machinesOpen: readMachinesOpen(),
  setMachinesOpen: (machinesOpen) => {
    try {
      localStorage.setItem(MACHINES_KEY, machinesOpen ? "open" : "closed");
    } catch {
      /* préférence non retenue */
    }
    set({ machinesOpen });
  },
}));

export const openLogs = (logs: LogTarget | null) => useShell.setState({ logs });

/** Va à une section, en ouvrant directement l'un de ses onglets. */
export function navigate(section: SectionId, tab?: string, serverId?: string) {
  if (serverId) useApp.getState().setActiveServer(serverId);
  useShell.setState({ intent: tab ? { section, tab } : null });
  useApp.getState().setSection(section);
}

/**
 * Onglet d'une page, qui suit les demandes `navigate(section, tab)` : l'onglet demandé est
 * appliqué à l'arrivée sur la page, puis la demande est effacée.
 */
export function useTabIntent<T extends string>(section: SectionId, initial: T): [T, (t: T) => void] {
  const [tab, setTab] = useState<T>(() => {
    const i = useShell.getState().intent;
    return i && i.section === section ? (i.tab as T) : initial;
  });
  const intent = useShell((s) => s.intent);
  useEffect(() => {
    if (intent && intent.section === section) {
      setTab(intent.tab as T);
      useShell.setState({ intent: null });
    }
  }, [intent, section]);
  return [tab, setTab];
}
