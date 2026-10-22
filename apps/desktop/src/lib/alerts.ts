import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { hasShell } from "./api";
import { fetchHealth } from "./health";
import { setServerAlerts } from "./desktop";
import { useApp } from "./store";

const INTERVAL_MS = 60_000;

/**
 * Notifications Windows pour les nouvelles alertes des serveurs connectés, tant que Zenytt est
 * ouvert (quand il est fermé, c'est l'agent zenyttd qui prévient par Discord, ntfy ou webhook).
 * Seuls les serveurs déjà connectés sont interrogés : aucune connexion n'est ouverte pour ça.
 */
export function watchAlerts(): () => void {
  /** Alertes déjà vues par serveur ; `undefined` : premier passage, rien n'est notifié. */
  const seen = new Map<string, Set<string>>();
  let stopped = false;
  let permission: boolean | null = null;

  const allowed = async () => {
    if (permission === null) {
      permission = await isPermissionGranted().catch(() => false);
      if (!permission) permission = (await requestPermission().catch(() => "denied")) === "granted";
    }
    return permission;
  };

  const tick = async () => {
    const { servers, settings } = useApp.getState();
    if (stopped || !settings.alertNotifications) return;
    for (const s of servers.filter((x) => x.connected && hasShell(x))) {
      const summary = await fetchHealth(s.id, 20_000).catch(() => null);
      if (!summary?.connected) continue;
      setServerAlerts(s.id, summary.alerts.length);
      const keys = new Set(summary.alerts.map((a) => a.key));
      const before = seen.get(s.id);
      seen.set(s.id, keys);
      if (!before) continue;
      const fresh = summary.alerts.filter((a) => !before.has(a.key));
      if (fresh.length && (await allowed())) {
        for (const a of fresh) sendNotification({ title: `Zenytt · ${s.name} : ${a.title}`, body: a.message });
      }
    }
  };

  void tick();
  const id = setInterval(() => void tick(), INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
