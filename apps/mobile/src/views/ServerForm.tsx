import { useState } from "react";
import { api, errorMessage, type AuthKind, type Server } from "../lib/api";
import { Confirm, Sheet } from "../ui";

/** Ajout à la main d'un serveur, ou saisie des identifiants d'un serveur récupéré du PC. */
export function ServerForm({
  server,
  onSaved,
  onDeleted,
  onClose,
}: {
  server: Server | null;
  onSaved: () => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "root");
  const [authKind, setAuthKind] = useState<AuthKind>(server?.authKind === "key" ? "key" : "password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [sudo, setSudo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveServer({
        id: server?.id,
        name,
        host,
        port: Number(port),
        username,
        authKind,
        // Un champ laissé vide ne change rien au secret déjà enregistré.
        password: authKind === "password" && password ? password : undefined,
        privateKey: authKind === "key" && privateKey ? privateKey : undefined,
        passphrase: authKind === "key" && passphrase ? passphrase : undefined,
        sudoPassword: sudo || undefined,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title={server ? "Modifier le serveur" : "Ajouter un serveur"} onClose={onClose}>
      <label className="field">
        Nom
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mon VPS" />
      </label>
      <label className="field">
        Hôte
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.10" inputMode="url" autoCapitalize="off" autoCorrect="off" />
      </label>
      <div className="btn-row">
        <label className="field" style={{ flex: 1 }}>
          Port
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </label>
        <label className="field" style={{ flex: 2 }}>
          Utilisateur
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
      </div>
      <label className="field">
        Authentification
        <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)}>
          <option value="password">Mot de passe</option>
          <option value="key">Clé privée</option>
        </select>
      </label>
      {authKind === "password" ? (
        <label className="field">
          Mot de passe {server?.authReady && "(laisser vide pour garder l'actuel)"}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      ) : (
        <>
          <label className="field">
            Clé privée (à coller) {server?.authReady && "(laisser vide pour garder l'actuelle)"}
            <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="field">
            Phrase de passe de la clé (si elle en a une)
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </label>
        </>
      )}
      <label className="field">
        Mot de passe sudo (optionnel, pour Docker et fail2ban)
        <input type="password" value={sudo} onChange={(e) => setSudo(e.target.value)} />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="btn-row">
        {server && (
          <button className="btn danger" onClick={() => setDeleting(true)}>
            Supprimer
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Annuler
        </button>
        <button className="btn primary" disabled={busy || !host.trim() || !username.trim()} onClick={() => void save()}>
          Enregistrer
        </button>
      </div>
      {deleting && server && (
        <Confirm
          title={`Supprimer « ${server.name} » ?`}
          message="Retire le serveur et ses secrets de ce téléphone. Rien n'est supprimé sur le serveur ni sur le PC."
          label="Supprimer"
          danger
          onConfirm={() => api.deleteServer(server.id).then(onDeleted)}
          onClose={() => setDeleting(false)}
        />
      )}
    </Sheet>
  );
}
