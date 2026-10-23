// Tunnels SSH : un port de 127.0.0.1 sur le PC relayé vers un service du serveur.
import { useCallback, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Cable, CopyPlus, ExternalLink, Pencil, Play, Plus, Search, Square, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import { api, errorMessage, type TunnelDef, type TunnelView } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { useAppPick } from "../lib/store";
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, IconButton, Input, Modal, Select, StatusDot, type Column, type MenuItem } from "../components/ui";
import PageLayout from "../components/PageLayout";
import { usePolling } from "../lib/poll";
import { useCachedState } from "../lib/cache";

/** Services courants : un clic règle le port distant et propose un nom. */
const PRESETS = [
  { id: "mysql", label: "MySQL / MariaDB", port: 3306 },
  { id: "postgres", label: "PostgreSQL", port: 5432 },
  { id: "redis", label: "Redis", port: 6379 },
  { id: "mongo", label: "MongoDB", port: 27017 },
  { id: "http", label: "Site web (HTTP)", port: 80 },
] as const;

const HTTP_PORTS = new Set([80, 443, 3000, 3001, 5000, 5173, 8000, 8080, 8081, 8443, 8888, 9000, 9090]);

/** Commande ou adresse prête à coller pour utiliser le tunnel, selon le service visé. */
function connectionString(t: Pick<TunnelDef, "localPort" | "remotePort">): { text: string; label: string; url?: string } {
  const p = t.localPort;
  switch (t.remotePort) {
    case 3306:
      return { label: "Commande mysql", text: `mysql -h 127.0.0.1 -P ${p} -u <utilisateur> -p` };
    case 5432:
      return { label: "Commande psql", text: `psql -h 127.0.0.1 -p ${p} -U <utilisateur>` };
    case 6379:
      return { label: "Commande redis-cli", text: `redis-cli -h 127.0.0.1 -p ${p}` };
    case 27017:
      return { label: "URI MongoDB", text: `mongodb://127.0.0.1:${p}` };
  }
  if (HTTP_PORTS.has(t.remotePort)) {
    const url = `${t.remotePort === 443 || t.remotePort === 8443 ? "https" : "http"}://127.0.0.1:${p}`;
    return { label: "Adresse", text: url, url };
  }
  return { label: "Adresse", text: `127.0.0.1:${p}` };
}

