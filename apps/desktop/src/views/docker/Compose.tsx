import { lazy, Suspense, useState } from "react";
import { Cable, Tag, FileCode2, FolderSearch, GitBranch, Layers, Lock, Package, Play, Plus, Rocket, RotateCw, ScrollText, Square, SquareTerminal, UploadCloud } from "lucide-react";
import { api, errorMessage, type ComposeProject, type Container, type DockerOverview } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, EmptyState, IconButton, MenuButton, Modal, StatusDot, useContextMenu, type MenuItem } from "../../components/ui";
import { deployProject, GithubDeployDialog, RestrictPortDialog, tunnelTo } from "../../components/DockerExtras";
import ContainerDrawer from "./ContainerDrawer";
import ConditionBadge from "./ConditionBadge";
import PortChips, { isExposed } from "./PortChips";
import { stateTone, useContainerActions, useContainerStats } from "./shared";
import { containerKey, projectCounts, projectDir, projectNameFromPath } from "../../lib/compose";
import { composeLockKey, confirmDestructive, groupByClient, useItemFolders, useLocks } from "../../lib/folders";
import { ClientFilter, clientMenuItems } from "../../components/ClientTools";

const FileEditor = lazy(() => import("../../components/FileEditor"));
const ComposeFileDialog = lazy(() => import("../../components/ComposeFileDialog"));

/** Colonnes d'une ligne de service : nom et état, image, ports, CPU, mémoire, actions. */
const STOP_WARNING = "Tous les conteneurs du projet seront arrêtés, sans être supprimés : « Démarrer » les relance. Cet arrêt étant voulu, ils ne seront pas signalés comme tombés.";

const SERVICE_GRID ="grid grid-cols-[minmax(140px,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_64px_72px_96px] items-center gap-3";

