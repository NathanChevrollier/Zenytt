// Éléments partagés par les onglets de la page Docker.
import { useState } from "react";
import { api, errorMessage, shellQuote, type ComposeProject, type Container, type ContainerStats } from "../../lib/api";
import { useApp, useAppPick } from "../../lib/store";
import { openLogs } from "../../lib/shell";
import { composeLockKey, confirmDestructive, useItemFolders, useLocks } from "../../lib/folders";
import { useCachedState } from "../../lib/cache";
import { usePolling } from "../../lib/poll";
import type { Tone } from "../../components/ui";

/** Statistiques des conteneurs, relues toutes les 5 s (partagées entre les onglets par le cache). */
export function useContainerStats(serverId: string) {
  const [stats, setStats] = useCachedState<Record<string, ContainerStats>>(`dockerStats:${serverId}`, {});
  // `docker stats` prend souvent 2 à 3 s : le hook évite d'empiler les appels.
  usePolling(
    () =>
      api
        .dockerStats(serverId)
        .then((list) => setStats(Object.fromEntries(list.map((s) => [s.id, s]))))
        .catch(() => {}),
    5000,
    [serverId],
  );
  return stats;
}

/** Actions sur un conteneur (avec confirmation quand elles interrompent un service), shell et logs. */
export function useContainerActions(serverId: string, docker: string, reload: () => Promise<void>, projects: ComposeProject[] = []) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
  const locks = useLocks(serverId);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (c: Container, action: string): Promise<boolean> => {
    const labels: Record<string, [string, string?, boolean?]> = {
      restart: ["Redémarrer"],
      stop: ["Arrêter", "Le service rendu par ce conteneur sera interrompu."],
      pause: ["Mettre en pause"],
      unpause: ["Reprendre"],
      start: ["Démarrer"],
      remove: ["Supprimer", "Le conteneur sera supprimé. Ses volumes nommés sont conservés.", true],
    };
    const [label, body, danger] = labels[action] ?? [action];
    // Conteneur d'un projet compose verrouillé : retaper le nom du projet pour arrêter, redémarrer ou supprimer.
    const p = c.composeProject ? projects.find((x) => x.name === c.composeProject) : undefined;
    const locked = !!p && locks.isLocked(composeLockKey(p));
    if (locked && ["stop", "restart", "remove"].includes(action)) {
      if (!(await confirmDestructive({ title: `${label} ${c.name} ?`, body: `Le projet « ${p.name} » est verrouillé.`, confirmLabel: label, name: p.name, locked }))) return false;
    } else if (body && !(await ask({ title: `${label} ${c.name} ?`, body, confirmLabel: label, danger }))) return false;
    setBusy(c.id);
    try {
      await api.dockerAction(serverId, c.id, action);
      notify(`${c.name} : ${label.toLowerCase()} OK`, "success");
      await reload();
      return true;
    } catch (e) {
      notify(errorMessage(e), "error");
      return false;
    } finally {
      setBusy(null);
    }
  };
  const shell = (c: Container) => openTab(serverId, { title: `${c.name} (shell)`, command: `${docker} exec -it ${shellQuote(c.id)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'` });
  const logs = (c: Container) => openContainerLogs(serverId, docker, c);
  return { busy, act, shell, logs };
}

/** Tiroir de logs d'un conteneur ; le menu ⋯ garde l'ancien `docker logs -f` dans un terminal. */
export function openContainerLogs(serverId: string, docker: string, c: Container) {
  openLogs({
    serverId,
    kind: "conteneur",
    name: c.name,
    sources: [{ kind: "docker", name: c.name }],
    terminal: () => useApp.getState().openTab(serverId, { title: `${c.name} (logs)`, command: `${docker} logs -f --tail 300 ${shellQuote(c.id)}` }),
  });
}

/** Limite de sources d'un suivi (`logs_start`). */
const MAX_SOURCES = 12;

/** Tiroir de logs de tous les services d'un projet compose (ancien `compose logs -f` au menu ⋯). */
export function openComposeLogs(serverId: string, docker: string, p: ComposeProject, containers: Container[]) {
  const names = containers.map((c) => c.name);
  openLogs({
    serverId,
    kind: "projet",
    name: p.name,
    sources: names.slice(0, MAX_SOURCES).map((name) => ({ kind: "docker" as const, name })),
    skipped: Math.max(0, names.length - MAX_SOURCES),
    terminal: async () => {
      try {
        const command = (await api.composeCommand(p, "logs -f --tail 200")).replace(/^docker /, `${docker} `);
        useApp.getState().openTab(serverId, { title: `${p.name} (logs)`, command });
      } catch (e) {
        useApp.getState().notify(errorMessage(e), "error");
      }
    },
  });
}

/**
 * Dossiers de conteneurs d'un serveur : ceux créés (même vides) et ceux déjà attribués.
 * Le classement est propre à ce PC (il ne change rien sur le serveur).
 */
export function useContainerFolders(serverId: string) {
  return useItemFolders("containers", serverId);
}

export function stateTone(state: string): Tone {
  return state === "running" ? "ok" : state === "restarting" || state === "paused" ? "warn" : state === "dead" ? "danger" : "muted";
}

