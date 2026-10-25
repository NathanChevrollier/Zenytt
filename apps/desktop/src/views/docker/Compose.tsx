import { lazy, Suspense, useState } from "react";
import { Box, Cable, ChevronRight, Tag, FileCode2, FolderSearch, GitBranch, Layers, Lock, Package, Play, Plus, Rocket, RotateCw, ScrollText, Square, SquareTerminal, UploadCloud } from "lucide-react";
import { api, errorMessage, formatBytes, type ComposeProject, type Container, type DockerOverview } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, IconButton, MenuButton, Modal, StatusDot, useContextMenu, type MenuItem } from "../../components/ui";
import { deployProject, GithubDeployDialog, RestrictPortDialog, tunnelTo } from "../../components/DockerExtras";
import ContainerDrawer from "./ContainerDrawer";
import ConditionBadge from "./ConditionBadge";
import PortChips, { isExposed } from "./PortChips";
import { openComposeLogs, stateTone, useContainerActions, useContainerFolders, useContainerStats } from "./shared";
import { containerMatches, type StateFilter } from "./Containers";
import { containerMenu } from "./containerMenu";
import { containerKey, memBytes, projectCounts, projectDir, projectNameFromPath } from "../../lib/compose";
import { composeLockKey, confirmDestructive, groupByClient, NO_CLIENT, useItemFolders, useLocks } from "../../lib/folders";
import { clientGroupItems, clientMenuItems } from "../../components/ClientTools";

const FileEditor = lazy(() => import("../../components/FileEditor"));
const ComposeFileDialog = lazy(() => import("../../components/ComposeFileDialog"));

const STOP_WARNING = "Tous les conteneurs du projet seront arrêtés, sans être supprimés : « Démarrer » les relance. Cet arrêt étant voulu, ils ne seront pas signalés comme tombés.";

/** Grille des cartes : une colonne, puis deux colonnes larges dès 1180 px de zone. */
const TWO_COLS = "@min-[1180px]:grid-cols-2";
/** Dernière carte d'un nombre impair : elle prend toute la ligne plutôt que de rester seule à gauche. */
const SPAN = "@min-[1180px]:col-span-2";

/** Services d'une carte : service, (image si la carte est assez large), ports, CPU, mémoire, actions. */
const SERVICE_GRID =
  "grid items-center gap-3 grid-cols-[minmax(110px,1fr)_minmax(0,0.9fr)_48px_64px_144px] @min-[640px]:grid-cols-[minmax(130px,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_48px_64px_144px]";
const SVC_WIDE = "hidden @min-[640px]:block";

/** Groupes repliés, retenus le temps de la session (changer d'onglet ne les perd pas). */
const sessionSets = new Map<string, Set<string>>();
function useSessionSet(key: string) {
  const [, bump] = useState(0);
  const set = sessionSets.get(key) ?? new Set<string>();
  const write = (next: Set<string>) => {
    sessionSets.set(key, next);
    bump((n) => n + 1);
  };
  return {
    has: (id: string) => set.has(id),
    toggle: (id: string) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      write(next);
    },
  };
}

