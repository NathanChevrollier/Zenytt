import { useState } from "react";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { api, errorMessage, type Server } from "../lib/api";
import { JoinSheet } from "./JoinSheet";

export function ServersView({
  servers,
  onOpen,
  onAdd,
  onChanged,
}: {
  servers: Server[];
  onOpen: (s: Server) => void;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const [joining, setJoining] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await api.syncNow();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <div className="header">
        <h1>Serveurs</h1>
        <button className="btn icon" aria-label="Synchroniser avec le PC" disabled={syncing} onClick={() => void sync()}>
          <RefreshCw size={20} />
        </button>
        <button className="btn icon" aria-label="Ajouter un serveur" onClick={onAdd}>
          <Plus size={22} />
        </button>
      </div>
      <div className="screen">
        {error && <div className="card danger error">{error}</div>}
        {servers.length === 0 && (
          <div className="card">
            <b>Aucun serveur</b>
            <p className="muted">Récupère tes serveurs depuis Zenytt sur ton PC (Réglages → Synchronisation → code d'appairage), ou ajoute-en un à la main.</p>
            <div className="btn-row">
              <button className="btn primary" onClick={() => setJoining(true)}>
                Rejoindre avec un code
              </button>
              <button className="btn" onClick={onAdd}>
                Ajouter à la main
              </button>
            </div>
          </div>
        )}
        {servers.map((s) => (
          <button key={s.id} className="row" onClick={() => onOpen(s)}>
            <span className={`dot ${s.authReady ? "" : "warn"}`} />
            <span className="grow">
              <div className="title">{s.name}</div>
              <div className="sub">
                {s.username}@{s.host}
                {s.port !== 22 ? `:${s.port}` : ""}
                {s.authReady ? "" : " · identifiants à saisir"}
              </div>
            </span>
            <ChevronRight size={18} className="muted" />
          </button>
        ))}
      </div>
      {joining && (
        <JoinSheet
          onClose={() => setJoining(false)}
          onDone={() => {
            setJoining(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}
