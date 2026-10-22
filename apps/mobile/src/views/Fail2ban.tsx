import { useState } from "react";
import { api, type Server } from "../lib/api";
import { usePolled } from "../lib/hooks";
import { Confirm, ProblemCard } from "../ui";

export function Fail2ban({ server, onEdit }: { server: Server; onEdit: () => void }) {
  const { data, error, refresh } = usePolled(() => api.fail2ban(server.id), 15000, [server.id]);
  const [target, setTarget] = useState<{ jail: string; ip: string } | null>(null);

  return (
    <div className="screen">
      {error && <ProblemCard serverId={server.id} error={error} onRetry={refresh} onEdit={onEdit} />}
      {data && !data.installed && <div className="card">fail2ban n'est pas installé sur ce serveur.</div>}
      {data && data.installed && !data.running && <div className="card warn">fail2ban est installé mais ne tourne pas.</div>}
      {data?.jails.map((j) => (
        <div key={j.name} className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <b>{j.name}</b>
          <span className="muted">
            {j.currentlyBanned} bannie{j.currentlyBanned > 1 ? "s" : ""} · {j.totalBanned} au total
          </span>
          {j.banned.map((ip) => (
            <div key={ip} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ flex: 1 }}>
                {ip}
              </span>
              <button className="btn" onClick={() => setTarget({ jail: j.name, ip })}>
                Débannir
              </button>
            </div>
          ))}
        </div>
      ))}
      {target && (
        <Confirm
          title={`Débannir ${target.ip} ?`}
          message={`Jail ${target.jail}. L'adresse pourra se reconnecter, et être bannie de nouveau si elle échoue encore.`}
          label="Débannir"
          onConfirm={() => api.unban(server.id, target.jail, target.ip).then(refresh)}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}
