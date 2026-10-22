import { useState } from "react";
import { api, errorMessage, type Container, type Server } from "../lib/api";
import { usePolled } from "../lib/hooks";
import { Confirm, ProblemCard, Sheet } from "../ui";

const FAILURES = ["unhealthy", "crashLoop", "crashed", "outOfMemory"];

function dot(c: Container) {
  return FAILURES.includes(c.condition) ? "danger" : c.state === "running" ? "ok" : "";
}

export function Containers({ server, onEdit }: { server: Server; onEdit: () => void }) {
  const { data, error, refresh } = usePolled(() => api.containers(server.id), 10000, [server.id]);
  const [selected, setSelected] = useState<Container | null>(null);

  return (
    <div className="screen">
      {error && <ProblemCard serverId={server.id} error={error} onRetry={refresh} onEdit={onEdit} />}
      {data && !data.available && <div className="card">Docker n'est pas installé sur ce serveur, ou l'utilisateur n'a pas le droit de l'utiliser.</div>}
      {data?.containers.map((c) => (
        <button key={c.id} className="row" onClick={() => setSelected(c)}>
          <span className={`dot ${dot(c)}`} />
          <span className="grow">
            <div className="title">{c.name}</div>
            <div className="sub">{c.status}</div>
          </span>
        </button>
      ))}
      {data?.available && data.containers.length === 0 && <div className="muted">Aucun conteneur.</div>}
      {selected && <ContainerSheet server={server} container={selected} onClose={() => setSelected(null)} onChanged={refresh} />}
    </div>
  );
}

function ContainerSheet({ server, container: c, onClose, onChanged }: { server: Server; container: Container; onClose: () => void; onChanged: () => void }) {
  const [confirm, setConfirm] = useState<"stop" | "restart" | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = c.state === "running";

  const run = async (action: "start" | "stop" | "restart") => {
    await api.containerAction(server.id, c.id, action);
    onChanged();
  };
  const showLogs = async () => {
    setBusy(true);
    setError(null);
    try {
      setLogs(await api.containerLogs(server.id, c.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (confirm) {
    const verb = confirm === "stop" ? "Arrêter" : "Redémarrer";
    return <Confirm title={`${verb} « ${c.name} » ?`} label={verb} danger={confirm === "stop"} onConfirm={() => run(confirm)} onClose={onClose} />;
  }
  return (
    <Sheet title={c.name} onClose={onClose}>
      <div className="muted">
        {c.image} · {c.status}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="btn-row">
        {running ? (
          <>
            <button className="btn" onClick={() => setConfirm("restart")}>
              Redémarrer
            </button>
            <button className="btn danger" onClick={() => setConfirm("stop")}>
              Arrêter
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={() => void run("start").then(onClose).catch((e) => setError(errorMessage(e)))}>
            Démarrer
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => void showLogs()}>
          Journaux
        </button>
      </div>
      {logs !== null && <pre className="logs">{logs || "(vide)"}</pre>}
    </Sheet>
  );
}
