import { useState } from "react";
import { Cable, ExternalLink, IdCard, Link2Off, Monitor, MonitorPlay, Pencil, Plus, Trash2 } from "lucide-react";
import { create } from "zustand";
import { api, errorMessage, type DesktopProtocol, type DesktopView, type RemoteDesktop } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Avatar, Badge, Button, Card, Checkbox, ColorPicker, EmptyState, Eyebrow, Field, Input, KeyValue, MenuButton, Modal, PROFILE_COLORS, Select, type MenuItem } from "./ui";
import { IdentitySuggestions, useIdentities } from "./Identities";
import { useRdp } from "../lib/rdp";

const COLORS = PROFILE_COLORS;

/** Port par défaut de chaque protocole (même règle que côté Rust). */
const DEFAULT_PORT: Record<DesktopProtocol, number> = { rdp: 3389, vnc: 5900, spice: 5900 };
export const protocolOf = (d: RemoteDesktop): DesktopProtocol => d.protocol ?? "rdp";

export const useDesktops = create<{ list: DesktopView[]; reload: () => Promise<void> }>((set) => ({
  list: [],
  reload: async () => set({ list: await api.desktops() }),
}));

/** Le bureau peut-il s'ouvrir dans Zenytt ? (SPICE : jamais ; RDP : avec un mot de passe enregistré.) */
export function canOpenInside(d: DesktopView): boolean {
  const p = protocolOf(d);
  return p === "vnc" || (p === "rdp" && d.hasPassword);
}

/**
 * Ouvre un bureau dans Zenytt (`internal`) ou dans le client du système (`external` : mstsc ou
 * FreeRDP pour le RDP, remote-viewer pour le VNC et le SPICE). Un bureau qui ne peut pas s'ouvrir
 * dans Zenytt part dans le client du système.
 */
export async function openDesktop(d: DesktopView, mode: "internal" | "external") {
  const { notify } = useApp.getState();
  try {
    if (d.viaServerId && !(await ensureConnected(d.viaServerId, { force: true }))) return;
    if (mode === "internal" && canOpenInside(d)) return void (await useRdp.getState().open(d));
    notify(await api.desktopLaunch(d.id), "success");
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** État vide des bureaux à distance (page Serveurs). */
export function DesktopsEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={<Monitor />}
      title="Aucun bureau à distance"
      action={
        <Button variant="primary" icon={<Plus size={14} />} onClick={onCreate}>
          Nouveau bureau
        </Button>
      }
    >
      Bureaux Windows (RDP) et Linux, Raspberry Pi ou macOS (VNC) ouverts dans Zenytt, consoles de VM QEMU/KVM (SPICE) dans remote-viewer. Via un serveur SSH, Zenytt ouvre un tunnel le temps de la session : ni le port 3389 ni le 5900 n'ont besoin d'être exposés.
    </EmptyState>
  );
}

/** Adresse affichée dans la liste : utilisateur, hôte, et port s'il n'est pas celui par défaut. */
export function desktopAddress(d: DesktopView, username?: string): string {
  const user = username || d.username;
  return `${user ? `${user}@` : ""}${d.host}${d.port !== DEFAULT_PORT[protocolOf(d)] ? `:${d.port}` : ""}`;
}

const PROTOCOL_NAMES: Record<DesktopProtocol, string> = { rdp: "RDP", vnc: "VNC", spice: "SPICE (console de VM)" };

