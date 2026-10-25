import { useMemo, useState } from "react";
import { Cable, Lock, Pencil, Play, RotateCw, ScrollText, SquareTerminal, Trash2 } from "lucide-react";
import { api, errorMessage, type ComposeProject, type Container, type DockerOverview } from "../../lib/api";
import { containerKey } from "../../lib/compose";
import { useApp } from "../../lib/store";
import { startDrag } from "../../lib/drag";
import { askFolderName, toggleCollapsed } from "../../components/Folders";
import { tunnelTo, RestrictPortDialog } from "../../components/DockerExtras";
import { Badge, DataTable, IconButton, MenuButton, StatusDot, useContextMenu, type Column } from "../../components/ui";
import ContainerDrawer from "./ContainerDrawer";
import ConditionBadge from "./ConditionBadge";
import { useContainerActions, useContainerFolders, useContainerStats } from "./shared";
import PortChips, { isExposed } from "./PortChips";
import { containerMenu } from "./containerMenu";

export type StateFilter = "all" | "running" | "stopped";

/** Filtre texte (nom, image, projet, port) et état d'un conteneur, partagés par le tableau et les cartes. */
export function containerMatches(c: Container, filter: string, state: StateFilter) {
  const f = filter.toLowerCase();
  return (
    (state === "all" || (state === "running" ? c.state === "running" : c.state !== "running")) &&
    (!f || c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || (c.composeProject ?? "").toLowerCase().includes(f) || c.ports.some((p) => String(p.hostPort).includes(f)))
  );
}

