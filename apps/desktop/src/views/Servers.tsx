// Serveurs : une liste de machines (serveurs et bureaux à distance) rangée par dossiers communs à
// gauche, fiche de la machine choisie à droite. Choisir un serveur dans la liste en fait le serveur
// actif (celui des sections du groupe « Serveur ») ; les identifiants s'ouvrent dans un tiroir.
import { useEffect, useMemo, useState } from "react";
import {
  Activity, ChevronDown, Container, Database, Download, ExternalLink, FolderInput, FolderPlus, FolderTree, Globe, IdCard, Monitor, MonitorPlay, Pencil, Plug, Plus, Search,
  Server, Share2, ShieldCheck, SquareTerminal, Stethoscope, Trash2, Unplug,
} from "lucide-react";
import { api, fullestDisk, errorMessage, formatDuration, hasShell, protocolBadge, type DesktopView, type ServerView } from "../lib/api";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { navigate, useShell, useTabIntent } from "../lib/shell";
import { fetchHealth, useHealth } from "../lib/health";
import { forgetCached } from "../lib/cache";
import { startDrag } from "../lib/drag";
import {
  Avatar, Badge, Button, Card, Drawer, EmptyState, Eyebrow, FOCUS_RING, IconButton, Input, KeyValue, LabeledMeter, MenuButton, StatusDot, useContextMenu, type MenuItem,
} from "../components/ui";
import PageLayout from "../components/PageLayout";
import { AUTH_LABELS, IdentitiesPanel, useIdentities } from "../components/Identities";
import { canOpenInside, desktopAddress, DesktopDetail, DesktopForm, DesktopsEmpty, openDesktop, protocolOf, useDesktops } from "../components/RemoteDesktops";
import { useRdp } from "../lib/rdp";
import { ReceiveShareDialog, ShareDialog } from "../components/ShareServers";
import { askFolderName, toggleCollapsed } from "../components/Folders";
import { useDoctor } from "../components/ConnectionDoctor";
import ServerForm from "./servers/ServerForm";
import ImportServers from "./servers/ImportServers";
import type { SectionId } from "../sections";

/** Anciens onglets, encore demandés par `navigate("servers", …)` : ils ouvrent les bureaux ou le tiroir. */
type Tab = "servers" | "desktops" | "identities";

