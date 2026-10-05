// Éléments partagés par les onglets de la page Docker.
import { useState } from "react";
import { api, errorMessage, shellQuote, type Container, type ContainerStats } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { useItemFolders } from "../../lib/folders";
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
export function useContainerActions(serverId: string, docker: string, reload: () => Promise<void>) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
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
    if (body && !(await ask({ title: `${label} ${c.name} ?`, body, confirmLabel: label, danger }))) return false;
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
  const logs = (c: Container) => openTab(serverId, { title: `${c.name} (logs)`, command: `${docker} logs -f --tail 300 ${shellQuote(c.id)}` });
  return { busy, act, shell, logs };
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