/** Fiche d'un bureau à distance, à droite de la liste des machines (page Serveurs). */
export function DesktopDetail({ desktop: d, onEdit, onDeleted, moveItems }: { desktop: DesktopView; onEdit: () => void; onDeleted: () => void; moveItems: MenuItem[] }) {
  const servers = useApp((s) => s.servers);
  const identity = useIdentities((s) => s.list.find((i) => i.id === d.identityId));
  const open = useRdp((s) => s.desktop?.id === d.id);
  const [busy, setBusy] = useState(false);
  const protocol = protocolOf(d);
  const via = servers.find((s) => s.id === d.viaServerId);
  const needsPassword = protocol === "rdp" && !d.hasPassword;

  const external = async () => {
    setBusy(true);
    await openDesktop(d, "external");
    setBusy(false);
  };
  const remove = async () => {
    const { ask, notify } = useApp.getState();
    if (!(await ask({ title: `Supprimer « ${d.name} » ?`, body: "Le profil et son mot de passe enregistré sont supprimés de ce PC.", confirmLabel: "Supprimer", danger: true }))) return;
    try {
      await api.desktopDelete(d.id);
      await useDesktops.getState().reload();
      onDeleted();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const no = (text: string) => <span className="text-muted">{text}</span>;
  const rdpRows: [React.ReactNode, React.ReactNode][] =
    protocol === "rdp"
      ? [
          ["Écran", d.fullscreen ? "Plein écran" : <span className="font-mono">{d.width ?? 1600}×{d.height ?? 900}</span>],
          ["Tous les écrans", d.multimon ? "Oui" : no("Non")],
          ["Disques partagés", d.redirectDrives ? "Oui" : no("Non")],
        ]
      : [];
  return (
    <div className="@container flex flex-col gap-5 px-7 py-6">
      <div className="flex flex-wrap items-center gap-3.5">
        <Avatar name={d.name} color={d.color ?? COLORS[0]} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[19px] font-semibold">{d.name}</h2>
            {open && <Badge tone="ok">session ouverte</Badge>}
            {d.group && <Badge>{d.group}</Badge>}
            <Badge tone="accent">{protocol.toUpperCase()}</Badge>
            {via ? <Badge tone="accent">via {via.name}</Badge> : protocol !== "rdp" ? <Badge tone="warn">direct, non chiffré</Badge> : <Badge>direct</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted">
            {identity ? identity.username : d.username || "?"}@{d.host}:{d.port}
          </div>
        </div>
        {/* Dans Zenytt par défaut : le client externe reste accessible juste à côté. */}
        {protocol === "spice" ? (
          <Button variant="primary" loading={busy} icon={<ExternalLink size={14} />} title="Ouvre la console dans remote-viewer (virt-viewer), à travers le tunnel SSH le cas échéant" onClick={() => void external()}>
            Ouvrir la console
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={needsPassword}
              title={needsPassword ? "Enregistre un mot de passe pour ouvrir la session dans Zenytt" : undefined}
              icon={<MonitorPlay size={14} />}
              onClick={() => void useRdp.getState().open(d)}
            >
              Se connecter
            </Button>
            <Button
              loading={busy}
              icon={<ExternalLink size={14} />}
              title={protocol === "rdp" ? "Ouvrir avec le client du système (mstsc, FreeRDP…)" : "Ouvrir dans remote-viewer (virt-viewer), à travers le tunnel SSH le cas échéant"}
              onClick={() => void external()}
            >
              Client du système
            </Button>
          </>
        )}
        <Button icon={<Pencil size={14} />} onClick={onEdit}>
          Modifier
        </Button>
        <MenuButton items={[...moveItems, "separator", { label: "Supprimer le profil…", icon: <Trash2 size={14} />, danger: true, onClick: () => void remove() }]} />
      </div>

      <div className="grid grid-cols-1 gap-3.5 @xl:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <Eyebrow>Connexion</Eyebrow>
          <KeyValue
            items={[
              ["Protocole", PROTOCOL_NAMES[protocol]],
              ["Hôte", <span className="font-mono">{d.host}</span>],
              ["Port", <span className="font-mono">{d.port}</span>],
              [
                "Passage",
                via ? (
                  <span className="flex items-center gap-1.5">
                    <Cable size={13} className="shrink-0 text-muted" />
                    via {via.name}, tunnel SSH le temps de la session
                  </span>
                ) : protocol !== "rdp" ? (
                  <span className="text-warn">Direct, non chiffré</span>
                ) : (
                  no("Connexion directe")
                ),
              ],
              ["Ouverture", protocol === "spice" ? "remote-viewer (virt-viewer)" : protocol === "rdp" ? "Dans Zenytt, ou mstsc / FreeRDP" : "Dans Zenytt (noVNC), ou remote-viewer"],
            ]}
          />
        </Card>
        <Card className="flex flex-col gap-3">
          <Eyebrow>Session</Eyebrow>
          <KeyValue
            items={[
              ["Utilisateur", identity || d.username ? <span className="font-mono">{identity ? identity.username : d.username}</span> : no(protocol === "spice" ? "Inutilisé en SPICE" : "Aucun")],
              ...(protocol === "rdp" ? ([["Domaine", d.domain ? <span className="font-mono">{d.domain}</span> : no("Aucun")]] as [React.ReactNode, React.ReactNode][]) : []),
              [
                "Identifiant",
                identity ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {identity.name} <Badge tone="accent">banque</Badge>
                  </span>
                ) : (
                  no("Propre au bureau")
                ),
              ],
              ["Mot de passe", d.hasPassword ? "Oui, dans le coffre du système" : no(protocol === "rdp" ? "Non : client du système seulement" : "Non")],
              ...rdpRows,
            ]}
          />
          {needsPassword && <p className="text-xs text-faint">Enregistre un mot de passe dans le profil pour ouvrir la session dans Zenytt.</p>}
        </Card>
      </div>
    </div>
  );
}

function emptyDesktop(): RemoteDesktop {
  return { id: "", name: "", protocol: "rdp", host: "", port: 3389, username: "", domain: null, identityId: null, viaServerId: null, fullscreen: false, width: 1600, height: 900, multimon: false, redirectDrives: false, color: COLORS[0] };
}

export function DesktopForm({ desktop, onClose, onSaved }: { desktop: DesktopView | null; onClose: () => void; onSaved: (id: string) => void }) {
  const notify = useApp((s) => s.notify);
  const servers = useApp((s) => s.servers);
  const identities = useIdentities((s) => s.list);
  const [d, setD] = useState<RemoteDesktop>(desktop ? { ...desktop } : emptyDesktop());
  const [password, setPassword] = useState("");
  const [suggest, setSuggest] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof RemoteDesktop>(k: K, v: RemoteDesktop[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const identity = identities.find((i) => i.id === d.identityId);
  const protocol = protocolOf(d);

  /** Changer de protocole remet le port par défaut, sauf s'il a été personnalisé. */
  const setProtocol = (p: DesktopProtocol) =>
    setD((prev) => ({ ...prev, protocol: p, port: prev.port === DEFAULT_PORT[protocolOf(prev)] ? DEFAULT_PORT[p] : prev.port }));

  const save = async () => {
    setSaving(true);
    try {
      const id = await api.desktopSave(d, password || undefined);
      onSaved(id);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={desktop ? `Modifier ${desktop.name}` : "Nouveau bureau à distance"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} disabled={!d.host.trim()} onClick={() => void save()}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-6 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="col-span-4">
          <Field label="Nom">
            <Input value={d.name} placeholder="PC du bureau" onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Protocole">
            <Select<DesktopProtocol>
              value={protocol}
              onChange={setProtocol}
              options={[
                { value: "rdp", label: "RDP (Windows, xrdp)" },
                { value: "vnc", label: "VNC (Linux, Mac, Pi)" },
                { value: "spice", label: "SPICE (VM QEMU/KVM)" },
              ]}
            />
          </Field>
        </div>
        <div className="col-span-4">
          <Field label="Hôte" hint={d.viaServerId ? "Adresse vue depuis le serveur de rebond (IP du réseau local, par exemple)." : undefined}>
            <Input value={d.host} placeholder="192.168.1.20 ou pc.exemple.fr" onChange={(e) => set("host", e.target.value)} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Port">
            <Input type="number" value={d.port} onChange={(e) => set("port", Number(e.target.value) || DEFAULT_PORT[protocol])} />
          </Field>
        </div>
        <div className="col-span-6">
          <Field label="Passer par un serveur SSH (recommandé hors du réseau local)">
            <Select
              value={d.viaServerId ?? ""}
              onChange={(v) => set("viaServerId", v || null)}
              options={[{ value: "", label: "Non : connexion directe" }, ...servers.map((s) => ({ value: s.id, label: `${s.name} (${s.host})` }))]}
            />
          </Field>
        </div>
        <div className={protocol === "rdp" ? "col-span-3" : "col-span-6"}>
          <Field label={protocol === "vnc" ? "Utilisateur (seulement si la machine en demande un, macOS par exemple)" : protocol === "spice" ? "Utilisateur (inutilisé en SPICE)" : "Utilisateur"}>
            {identity ? (
              <div className="flex h-8 items-center gap-2 rounded-lg border border-accent/50 bg-accent/10 px-2.5 text-[13px]">
                <IdCard size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  {identity.name} <span className="font-mono text-xs text-muted">({identity.username})</span>
                </span>
                <button type="button" title="Délier" className="text-muted hover:text-fg" onClick={() => set("identityId", null)}>
                  <Link2Off size={13} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input value={d.username} autoComplete="off" onFocus={() => setSuggest(true)} onChange={(e) => set("username", e.target.value)} />
                {suggest && (
                  <IdentitySuggestions
                    filter=""
                    onClose={() => setSuggest(false)}
                    onPick={(i) => {
                      setD((prev) => ({ ...prev, identityId: i.id, username: i.username }));
                      setSuggest(false);
                    }}
                  />
                )}
              </div>
            )}
          </Field>
        </div>
        {protocol === "rdp" && (
          <div className="col-span-3">
            <Field label="Domaine (optionnel)">
              <Input value={d.domain ?? ""} placeholder="MAISON" onChange={(e) => set("domain", e.target.value || null)} />
            </Field>
          </div>
        )}
        {!identity && (
          <div className="col-span-6">
            <Field
              label={protocol === "vnc" ? "Mot de passe VNC" : protocol === "spice" ? "Mot de passe SPICE" : "Mot de passe"}
              hint={
                desktop?.hasPassword
                  ? "Déjà enregistré : laisse vide pour le conserver."
                  : protocol === "vnc"
                    ? "Celui du serveur VNC (8 caractères au plus pour l'authentification VNC classique)."
                    : protocol === "spice"
                      ? "Celui de la console SPICE de la VM, s'il y en a un."
                      : "Optionnel : sinon Windows le demandera."
              }
            >
              <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        )}
        {protocol === "rdp" && (
        <div className="col-span-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <Checkbox checked={d.fullscreen} onChange={(v) => set("fullscreen", v)} label="Plein écran" />
          {!d.fullscreen && (
            <span className="flex items-center gap-1.5">
              <Input className="!h-7 !w-20" type="number" value={d.width ?? 1600} onChange={(e) => set("width", Number(e.target.value) || null)} />×
              <Input className="!h-7 !w-20" type="number" value={d.height ?? 900} onChange={(e) => set("height", Number(e.target.value) || null)} />
            </span>
          )}
          <Checkbox checked={d.multimon} onChange={(v) => set("multimon", v)} label="Tous les écrans" />
          <Checkbox checked={d.redirectDrives} onChange={(v) => set("redirectDrives", v)} label="Partager mes disques" />
        </div>
        )}
        {protocol === "spice" && (
          <p className="col-span-6 rounded-lg border border-border bg-subtle p-3 text-xs text-muted">
            SPICE s'ouvre dans remote-viewer (paquet virt-viewer), le client de référence : à installer sur ce PC. Pour une VM Proxmox, le VNC intégré à
            Zenytt suffit souvent — c'est ce qu'utilise sa console web.
          </p>
        )}
        {protocol !== "rdp" && !d.viaServerId && (
          <p className="col-span-6 rounded-lg border border-warn/40 bg-warn/8 p-3 text-xs">
            {protocol === "spice" ? "SPICE sans TLS" : "VNC"} ne chiffre généralement ni l'écran ni le mot de passe. Hors de ton réseau local, choisis un serveur SSH ci-dessus : la session passera
            alors dans un tunnel chiffré, et le port 5900 n'aura pas à être ouvert.
          </p>
        )}
        {d.viaServerId && (
          <p className="col-span-6 flex items-start gap-2 rounded-lg border border-border bg-subtle p-3 text-xs text-muted">
            <Cable size={14} className="mt-px shrink-0" />
            Un tunnel SSH local est ouvert à chaque connexion vers {d.host || "l'hôte"}:{d.port}, puis refermé à la fin de la session.
          </p>
        )}
        <div className="col-span-6">
          <Field label="Couleur">
            <ColorPicker value={d.color} onChange={(c) => set("color", c)} />
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