/** Range des serveurs et des bureaux (mêmes dossiers) dans un dossier puis relit les listes. */
async function moveMachines(ids: string[], folder: string | null) {
  const { notify, refreshServers } = useApp.getState();
  try {
    await api.serversSetGroup(ids, folder);
    await Promise.all([refreshServers(), useDesktops.getState().reload()]);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Dossiers de machines : ceux créés (même vides) et ceux portés par les profils, triés. */
function useServerFolders(): string[] {
  const servers = useApp((s) => s.servers);
  const desktops = useDesktops((s) => s.list);
  const created = useApp((s) => s.folders.servers);
  return useMemo(
    () => [...new Set([...created, ...[...servers, ...desktops].map((m) => m.group ?? "").filter(Boolean)])].sort((a, b) => a.localeCompare(b, "fr")),
    [servers, desktops, created],
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export default function ServersView() {
  const servers = useApp((s) => s.servers);
  const activeServerId = useApp((s) => s.activeServerId);
  const refresh = useApp((s) => s.refreshServers);
  const folders = useServerFolders();
  const [tab, setTab] = useTabIntent<Tab>("servers", "servers");
  const [editing, setEditing] = useState<ServerView | "new" | null>(null);
  const [editingDesktop, setEditingDesktop] = useState<DesktopView | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [sharing, setSharing] = useState<"send" | "receive" | null>(null);
  const [identitiesOpen, setIdentitiesOpen] = useState(false);
  const [newIdentity, setNewIdentity] = useState(false);
  // Bureau affiché à droite : `null` pour le serveur actif, "" pour le premier bureau.
  const [desktopSel, setDesktopSel] = useState<string | null>(null);
  const identitiesCount = useIdentities((s) => s.list.length);
  const desktops = useDesktops((s) => s.list);
  const reloadIdentities = useIdentities((s) => s.reload);
  const reloadDesktops = useDesktops((s) => s.reload);
  useEffect(() => {
    void reloadIdentities();
    void reloadDesktops();
  }, [reloadIdentities, reloadDesktops]);

  useEffect(() => {
    if (tab === "servers") return;
    if (tab === "desktops") setDesktopSel("");
    else setIdentitiesOpen(true);
    setTab("servers");
  }, [tab, setTab]);

  // « Ajouter un serveur » demandé depuis l'accueil ou le sélecteur de serveur.
  const newRequested = useShell((s) => s.newServerRequested);
  useEffect(() => {
    if (!newRequested) return;
    setEditing("new");
    useShell.getState().requestNewServer(false);
  }, [newRequested]);

  const newFolder = async () => {
    const name = await askFolderName("Nouveau dossier");
    if (name) useApp.getState().setFolders((f) => ({ ...f, servers: [...new Set([...f.servers, name])] }));
  };

  const actions = (
    <>
      <Button icon={<IdCard size={14} />} onClick={() => setIdentitiesOpen(true)}>
        Identifiants · {identitiesCount}
      </Button>
      <Button icon={<Download size={14} />} onClick={() => setImporting(true)}>
        Importer
      </Button>
      <MenuButton
        label="Partage"
        icon={<Share2 size={14} />}
        items={[
          { label: "Partager des serveurs…", icon: <Share2 size={14} />, disabled: servers.length === 0, onClick: () => setSharing("send") },
          { label: "Recevoir un partage…", icon: <Download size={14} />, onClick: () => setSharing("receive") },
          "separator",
          { label: "Nouveau dossier…", icon: <FolderPlus size={14} />, onClick: () => void newFolder() },
        ]}
      />
      <MenuButton
        label="Ajouter"
        title="Ajouter une machine"
        variant="primary"
        icon={<Plus size={15} />}
        items={[
          { label: "Serveur…", icon: <Server size={14} />, onClick: () => setEditing("new") },
          { label: "Bureau à distance…", icon: <Monitor size={14} />, onClick: () => setEditingDesktop("new") },
        ]}
      />
    </>
  );

  const empty = servers.length === 0 && desktops.length === 0;
  return (
    <div className="relative h-full">
      <PageLayout
        title="Serveurs"
        context="Poste"
        subtitle={`${plural(servers.length, "serveur", "serveurs")} · ${plural(desktops.length, "bureau à distance", "bureaux à distance")} · secrets dans le coffre-fort du système`}
        scroll={false}
        actions={actions}
      >
        {empty && desktopSel !== null ? (
          <DesktopsEmpty onCreate={() => setEditingDesktop("new")} />
        ) : empty ? (
          <EmptyState
            icon={<Server />}
            title="Aucun serveur"
            action={
              <>
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing("new")}>
                  Ajouter un serveur
                </Button>
                <Button icon={<Download size={14} />} onClick={() => setImporting(true)}>
                  Importer PuTTY / OpenSSH
                </Button>
                <Button icon={<Monitor size={14} />} onClick={() => setEditingDesktop("new")}>
                  Ajouter un bureau à distance
                </Button>
              </>
            }
          >
            Ajoute ton VPS, ou importe directement tes sessions PuTTY et les hôtes de ton fichier <span className="font-mono">~/.ssh/config</span>. Les bureaux à distance (RDP, VNC,
            SPICE) se rangent dans la même liste.
          </EmptyState>
        ) : (
          <ServersMasterDetail
            folders={folders}
            activeId={activeServerId}
            desktopSel={desktopSel}
            onSelectDesktop={setDesktopSel}
            onEdit={setEditing}
            onEditDesktop={setEditingDesktop}
            onNewFolder={() => void newFolder()}
          />
        )}
      </PageLayout>

      {editing && (
        <ServerForm
          server={editing === "new" ? null : editing}
          folders={folders}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            setDesktopSel(null);
            void refresh().then(() => useApp.getState().setActiveServer(id));
          }}
        />
      )}
      {editingDesktop && (
        <DesktopForm
          desktop={editingDesktop === "new" ? null : editingDesktop}
          onClose={() => setEditingDesktop(null)}
          onSaved={(id) => {
            setEditingDesktop(null);
            setDesktopSel(id);
            void reloadDesktops();
          }}
        />
      )}
      {identitiesOpen && (
        <Drawer
          title="Identifiants"
          subtitle="Un utilisateur et son secret, réutilisés par plusieurs serveurs"
          width={520}
          onClose={() => setIdentitiesOpen(false)}
          actions={
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setNewIdentity(true)}>
              Nouvel identifiant
            </Button>
          }
        >
          <IdentitiesPanel creating={newIdentity} onCreatingChange={setNewIdentity} />
        </Drawer>
      )}
      {importing && <ImportServers onClose={() => setImporting(false)} onDone={() => void refresh()} />}
      {sharing === "send" && <ShareDialog onClose={() => setSharing(null)} />}
      {sharing === "receive" && <ReceiveShareDialog onClose={() => setSharing(null)} onDone={() => void refresh()} />}
    </div>
  );
}

