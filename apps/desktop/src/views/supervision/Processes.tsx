import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Search, Skull, X } from "lucide-react";
import { api, errorMessage, formatBytes, formatDuration, type Process } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { usePolling } from "../../lib/poll";
import { writeClipboard } from "../../lib/clipboard";
import { DataTable, ErrorState, IconButton, Input, type Column } from "../../components/ui";
import { useCachedState } from "../../lib/cache";

export default function Processes({ serverId, visible, onCount }: { serverId: string; visible: boolean; onCount?: (n: number) => void }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [list, setList] = useCachedState<Process[]>(`processes:${serverId}`, []);
  const [filter, setFilter] = useState("");
  // Affichée dans la vue (et non en notification, qui se répéterait à chaque actualisation).
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.processes(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId]);

  usePolling(load, 5000, [serverId], visible);
  useEffect(() => onCount?.(list.length), [list.length, onCount]);

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    return list.filter((p) => !f || p.command.toLowerCase().includes(f) || p.user.toLowerCase().includes(f) || String(p.pid) === f);
  }, [list, filter]);

  const kill = async (p: Process, force: boolean) => {
    const ok = await ask({
      title: force ? `Forcer l'arrêt de ${p.name} (PID ${p.pid}) ?` : `Arrêter ${p.name} (PID ${p.pid}) ?`,
      body: force ? "SIGKILL tue le processus immédiatement, sans lui laisser le temps de se terminer proprement." : "SIGTERM demande au processus de s'arrêter proprement.",
      code: p.command,
      confirmLabel: force ? "Forcer (SIGKILL)" : "Arrêter (SIGTERM)",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.kill(serverId, p.pid, force);
      notify(`Signal envoyé à ${p.pid}`, "success");
      void load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const columns: Column<Process>[] = [
    { key: "pid", header: "PID", width: "80px", sortValue: (p) => p.pid, render: (p) => <span className="font-mono text-xs text-muted tabular-nums">{p.pid}</span> },
    { key: "user", header: "Utilisateur", width: "110px", sortValue: (p) => p.user, render: (p) => <span className="text-xs">{p.user}</span> },
    { key: "cpu", header: "CPU", width: "80px", align: "right", sortValue: (p) => p.cpu, render: (p) => <span className={`text-xs tabular-nums ${p.cpu >= 50 ? "text-warn" : ""}`}>{p.cpu.toFixed(1)} %</span> },
    { key: "mem", header: "Mém.", width: "80px", align: "right", sortValue: (p) => p.mem, render: (p) => <span className="text-xs tabular-nums">{p.mem.toFixed(1)} %</span> },
    { key: "rss", header: "RSS", width: "90px", align: "right", sortValue: (p) => p.rss, render: (p) => <span className="text-xs text-muted tabular-nums">{formatBytes(p.rss)}</span> },
    { key: "elapsed", header: "Durée", width: "100px", align: "right", sortValue: (p) => p.elapsed, render: (p) => <span className="text-xs text-muted tabular-nums">{formatDuration(p.elapsed)}</span> },
    {
      key: "command",
      header: "Commande",
      sortValue: (p) => p.name,
      render: (p) => (
        <span className="font-mono text-xs select-text" title={p.command}>
          {p.command}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-7 py-2.5">
        <label className="relative w-80">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input className="pl-8" placeholder="Filtrer : commande, utilisateur, PID" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <span className="text-xs text-muted">
          {rows.length} processus · actualisé toutes les 5 s
        </span>
      </div>
      {error && (
        <div className="px-7 pt-4">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      )}
      <DataTable
        className="min-h-0 flex-1"
        rows={rows}
        rowKey={(p) => String(p.pid)}
        columns={columns}
        rowHeight={34}
        initialSort={{ key: "cpu", dir: "desc" }}
        actionsWidth={76}
        rowActions={(p) => (
          <IconButton size="sm" title="Arrêter (SIGTERM)" onClick={() => void kill(p, false)}>
            <X size={14} />
          </IconButton>
        )}
        rowMenu={(p) => [
          { label: "Arrêter (SIGTERM)", icon: <X size={14} />, onClick: () => void kill(p, false) },
          { label: "Forcer l'arrêt (SIGKILL)", icon: <Skull size={14} />, danger: true, onClick: () => void kill(p, true) },
          "separator",
          { label: "Copier la commande", icon: <Copy size={14} />, onClick: () => void writeClipboard(p.command) },
          { label: "Copier le PID", onClick: () => void writeClipboard(String(p.pid)) },
        ]}
        empty={filter ? "Aucun processus ne correspond." : "Lecture des processus…"}
      />
    </div>
  );
}
