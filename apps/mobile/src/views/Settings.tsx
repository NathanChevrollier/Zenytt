import { useState } from "react";
import { api, errorMessage } from "../lib/api";
import { ago } from "../lib/format";
import { usePolled } from "../lib/hooks";
import { JoinSheet } from "./JoinSheet";

export function SettingsView({ onChanged }: { onChanged: () => void }) {
  const { data: sync, refresh } = usePolled(() => api.syncConfig(), 60000, []);
  const [joining, setJoining] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const resync = async () => {
    setMessage("Synchronisation…");
    try {
      await api.syncNow();
      setMessage("Synchronisé.");
      onChanged();
      refresh();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  return (
    <>
      <div className="header">
        <h1>Réglages</h1>
      </div>
      <div className="screen">
        <div className="section-title">Synchronisation avec le PC</div>
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sync?.mode === "server" ? (
            <div>Liée à Zenytt sur ton PC{sync.lastSync ? ` · dernière synchronisation ${ago(sync.lastSync)}` : ""}.</div>
          ) : (
            <div className="muted">Pas encore liée. Dans Zenytt sur le PC : Réglages → Synchronisation → code d'appairage.</div>
          )}
          {message && <div className="muted">{message}</div>}
          <div className="btn-row">
            <button className="btn primary" onClick={() => setJoining(true)}>
              {sync?.mode === "server" ? "Changer de code" : "Rejoindre avec un code"}
            </button>
            {sync?.mode === "server" && (
              <button className="btn" onClick={() => void resync()}>
                Synchroniser
              </button>
            )}
          </div>
        </div>
        <div className="section-title">À savoir</div>
        <div className="card muted">
          Les mots de passe et clés sont rangés dans le stockage privé de l'app (protégé par le système), pas dans le trousseau Android / iOS. Pas de surveillance
          en arrière-plan : les connexions SSH sont reprises à l'ouverture de l'app.
        </div>
      </div>
      {joining && (
        <JoinSheet
          onClose={() => setJoining(false)}
          onDone={() => {
            setJoining(false);
            onChanged();
            refresh();
          }}
        />
      )}
    </>
  );
}