/** Cartes par projet compose (onglet Applications), plus une carte « Hors compose » pour les conteneurs isolés. */
export default function Compose({
  serverId,
  data,
  docker,
  reload,
  onNew,
  onCatalog,
  filter: text,
  state,
  clientFilter,
}: {
  serverId: string;
  data: DockerOverview;
  docker: string;
  reload: () => Promise<void>;
  onNew: () => void;
  onCatalog: () => void;
  filter: string;
  state: StateFilter;
  clientFilter: string;
}) {
  const { ask, notify } = useAppPick("ask", "notify");
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
  const folders = useContainerFolders(serverId);
  const collapsedGroups = useSessionSet(`compose:groups:${serverId}`);
  const lockOf = (p: ComposeProject) => composeLockKey(p);
  // État vide compact, sur une ligne : les boutons du bandeau restent aussi disponibles.
  const emptyLine = (
    <div className="flex flex-wrap items-center gap-3 py-1 text-[13px] text-muted">
      <Layers size={16} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate" title="Le catalogue propose des applications prêtes à l'emploi (n8n, Uptime Kuma, Vaultwarden…).">
        Aucun projet docker compose : ceux lancés avec docker compose apparaîtront ici.
      </span>
      <Button size="sm" icon={<Package size={13} />} onClick={onCatalog}>
        Catalogue
      </Button>
      <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={onNew}>
        Nouveau projet
      </Button>
    </div>
  );

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

  const clientOf = (p: ComposeProject) => clients.folderOf(projectDir(p));
  // Un filtre sur un client supprimé ou renommé retombe sur « Tous ».
  const filter = clientFilter === NO_CLIENT || clients.names.includes(clientFilter) ? clientFilter : "";
  const f = text.toLowerCase();
  /** Services listés d'un projet : tous si le nom du projet correspond au filtre, sinon ceux qui correspondent. */
  const listedOf = (p: ComposeProject) => {
    const hit = !f || p.name.toLowerCase().includes(f) || p.configFiles.toLowerCase().includes(f);
    return { hit, list: containersOf(p.name).filter((c) => containerMatches(c, hit ? "" : text, state)) };
  };
  const shown = (p: ComposeProject) => {
    const { hit, list } = listedOf(p);
    return list.length > 0 || (hit && (state === "all" || (state === "stopped" && containersOf(p.name).length === 0)));
  };
  const groups = groupByClient(data.projects.filter(shown), clientOf, filter);
  // Conteneurs lancés hors compose (ou d'un projet que Docker ne liste plus) : carte à part, hors filtre client.
  const loose = filter
    ? []
    : data.containers.filter((c) => !data.projects.some((p) => p.name === c.composeProject) && containerMatches(c, text, state)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const filtering = !!text || state !== "all" || !!filter;

  const containerAct = (c: Container, a: string) => containerActions.act(c, a).then((ok) => ok && a === "remove" && setSelectedId(null));

  const serviceRow = (c: Container, p?: ComposeProject) => {
    const running = c.state === "running";
    const s = running ? stats[c.id] : undefined;
    return (
      <li
        key={c.id}
        className={`group ${SERVICE_GRID} h-8 cursor-pointer px-3 text-[13px] hover:bg-hover-soft ${c.id === selectedId ? "bg-hover-soft" : ""}`}
        onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
      >
        <span className="flex min-w-0 items-center gap-2" title={c.status}>
          <StatusDot tone={stateTone(c.state)} className="size-2!" />
          <span className="truncate font-medium">{p ? (c.composeService ?? c.name) : c.name}</span>
          {occasional.has(containerKey(c)) && <Badge tone="muted">ponctuel</Badge>}
          <ConditionBadge c={c} onPurpose={onPurpose.has(containerKey(c))} occasional={occasional.has(containerKey(c))} />
        </span>
        <span className={`${SVC_WIDE} truncate font-mono text-xs text-fg/80`} title={c.image}>
          {c.image.split("@")[0]}
        </span>
        {/* Ports sur une ligne : la hauteur des lignes reste constante. */}
        <span className="h-[22px] min-w-0 overflow-hidden [&>span]:flex-nowrap" title={c.ports.map((x) => `${x.hostPort}→${x.containerPort}`).join(", ")}>
          <PortChips
            ports={c.ports}
            onPortClick={(port, e) =>
              portMenu.open(e, [
                { heading: `Port ${port.hostPort}` },
                ...(port.protocol === "tcp" ? [{ label: "Ouvrir un tunnel depuis mon PC", icon: <Cable size={14} />, onClick: () => void tunnelTo(serverId, c, port.hostPort) }] : []),
                ...(isExposed(port) && p ? [{ label: "Restreindre à 127.0.0.1…", icon: <Lock size={14} />, onClick: () => setRestrict({ project: p, port: port.hostPort }) }] : []),
              ])
            }
          />
        </span>
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
              <IconButton size="sm" title={p ? "Redémarrer ce service" : "Redémarrer"} disabled={!!containerActions.busy} onClick={() => void containerActions.act(c, "restart")}>
                <RotateCw size={14} className={containerActions.busy === c.id ? "animate-spin" : ""} />
              </IconButton>
              <IconButton size="sm" title={p ? "Arrêter ce service" : "Arrêter"} disabled={!!containerActions.busy} onClick={() => void containerActions.act(c, "stop")}>
                <Square size={13} />
              </IconButton>
            </>
          ) : (
            <IconButton
              size="sm"
              title={c.state === "paused" ? "Reprendre" : p ? "Démarrer ce service" : "Démarrer"}
              disabled={!!containerActions.busy}
              onClick={() => void containerActions.act(c, c.state === "paused" ? "unpause" : "start")}
            >
              <Play size={14} />
            </IconButton>
          )}
          <MenuButton
            size="sm"
            title="Actions du conteneur"
            items={() => containerMenu(c, { act: (x, a) => void containerAct(x, a), shell: containerActions.shell, logs: containerActions.logs, details: (x) => setSelectedId(x.id), folders })}
          />
        </span>
      </li>
    );
  };

  const serviceTable = (rows: Container[], p?: ComposeProject) => (
    <div className="border-t border-border">
      <div className={`${SERVICE_GRID} h-7 border-b border-line bg-subtle px-3 text-[11px] font-medium text-muted`}>
        <span>{p ? "Service" : "Conteneur"}</span>
        <span className={SVC_WIDE}>Image</span>
        <span>Ports</span>
        <span className="text-right">CPU</span>
        <span className="text-right">Mémoire</span>
        <span />
      </div>
      <ul className="flex flex-col divide-y divide-line">{rows.map((c) => serviceRow(c, p))}</ul>
    </div>
  );

  const usage = (list: Container[]) => {
    const cpu = list.reduce((n, c) => n + (stats[c.id]?.cpu ?? 0), 0);
    const mem = list.reduce((n, c) => n + (c.state === "running" && stats[c.id] ? memBytes(stats[c.id].memUsage) : 0), 0);
    return `${cpu.toFixed(1)} % · ${mem > 0 ? formatBytes(mem) : "—"}`;
  };

  const looseCard = () => {
    const run = loose.filter((c) => c.state === "running").length;
    return (
      <section className="@container flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-panel">
        <header className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <Box size={14} className="shrink-0 text-muted" />
              <span className="truncate font-semibold">Hors compose</span>
              <Badge tone={run === 0 ? "muted" : run === loose.length ? "ok" : "warn"} className="shrink-0" title={`${run} en cours sur ${loose.length}`}>
                {run}/{loose.length}
              </Badge>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-3 pl-[22px] text-xs text-muted">
              <span className="min-w-0 flex-1 truncate">Conteneurs lancés sans docker compose (docker run…)</span>
              {run > 0 && (
                <span className="shrink-0 tabular-nums" title="CPU et mémoire de ces conteneurs">
                  {usage(loose)}
                </span>
              )}
            </div>
          </div>
        </header>
        {serviceTable(loose)}
      </section>
    );
  };

  const projectCard = (p: ComposeProject) => {
    const file = p.configFiles.split(",")[0];
    const b = (a: string) => busy === `${p.name}:${a}`;
    const services = containersOf(p.name);
    const listed = listedOf(p).list;
    const enMarche = services.filter((c) => c.state === "running").length;
    const arrete = services.length > 0 && enMarche === 0;
    // Les conteneurs ponctuels ne comptent pas : seul le « migrator » arrêté ne rend pas le projet incomplet.
    const counts = projectCounts(services, occasional);
    const locked = locks.isLocked(lockOf(p));
    const client = clientOf(p);
    const dir = projectDir(p);
    const dirDiffers = projectNameFromPath(dir) !== p.name;
    const status = services.length > 0 ? `${counts.running}/${counts.expected}` : p.status;
    return (
      // Carte : en-tête sur deux lignes (identité | chemin et ressources), actions à droite sans retour à la ligne, puis les services.
      <section className="@container flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-panel">
        <header className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <Layers size={14} className="shrink-0 text-accent" />
              <span className="truncate font-semibold" title={p.name}>
                {p.name}
              </span>
              <Badge
                tone={counts.running === 0 ? "muted" : counts.running === counts.expected ? "ok" : "warn"}
                className="shrink-0"
                title={`${services.length > 0 ? `${status} en cours` : status}${counts.occasional > 0 ? `, +${counts.occasional} ponctuel${counts.occasional > 1 ? "s" : ""} (arrêt non signalé)` : ""}`}
              >
                {status}
              </Badge>
              {locked && (
                <span className="shrink-0 text-warn" title="Verrouillé : actions destructrices à confirmer en retapant le nom">
                  <Lock size={12} />
                </span>
              )}
              {p.missing && (
                <Badge tone="warn" className="shrink-0" title="Le dossier du projet a sans doute été renommé, déplacé ou supprimé">
                  introuvable
                </Badge>
              )}
              {client && (
                <Badge className="max-w-[12rem] min-w-0" title={`Client : ${client}`}>
                  <Tag size={10} className="shrink-0" /> <span className="truncate">{client}</span>
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-3 pl-[22px] text-xs">
              {p.missing ? (
                <span className="min-w-0 flex-1 truncate font-mono text-faint" title={`${p.configFiles}\nCe fichier n'existe plus`}>
                  {file}
                </span>
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left font-mono text-muted hover:text-accent"
                  title={`${p.configFiles}${dirDiffers ? `\nLe dossier ne porte pas le nom du projet compose (-p ${p.name})` : ""}\nClic : éditer le fichier`}
                  onClick={() => setEditing(file)}
                >
                  {file}
                </button>
              )}
              {enMarche > 0 && (
                <span className="shrink-0 text-muted tabular-nums" title="CPU et mémoire de tous les services">
                  {usage(services)}
                </span>
              )}
            </div>
          </div>
          {/* Une action principale, le reste en icônes ou derrière « … » : rien ne passe à la ligne. */}
          <span className="flex shrink-0 items-center gap-0.5">
            {p.missing ? (
              <Button size="sm" variant="primary" icon={<FolderSearch size={12} />} title="Retrouver le fichier compose à son nouvel emplacement et relancer le projet depuis là" onClick={() => void relink(p)}>
                Relier…
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={<Rocket size={12} />} title="Nouvelles images, redémarrage, vérification, et retour à la version précédente si elle échoue" onClick={() => void deployProject(serverId, p)}>
                Déployer
              </Button>
            )}
            {enMarche === 0 && !p.missing ? (
              <IconButton size="sm" title="Démarrer (up -d)" disabled={b("up")} onClick={() => void act(p, "up", "Démarrer (up -d)")}>
                <Play size={14} className={b("up") ? "animate-pulse" : ""} />
              </IconButton>
            ) : (
              <IconButton size="sm" title="Redémarrer" disabled={b("restart")} onClick={() => void act(p, "restart", "Redémarrer")}>
                <RotateCw size={14} className={b("restart") ? "animate-spin" : ""} />
              </IconButton>
            )}
            {enMarche > 0 ? (
              <IconButton size="sm" title="Arrêter : tous les conteneurs du projet, sans les supprimer" disabled={b("stop")} onClick={() => void act(p, "stop", "Arrêter", STOP_WARNING)}>
                <Square size={13} />
              </IconButton>
            ) : (
              <span className="size-7" />
            )}
            <IconButton
              size="sm"
              title="Logs de tous les services, en direct"
              onClick={() => openComposeLogs(serverId, docker, p, services)}
            >
              <ScrollText size={14} />
            </IconButton>
            <MenuButton size="sm" title="Autres actions" items={() => (p.missing ? missingItems(p) : projectItems(p, file, arrete))} />
          </span>
        </header>

        {services.length > 0 ? (
          listed.length > 0 && serviceTable(listed, p)
          ) : (
            <p className="border-t border-line px-3 py-2 text-xs text-muted">Aucun conteneur pour ce projet : ▶ le lance (up -d).</p>
          )}
      </section>
    );
  };

  return (
    <div className="@container flex min-w-0 flex-col gap-3 px-6 py-4">
      {data.projects.length === 0 && emptyLine}
      {groups.length === 0 && loose.length === 0 && filtering && data.projects.length + data.containers.length > 0 && (
        <p className="py-6 text-center text-[13px] text-muted">Aucune application ne correspond aux filtres.</p>
      )}
      {/* Deux colonnes larges ; un groupe de clients commence sur sa propre ligne et la dernière carte
          d'un nombre impair prend toute la largeur : aucune carte ne reste seule sur une demi-ligne. */}
      <div className={`grid grid-cols-1 gap-3 ${TWO_COLS}`}>
        {(() => {
          const cards = (list: ComposeProject[], withLoose: boolean) => {
            const n = list.length + (withLoose ? 1 : 0);
            const span = (i: number) => (n % 2 === 1 && i === n - 1 ? SPAN : "");
            return [
              ...list.map((p, i) => (
                <div key={p.name} className={`min-w-0 ${span(i)}`}>
                  {projectCard(p)}
                </div>
              )),
              ...(withLoose
                ? [
                    <div key="loose" className={`min-w-0 ${span(n - 1)}`}>
                      {looseCard()}
                    </div>,
                  ]
                : []),
            ];
          };
          // Sans aucun client défini, pas d'en-tête de groupe : les cartes s'enchaînent.
          if (clients.names.length === 0) return cards(groups.flatMap(([, list]) => list), loose.length > 0);
          return [
            ...groups.flatMap(([client, list]) => {
              const gid = client || NO_CLIENT;
              const folded = collapsedGroups.has(gid);
              return [
                <div key={`client:${gid}`} className="col-span-full -mb-1 flex h-7 items-center gap-2 px-1 text-xs">
                  <button type="button" aria-expanded={!folded} className="flex min-w-0 items-center gap-1.5 font-medium" onClick={() => collapsedGroups.toggle(gid)}>
                    <ChevronRight size={13} className={`shrink-0 text-muted transition-transform ${folded ? "" : "rotate-90"}`} />
                    <Tag size={12} className="shrink-0 text-muted" />
                    <span className="truncate">{client || "Sans client"}</span>
                    <span className="font-normal text-faint tabular-nums">· {list.length}</span>
                  </button>
                  {client && (
                    <span className="ml-auto">
                      <MenuButton size="sm" title={`Client ${client}`} items={() => clientGroupItems(clients, client)} />
                    </span>
                  )}
                </div>,
                ...(folded ? [] : cards(list, false)),
              ];
            }),
            ...(loose.length > 0
              ? [
                  <div key="loose" className="col-span-full min-w-0">
                    {looseCard()}
                  </div>,
                ]
              : []),
          ];
        })()}
      </div>
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
          onAction={(a) => void containerAct(selected, a)}
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
