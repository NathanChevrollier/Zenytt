import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { IdCard, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { create } from "zustand";
import { api, errorMessage, type AuthKind, type Identity, type IdentityView } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, Segmented } from "./ui";

/** Banque d'identifiants, partagée par la liste et les formulaires de serveurs. */
export const useIdentities = create<{ list: IdentityView[]; reload: () => Promise<void> }>((set) => ({
  list: [],
  reload: async () => set({ list: await api.identities() }),
}));

export const AUTH_LABELS: Record<AuthKind, string> = { password: "mot de passe", key: "clé privée", agent: "agent SSH" };

/** Ligne d'un identifiant, comme dans un gestionnaire de mots de passe : nom, utilisateur, secret masqué. */
function IdentityLine({ i }: { i: IdentityView }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <IdCard size={15} className="shrink-0 text-muted" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{i.name}</span>
        <span className="block truncate font-mono text-[11px] text-muted">
          {i.username}, {i.authKind === "password" ? (i.hasPassword ? "••••••••" : "mot de passe demandé") : AUTH_LABELS[i.authKind]}
        </span>
      </span>
    </span>
  );
}

/** Identifiants dont le nom ou l'utilisateur contient le texte tapé. */
export function filterIdentities(list: IdentityView[], filter: string): IdentityView[] {
  const f = filter.trim().toLowerCase();
  return list.filter((i) => !f || i.name.toLowerCase().includes(f) || i.username.toLowerCase().includes(f));
}

/**
 * Menu déroulant des identifiants sous le champ « Utilisateur » d'un serveur : un clic lie le
 * serveur à l'identifiant (utilisateur et secrets pris dans la banque).
 */
export function IdentitySuggestions({ filter, onPick, onClose, index = -1 }: { filter: string; onPick: (i: IdentityView) => void; onClose: () => void; index?: number }) {
  const list = useIdentities((s) => s.list);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  const shown = filterIdentities(list, filter);
  if (!shown.length) return null;
  return (
    <div ref={ref} role="listbox" aria-label="Identifiants enregistrés" className="animate-pop-in absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-auto rounded-xl border border-border-strong bg-raised p-1 shadow-2xl">
      <div className="px-2.5 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">Identifiants enregistrés</div>
      {shown.map((i, n) => (
        <button
          type="button"
          role="option"
          aria-selected={n === index}
          key={i.id}
          className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left hover:bg-hover-strong ${n === index ? "bg-hover-strong" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(i)}
        >
          <IdentityLine i={i} />
        </button>
      ))}
    </div>
  );
}

/** Identifiants de la banque, dans le tiroir « Identifiants » de la page Serveurs. */
export function IdentitiesPanel({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (v: boolean) => void }) {
  const { list, reload } = useIdentities();
  const { notify, ask } = useApp.getState();
  const [edited, setEditing] = useState<IdentityView | null>(null);
  const editing: IdentityView | "new" | null = creating ? "new" : edited;
  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (i: IdentityView) => {
    const ok = await ask({ title: `Supprimer « ${i.name} » ?`, body: "L'identifiant et ses secrets seront supprimés de ce PC.", confirmLabel: "Supprimer", danger: true });
    if (!ok) return;
    try {
      await api.identityDelete(i.id);
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <>
      {list.length === 0 ? (
        <EmptyState
          icon={<IdCard />}
          title="Aucun identifiant"
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => onCreatingChange(true)}>
              Nouvel identifiant
            </Button>
          }
        >
          Enregistre une fois un utilisateur et son secret (« root du VPS », « admin Unraid »…), puis choisis-le dans chaque serveur qui l'utilise. Le changer ici le change partout.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {list.map((i) => (
            <Card key={i.id} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <IdentityLine i={i} />
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge>{AUTH_LABELS[i.authKind]}</Badge>
                  {i.usedBy.length > 0 ? <Badge tone="accent">{i.usedBy.length} serveur(s)</Badge> : <Badge>inutilisé</Badge>}
                </div>
              </div>
              <div className="flex">
                <IconButton title="Modifier" onClick={() => setEditing(i)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton title={i.usedBy.length ? `Utilisé par ${i.usedBy.join(", ")}` : "Supprimer"} disabled={i.usedBy.length > 0} onClick={() => void remove(i)}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <IdentityForm
          identity={editing === "new" ? null : editing}
          onClose={() => {
            setEditing(null);
            onCreatingChange(false);
          }}
          onSaved={() => {
            setEditing(null);
            onCreatingChange(false);
            void reload();
            void useApp.getState().refreshServers();
          }}
        />
      )}
    </>
  );
}

function IdentityForm({ identity, onClose, onSaved }: { identity: IdentityView | null; onClose: () => void; onSaved: (id: string) => void }) {
  const notify = useApp((s) => s.notify);
  const [p, setP] = useState<Identity>(identity ? { id: identity.id, name: identity.name, username: identity.username, authKind: identity.authKind, keyPath: identity.keyPath } : { id: "", name: "", username: "root", authKind: "password", keyPath: null });
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Identity>(k: K, v: Identity[K]) => setP((prev) => ({ ...prev, [k]: v }));
  const kept = (has: boolean | undefined) => (has ? "Déjà enregistré : laisse vide pour le conserver." : undefined);

  const save = async () => {
    setSaving(true);
    try {
      const id = await api.identitySave(p, { password: password || undefined, passphrase: passphrase || undefined });
      onSaved(id);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={identity ? `Modifier ${identity.name}` : "Nouvel identifiant"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} disabled={!p.username.trim()} onClick={() => void save()}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Nom">
            <Input value={p.name} placeholder="root du VPS" onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
          <Field label="Utilisateur">
            <Input value={p.username} onChange={(e) => set("username", e.target.value)} />
          </Field>
        </div>
        <Field label="Authentification">
          <Segmented
            label="Authentification"
            value={p.authKind}
            onChange={(k) => set("authKind", k)}
            className="self-start"
            options={[
              { value: "password", label: "Mot de passe" },
              { value: "key", label: "Clé privée" },
              { value: "agent", label: "Agent SSH / Pageant" },
            ]}
          />
        </Field>
        {p.authKind === "password" && (
          <Field label="Mot de passe" hint={kept(identity?.hasPassword) ?? "Laisse vide pour qu'il soit demandé à la première connexion."}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        {p.authKind !== "password" && (
          <Field label={p.authKind === "key" ? "Clé privée" : "Clé à utiliser dans l'agent (optionnel)"} hint="Formats OpenSSH et PuTTY (.ppk) acceptés.">
            <div className="flex gap-2">
              <Input value={p.keyPath ?? ""} placeholder="~/.ssh/id_ed25519" onChange={(e) => set("keyPath", e.target.value || null)} />
              <Button
                type="button"
                icon={<KeyRound size={14} />}
                onClick={async () => {
                  const file = await open({ title: "Choisir une clé privée", multiple: false, directory: false });
                  if (typeof file === "string") set("keyPath", file);
                }}
              >
                Parcourir
              </Button>
            </div>
          </Field>
        )}
        {p.authKind === "key" && (
          <Field label="Passphrase (si la clé est chiffrée)" hint={kept(identity?.hasPassphrase)}>
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