export default function TunnelsView() {
  const { servers, notify, ask, activeServerId } = useAppPick("servers", "notify", "ask", "activeServerId");
  const [list, setList] = useCachedState<TunnelView[]>("tunnels:list", []);
  const [editing, setEditing] = useState<TunnelDef | null>(null);
  const [serverFilter, setServerFilter] = useState("all");
  const [query, setQuery] = useState("");

  const load = useCallback(() => api.tunnels().then(setList), []);
  usePolling(load, 3000, []);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
    load();
  };

  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "serveur supprimé";

  const create = async (preset?: (typeof PRESETS)[number]) => {
    const remotePort = preset?.port ?? 3306;
    const port = await api.tunnelFreePort(10000 + remotePort).catch(() => 10000 + remotePort);
    const serverId = serverFilter !== "all" ? serverFilter : (activeServerId ?? servers[0].id);
    setEditing({ id: "", serverId, name: preset ? `${preset.label.split(" ")[0]} ${serverName(serverId)}` : "", localPort: port, remoteHost: "127.0.0.1", remotePort, autoStart: false });
  };

  const copy = (t: TunnelView) => {
    const c = connectionString(t);
    void writeClipboard(c.text);
    notify(`${c.label} copiée : ${c.text}`, "success");
  };

  const remove = async (t: TunnelView) => {
    if (await ask({ title: `Supprimer le tunnel « ${t.name || t.localPort} » ?`, body: t.running ? "Il est actif : les connexions en cours seront coupées." : undefined, confirmLabel: "Supprimer", danger: true })) {
      await run(() => api.tunnelDelete(t.id));
    }
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter(
      (t) => (serverFilter === "all" || t.serverId === serverFilter) && (!q || `${t.name} ${t.localPort} ${t.remoteHost}:${t.remotePort}`.toLowerCase().includes(q)),
    );
  }, [list, serverFilter, query]);

  const active = list.filter((t) => t.running).length;
  const failing = list.filter((t) => t.lastError).length;
  const usedServers = [...new Set(list.map((t) => t.serverId))];

  const columns: Column<TunnelView>[] = [
    {
      key: "name",
      header: "Tunnel",
      sortValue: (t) => (t.name || `${t.remoteHost}:${t.remotePort}`).toLowerCase(),
      render: (t) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={t.lastError ? "danger" : t.running ? "ok" : "muted"} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{t.name || `${t.remoteHost}:${t.remotePort}`}</span>
            <span className="block truncate text-xs text-muted">
              {serverName(t.serverId)}
              {t.autoStart ? " · démarre avec Zenytt" : ""}
            </span>
          </span>
        </span>
      ),
    },
    { key: "local", header: "Sur ton PC", width: "150px", sortValue: (t) => t.localPort, render: (t) => <span className="font-mono text-xs">127.0.0.1:{t.localPort}</span> },
    {
      key: "remote",
      header: "Vers (depuis le serveur)",
      width: "minmax(0,0.8fr)",
      sortValue: (t) => t.remotePort,
      render: (t) => (
        <span className="truncate font-mono text-xs text-muted">
          {t.remoteHost}:{t.remotePort}
        </span>
      ),
    },
    {
      key: "state",
      header: "État",
      width: "minmax(0,0.9fr)",
      sortValue: (t) => (t.running ? 0 : 1),
      render: (t) =>
        t.lastError ? (
          <span className="truncate text-xs text-danger" title={t.lastError}>
            {t.lastError}
          </span>
        ) : t.running ? (
          <Badge tone="ok">
            actif · {t.activeConnections} connexion{t.activeConnections > 1 ? "s" : ""}
          </Badge>
        ) : (
          <Badge>arrêté</Badge>
        ),
    },
  ];

  const menu = (t: TunnelView): MenuItem[] => {
    const c = connectionString(t);
    return [
      t.running
        ? { label: "Arrêter", icon: <Square size={14} />, onClick: () => void run(() => api.tunnelStop(t.id)) }
        : { label: "Démarrer", icon: <Play size={14} />, onClick: () => void run(() => api.tunnelStart(t.id)) },
      { label: `Copier : ${c.label.toLowerCase()}`, icon: <TerminalIcon size={14} />, onClick: () => copy(t) },
      ...(c.url ? [{ label: "Ouvrir dans le navigateur", icon: <ExternalLink size={14} />, onClick: () => void openUrl(c.url!) }] : []),
      "separator",
      { label: "Modifier…", icon: <Pencil size={14} />, onClick: () => setEditing(t) },
      {
        label: "Dupliquer…",
        icon: <CopyPlus size={14} />,
        onClick: async () => setEditing({ ...t, id: "", name: `${t.name} (copie)`, localPort: await api.tunnelFreePort(t.localPort + 1).catch(() => t.localPort + 1) }),
      },
      "separator",
      { label: "Supprimer…", icon: <Trash2 size={14} />, danger: true, onClick: () => void remove(t) },
    ];
  };

  return (
    <PageLayout
      title="Tunnels SSH"
      subtitle="Accède depuis ton PC à un service du serveur sans l'exposer sur Internet."
      guide="tunnels"
      scroll={list.length === 0}
      status={
        list.length > 0 && (
          <>
            <Badge tone={active ? "ok" : "muted"}>
              {active} actif{active > 1 ? "s" : ""} sur {list.length}
            </Badge>
            {failing > 0 && <Badge tone="danger">{failing} en erreur</Badge>}
            <span className="text-xs text-muted">N'écoutent que sur 127.0.0.1 · la connexion SSH s'ouvre à la première utilisation.</span>
          </>
        )
      }
      toolbar={
        list.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative w-64">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
              <Input className="pl-8" placeholder="Filtrer : nom, port" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            {usedServers.length > 1 && (
              <Select
                className="w-52"
                aria-label="Serveur"
                value={serverFilter}
                onChange={setServerFilter}
                options={[{ value: "all", label: "Tous les serveurs" }, ...usedServers.map((id) => ({ value: id, label: serverName(id) }))]}
              />
            )}
          </div>
        )
      }
      actions={
        <Button variant="primary" icon={<Plus size={14} />} disabled={!servers.length} onClick={() => void create()}>
          Nouveau tunnel
        </Button>
      }
    >
      {list.length === 0 ? (
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-7 py-10">
          <EmptyState icon={<Cable />} title="Aucun tunnel">
            Exemple : ta base MySQL écoute sur le port 3306 du serveur. Un tunnel la rend accessible sur <span className="font-mono">127.0.0.1:13306</span> de ton PC,
            chiffrée par SSH, sans ouvrir de port sur Internet.
          </EmptyState>
          {servers.length > 0 && (
            <Card className="flex flex-col gap-3">
              <p className="text-xs font-medium text-muted">Démarrer depuis un service courant</p>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button key={p.id} size="sm" onClick={() => void create(p)}>
                    {p.label} <span className="font-mono text-faint">:{p.port}</span>
                  </Button>
                ))}
              </div>
            </Card>
          )}
        </div>
      ) : (
        <DataTable
          className="min-h-0 flex-1"
          rows={rows}
          rowKey={(t) => t.id}
          columns={columns}
          rowHeight={52}
          initialSort={{ key: "name", dir: "asc" }}
          onRowDoubleClick={(t) => setEditing(t)}
          actionsWidth={112}
          rowActions={(t) => (
            <>
              {t.running ? (
                <IconButton size="sm" title="Arrêter" onClick={() => void run(() => api.tunnelStop(t.id))}>
                  <Square size={13} />
                </IconButton>
              ) : (
                <IconButton size="sm" title="Démarrer" onClick={() => void run(() => api.tunnelStart(t.id))}>
                  <Play size={14} />
                </IconButton>
              )}
              <IconButton size="sm" title={`Copier : ${connectionString(t).text}`} onClick={() => copy(t)}>
                <TerminalIcon size={14} />
              </IconButton>
            </>
          )}
          rowMenu={menu}
          empty="Aucun tunnel ne correspond au filtre."
        />
      )}
      {editing && (
        <TunnelForm
          initial={editing}
          others={list.filter((x) => x.id !== editing.id)}
          onClose={() => setEditing(null)}
          onSaved={async (id, start) => {
            setEditing(null);
            if (start) await run(() => api.tunnelStart(id));
            else load();
          }}
        />
      )}
    </PageLayout>
  );
}

