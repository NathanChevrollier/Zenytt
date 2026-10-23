// Vie de l'app sur le poste : fermeture de la fenêtre (réduire ou quitter), sortie avec les
// activités en cours, icône de la zone de notification et connexions automatiques au démarrage.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "./api";
import { useLock } from "./lock";
import { ensureConnected, useApp } from "./store";
import { runSync } from "./sync";
import { useTransfers } from "./transfers";

/** Ce qui s'arrête si l'app quitte. */
export interface Activity {
  tunnels: number;
  transfers: number;
  terminals: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Lignes du message de confirmation, vide s'il n'y a rien à perdre. */
export function activityLines(a: Activity): string[] {
  const lines: string[] = [];
  if (a.tunnels) lines.push(`${plural(a.tunnels, "tunnel ouvert", "tunnels ouverts")} (les applications qui s'en servent seront coupées)`);
  if (a.transfers) lines.push(plural(a.transfers, "transfert de fichiers en cours", "transferts de fichiers en cours"));
  if (a.terminals) lines.push(`${plural(a.terminals, "terminal ouvert", "terminaux ouverts")} (les sessions tmux continuent sur le serveur)`);
  return lines;
}

async function currentActivity(): Promise<Activity> {
  const tunnels = await api.tunnels().then((l) => l.filter((t) => t.running).length).catch(() => 0);
  return {
    tunnels,
    transfers: useTransfers.getState().list.filter((t) => t.state === "running").length,
    terminals: useApp.getState().tabs.length,
  };
}

/** Quitte vraiment, après confirmation s'il reste des activités en cours. */
export async function quitApp(): Promise<void> {
  // Avertissement désactivé dans les réglages : on quitte sans rien demander.
  const lines = useApp.getState().settings.confirmQuit ? activityLines(await currentActivity()) : [];
  if (lines.length && !useLock.getState().locked) {
    const ok = await useApp.getState().ask({
      title: "Quitter Zenytt ?",
      body: "Ces activités s'arrêteront :",
      code: lines.map((l) => `• ${l}`).join("\n"),
      confirmLabel: "Quitter quand même",
      danger: true,
    });
    if (!ok) return;
  }
  await api.appQuit();
}

/** Dialogue « Réduire ou quitter ? » affiché à la fermeture de la fenêtre. */
export const useCloseDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Fermeture de la fenêtre : applique le choix retenu, sinon le demande. */
async function onCloseRequested(): Promise<void> {
  const action = useApp.getState().settings.closeAction;
  // Verrouillée, l'app ne montre rien : sans choix retenu, elle se réduit (rien n'est perdu).
  if (action === "quit") return quitApp();
  if (action === "tray" || useLock.getState().locked) return api.appHide();
  useCloseDialog.getState().setOpen(true);
}

/** Alertes en cours par serveur (remontées par la surveillance des alertes). */
const alerts = new Map<string, number>();

export function setServerAlerts(serverId: string, count: number) {
  if (alerts.get(serverId) === count) return;
  alerts.set(serverId, count);
  pushTray();
}

/** Menu de l'icône : serveurs, état de connexion et alertes. Rien n'est montré quand l'app est verrouillée. */
function pushTray() {
  const locked = useLock.getState().locked;
  const servers = locked ? [] : useApp.getState().servers.map((s) => ({ id: s.id, name: s.name, connected: s.connected, alerts: s.connected ? (alerts.get(s.id) ?? 0) : 0 }));
  void api.trayUpdate(servers).catch(() => {});
}

/** Branche l'interface sur l'icône et la fenêtre. À appeler une fois, au montage de l'app. */
export function watchDesktop(): () => void {
  const offTray = listen<{ action: string; serverId: string | null }>("zenytt://tray", ({ payload }) => {
    switch (payload.action) {
      case "close":
        void onCloseRequested();
        break;
      case "quit":
        void quitApp();
        break;
      case "sync":
        void runSync(true);
        break;
      case "lock":
        useLock.getState().lock();
        break;
      case "server":
        if (payload.serverId && !useLock.getState().locked) {
          useApp.getState().setActiveServer(payload.serverId);
          useApp.getState().setSection("monitoring");
        }
        break;
    }
  });
  const offServers = useApp.subscribe((s, prev) => {
    if (s.servers !== prev.servers) pushTray();
  });
  const offLock = useLock.subscribe((s, prev) => {
    if (s.locked !== prev.locked) pushTray();
  });
  void api.appUiReady().catch(() => {});
  pushTray();
  return () => {
    void offTray.then((stop) => stop());
    offServers();
    offLock();
  };
}

/**
 * Connexion en arrière-plan des serveurs marqués « se connecter au démarrage ». Jamais de
 * dialogue, et un échec d'authentification suspend les tentatives (fail2ban) : c'est le mode
 * non interactif de `ensureConnected`.
 */
export async function autoConnect(): Promise<void> {
  for (const s of useApp.getState().servers.filter((x) => x.autoConnect && !x.connected)) {
    await ensureConnected(s.id, { interactive: false }).catch(() => false);
  }
}
