import { useState } from "react";
import { api, errorMessage } from "../lib/api";
import { classify } from "../lib/errors";
import { Sheet } from "../ui";

/**
 * Rejoint la synchronisation d'un PC : code d'appairage + phrase de passe, affichés dans Zenytt
 * sur le PC (Réglages → Synchronisation). En mode privé, la première connexion au serveur de
 * synchronisation demande d'approuver son empreinte SSH.
 */
export function JoinSheet({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<{ serverId: string; fingerprint: string } | null>(null);

  const finish = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onDone();
    } catch (e) {
      const msg = errorMessage(e);
      const problem = classify(msg);
      if (problem.kind === "unknownHost") {
        // Le serveur à joindre est celui du tunnel de synchronisation.
        const serverId = (await api.syncConfig().catch(() => null))?.tunnel?.serverId;
        if (serverId) setTrust({ serverId, fingerprint: problem.fingerprint });
        else setError(msg);
      } else setError(msg);
      setBusy(false);
    }
  };

  if (trust) {
    return (
      <Sheet title="Premier contact avec le serveur" onClose={onClose}>
        <div className="muted">Le code passe par ton serveur. Vérifie que cette empreinte est la sienne.</div>
        <div className="mono" style={{ overflowWrap: "anywhere" }}>
          {trust.fingerprint}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Annuler
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void finish(async () => {
                await api.trustHost(trust.serverId, trust.fingerprint);
                await api.syncNow();
              })
            }
          >
            Faire confiance
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </Sheet>
    );
  }

  return (
    <Sheet title="Rejoindre avec un code" onClose={onClose}>
      <label className="field">
        Code d'appairage (zenytt-pair:…)
        <textarea value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <label className="field">
        Phrase de passe de synchronisation
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoCapitalize="off" />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="btn-row">
        <button className="btn" onClick={onClose}>
          Annuler
        </button>
        <button className="btn primary" disabled={busy || !code.trim() || !passphrase} onClick={() => void finish(() => api.syncJoin(code, passphrase))}>
          {busy ? "Synchronisation…" : "Rejoindre"}
        </button>
      </div>
    </Sheet>
  );
}
