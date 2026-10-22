// Formulaire d'un profil de serveur, dans un tiroir : la liste reste visible derrière, et les
// champs sont rangés par thème (connexion, authentification, avancé, apparence).
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { IdCard, KeyRound, Link2Off } from "lucide-react";
import { api, errorMessage, PROTOCOL_LABELS, type Protocol, type ServerProfile, type ServerView } from "../../lib/api";
import { useApp } from "../../lib/store";
import { AUTH_LABELS, filterIdentities, IdentitySuggestions, useIdentities } from "../../components/Identities";
import { Button, Checkbox, ColorPicker, Drawer, Eyebrow, Field, Input, PROFILE_COLORS, Segmented, Select } from "../../components/ui";

function emptyProfile(): ServerProfile {
  return { id: "", name: "", host: "", port: 22, username: "root", authKind: "password", protocol: "ssh", keyPath: null, color: PROFILE_COLORS[0], group: null };
}

export default function ServerForm({ server, folders, onClose, onSaved }: { server: ServerView | null; folders: string[]; onClose: () => void; onSaved: (id: string) => void }) {
  const notify = useApp((s) => s.notify);
  const [p, setP] = useState<ServerProfile>(server ? { ...server } : emptyProfile());
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [sudo, setSudo] = useState("");
  const [saving, setSaving] = useState(false);
  const [suggest, setSuggest] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  /** Enregistrer aussi l'utilisateur et son secret dans la banque d'identifiants. */
  const [toBank, setToBank] = useState<string | null>(null);
  const set = <K extends keyof ServerProfile>(k: K, v: ServerProfile[K]) => setP((prev) => ({ ...prev, [k]: v }));
  const others = useApp((s) => s.servers).filter((s) => s.id !== server?.id);
  const identities = useIdentities((s) => s.list);
  const identity = identities.find((i) => i.id === p.identityId);
  const suggestions = filterIdentities(identities, p.username === "root" && !server ? "" : p.username);
  const protocol = p.protocol ?? "ssh";
  const ftp = protocol === "ftp" || protocol === "ftps";
  const hostError = p.host.trim() && /\s/.test(p.host.trim()) ? "L'hôte ne doit pas contenir d'espace." : undefined;
  const portError = p.port < 1 || p.port > 65535 ? "Port entre 1 et 65535." : undefined;

  // FTP/FTPS : mot de passe uniquement, ni clé ni rebond ; le port par défaut suit le protocole.
  const setProtocol = (next: Protocol) =>
    setP((prev) => {
      const toFtp = next === "ftp" || next === "ftps";
      const port = toFtp && prev.port === 22 ? 21 : !toFtp && prev.port === 21 ? 22 : prev.port;
      return toFtp ? { ...prev, protocol: next, port, authKind: "password", keyPath: null, jumpId: null } : { ...prev, protocol: next, port };
    });

  const linkIdentity = (i: (typeof identities)[number]) => {
    setP((prev) => ({ ...prev, identityId: i.id, username: i.username, authKind: i.authKind, keyPath: i.keyPath ?? null }));
    setToBank(null);
    setSuggest(false);
  };

  const save = async () => {
    if (hostError || portError) return;
    setSaving(true);
    try {
      let profile = { ...p, name: p.name.trim() || p.host.trim(), host: p.host.trim(), username: p.username.trim() };
      let secrets = { password: password || undefined, passphrase: passphrase || undefined, sudoPassword: sudo || undefined };
      if (!identity && toBank !== null) {
        // Nouvel identifiant de la banque avec ce qui vient d'être saisi, puis le serveur s'y lie.
        const id = await api.identitySave(
          { id: "", name: toBank.trim() || profile.username, username: profile.username, authKind: profile.authKind, keyPath: profile.keyPath },
          { password: secrets.password, passphrase: secrets.passphrase },
        );
        profile = { ...profile, identityId: id };
        secrets = { password: undefined, passphrase: undefined, sudoPassword: secrets.sudoPassword };
        void useIdentities.getState().reload();
      }
      const id = await api.saveServer(profile, secrets);
      onSaved(id);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const pickKey = async () => {
    const file = await open({ title: "Choisir une clé privée", multiple: false, directory: false });
    if (typeof file === "string") set("keyPath", file);
  };

  const keptHint = (has: boolean | undefined) => (has ? "Déjà enregistré : laisse vide pour le conserver." : undefined);

  return (
    <Drawer
      title={server ? `Modifier ${server.name}` : "Nouveau serveur"}
      subtitle={server ? `${server.username}@${server.host}:${server.port}` : "Les secrets sont gardés dans le coffre-fort du système, jamais dans un fichier."}
      width={540}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()} disabled={!p.host.trim() || !p.username.trim() || !!hostError || !!portError}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <section className="flex flex-col gap-4">
          <Eyebrow>Connexion</Eyebrow>
          <Field label="Nom">
            <Input value={p.name} placeholder="Mon VPS" onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
          <Field label="Protocole" hint={protocol === "sftp" ? "Pour un compte limité au transfert de fichiers (internal-sftp, chroot) : aucune commande n'est lancée." : ftp ? "Fichiers uniquement, sans SSH. FTPS chiffre la connexion (TLS explicite)." : undefined}>
            <Select value={protocol} onChange={(v) => setProtocol(v as Protocol)} options={(Object.keys(PROTOCOL_LABELS) as Protocol[]).map((k) => ({ value: k, label: PROTOCOL_LABELS[k] }))} />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
            <Field label="Hôte" error={hostError}>
              <Input className="font-mono" value={p.host} placeholder="vps.exemple.fr ou 51.xx.xx.xx" onChange={(e) => set("host", e.target.value)} />
            </Field>
            <Field label="Port" error={portError}>
              <Input className="font-mono" type="number" value={p.port} onChange={(e) => set("port", Number(e.target.value) || (ftp ? 21 : 22))} />
            </Field>
          </div>
          <Field
            label="Utilisateur"
            hint={identity ? "Identité liée : le mot de passe ou la clé viennent de la banque d'identifiants." : identities.length ? "Tape ou choisis un identifiant enregistré (flèches, Entrée)." : undefined}
          >
            {identity ? (
              <div className="flex h-8 items-center gap-2 rounded-lg border border-accent/60 bg-accent/10 px-2.5 text-[13px]">
                <IdCard size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate" title={`Identifiant « ${identity.name} » de la banque`}>
                  {identity.name} <span className="font-mono text-xs text-muted">({identity.username})</span>
                </span>
                <button type="button" title="Délier : saisir l'utilisateur à la main" className="text-muted hover:text-fg" onClick={() => setP((prev) => ({ ...prev, identityId: null }))}>
                  <Link2Off size={13} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  className="font-mono"
                  value={p.username}
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={suggest && suggestions.length > 0}
                  onFocus={() => setSuggest(true)}
                  onChange={(e) => {
                    set("username", e.target.value);
                    setSuggest(true);
                    setSuggestIndex(-1);
                  }}
                  onKeyDown={(e) => {
                    if (!suggest || !suggestions.length) return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSuggestIndex((i) => Math.min(i + 1, suggestions.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSuggestIndex((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter" && suggestIndex >= 0) {
                      e.preventDefault();
                      linkIdentity(suggestions[suggestIndex]);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setSuggest(false);
                    }
                  }}
                />
                {suggest && <IdentitySuggestions filter={p.username === "root" && !server ? "" : p.username} index={suggestIndex} onClose={() => setSuggest(false)} onPick={linkIdentity} />}
              </div>
            )}
          </Field>
          <Field label="Dossier (optionnel)" hint="Range le serveur dans la barre latérale et la liste.">
            <Input list="zenytt-server-folders" value={p.group ?? ""} placeholder="Production, perso…" onChange={(e) => set("group", e.target.value || null)} />
            <datalist id="zenytt-server-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
        </section>

        <section className="flex flex-col gap-4">
          <Eyebrow>Authentification</Eyebrow>
          {identity ? (
            <p className="rounded-lg border border-border bg-subtle p-3 text-xs text-muted">
              Authentification de l'identifiant « {identity.name} » ({AUTH_LABELS[identity.authKind]}
              {identity.authKind === "password" && !identity.hasPassword ? ", demandé à la connexion" : ""}). Modifiable dans l'onglet Identifiants.
            </p>
          ) : (
            <>
              {!ftp && (
                <Segmented
                  label="Méthode d'authentification"
                  value={p.authKind}
                  onChange={(k) => set("authKind", k)}
                  className="self-start"
                  options={[
                    { value: "key", label: "Clé privée" },
                    { value: "password", label: "Mot de passe" },
                    { value: "agent", label: "Agent SSH / Pageant" },
                  ]}
                />
              )}
              {p.authKind === "password" && (
                <Field label="Mot de passe" hint={keptHint(server?.hasPassword) ?? "Tu peux aussi le laisser vide : il sera demandé à la connexion."}>
                  <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
                </Field>
              )}
              {p.authKind === "key" && (
                <>
                  <Field label="Clé privée" hint="Formats OpenSSH et PuTTY (.ppk) acceptés.">
                    <div className="flex gap-2">
                      <Input className="font-mono" value={p.keyPath ?? ""} placeholder="~/.ssh/id_ed25519" onChange={(e) => set("keyPath", e.target.value)} />
                      <Button icon={<KeyRound size={14} />} onClick={() => void pickKey()}>
                        Parcourir
                      </Button>
                    </div>
                  </Field>
                  <Field label="Passphrase (si la clé est chiffrée)" hint={keptHint(server?.hasPassphrase)}>
                    <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                  </Field>
                </>
              )}
              {p.authKind === "agent" && (
                <p className="rounded-lg border border-border bg-subtle p-3 text-xs text-muted">Zenytt utilisera les clés chargées dans l'agent OpenSSH du système ou dans Pageant (PuTTY).</p>
              )}
              <div className="flex flex-col gap-2">
                <Checkbox
                  checked={toBank !== null}
                  onChange={(v) => setToBank(v ? `${p.username}@${p.name || p.host}` : null)}
                  label="Enregistrer aussi dans la banque d'identifiants"
                  hint="Pour réutiliser cet utilisateur et son secret sur d'autres serveurs."
                />
                {toBank !== null && <Input className="ml-6 w-[calc(100%-24px)]" value={toBank} onChange={(e) => setToBank(e.target.value)} aria-label="Nom de l'identifiant" />}
              </div>
            </>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <Eyebrow>Avancé</Eyebrow>
          {others.length > 0 && !ftp && (
            <Field label="Serveur de rebond" hint="Pour un serveur joignable seulement à travers un autre (bastion, réseau privé) : équivalent de ssh -J.">
              <Select
                value={p.jumpId ?? ""}
                onChange={(v) => set("jumpId", v || null)}
                options={[{ value: "", label: "Aucun : connexion directe" }, ...others.map((s) => ({ value: s.id, label: `${s.name} (${s.username}@${s.host})` }))]}
              />
            </Field>
          )}
          {protocol === "ssh" && (
            <Field label="Mot de passe sudo (optionnel)" hint={keptHint(server?.hasSudoPassword) ?? "Pour les actions d'administration (nginx, services…) si tu ne te connectes pas en root."}>
              <Input type="password" value={sudo} onChange={(e) => setSudo(e.target.value)} />
            </Field>
          )}
          <Checkbox
            checked={p.autoConnect ?? false}
            onChange={(v) => set("autoConnect", v)}
            label="Se connecter au démarrage de Zenytt"
            hint="En arrière-plan, sans aucune fenêtre. Un échec d'authentification suspend les nouvelles tentatives (pour ne pas être banni par fail2ban)."
          />
        </section>

        <section className="flex flex-col gap-3">
          <Eyebrow>Apparence</Eyebrow>
          <ColorPicker value={p.color} onChange={(c) => set("color", c)} />
        </section>
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