const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

function TunnelForm({
  initial,
  others = [],
  onClose,
  onSaved,
}: {
  initial: TunnelDef;
  /** Autres tunnels : un port local déjà pris est signalé avant l'enregistrement. */
  others?: TunnelDef[];
  onClose: () => void;
  onSaved: (id: string, start: boolean) => void;
}) {
  const { servers, notify } = useAppPick("servers", "notify");
  const [t, setT] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TunnelDef>(k: K, v: TunnelDef[K]) => setT((x) => ({ ...x, [k]: v }));

  const clash = others.find((o) => o.localPort === t.localPort);
  const errors = {
    remoteHost: t.remoteHost.trim() ? null : "Indique l'hôte à joindre depuis le serveur.",
    remotePort: validPort(t.remotePort) ? null : "Port entre 1 et 65535.",
    localPort: !validPort(t.localPort) ? "Port entre 1 et 65535." : clash ? `Déjà utilisé par « ${clash.name || clash.localPort} ».` : null,
  };
  const invalid = Object.values(errors).some(Boolean) || !t.serverId;

  const save = async (start: boolean) => {
    if (invalid) return;
    setBusy(true);
    try {
      const id = await api.tunnelSave({ ...t, remoteHost: t.remoteHost.trim(), name: t.name.trim() });
      onSaved(id, start);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = async (p: (typeof PRESETS)[number]) => {
    const localPort = await api.tunnelFreePort(10000 + p.port).catch(() => 10000 + p.port);
    const serverName = servers.find((s) => s.id === t.serverId)?.name ?? "";
    setT((x) => ({ ...x, remotePort: p.port, localPort, name: x.name.trim() ? x.name : `${p.label.split(" ")[0]} ${serverName}`.trim() }));
  };

  const preview = validPort(t.localPort) ? connectionString(t) : null;

  return (
    <Modal
      title={t.id ? "Modifier le tunnel" : "Nouveau tunnel"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button disabled={invalid} loading={busy} onClick={() => void save(false)}>
            Enregistrer
          </Button>
          <Button variant="primary" disabled={invalid} loading={busy} onClick={() => void save(true)}>
            Enregistrer et démarrer
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <div className="col-span-2 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <Button key={p.id} type="button" size="sm" variant={t.remotePort === p.port ? "subtle" : "outline"} onClick={() => void applyPreset(p)}>
              {p.label}
            </Button>
          ))}
        </div>
        <Field label="Nom">
          <Input value={t.name} onChange={(e) => set("name", e.target.value)} placeholder="MySQL prod" autoFocus />
        </Field>
        <Field label="Serveur">
          <Select className="w-full" value={t.serverId} onChange={(v) => set("serverId", v)} options={servers.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field label="Hôte, vu depuis le serveur" hint="127.0.0.1 pour un service du serveur, ou l'IP d'un conteneur." error={errors.remoteHost}>
          <Input className="font-mono" value={t.remoteHost} onChange={(e) => set("remoteHost", e.target.value)} />
        </Field>
        <Field label="Port distant" error={errors.remotePort}>
          <Input type="number" min={1} max={65535} value={t.remotePort || ""} onChange={(e) => set("remotePort", Number(e.target.value))} />
        </Field>
        <Field
          label="Port local sur ton PC"
          error={errors.localPort}
          hint={t.localPort > 0 && t.localPort < 1024 ? "Sous 1024, le système peut exiger des droits administrateur." : "Tu te connecteras à 127.0.0.1 sur ce port."}
        >
          <Input type="number" min={1} max={65535} value={t.localPort || ""} onChange={(e) => set("localPort", Number(e.target.value))} />
        </Field>
        <div className="self-center">
          <Checkbox checked={t.autoStart} onChange={(v) => set("autoStart", v)} label="Démarrer au lancement de Zenytt" />
        </div>
        {preview && (
          <div className="col-span-2 rounded-md border border-border bg-subtle px-3 py-2 text-xs">
            <span className="text-muted">{preview.label} : </span>
            <span className="font-mono select-text">{preview.text}</span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