export default function Compose({ serverId, data, docker, reload, onNew, onCatalog }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void>; onNew: () => void; onCatalog: () => void }) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
  const stats = useContainerStats(serverId);
  const containerActions = useContainerActions(serverId, docker, reload, data.projects);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [github, setGithub] = useState<ComposeProject | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restrict, setRestrict] = useState<{ project: ComposeProject; port: number } | null>(null);
  /** Nouveau fichier compose choisi pour un projet dont le fichier a disparu. */
  const [relinkFile, setRelinkFile] = useState<string | null>(null);
  const portMenu = useContextMenu();
  const clients = useItemFolders("compose", serverId);
  const locks = useLocks(serverId);
  const [clientFilter, setClientFilter] = useState("");
  const lockOf = (p: ComposeProject) => composeLockKey(p);
  if (data.projects.length === 0) {
    return (
      <EmptyState
        icon={<Layers />}
        title="Aucun projet docker compose"
        action={
          <>
            <Button variant="primary" icon={<Plus size={14} />} onClick={onNew}>
              Nouveau projet
            </Button>
            <Button icon={<Package size={14} />} onClick={onCatalog}>
              Catalogue d'applications
            </Button>
          </>
        }
      >
        Les projets lancés avec docker compose apparaîtront ici. Le catalogue propose des applications prêtes à l'emploi (n8n, Uptime Kuma, Vaultwarden…).
      </EmptyState>
    );
  }

  const act = async (p: ComposeProject, action: string, label: string, danger?: string) => {
    const locked = locks.isLocked(lockOf(p));
    // Un projet verrouillé demande une confirmation (nom à retaper) pour toute action qui interrompt le service.
    if (danger || (locked && ["stop", "down", "rebuild", "restart", "remove"].includes(action))) {
      const ok = await confirmDestructive({ title: `${label} « ${p.name} » ?`, body: danger ?? "Le service sera brièvement interrompu.", confirmLabel: label, name: p.name, locked });
      if (!ok) return;
    }
    setBusy(`${p.name}:${action}`);
    try {
      const out = await api.composeAction(serverId, p, action);
      setOutput({ title: `${p.name} — ${label}`, text: out || "Terminé." });
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const containersOf = (name: string) => data.containers.filter((c) => c.composeProject === name).sort((a, b) => (a.composeService ?? a.name).localeCompare(b.composeService ?? b.name, "fr"));
  const projectOf = (c: Container) => data.projects.find((x) => x.name === c.composeProject);

  /** Projet dont le fichier a disparu : on demande où il se trouve maintenant, puis le dialogue
   *  du fichier propose de remplacer l'ancien projet par celui-ci. */
  const relink = async (p: ComposeProject) => {
    const old = p.configFiles.split(",")[0];
    const path = await ask({
      title: `Relier « ${p.name} » à son nouveau dossier`,
      body: `Docker cherchait ${old}, qui n'existe plus. Indique le chemin complet du fichier compose à son nouvel emplacement.`,
      input: { label: "Fichier compose", initial: old },
      confirmLabel: "Continuer",
    });
    if (typeof path === "string" && path.trim()) setRelinkFile(path.trim());
  };

  /** Sans fichier, seules les actions qui se font par le nom du projet restent possibles. */
  const organise = (p: ComposeProject): MenuItem[] => [...clientMenuItems(clients, projectDir(p), locks.isLocked(lockOf(p)), () => locks.toggle(lockOf(p))), "separator"];

  const missingItems = (p: ComposeProject): MenuItem[] => [
    ...organise(p),
    { label: "Relier au nouveau dossier…", icon: <FolderSearch size={14} />, onClick: () => void relink(p) },
    "separator",
    { label: "Arrêter (stop)", icon: <Square size={14} />, onClick: () => void act(p, "stop", "Arrêter") },
    {
      label: "Arrêter et supprimer (down)…",
      icon: <Square size={14} />,
      danger: true,
      onClick: () => void act(p, "down", "Arrêter et supprimer (down)", "Les conteneurs du projet seront arrêtés et supprimés (les volumes nommés sont conservés)."),
    },
  ];

  const projectItems = (p: ComposeProject, file: string, stopped: boolean): MenuItem[] => [
    ...organise(p),
    { label: "Mettre à jour (pull + up)", icon: <UploadCloud size={14} />, onClick: () => void act(p, "update", "Mettre à jour (pull + up)") },
    ...(stopped ? [] : [{ label: "Démarrer les services manquants (up -d)", icon: <Play size={14} />, onClick: () => void act(p, "up", "Démarrer (up -d)") }]),
    ...(stopped
      ? []
      : [
          {
            label: "Arrêter tous les services (stop)",
            hint: "conteneurs conservés",
            icon: <Square size={14} />,
            onClick: () => void act(p, "stop", "Arrêter", STOP_WARNING),
          },
        ]),
    {
      label: "Reconstruire complètement…",
      hint: "down + build + up",
      icon: <RotateCw size={14} />,
      danger: true,
      onClick: () =>
        void act(
          p,
          "rebuild",
          "Reconstruire complètement",
          "Le projet sera arrêté, les images seront récupérées, les services seront reconstruits puis redémarrés. Les volumes nommés sont conservés, mais le service sera indisponible pendant l'opération.",
        ),
    },
    "separator",
    { label: "Éditer le compose.yml", icon: <FileCode2 size={14} />, onClick: () => setEditing(file) },
    { label: "Déploiement depuis GitHub…", icon: <GitBranch size={14} />, onClick: () => setGithub(p) },
    "separator",
    {
      label: "Arrêter et supprimer (down)…",
      icon: <Square size={14} />,
      danger: true,
      onClick: () =>
        void act(p, "down", "Arrêter et supprimer (down)", "Les conteneurs du projet seront arrêtés et supprimés (les volumes nommés sont conservés). Le site sera indisponible."),
    },
  ];

  const groups = groupByClient(data.projects, (p) => clients.folderOf(projectDir(p)), clientFilter);

  const selected = data.containers.find((c) => c.id === selectedId);
  const occasional = new Set(data.occasional);
  const onPurpose = new Set(data.onPurpose ?? []);
  const setOnPurpose = async (c: Container, value: boolean) => {
    try {
      await api.dockerOnPurposeSet(serverId, [containerKey(c)], value);
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };
  const setOccasional = async (c: Container, value: boolean) => {
    try {
      await api.dockerOccasionalSet(serverId, containerKey(c), value);
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    // Une colonne tant qu'il n'y a pas la place pour deux projets lisibles côte à côte.
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,640px),1fr))] items-start gap-4 px-7 py-5">
      {clients.names.length > 0 && (
        <div className="col-span-full flex items-center gap-2">
          <ClientFilter names={clients.names} value={clientFilter} onChange={setClientFilter} />
        </div>
      )}
      {groups.flatMap(([client, list]) => [
        clients.names.length > 0 ? (
          <h3 key={`client:${client}`} className="col-span-full flex items-center gap-1.5 text-xs font-medium text-muted">
            <Tag size={12} /> {client || "Sans client"}
          </h3>
        ) : null,
        ...list.map((p) => {
        const file = p.configFiles.split(",")[0];
        const b = (a: string) => busy === `${p.name}:${a}`;
        const services = containersOf(p.name);
        const enMarche = services.filter((c) => c.state === "running").length;
        const arrete = services.length > 0 && enMarche === 0;
        // Les conteneurs ponctuels ne comptent pas : seul le « migrator » arrêté ne rend pas le projet incomplet.
        const counts = projectCounts(services, occasional);
        const cpu = services.reduce((n, c) => n + (stats[c.id]?.cpu ?? 0), 0);
        return (
          <section key={p.name} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-panel">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
              <Layers size={16} className="shrink-0 text-accent" />
              {/* Largeur minimale : les boutons passent à la ligne plutôt que d'écraser le nom du projet. */}
              <div className="min-w-[min(100%,18rem)] flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-semibold" title={p.name}>
                    {p.name}
                  </span>
                  <Badge tone={counts.running === 0 ? "muted" : counts.running === counts.expected ? "ok" : "warn"}>
                    {services.length > 0 ? `${counts.running}/${counts.expected} en cours` : p.status}
                  </Badge>
                  {counts.occasional > 0 && (
                    <Badge tone="muted" title="Conteneurs ponctuels : leur arrêt n'est pas signalé">
                      +{counts.occasional} ponctuel{counts.occasional > 1 ? "s" : ""}
                    </Badge>
                  )}
                  {locks.isLocked(lockOf(p)) && (
                    <Badge tone="warn" title="Verrouillé : actions destructrices à confirmer en retapant le nom">
                      <Lock size={10} /> verrouillé
                    </Badge>
                  )}
                  {clients.folderOf(projectDir(p)) && <Badge title="Client">{clients.folderOf(projectDir(p))}</Badge>}
                  {projectNameFromPath(projectDir(p)) !== p.name && (
                    <Badge tone="muted" title={`Le dossier ${projectDir(p)} ne porte pas le nom du projet compose (-p ${p.name})`}>
                      dossier « {projectDir(p).split("/").pop() || "/"} »
                    </Badge>
                  )}
                  {p.missing && (
                    <Badge tone="warn" title="Le dossier du projet a sans doute été renommé, déplacé ou supprimé">
                      Fichier introuvable
                    </Badge>
                  )}
                  {enMarche > 0 && <span className="shrink-0 text-xs text-muted tabular-nums">CPU {cpu.toFixed(1)} %</span>}
                </div>
                {p.missing ? (
                  <span className="block max-w-full truncate font-mono text-xs text-faint" title={`${p.configFiles}\nCe fichier n'existe plus`}>
                    Ancien fichier : {file}
                  </span>
                ) : (
                  <button type="button" className="block max-w-full truncate font-mono text-xs text-muted hover:text-accent" title={`${p.configFiles}\nClic : éditer le fichier`} onClick={() => setEditing(file)}>
                    {file}
                  </button>
                )}
              </div>
              {/* Les actions courantes en clair, le reste rangé derrière « … ». */}
              <div className="flex shrink-0 items-center gap-1.5">
                {p.missing ? (
                  <Button size="sm" variant="primary" icon={<FolderSearch size={12} />} title="Retrouver le fichier compose à son nouvel emplacement et relancer le projet depuis là" onClick={() => void relink(p)}>
                    Relier au nouveau dossier
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" icon={<Rocket size={12} />} title="Nouvelles images, redémarrage, vérification, et retour à la version précédente si elle échoue" onClick={() => void deployProject(serverId, p)}>
                    Déployer
                  </Button>
                )}
                {arrete && !p.missing ? (
                  <Button size="sm" icon={<Play size={12} />} loading={b("up")} onClick={() => void act(p, "up", "Démarrer (up -d)")}>
                    Démarrer
                  </Button>
                ) : (
                  <>
                    <Button size="sm" icon={<RotateCw size={12} />} loading={b("restart")} onClick={() => void act(p, "restart", "Redémarrer")}>
                      Redémarrer
                    </Button>
                    {enMarche > 0 && (
                      <Button size="sm" icon={<Square size={12} />} loading={b("stop")} title="Arrête tous les conteneurs du projet, sans les supprimer" onClick={() => void act(p, "stop", "Arrêter", STOP_WARNING)}>
                        Arrêter
                      </Button>
                    )}
                  </>
                )}
                <Button
                  size="sm"
                  icon={<ScrollText size={12} />}
                  title="Logs de tous les services, en direct"
                  onClick={async () =>
                    openTab(serverId, {
                      title: `${p.name} (logs)`,
                      command: (await api.composeCommand(p, "logs -f --tail 200")).replace(/^docker /, `${docker} `),
                    })
                  }
                >
                  Logs
                </Button>
                <MenuButton size="sm" title="Autres actions" items={() => (p.missing ? missingItems(p) : projectItems(p, file, arrete))} />
              </div>
            </header>

            {services.length > 0 ? (
              <div className="overflow-x-auto">
                <div className="min-w-[620px]">
                  <div className={`${SERVICE_GRID} border-b border-line bg-subtle px-4 py-1.5 text-[11px] font-medium text-muted`}>
                    <span>Service</span>
                    <span>Image</span>
                    <span>Ports</span>
                    <span className="text-right">CPU</span>
                    <span className="text-right">Mémoire</span>
                    <span />
                  </div>
                  <ul className="flex flex-col divide-y divide-line">
                    {services.map((c) => {
                      const running = c.state === "running";
                      const s = running ? stats[c.id] : undefined;
                      return (
                        <li
                          key={c.id}
                          className={`group ${SERVICE_GRID} cursor-pointer px-4 py-2 text-[13px] hover:bg-hover-soft ${c.id === selectedId ? "bg-hover-soft" : ""}`}
                          onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <StatusDot tone={stateTone(c.state)} className="size-2!" />
                            <span className="min-w-0">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate font-medium">{c.composeService ?? c.name}</span>
                                {occasional.has(containerKey(c)) && <Badge tone="muted">ponctuel</Badge>}
              <ConditionBadge c={c} onPurpose={onPurpose.has(containerKey(c))} occasional={occasional.has(containerKey(c))} />
                              </span>
                              <span className="block truncate text-[11.5px] text-muted">{c.status}</span>
                            </span>
                          </span>
                          <span className="truncate font-mono text-xs text-fg/80" title={c.image}>
                            {c.image.split("@")[0]}
                          </span>
                          <PortChips
                            ports={c.ports}
                            onPortClick={(port, e) =>
                              portMenu.open(e, [
                                { heading: `Port ${port.hostPort}` },
                                ...(port.protocol === "tcp" ? [{ label: "Ouvrir un tunnel depuis mon PC", icon: <Cable size={14} />, onClick: () => void tunnelTo(serverId, c, port.hostPort) }] : []),
                                ...(isExposed(port) ? [{ label: "Restreindre à 127.0.0.1…", icon: <Lock size={14} />, onClick: () => setRestrict({ project: p, port: port.hostPort }) }] : []),
                              ])
                            }
                          />
                          <span className="text-right text-xs tabular-nums">{s ? `${s.cpu.toFixed(1)} %` : <span className="text-faint">—</span>}</span>
                          <span className="truncate text-right text-xs text-muted tabular-nums" title={s?.memUsage}>
                            {s ? s.memUsage.split(" / ")[0] : <span className="text-faint">—</span>}
                          </span>
                          <span className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <IconButton size="sm" title="Logs en direct" onClick={() => containerActions.logs(c)}>
                              <ScrollText size={14} />
                            </IconButton>
                            {running ? (
                              <>
                                <IconButton size="sm" title="Shell dans le conteneur" onClick={() => containerActions.shell(c)}>
                                  <SquareTerminal size={14} />
                                </IconButton>
                                <IconButton size="sm" title="Redémarrer ce service" disabled={!!containerActions.busy} onClick={() => void containerActions.act(c, "restart")}>
                                  <RotateCw size={14} className={containerActions.busy === c.id ? "animate-spin" : ""} />
                                </IconButton>
                                <IconButton size="sm" title="Arrêter ce service" disabled={!!containerActions.busy} onClick={() => void containerActions.act(c, "stop")}>
                                  <Square size={13} />
                                </IconButton>
                              </>
                            ) : (
                              <IconButton size="sm" title="Démarrer ce service" disabled={!!containerActions.busy} onClick={() => void containerActions.act(c, "start")}>
                                <Play size={14} />
                              </IconButton>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted">Aucun conteneur pour ce projet : « Démarrer » le lance (up -d).</p>
            )}
          </section>
        );
        }),
      ])}
      {portMenu.menu}
      {relinkFile && (
        <Suspense fallback={null}>
          <ComposeFileDialog
            serverId={serverId}
            file={relinkFile}
            onClose={() => {
              setRelinkFile(null);
              void reload();
            }}
          />
        </Suspense>
      )}
      {selected && (
        <ContainerDrawer
          key={selected.id}
          serverId={serverId}
          container={selected}
          stats={stats[selected.id]}
          project={projectOf(selected)}
          onClose={() => setSelectedId(null)}
          onAction={(a) => void containerActions.act(selected, a).then((ok) => ok && a === "remove" && setSelectedId(null))}
          onShell={() => containerActions.shell(selected)}
          onLogs={() => containerActions.logs(selected)}
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
      {output && (
        <Modal title={output.title} width="max-w-3xl" onClose={() => setOutput(null)}>
          <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-term p-3 font-mono text-xs whitespace-pre-wrap select-text">{output.text}</pre>
        </Modal>
      )}
      {editing && (
        <Suspense fallback={null}>
          <FileEditor serverId={serverId} path={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
      {github && <GithubDeployDialog serverId={serverId} project={github} onClose={() => setGithub(null)} />}
    </div>
  );
}
