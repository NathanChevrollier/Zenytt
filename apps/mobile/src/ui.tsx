// Petit jeu de composants du téléphone : gabarits tactiles (44 px minimum), feuille du bas, jauge.
import { useState, type ReactNode } from "react";
import { api, errorMessage } from "./lib/api";
import { classify } from "./lib/errors";

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Confirmation (ou saisie d'un texte si `initial` est fourni) avant une action. */
export function Confirm({
  title,
  message,
  initial,
  label,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message?: string;
  initial?: string;
  label: string;
  danger?: boolean;
  onConfirm: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(value);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={title} onClose={onClose}>
      {message && <div className="muted">{message}</div>}
      {initial !== undefined && (
        <label className="field">
          <input value={value} onChange={(e) => setValue(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="btn-row">
        <button className="btn" onClick={onClose}>
          Annuler
        </button>
        <button className={`btn ${danger ? "danger" : "primary"}`} disabled={busy || (initial !== undefined && !value.trim())} onClick={() => void run()}>
          {label}
        </button>
      </div>
    </Sheet>
  );
}

export function Gauge({ label, value, detail }: { label: string; value: number; detail?: string }) {
  const level = value >= 90 ? "danger" : value >= 75 ? "warn" : "";
  return (
    <div className="gauge">
      <div className="head">
        <span>{label}</span>
        <span className="muted">{detail ?? `${value.toFixed(0)} %`}</span>
      </div>
      <div className="bar" role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <div className={level} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}

/**
 * Affiche l'erreur d'un serveur avec l'action qu'elle appelle : approuver une clé d'hôte inconnue,
 * relancer après un refus d'authentification, ou corriger les identifiants.
 */
export function ProblemCard({
  serverId,
  error,
  onRetry,
  onEdit,
}: {
  serverId: string;
  error: string;
  onRetry: () => void;
  onEdit?: () => void;
}) {
  const problem = classify(error);
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
    onRetry();
  };
  return (
    <div className="card danger">
      {problem.kind === "unknownHost" && (
        <>
          <b>Premier contact avec ce serveur</b>
          <p className="muted">Vérifie que cette empreinte est bien la sienne avant de continuer.</p>
          <p className="mono" style={{ overflowWrap: "anywhere" }}>
            {problem.fingerprint}
          </p>
          <button className="btn primary" disabled={busy} onClick={() => void act(() => api.trustHost(serverId, problem.fingerprint))}>
            Faire confiance
          </button>
        </>
      )}
      {problem.kind === "hostChanged" && (
        <>
          <b>La clé du serveur a changé</b>
          <p className="muted">Quelqu'un se fait peut-être passer pour lui. Vérifie depuis le PC avant de continuer : la connexion est refusée.</p>
        </>
      )}
      {problem.kind === "needAuth" && (
        <>
          <b>Identifiants manquants sur ce téléphone</b>
          <p className="muted">{problem.message}</p>
          {onEdit && (
            <button className="btn primary" onClick={onEdit}>
              Saisir les identifiants
            </button>
          )}
        </>
      )}
      {problem.kind === "authFailed" && (
        <>
          <b>Authentification refusée</b>
          <p className="error">{problem.message}</p>
          <div className="btn-row">
            {onEdit && (
              <button className="btn" onClick={onEdit}>
                Modifier
              </button>
            )}
            <button className="btn primary" disabled={busy} onClick={() => void act(() => api.retry(serverId))}>
              Réessayer
            </button>
          </div>
        </>
      )}
      {problem.kind === "other" && (
        <>
          <p className="error">{problem.message}</p>
          <button className="btn" disabled={busy} onClick={() => void act(() => api.retry(serverId))}>
            Réessayer
          </button>
        </>
      )}
    </div>
  );
}
