import { api, type Server, type Summary } from "../lib/api";
import { ago } from "../lib/format";
import { usePolled } from "../lib/hooks";

/** Alertes de l'agent zenyttd de chaque serveur (relevées tant que cet écran est visible), et serveurs injoignables. */
export function AlertsView({ servers, onOpen }: { servers: Server[]; onOpen: (s: Server) => void }) {
  const { data } = usePolled(
    async () => {
      // Serveurs dont l'authentification est impossible depuis ce téléphone : inutile de les solliciter.
      const ready = servers.filter((s) => s.authReady);
      return Promise.all(ready.map(async (s): Promise<[Server, Summary | null]> => [s, await api.summary(s.id).catch(() => null)]));
    },
    30000,
    [servers],
  );
  const items = data ?? [];
  const alerting = items.filter(([, sum]) => sum && sum.alerts.length > 0);
  const down = items.filter(([, sum]) => !sum || !sum.connected);

  return (
    <>
      <div className="header">
        <h1>Alertes</h1>
      </div>
      <div className="screen">
        {data && alerting.length === 0 && down.length === 0 && <div className="card">Tout va bien : aucune alerte en cours.</div>}
        {down.map(([s, sum]) => (
          <button key={s.id} className="row" onClick={() => onOpen(s)}>
            <span className="dot danger" />
            <span className="grow">
              <div className="title">{s.name}</div>
              <div className="sub">{sum?.error ?? "injoignable"}</div>
            </span>
          </button>
        ))}
        {alerting.map(([s, sum]) =>
          sum!.alerts.map((a) => (
            <button key={`${s.id}:${a.key}`} className="row" onClick={() => onOpen(s)}>
              <span className="dot warn" />
              <span className="grow">
                <div className="title">
                  {s.name} · {a.title}
                </div>
                <div className="sub">
                  {a.message} · {ago(a.since)}
                </div>
              </span>
            </button>
          )),
        )}
        <div className="muted">Sans surveillance continue : le téléphone ne relève les alertes que lorsque cet écran est ouvert. Pour être prévenu à tout moment, utilise les notifications ntfy de l'agent.</div>
      </div>
    </>
  );
}
