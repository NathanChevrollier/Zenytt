import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { api, errorMessage, type ServerUser } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, ErrorState, Field, IconButton, Loading, Modal, Textarea } from "../../components/ui";
import { useCachedState } from "../../lib/cache";

export default function Access({ serverId, onCount }: { serverId: string; onCount?: (n: number) => void }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [users, setUsers] = useCachedState<ServerUser[] | null>(`users:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Compte pour lequel on colle une clé publique. */
  const [adding, setAdding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await api.accessUsers(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);
  const count = users?.length;
  useEffect(() => {
    if (count != null) onCount?.(count);
  }, [count, onCount]);

  const addKey = async (user: string, key: string) => {
    await api.accessAddKey(serverId, user, key.trim());
    notify(`Clé ajoutée pour ${user}`, "success");
    setAdding(null);
    await load();
  };

  if (error && !users) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!users) return <Loading label="Lecture des comptes…" rows={4} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        Comptes avec un shell (root compris) et leurs clés SSH autorisées.
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>
      {users.map((u) => (
        <section key={u.name} className="rounded-xl border border-border bg-panel">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <UserRound size={14} />
            <span className="font-medium">{u.name}</span>
            {u.admin && (
              <Badge tone={u.uid === 0 ? "danger" : "warn"}>
                <ShieldCheck size={11} className="mr-1" /> {u.uid === 0 ? "root" : "sudo"}
              </Badge>
            )}
            <span className="min-w-0 truncate text-xs text-muted">
              {u.home} · {u.shell} · dernière connexion : {u.lastLogin || "inconnue"}
            </span>
            <Button size="sm" className="ml-auto" icon={<Plus size={13} />} onClick={() => setAdding(u.name)}>
              Autoriser une clé
            </Button>
          </header>
          {u.keys.length === 0 ? (
            <p className="px-4 py-2.5 text-[13px] text-muted">Aucune clé SSH : connexion par mot de passe uniquement (si autorisée).</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {u.keys.map((k) => (
                <li key={k.line} className="flex items-center gap-3 px-4 py-1.5 text-[13px]">
                  <KeyRound size={14} className={k.current ? "text-accent" : "text-muted"} />
                  <span className="w-28 font-mono text-xs">{k.algorithm}</span>
                  {/* Commentaire, empreinte et options en colonnes quand la place le permet. */}
                  <span className="flex min-w-0 flex-1 flex-col @4xl:flex-row @4xl:items-center @4xl:gap-4">
                    <span className="truncate @4xl:flex-1">{k.comment || <span className="text-muted">(sans commentaire)</span>}</span>
                    <span className="truncate font-mono text-[11px] text-muted @4xl:flex-[1.4]" title={k.fingerprint}>
                      {k.fingerprint}
                    </span>
                    {k.options && <span className="truncate font-mono text-[11px] text-warn @4xl:flex-1" title={k.options}>{k.options}</span>}
                  </span>
                  {k.current && <Badge tone="accent">clé de Zenytt</Badge>}
                  {!k.current && (
                    <IconButton
                      title="Retirer cette clé"
                      onClick={async () => {
                        const ok = await ask({
                          title: `Retirer cette clé de ${u.name} ?`,
                          body: "La personne ou la machine qui l'utilise ne pourra plus se connecter. Une copie de l'ancien fichier est gardée (authorized_keys.zenytt-avant).",
                          code: `${k.algorithm} ${k.fingerprint} ${k.comment}`,
                          confirmLabel: "Retirer",
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await api.accessRemoveKey(serverId, u.name, k.line);
                          notify("Clé retirée", "success");
                          await load();
                        } catch (e) {
                          notify(errorMessage(e), "error");
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {adding && <AddKeyDialog user={adding} onClose={() => setAdding(null)} onAdd={(k) => addKey(adding, k)} />}
    </div>
  );
}

const KEY_RE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)\s+[A-Za-z0-9+/=]{40,}(\s+.*)?$/;

/** Clé publique collée dans une zone multiligne : une clé RSA ne tient pas dans un champ d'une ligne. */
function AddKeyDialog({ user, onClose, onAdd }: { user: string; onClose: () => void; onAdd: (key: string) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = key.trim().replace(/\s*\n\s*/g, " ");
  const isPrivate = /PRIVATE KEY/.test(key);
  const valid = KEY_RE.test(clean);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdd(clean);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Autoriser une clé SSH pour ${user}`}
      description="Colle la clé PUBLIQUE (fichier .pub). Jamais la clé privée."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void submit()}>
            Autoriser
          </Button>
        </>
      }
    >
      <Field
        label="Clé publique"
        error={isPrivate ? "C'est une clé PRIVÉE : ne la colle nulle part. Utilise le fichier .pub correspondant." : error ?? (key.trim() && !valid ? "Format attendu : ssh-ed25519 AAAA… commentaire" : null)}
      >
        <Textarea autoFocus rows={5} className="font-mono text-xs break-all" placeholder="ssh-ed25519 AAAAC3Nza… moi@portable" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
    </Modal>
  );
}