function ServersMasterDetail({
  folders,
  activeId,
  desktopSel,
  onSelectDesktop,
  onEdit,
  onEditDesktop,
  onNewFolder,
}: {
  folders: string[];
  activeId: string | null;
  desktopSel: string | null;
  onSelectDesktop: (id: string | null) => void;
  onEdit: (s: ServerView) => void;
  onEditDesktop: (d: DesktopView | "new") => void;
  onNewFolder: () => void;
}) {
  const servers = useApp((s) => s.servers);
  const desktops = useDesktops((s) => s.list);
  const identities = useIdentities((s) => s.list);
  const openDesktopId = useRdp((s) => s.desktop?.id);
  const setActive = useApp((s) => s.setActiveServer);
  const setFolders = useApp((s) => s.setFolders);
  const collapsed = useApp((s) => s.folders.collapsed);
  const [filter, setFilter] = useState("");
  const menu = useContextMenu();
  const pickedDesktop = desktopSel === null ? undefined : (desktops.find((d) => d.id === desktopSel) ?? (desktopSel === "" ? desktops[0] : undefined));
  const selected = pickedDesktop ? undefined : (servers.find((s) => s.id === activeId) ?? servers[0]);
  const selectedDesktop = pickedDesktop ?? (selected ? undefined : desktops[0]);
  const selectServer = (id: string) => {
    setActive(id);
    onSelectDesktop(null);
  };

  const q = filter.trim().toLowerCase();
  const matches = (s: ServerView) => !q || `${s.name} ${s.host} ${s.username} ${s.group ?? ""} ${s.protocol ?? "ssh"}`.toLowerCase().includes(q);
  const matchesDesktop = (d: DesktopView) => !q || `${d.name} ${d.host} ${d.username} ${d.group ?? ""} ${protocolOf(d)}`.toLowerCase().includes(q);
  const inFolder = (name: string) => servers.filter((s) => (s.group ?? "") === name && matches(s));
  const desktopsIn = (name: string) => desktops.filter((d) => (d.group ?? "") === name && matchesDesktop(d));
  const idsIn = (name: string) => [...servers, ...desktops].filter((m) => m.group === name).map((m) => m.id);

  const renameFolder = async (name: string) => {
    const next = await askFolderName(`Renommer « ${name} »`, name);
    if (!next || next === name) return;
    setFolders((f) => ({ ...f, servers: [...f.servers.filter((x) => x !== name && x !== next), next], collapsed: f.collapsed.map((k) => (k === `servers:${name}` ? `servers:${next}` : k)) }));
    await moveMachines(idsIn(name), next);
  };
  const removeFolder = async (name: string) => {
    setFolders((f) => ({ ...f, servers: f.servers.filter((x) => x !== name) }));
    const ids = idsIn(name);
    if (ids.length) await moveMachines(ids, null);
  };

  const moveItems = (machine: { id: string; group?: string | null }): MenuItem[] => [
    { heading: "Déplacer vers" },
    ...folders.filter((f) => f !== (machine.group ?? "")).map((f) => ({ label: f, icon: <FolderInput size={14} />, onClick: () => void moveMachines([machine.id], f) })),
    ...(machine.group ? [{ label: "Sortir du dossier", onClick: () => void moveMachines([machine.id], null) }] : []),
    {
      label: "Nouveau dossier…",
      icon: <FolderPlus size={14} />,
      onClick: async () => {
        const name = await askFolderName("Nouveau dossier");
        if (name) await moveMachines([machine.id], name);
      },
    },
  ];

  const desktopMenu = (d: DesktopView): MenuItem[] => [
    ...(protocolOf(d) === "spice"
      ? [{ label: "Ouvrir la console", icon: <ExternalLink size={14} />, onClick: () => void openDesktop(d, "external") }]
      : [
          ...(canOpenInside(d) ? [{ label: "Se connecter", icon: <MonitorPlay size={14} />, onClick: () => void useRdp.getState().open(d) }] : []),
          { label: "Client du système", icon: <ExternalLink size={14} />, onClick: () => void openDesktop(d, "external") },
        ]),
    { label: "Modifier…", icon: <Pencil size={14} />, onClick: () => onEditDesktop(d) },
    "separator",
    ...moveItems(d),
  ];

  /** Ligne de la liste : élément « bouton » sans balise <button>, le glisser vers un dossier ignore les boutons. */
  const row = (m: { key: string; name: string; color?: string | null; badge: string; address: string; on: boolean; current: boolean; select: () => void; drop: (folder: string) => void; menu: () => MenuItem[] }) => (
    <div
      key={m.key}
      role="button"
      tabIndex={0}
      onClick={m.select}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          m.select();
        }
      }}
      onMouseDown={(e) => startDrag(e, m.name, m.drop)}
      onContextMenu={(e) => menu.open(e, m.menu())}
      aria-current={m.current ? "true" : undefined}
      className={`flex w-full cursor-default items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-colors ${FOCUS_RING} ${
        m.current ? "border-border-strong bg-raised" : "border-transparent hover:bg-hover"
      }`}
    >
      <Avatar name={m.name} color={m.color} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 truncate text-[13px] font-medium">
          {m.name}
          <Badge>{m.badge}</Badge>
        </span>
        <span className="truncate font-mono text-[10.5px] text-muted">{m.address}</span>
      </span>
      <StatusDot tone={m.on ? "ok" : "muted"} />
    </div>
  );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[clamp(240px,28%,320px)_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-2 border-r border-border bg-subtle px-3 py-3.5">
        <label className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input className="pl-8" placeholder="Filtrer : nom, hôte, dossier…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <div className="scroll-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {[...folders, ""].map((name) => {
            const list = inFolder(name);
            const desks = desktopsIn(name);
            const count = list.length + desks.length;
            if (!name && !count) return null;
            if (q && !count) return null;
            const key = `servers:${name}`;
            const isCollapsed = collapsed.includes(key) && !q;
            return (
              <section key={name || "-"} data-drop={name} className="mb-1.5 rounded-lg">
                <div className="group/folder flex h-7 items-center gap-1.5 px-1.5 text-xs text-muted">
                  <button type="button" onClick={() => toggleCollapsed(key)} aria-expanded={!isCollapsed} className={`flex min-w-0 flex-1 items-center gap-1.5 rounded ${FOCUS_RING}`}>
                    <ChevronDown size={13} className={`shrink-0 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                    <span className={`truncate font-semibold ${name ? "text-fg/80" : ""}`}>{name || "Sans dossier"}</span>
                    <span className="text-faint">{count}</span>
                  </button>
                  {name && (
                    <MenuButton
                      size="sm"
                      title={`Dossier ${name}`}
                      items={[
                        { label: "Renommer…", icon: <Pencil size={14} />, onClick: () => void renameFolder(name) },
                        { label: "Supprimer le dossier", icon: <Trash2 size={14} />, danger: true, onClick: () => void removeFolder(name) },
                      ]}
                    />
                  )}
                </div>
                {!isCollapsed && (
                  <div className="flex flex-col gap-0.5">
                    {list.map((s) =>
                      row({
                        key: s.id,
                        name: s.name,
                        color: s.color,
                        badge: (s.protocol ?? "ssh").toUpperCase(),
                        address: `${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`,
                        on: s.connected,
                        current: s.id === selected?.id,
                        select: () => selectServer(s.id),
                        drop: (folder) => folder !== (s.group ?? "") && void moveMachines([s.id], folder || null),
                        menu: () => [
                          { label: "Modifier…", icon: <Pencil size={14} />, onClick: () => onEdit(s) },
                          ...(hasShell(s) ? [{ label: "Terminal", icon: <SquareTerminal size={14} />, onClick: () => void openTerminal(s) }] : []),
                          "separator",
                          ...moveItems(s),
                        ],
                      }),
                    )}
                    {desks.map((d) => {
                      const via = servers.find((s) => s.id === d.viaServerId);
                      const address = desktopAddress(d, identities.find((i) => i.id === d.identityId)?.username);
                      return row({
                        key: d.id,
                        name: d.name,
                        color: d.color,
                        badge: protocolOf(d).toUpperCase(),
                        address: via ? `via ${via.name} · ${address}` : address,
                        on: openDesktopId === d.id,
                        current: d.id === selectedDesktop?.id,
                        select: () => onSelectDesktop(d.id),
                        drop: (folder) => folder !== (d.group ?? "") && void moveMachines([d.id], folder || null),
                        menu: () => desktopMenu(d),
                      });
                    })}
                    {count === 0 && <p className="mx-1 rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-faint">Glisse une machine ici</p>}
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <div className="flex items-center justify-between px-1.5 text-[11.5px] text-faint">
          <span>Glisser sur un dossier pour ranger · clic droit : plus</span>
          <IconButton size="sm" title="Nouveau dossier" onClick={onNewFolder}>
            <FolderPlus size={14} />
          </IconButton>
        </div>
        {menu.menu}
      </aside>
      <section className="min-h-0 overflow-auto">
        {desktopSel === "" && desktops.length === 0 ? (
          <DesktopsEmpty onCreate={() => onEditDesktop("new")} />
        ) : selectedDesktop ? (
          <DesktopDetail key={selectedDesktop.id} desktop={selectedDesktop} onEdit={() => onEditDesktop(selectedDesktop)} onDeleted={() => onSelectDesktop(null)} moveItems={moveItems(selectedDesktop)} />
        ) : selected ? (
          <ServerDetail key={selected.id} server={selected} onEdit={() => onEdit(selected)} moveItems={moveItems(selected)} />
        ) : null}
      </section>
    </div>
  );
}

async function openTerminal(s: ServerView) {
  const { setActiveServer, openTab } = useApp.getState();
  setActiveServer(s.id);
  if (await ensureConnected(s.id, { force: true })) openTab(s.id);
}

function ServerDetail({ server, onEdit, moveItems }: { server: ServerView; onEdit: () => void; moveItems: MenuItem[] }) {
  const { refreshServers, notify, ask, servers } = useAppPick("refreshServers", "notify", "ask", "servers");
  const identity = useIdentities((s) => s.list.find((i) => i.id === server.identityId));
  const summary = useHealth((s) => s.summaries[server.id]);
  const [busy, setBusy] = useState(false);
  const jump = servers.find((s) => s.id === server.jumpId);

  useEffect(() => {
    if (server.connected && hasShell(server)) void fetchHealth(server.id, 20_000);
  }, [server.id, server.connected]);

  const connect = async () => {
    setBusy(true);
    if (await ensureConnected(server.id, { force: true })) notify(`Connecté à ${server.name}`, "success");
    setBusy(false);
  };
  const disconnect = async () => {
    await api.disconnect(server.id);
    void refreshServers();
  };
  const remove = async () => {
    const ok = await ask({
      title: `Supprimer « ${server.name} » ?`,
      body: "Le profil et ses secrets enregistrés seront supprimés. Rien n'est modifié sur le serveur.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    await api.deleteServer(server.id);
    forgetCached(server.id);
    useHealth.getState().forget(server.id);
    void refreshServers();
  };

  const m = summary?.connected ? summary.metrics : null;
  const mem = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : null;
  const root = fullestDisk(m?.disks);
  const disk = root && root.total ? (root.used / root.total) * 100 : null;
  const go = (section: SectionId, tab?: string) => navigate(section, tab, server.id);

  const allJumps: { section: SectionId; tab?: string; label: string; icon: React.ReactNode; hint: string }[] = [
    { section: "monitoring", label: "Supervision", icon: <Activity size={15} />, hint: summary?.connected ? (summary.alerts.length ? `${summary.alerts.length} alerte(s)` : "aucune alerte") : "métriques, processus" },
    { section: "files", label: "Fichiers", icon: <FolderTree size={15} />, hint: "explorateur SFTP" },
    { section: "docker", label: "Docker", icon: <Container size={15} />, hint: summary?.connected && summary.docker ? `${summary.containersRunning} conteneur(s)` : "conteneurs, compose" },
    { section: "databases", label: "Bases", icon: <Database size={15} />, hint: "SQL et Redis" },
    { section: "sites", label: "Sites", icon: <Globe size={15} />, hint: summary?.connected ? `${summary.certificates.length} certificat(s)` : "nginx, certificats" },
    { section: "monitoring", tab: "security", label: "Sécurité", icon: <ShieldCheck size={15} />, hint: "audit, pare-feu" },
  ];
  const jumps = hasShell(server) ? allJumps : allJumps.filter((j) => j.section === "files");

  return (
    <div className="@container flex flex-col gap-5 px-7 py-6">
      <div className="flex flex-wrap items-center gap-3.5">
        <Avatar name={server.name} color={server.color} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[19px] font-semibold">{server.name}</h2>
            {server.connected ? <Badge tone="ok">connecté</Badge> : <Badge>hors ligne</Badge>}
            {server.group && <Badge>{server.group}</Badge>}
            {protocolBadge(server) && <Badge tone="accent">{protocolBadge(server)}</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted">
            {server.username}@{server.host}:{server.port}
            {m ? ` · en ligne depuis ${formatDuration(m.uptimeSecs)}` : ""}
          </div>
        </div>
        {hasShell(server) && (
          <Button variant="primary" icon={<SquareTerminal size={14} />} onClick={() => void openTerminal(server)}>
            Terminal
          </Button>
        )}
        {server.connected ? (
          <Button icon={<Unplug size={14} />} onClick={() => void disconnect()}>
            Déconnecter
          </Button>
        ) : (
          <Button loading={busy} icon={<Plug size={14} />} onClick={() => void connect()}>
            Connecter
          </Button>
        )}
        <Button icon={<Pencil size={14} />} onClick={onEdit}>
          Modifier
        </Button>
        <MenuButton
          items={[
            { label: "Diagnostiquer la connexion", icon: <Stethoscope size={14} />, onClick: () => useDoctor.getState().open(server.id) },
            "separator",
            ...moveItems,
            "separator",
            { label: "Supprimer le profil…", icon: <Trash2 size={14} />, danger: true, onClick: () => void remove() },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 gap-3.5 @xl:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <Eyebrow>Connexion</Eyebrow>
          <KeyValue
            items={[
              ["Hôte", <span className="font-mono">{server.host}</span>],
              ["Port", <span className="font-mono">{server.port}</span>],
              ["Utilisateur", <span className="font-mono">{identity ? identity.username : server.username}</span>],
              ["Rebond", jump ? `via ${jump.name}` : <span className="text-muted">Connexion directe</span>],
            ]}
          />
        </Card>
        <Card className="flex flex-col gap-3">
          <Eyebrow>Authentification</Eyebrow>
          <KeyValue
            items={[
              [
                "Méthode",
                identity ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {identity.name} <Badge tone="accent">{AUTH_LABELS[identity.authKind]}</Badge>
                  </span>
                ) : (
                  AUTH_LABELS[server.authKind]
                ),
              ],
              ...((identity ? identity.authKind : server.authKind) === "key"
                ? ([["Clé", <span className="font-mono text-xs">{(identity ? identity.keyPath : server.keyPath) || "—"}</span>]] as [React.ReactNode, React.ReactNode][])
                : []),
              ["Secret enregistré", server.hasPassword || server.hasPassphrase || identity?.hasPassword || identity?.hasPassphrase ? "Oui, dans le coffre du système" : <span className="text-muted">Non</span>],
              ["Sudo", server.hasSudoPassword ? "Mot de passe enregistré" : <span className="text-muted">Non renseigné</span>],
              ["Accès IA (MCP)", server.aiAccess ? "Lecture seule autorisée" : <span className="text-muted">Désactivé</span>],
            ]}
          />
        </Card>
        {hasShell(server) && <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Eyebrow>Santé</Eyebrow>
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => go("monitoring")}>
              Supervision
            </button>
          </div>
          {summary?.connected ? (
            <div className="flex flex-col gap-3">
              <LabeledMeter label="CPU" value={m ? m.cpuPercent : null} />
              <LabeledMeter label="Mémoire" value={mem} />
              <LabeledMeter label="Disque /" value={disk} />
            </div>
          ) : (
            <p className="text-[13px] text-muted">{server.connected ? "Mesure en cours…" : "Connecte le serveur pour voir sa santé."}</p>
          )}
        </Card>}
        <Card className="@container flex flex-col gap-3">
          <Eyebrow>Aller à</Eyebrow>
          <div className="grid grid-cols-2 gap-2 @sm:grid-cols-3">
            {jumps.map((j) => (
              <button
                key={`${j.section}:${j.tab ?? ""}`}
                type="button"
                onClick={() => go(j.section, j.tab)}
                className={`flex min-w-0 flex-col items-start gap-1 rounded-lg border border-border bg-subtle px-2.5 py-2 text-left transition-colors hover:border-border-strong ${FOCUS_RING}`}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  <span className="text-muted">{j.icon}</span>
                  {j.label}
                </span>
                <span className="w-full truncate text-[11px] text-faint">{j.hint}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
