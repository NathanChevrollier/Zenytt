import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { errorMessage } from "./api";

/**
 * Exécute `task` tout de suite puis toutes les `intervalMs`, tant que l'écran est visible (iOS coupe
 * les connexions d'une app en arrière-plan : on se contente de reprendre au retour).
 * Jamais deux exécutions en même temps.
 */
export function usePolling(task: () => Promise<unknown>, intervalMs: number, deps: DependencyList) {
  const ref = useRef(task);
  ref.current = task;
  useEffect(() => {
    let busy = false;
    let stopped = false;
    const tick = async () => {
      if (busy || stopped || document.hidden) return;
      busy = true;
      try {
        await ref.current();
      } catch {
        /* erreurs traitées par la tâche */
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}

/** Donnée rafraîchie en continu : garde la dernière valeur lue pendant qu'une erreur éventuelle s'affiche. */
export function usePolled<T>(load: () => Promise<T>, intervalMs: number, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  usePolling(
    async () => {
      try {
        setData(await load());
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    intervalMs,
    [version, ...deps],
  );
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, refresh };
}

/**
 * Hauteur réellement visible (clavier exclu) dans `--vvh`, et classe `kbd` sur `<html>` quand le
 * clavier est ouvert : le terminal et sa barre de touches se calent juste au-dessus.
 */
export function useViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let max = vv.height;
    const update = () => {
      max = Math.max(max, vv.height);
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
      document.documentElement.classList.toggle("kbd", vv.height < max - 150);
      window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
}
