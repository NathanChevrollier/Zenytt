// Relevé des ressources partagé par serveur (supervision, barre du terminal…) : un seul poller par
// serveur, au plus petit intervalle demandé, jamais deux requêtes en même temps, en pause quand la
// fenêtre est masquée ou Zenytt verrouillé. Les relevés s'accumulent dans un tampon commun : la
// courbe « Direct » est déjà remplie quand on ouvre la page.
import { useEffect } from "react";
import { create } from "zustand";
import { api, errorMessage, type Metrics } from "./api";
import { useLock } from "./lock";

export const LIVE_POINTS = 150;

export interface MetricsEntry {
  samples: Metrics[];
  error: string | null;
}

export const useMetricsStore = create<{ byServer: Record<string, MetricsEntry> }>(() => ({ byServer: {} }));

const EMPTY: MetricsEntry = { samples: [], error: null };

interface Poller {
  /** Intervalle demandé par chaque abonné. */
  wants: Map<number, number>;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
  last: number;
}

const pollers = new Map<string, Poller>();
let seq = 0;

const patch = (serverId: string, f: (e: MetricsEntry) => MetricsEntry) =>
  useMetricsStore.setState((s) => ({ byServer: { ...s.byServer, [serverId]: f(s.byServer[serverId] ?? EMPTY) } }));

function schedule(serverId: string) {
  const p = pollers.get(serverId);
  if (!p) return;
  clearTimeout(p.timer);
  if (!p.wants.size || p.busy) return;
  const every = Math.min(...p.wants.values());
  p.timer = setTimeout(() => void tick(serverId), Math.max(0, p.last + every - Date.now()));
}

async function tick(serverId: string) {
  const p = pollers.get(serverId);
  if (!p || p.busy || !p.wants.size) return;
  // En pause : le prochain tour est relancé par le retour de la fenêtre ou le déverrouillage.
  if (document.hidden || useLock.getState().locked) return;
  p.busy = true;
  try {
    const m = await api.metrics(serverId);
    patch(serverId, (e) => ({ samples: [...e.samples, m].slice(-LIVE_POINTS), error: null }));
  } catch (e) {
    patch(serverId, (x) => ({ ...x, error: errorMessage(e) }));
  } finally {
    p.busy = false;
    p.last = Date.now();
    if (p.wants.size) schedule(serverId);
    else pollers.delete(serverId);
  }
}

const resumeAll = () => {
  if (document.hidden || useLock.getState().locked) return;
  for (const id of pollers.keys()) schedule(id);
};
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", resumeAll);
  useLock.subscribe((s, prev) => s.locked !== prev.locked && resumeAll());
}

/** Abonne un lecteur au relevé d'un serveur ; renvoie la fonction de désabonnement. */
export function subscribeMetrics(serverId: string, intervalMs: number): () => void {
  listen();
  const id = ++seq;
  let p = pollers.get(serverId);
  if (!p) {
    p = { wants: new Map(), busy: false, last: 0 };
    pollers.set(serverId, p);
  }
  p.wants.set(id, intervalMs);
  schedule(serverId);
  return () => {
    const q = pollers.get(serverId);
    if (!q) return;
    q.wants.delete(id);
    if (q.wants.size) schedule(serverId);
    else {
      clearTimeout(q.timer);
      // Gardé tant qu'une requête est en vol : elle se termine sans relancer de tour.
      if (!q.busy) pollers.delete(serverId);
    }
  };
}

/** Relevés d'un serveur (les plus récents à la fin), relus toutes les `intervalMs` tant que `enabled`. */
export function useMetrics(serverId: string | null | undefined, intervalMs: number, enabled = true): MetricsEntry {
  useEffect(() => {
    if (!serverId || !enabled) return;
    return subscribeMetrics(serverId, intervalMs);
  }, [serverId, intervalMs, enabled]);
  return useMetricsStore((s) => (serverId ? s.byServer[serverId] : undefined)) ?? EMPTY;
}

/** Teinte d'une jauge de disque : alignée sur le seuil de l'alerte « Disque » de l'agent s'il est connu, sinon seuils communs (80 / 90 %). */
export function diskTone(pct: number, threshold?: number): "accent" | "warn" | "danger" {
  if (threshold == null) return pct >= 90 ? "danger" : pct >= 80 ? "warn" : "accent";
  return pct >= threshold ? "danger" : pct >= threshold - 10 ? "warn" : "accent";
}