/** Tableau des conteneurs (affichages « par dossier » et « sans groupe » de l'onglet Applications). */
export default function Containers({
  serverId,
  data,
  docker,
  reload,
  filter,
  state,
  groupBy,
}: {
  serverId: string;
  data: DockerOverview;
  docker: string;
  reload: () => Promise<void>;
  filter: string;
  state: StateFilter;
  groupBy: "folder" | "none";
}) {
  const stats = useContainerStats(serverId);
  const { busy, act: runAction, shell, logs } = useContainerActions(serverId, docker, reload, data.projects);
  const occasional = new Set(data.occasional);
  const onPurpose = new Set(data.onPurpose ?? []);
  const setOnPurpose = async (c: Container, value: boolean) => {
    try {
      await api.dockerOnPurposeSet(serverId, [containerKey(c)], value);
      await reload();
    } catch (e) {
      useApp.getState().notify(errorMessage(e), "error");
    }
  };
  const setOccasional = async (c: Container, value: boolean) => {
    try {
      await api.dockerOccasionalSet(serverId, containerKey(c), value);
      await reload();
    } catch (e) {
      useApp.getState().notify(errorMessage(e), "error");
    }
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restrict, setRestrict] = useState<{ project: ComposeProject; port: number } | null>(null);
  const collapsed = useApp((s) => s.folders.collapsed);
  const folders = useContainerFolders(serverId);
  const portMenu = useContextMenu();

  const groupOf = (c: Container) => (groupBy === "folder" ? folders.folderOf(c.name) : "");
  const rows = useMemo(() => {
    const list = data.containers.filter((c) => containerMatches(c, filter, state));
    if (groupBy === "none") return list;
    // Groupes nommés d'abord (ordre alphabétique), « sans groupe » à la fin.
    return [...list].sort((a, b) => {
      const ga = groupOf(a) || "￿";
      const gb = groupOf(b) || "￿";
      return ga.localeCompare(gb, "fr") || a.name.localeCompare(b.name, "fr");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filter, state, groupBy, folders.folderOf]);


  const act = async (c: Container, action: string) => {
    if ((await runAction(c, action)) && action === "remove") setSelectedId(null);
  };
  const projectOf = (c: Container) => data.projects.find((x) => x.name === c.composeProject);

  const rowMenu = (c: Container) => containerMenu(c, { act: (x, a) => void act(x, a), shell, logs, details: (x) => setSelectedId(x.id), folders });

  const columns: Column<Container>[] = [
    {
      key: "name",
      header: "Conteneur",
      width: "minmax(0,1.3fr)",
      sortValue: (c) => c.name,
      render: (c) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={c.state === "running" ? "ok" : c.state === "paused" || c.state === "restarting" ? "warn" : c.state === "dead" ? "danger" : "muted"} className="size-2!" />
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{c.name}</span>
              {occasional.has(containerKey(c)) && <Badge tone="muted">ponctuel</Badge>}
              <ConditionBadge c={c} onPurpose={onPurpose.has(containerKey(c))} occasional={occasional.has(containerKey(c))} />
            </span>
            <span className="block truncate text-[11.5px] text-muted">{c.status}</span>
          </span>
        </span>
      ),
    },
    { key: "image", header: "Image", width: "minmax(0,1.1fr)", sortValue: (c) => c.image, render: (c) => <span className="font-mono text-xs text-fg/80" title={c.image}>{c.image}</span> },
    {
      key: "ports",
      header: "Ports",
      width: "minmax(0,1.1fr)",
      render: (c) =>
        c.ports.length === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <PortChips
            ports={c.ports}
            onPortClick={(p, e) => {
              const project = projectOf(c);
              portMenu.open(e, [
                { heading: `Port ${p.hostPort}` },
                ...(p.protocol === "tcp" ? [{ label: "Ouvrir un tunnel depuis mon PC", icon: <Cable size={14} />, onClick: () => void tunnelTo(serverId, c, p.hostPort) }] : []),
                ...(isExposed(p) && project ? [{ label: "Restreindre à 127.0.0.1…", icon: <Lock size={14} />, onClick: () => setRestrict({ project, port: p.hostPort }) }] : []),
              ]);
            }}
          />
        ),
    },
    {
      key: "cpu",
      header: "CPU",
      width: "100px",
      sortValue: (c) => stats[c.id]?.cpu ?? -1,
      render: (c) => {
        const s = stats[c.id];
        if (!s || c.state !== "running") return <span className="text-faint">—</span>;
        return (
          <span className="flex items-center gap-2">
            <span className="h-1 w-10 overflow-hidden rounded-full bg-hover-strong">
              <span className="block h-full bg-accent" style={{ width: `${Math.min(100, s.cpu)}%` }} />
            </span>
            <span className="text-xs tabular-nums">{s.cpu.toFixed(1)} %</span>
          </span>
        );
      },
    },
    {
      key: "mem",
      header: "Mémoire",
      width: "90px",
      sortValue: (c) => stats[c.id]?.memPercent ?? -1,
      render: (c) => {
        const s = stats[c.id];
        return s && c.state === "running" ? (
          <span className="text-xs text-muted tabular-nums" title={s.memUsage}>
            {s.memUsage.split(" / ")[0]}
          </span>
        ) : (
          <span className="text-faint">—</span>
        );
      },
    },
  ];

  const selected = data.containers.find((c) => c.id === selectedId);
  const groupLabel = (k: string) => k || "Sans dossier";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DataTable
        className="min-h-0 flex-1"
        rows={rows}
        rowKey={(c) => c.id}
        columns={columns}
        rowHeight={48}
        isSelected={(c) => c.id === selectedId}
        onRowClick={(c) => setSelectedId(c.id === selectedId ? null : c.id)}
        onRowMouseDown={groupBy === "folder" ? (c, e) => startDrag(e, c.name, (folder) => folders.move([c.name], folder || null)) : undefined}
        actionsWidth={128}
        rowActions={(c) => (
          <>
            <IconButton size="sm" title="Logs en direct" onClick={() => logs(c)}>
              <ScrollText size={14} />
            </IconButton>
            {c.state === "running" ? (
              <>
                <IconButton size="sm" title="Shell dans le conteneur" onClick={() => shell(c)}>
                  <SquareTerminal size={14} />
                </IconButton>
                <IconButton size="sm" title="Redémarrer" disabled={!!busy} onClick={() => void act(c, "restart")}>
                  <RotateCw size={14} className={busy === c.id ? "animate-spin" : ""} />
                </IconButton>
              </>
            ) : (
              <IconButton size="sm" title={c.state === "paused" ? "Reprendre" : "Démarrer"} disabled={!!busy} onClick={() => void act(c, c.state === "paused" ? "unpause" : "start")}>
                <Play size={14} />
              </IconButton>
            )}
          </>
        )}
        rowMenu={rowMenu}
        groupBy={
          groupBy === "none"
            ? undefined
            : {
                key: groupOf,
                collapsed: (k) => collapsed.includes(`docker:${serverId}:${groupBy}:${k}`),
                header: (k, list) => {
                  const collapseKey = `docker:${serverId}:${groupBy}:${k}`;
                  const isCollapsed = collapsed.includes(collapseKey);
                  const run = list.filter((c) => c.state === "running").length;
                  return (
                    <div data-drop={groupBy === "folder" ? k : undefined} className="flex h-9 items-center gap-2 border-b border-line bg-subtle px-3 text-xs text-muted">
                      <button type="button" onClick={() => toggleCollapsed(collapseKey)} aria-expanded={!isCollapsed} className="flex min-w-0 items-center gap-2">
                        <span className={`inline-block transition-transform ${isCollapsed ? "-rotate-90" : ""}`}>▾</span>
                        <span className={`truncate font-semibold ${k ? "text-fg" : ""}`}>{groupLabel(k)}</span>
                      </button>
                      <span className="ml-auto">
                        {run} / {list.length} en cours
                      </span>
                      {groupBy === "folder" && k && (
                        <MenuButton
                          size="sm"
                          title={`Dossier ${k}`}
                          items={[
                            {
                              label: "Renommer…",
                              icon: <Pencil size={14} />,
                              onClick: async () => {
                                const next = await askFolderName(`Renommer « ${k} »`, k);
                                if (next && next !== k) folders.rename(k, next);
                              },
                            },
                            { label: "Supprimer le dossier", icon: <Trash2 size={14} />, danger: true, onClick: () => folders.remove(k) },
                          ]}
                        />
                      )}
                    </div>
                  );
                },
              }
        }
        empty={filter || state !== "all" ? "Aucun conteneur ne correspond aux filtres." : "Aucun conteneur sur ce serveur."}
      />
      {portMenu.menu}
      {selected && (
        <ContainerDrawer
          key={selected.id}
          serverId={serverId}
          container={selected}
          stats={stats[selected.id]}
          project={projectOf(selected)}
          onClose={() => setSelectedId(null)}
          onAction={(a) => void act(selected, a)}
          onShell={() => shell(selected)}
          onLogs={() => logs(selected)}
          onTunnel={(port) => void tunnelTo(serverId, selected, port)}
          onRestrict={(port) => {
            const project = projectOf(selected);
            if (project) setRestrict({ project, port });
          }}
          occasional={occasional.has(containerKey(selected))}
          onOccasional={(v) => void setOccasional(selected, v)}
          onPurpose={onPurpose.has(containerKey(selected))}
          onOnPurpose={(v) => void setOnPurpose(selected, v)}
        />
      )}
      {restrict && (
        <RestrictPortDialog
          serverId={serverId}
          project={restrict.project}
          port={restrict.port}
          onClose={() => setRestrict(null)}
          onDone={() => {
            setRestrict(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
