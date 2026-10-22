import { Power } from "lucide-react";
import { useState } from "react";
import { api, type Server } from "../lib/api";
import { ago, formatBytes, formatUptime, percent } from "../lib/format";
import { usePolled } from "../lib/hooks";
import { Confirm, Gauge, ProblemCard } from "../ui";

export function Dashboard({ server, onEdit }: { server: Server; onEdit: () => void }) {
  const [rebooting, setRebooting] = useState(false);
  const { data, error, refresh } = usePolled(() => api.summary(server.id), 5000, [server.id]);
  const problem = error ?? data?.error ?? null;
  const m = data?.metrics;
  const disk = m?.disks.filter((d) => !d.readOnly && !d.ignored).sort((a, b) => percent(b.used, b.total) - percent(a.used, a.total))[0];

  return (
    <div className="screen">
      {problem && <ProblemCard serverId={server.id} error={problem} onRetry={refresh} onEdit={onEdit} />}
      {!m && !problem && <div className="muted">Connexion…</div>}
      {m && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Gauge label={`CPU (${m.cpuCount} cœurs)`} value={m.cpuPercent} />
          <Gauge label="Mémoire" value={percent(m.memUsed, m.memTotal)} detail={`${formatBytes(m.memUsed)} / ${formatBytes(m.memTotal)}`} />
          {disk && (
            <Gauge label={`Disque ${disk.mount}`} value={percent(disk.used, disk.total)} detail={`${formatBytes(disk.used)} / ${formatBytes(disk.total)}`} />
          )}
          <div className="gauge">
            <div className="head">
              <span>Charge</span>
              <span className="muted mono">{m.load.map((l) => l.toFixed(2)).join("  ")}</span>
            </div>
            <div className="head">
              <span>Disponibilité</span>
              <span className="muted">{formatUptime(m.uptimeSecs)}</span>
            </div>
          </div>
        </div>
      )}
      {data?.connected && (
        <>
          <div className="section-title">Agent zenyttd</div>
          {!data.agent && <div className="muted">Non installé : les mesures viennent d'un relevé direct. L'agent (installé depuis Zenytt sur le PC) ajoute les alertes.</div>}
          {data.agent && data.alerts.length === 0 && <div className="card">Aucune alerte en cours.</div>}
          {data.alerts.map((a) => (
            <div key={a.key} className="card warn">
              <b>{a.title}</b>
              <div className="muted">{a.message}</div>
              <div className="muted">{ago(a.since)}</div>
            </div>
          ))}
        </>
      )}
      <div className="section-title">Serveur</div>
      <button className="btn danger" onClick={() => setRebooting(true)}>
        <Power size={18} /> Redémarrer le serveur
      </button>
      {rebooting && (
        <Confirm
          title={`Redémarrer « ${server.name} » ?`}
          message="Les sites et conteneurs seront coupés le temps du redémarrage. Tape le nom du serveur pour confirmer."
          initial=""
          label="Redémarrer"
          danger
          onConfirm={async (typed) => {
            if (typed.trim() !== server.name) throw new Error("Le nom saisi ne correspond pas.");
            await api.reboot(server.id);
          }}
          onClose={() => setRebooting(false)}
        />
      )}
    </div>
  );
}
