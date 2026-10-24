import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Circle, Columns2, FolderTree, History, LayoutGrid, PanelLeft, PanelLeftClose, PanelLeftOpen, PanelRight, PanelTop, Plus, Radio, Rows2, ScrollText, Search, Server, Share2, Square, SquareTerminal, Users, X,
} from "lucide-react";
import TerminalPane from "../components/TerminalPane";
import SnippetsPanel from "../components/SnippetsPanel";
import TerminalFiles from "../components/TerminalFiles";
import TerminalStatusBar from "../components/TerminalStatusBar";
import TransfersBar from "../components/TransfersBar";
import { api, errorMessage, type TmuxSession } from "../lib/api";
import { useBroadcast } from "../lib/broadcast";
import { usePanes } from "../lib/panes";
import { paneActions, usePaneStatus } from "../lib/paneActions";
import { ensureConnected, newTmuxName, useApp, useAppPick, type TermTab } from "../lib/store";
import {
  Badge, Button, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, MenuButton, Modal, ResizeHandle, Skeleton, Textarea, ToolbarSep, useContextMenu, useResizable, type MenuItem,
} from "../components/ui";
import { display, matches, shortcutOf } from "../lib/shortcuts";
import { focusedTerminal } from "../lib/focus";
import { groupTabsByServer } from "../lib/terminal-tabs";

const HistoryList = lazy(() => import("../components/HistoryPalette").then((m) => ({ default: m.HistoryList })));

type DockTab = "files" | "snippets" | "history" | "recordings";
const DOCK_TABS: { id: DockTab; label: string; icon: React.ReactNode }[] = [
  { id: "files", label: "Fichiers", icon: <FolderTree size={13} /> },
  { id: "snippets", label: "Fragments", icon: <ScrollText size={13} /> },
  { id: "history", label: "Historique", icon: <History size={13} /> },
  { id: "recordings", label: "", icon: <Circle size={12} /> },
];

const SHELLS = ["bash", "zsh", "sh", "fish", "dash", "ash"];

/** Sessions tmux d'un onglet, avec le serveur de chacune (un onglet peut en couvrir plusieurs). */
function tabSessions(tab: TermTab): { serverId: string; name: string }[] {
  const out: { serverId: string; name: string }[] = [];
  if (tab.join) return out;
  if (tab.tmux) out.push({ serverId: tab.serverId, name: tab.tmux });
  if (tab.split) out.push({ serverId: tab.splitServerId ?? tab.serverId, name: tab.split });
  for (const g of tab.grid ?? []) if (g.tmux) out.push({ serverId: g.serverId, name: g.tmux });
  return out;
}

/** Identifiants des panneaux d'un onglet (diffusion, panneau actif). */
function tabPaneIds(tab: TermTab): string[] {
  if (tab.grid) return tab.grid.map((_, i) => `${tab.key}:g${i}`);
  return tab.split != null ? [`${tab.key}:0`, `${tab.key}:1`] : [`${tab.key}:0`];
}

export default function TerminalView({ visible }: { visible: boolean }) {
  const { tabs, activeTab, setActiveTab, closeTab, openTab, openGridTab, openJoinTab, updateTab, activeServerId, servers, ask, notify, settings, setSettings } = useAppPick("tabs", "activeTab", "setActiveTab", "closeTab", "openTab", "openGridTab", "openJoinTab", "updateTab", "activeServerId", "servers", "ask", "notify", "settings", "setSettings");
  const [titles, setTitles] = useState<Record<string, string>>({});
  /** Dock latéral : un seul panneau à la fois (fichiers, fragments, historique, enregistrements). */
  const [dock, setDock] = useState<DockTab | null>(() => {
    try {
      const v = localStorage.getItem("zenytt.terminal.dock");
      return v === "files" || v === "snippets" || v === "history" || v === "recordings" ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("zenytt.terminal.dock", dock ?? "");
    } catch {
      /* préférence non retenue */
    }
  }, [dock]);
  const dockSize = useResizable("terminal-dock", 330, 240, 760, "left");

  // Le panneau actif suit l'onglet affiché, sans attendre un clic dans le terminal : sinon le
  // panneau Fichiers restait branché sur l'onglet précédent et semblait ne plus suivre les « cd ».
  const knownPanes = usePanes((s) => s.panes);
  useEffect(() => {
    if (!activeTab) return;
    const { active, setActive } = usePanes.getState();
    // Un panneau déjà actif dans cet onglet (division, grille) garde la main.
    if (active && active.startsWith(`${activeTab}:`)) return;
    const first = Object.keys(knownPanes).find((id) => id.startsWith(`${activeTab}:`));
    if (first) setActive(first);
  }, [activeTab, knownPanes]);
  /** Part de l'espace prise par le premier panneau d'un onglet divisé (poignée centrale). */
  const [splitRatios, setSplitRatios] = useState<Record<string, number>>({});
  const [multiPicker, setMultiPicker] = useState(false);
  const [joinPicker, setJoinPicker] = useState(false);
  const [sessionsOf, setSessionsOf] = useState<string | null>(null);
  const [broadcastPicker, setBroadcastPicker] = useState(false);
  const broadcast = useBroadcast();
  const current = tabs.find((t) => t.key === activeTab);
  const serverOf = useCallback((id: string) => servers.find((s) => s.id === id), [servers]);
  // Panneau qui a le focus dans l'onglet affiché (à défaut, le premier) : cible du panneau
  // Fichiers et de la barre de monitoring.
  const focusedPane = usePanes((s) => s.active);
  const currentPanes = current ? tabPaneIds(current) : [];
  const activePane = focusedPane && currentPanes.includes(focusedPane) ? focusedPane : (currentPanes[0] ?? null);
  const activePaneServer = usePanes((s) => (activePane ? s.panes[activePane]?.serverId : undefined)) ?? current?.serverId;

  // La diffusion s'arrête dès qu'on quitte le terminal.
  useEffect(() => {
    if (!visible && useBroadcast.getState().active) useBroadcast.getState().setActive(false);
  }, [visible]);

  /**
   * Ferme un onglet. Sa session tmux est fermée aussi, sauf si un programme y tourne encore :
   * on propose alors de le laisser continuer en arrière-plan.
   */
  const close = useCallback(
    async (tab: TermTab) => {
      const sessions = tabSessions(tab);
      const byServer = new Map<string, string[]>();
      for (const s of sessions) byServer.set(s.serverId, [...(byServer.get(s.serverId) ?? []), s.name]);
      const live: { serverId: string; name: string; command: string }[] = [];
      for (const [serverId, names] of byServer) {
        try {
          for (const s of await api.tmuxSessions(serverId)) if (names.includes(s.name)) live.push({ serverId, name: s.name, command: s.command });
        } catch {
          /* serveur injoignable : la session sera visible dans « Sessions » à la prochaine connexion */
        }
      }
      const busy = live.filter((s) => !SHELLS.includes(s.command));
      let keep = false;
      if (busy.length) {
        keep = !!(await ask({
          title: "Un programme tourne encore",
          body: `« ${busy.map((b) => b.command).join(", ")} » est en cours dans ce terminal. Le laisser continuer en arrière-plan ? Tu pourras le retrouver via « Sessions ». Sinon, il sera arrêté.`,
          confirmLabel: "Laisser tourner",
        }));
      }
      if (!keep) for (const s of live) await api.tmuxKill(s.serverId, s.name).catch(() => {});
      closeTab(tab.key);
    },
    [ask, closeTab],
  );

  // Raccourcis (modifiables dans les réglages) : nouvel onglet, fermer, onglet suivant / précédent.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "newTab") && activeServerId) {
        e.preventDefault();
        openTab(activeServerId);
      } else if (matches(e, "closeTab") && current) {
        e.preventDefault();
        void close(current);
      } else if ((matches(e, "nextTab") || matches(e, "prevTab")) && tabs.length > 1 && current) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.key === current.key);
        const next = tabs[(i + (matches(e, "nextTab") ? 1 : tabs.length - 1)) % tabs.length];
        setActiveTab(next.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, activeServerId, current, openTab, close, tabs, setActiveTab]);

  /** Divise l'onglet ; le second panneau peut ouvrir un autre serveur (deux hôtes côte à côte). */
  const splitWith = async (serverId: string, dir: "cols" | "rows" = "cols") => {
    if (!current) return;
    const other = serverId !== current.serverId;
    // Autre serveur : connecté d'abord, pour que ses dialogues (clé d'hôte, mot de passe) passent seuls.
    if (other && !(await ensureConnected(serverId, { force: true }))) return;
    const persistent = other
      ? settings.persistentSessions && !settings.tmuxDeclined[serverId]
      : !current.command && !!current.tmux;
    updateTab(current.key, { split: persistent ? newTmuxName() : "", splitServerId: other ? serverId : undefined, splitDir: dir });
  };
  /** Retire la division : la session du second panneau est fermée, après confirmation. */
  const unsplit = async () => {
    if (!current || current.split == null) return;
    const name = current.split;
    const on = current.splitServerId ?? current.serverId;
    if (
      name &&
      !(await ask({
        title: "Retirer la division ?",
        body: "Le second terminal sera fermé, ainsi que sa session sur le serveur (et ce qui y tourne).",
        confirmLabel: "Retirer",
        danger: true,
      }))
    )
      return;
    updateTab(current.key, { split: null, splitServerId: undefined });
    if (name) void api.tmuxKill(on, name).catch(() => {});
  };

  const splitItems = (): MenuItem[] => {
    if (!current) return [];
    if (current.split != null)
      return [
        {
          label: current.splitDir === "rows" ? "Passer côte à côte" : "Passer l'un au-dessus de l'autre",
          icon: current.splitDir === "rows" ? <Columns2 size={14} /> : <Rows2 size={14} />,
          onClick: () => {
            // Les proportions repartent de la moitié : celles de l'autre sens n'ont pas de sens ici.
            setSplitRatios((x) => ({ ...x, [current.key]: 0.5 }));
            updateTab(current.key, { splitDir: current.splitDir === "rows" ? "cols" : "rows" });
          },
        },
        "separator",
        { label: "Retirer la division…", icon: <X size={14} />, danger: true, onClick: () => void unsplit() },
      ];
    const others = servers.filter((s) => s.id !== current.serverId);
    return [
      { label: "Côte à côte", icon: <Columns2 size={14} />, onClick: () => void splitWith(current.serverId, "cols") },
      { label: "L'un au-dessus de l'autre", icon: <Rows2 size={14} />, onClick: () => void splitWith(current.serverId, "rows") },
      ...(others.length
        ? ([{ heading: "Avec un autre serveur" }, ...others.map((s) => ({ label: s.name, hint: s.host, icon: <Server size={14} style={{ color: s.color ?? undefined }} />, onClick: () => void splitWith(s.id) }))] as MenuItem[])
        : []),
    ];
  };

  const recording = usePaneStatus((s) => (activePane ? s.recording[activePane] : undefined));
  const sharedMode = usePaneStatus((s) => (activePane ? s.shared[activePane] : undefined));

  /** Glissement de la poignée entre les deux panneaux d'un onglet divisé. */
  const startSplitResize = (key: string, rows: boolean) => (e: React.PointerEvent<HTMLDivElement>) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const r = rows ? (ev.clientY - box.top) / box.height : (ev.clientX - box.left) / box.width;
      setSplitRatios((x) => ({ ...x, [key]: Math.min(0.85, Math.max(0.15, r)) }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = rows ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const labelOf = (t: TermTab, right = false) =>
    t.join
      ? `${titles[t.key] ?? t.title} (partagé)`
      : right
        ? `${serverOf(t.splitServerId ?? t.serverId)?.name ?? "?"} · ${titles[t.key] ?? t.title} (${t.splitDir === "rows" ? "bas" : "droite"})`
        : `${serverOf(t.serverId)?.name ?? "?"} · ${titles[t.key] ?? t.title}`;

  const act = paneActions(activePane);
  const runner = activePaneServer ?? current?.serverId ?? activeServerId;

  const vertical = settings.terminalTabs === "vertical";
  const ctx = useContextMenu();
  /** Menu contextuel d'un terminal de la liste (onglet ou ligne de la colonne). */
  const tabMenu = (t: TermTab): MenuItem[] => [
    ...(t.join || t.grid
      ? []
      : ([
          { label: `Nouveau terminal sur ${serverOf(t.serverId)?.name ?? "ce serveur"}`, icon: <Plus size={14} />, onClick: () => openTab(t.serverId) },
          { label: "Sessions persistantes du serveur…", icon: <History size={14} />, onClick: () => setSessionsOf(t.serverId) },
          "separator",
        ] as MenuItem[])),
    {
      label: "Fermer les autres",
      icon: <X size={14} />,
      disabled: tabs.length < 2,
      onClick: () => void (async () => {
        for (const o of tabs) if (o.key !== t.key) await close(o);
      })(),
    },
    { label: "Fermer", hint: display(shortcutOf("closeTab")), icon: <X size={14} />, onClick: () => void close(t) },
  ];
  /** Comportements communs aux deux présentations : clic, clic molette, clic droit, infobulle. */
  const tabProps = (t: TermTab) => ({
    "data-tab": t.key,
    onClick: () => setActiveTab(t.key),
    onAuxClick: (e: React.MouseEvent) => e.button === 1 && void close(t),
    onContextMenu: (e: React.MouseEvent) => ctx.open(e, tabMenu(t)),
    title: `${titles[t.key] ?? t.title} · clic molette pour fermer`,
  });
  const closeButton = (t: TermTab, active: boolean) => (
    <button
      type="button"
      tabIndex={-1}
      className={`flex size-5 shrink-0 items-center justify-center rounded hover:bg-hover-strong ${active ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
      onClick={(e) => {
        e.stopPropagation();
        void close(t);
      }}
      aria-label={`Fermer le terminal ${t.title}`}
      title={`Fermer (${display(shortcutOf("closeTab"))})`}
    >
      <X size={12} />
    </button>
  );
  const newTabTitle = `Nouveau terminal (${display(shortcutOf("newTab"))})`;

  return (
    <div className="flex h-full flex-col">
      <div className="@container/termbar flex h-10 shrink-0 items-center gap-2 border-b border-border bg-rail pr-2 pl-3">
        <TermContext tab={current} serverId={activePaneServer} />
        {/* Trois groupes : disposition · panneau latéral · partage et sessions. */}
        <div className="flex shrink-0 items-center gap-1">
          {broadcast.active && (
            <Button size="sm" variant="danger" icon={<Radio size={13} />} onClick={() => broadcast.setActive(false)}>
              Arrêter la diffusion
            </Button>
          )}
          <IconButton
            size="sm"
            title={vertical ? "Terminaux en onglets horizontaux" : "Terminaux en liste verticale"}
            onClick={() => setSettings({ terminalTabs: vertical ? "horizontal" : "vertical" })}
          >
            {vertical ? <PanelTop size={15} /> : <PanelLeft size={15} />}
          </IconButton>
          <MenuButton
            size="sm"
            variant={current?.split != null ? "subtle" : "ghost"}
            label={<Lbl>Diviser</Lbl>}
            icon={current?.splitDir === "rows" ? <Rows2 size={14} /> : <Columns2 size={14} />}
            title="Diviser l'écran (même serveur ou un autre)"
            disabled={!current || !!current.grid || !!current.join}
            align="end"
            items={splitItems}
          />
          <Button size="sm" variant="ghost" icon={<LayoutGrid size={14} />} disabled={servers.length < 2} onClick={() => setMultiPicker(true)} title="Un terminal par serveur, en grille">
            <Lbl>Grille</Lbl>
          </Button>
          <ToolbarSep />
          <Button size="sm" variant={dock ? "subtle" : "ghost"} icon={<PanelRight size={14} />} aria-pressed={!!dock} onClick={() => setDock(dock ? null : "files")} title="Panneau latéral : fichiers, fragments, historique, enregistrements">
            <Lbl>Panneau</Lbl>
          </Button>
          <ToolbarSep />
          <IconButton size="sm" title={`Rechercher dans le terminal (${display(shortcutOf("termSearch"))})`} disabled={!act} onClick={() => act?.search()}>
            <Search size={15} />
          </IconButton>
          <IconButton size="sm" title={recording ? "Arrêter et enregistrer la session" : "Enregistrer la session (asciicast)"} active={!!recording} disabled={!act} onClick={() => void act?.toggleRecording()}>
            {recording ? <Square size={13} fill="currentColor" className="text-danger" /> : <Circle size={14} />}
          </IconButton>
          <MenuButton
            size="sm"
            variant={sharedMode ? "subtle" : "ghost"}
            label={<Lbl>Partage</Lbl>}
            icon={<Share2 size={14} />}
            title="Partager, rejoindre, diffuser la saisie"
            items={() => [
              { label: sharedMode ? "Arrêter le partage de ce terminal" : "Partager ce terminal…", icon: <Share2 size={14} />, disabled: !act || !!current?.join, onClick: () => act?.share() },
              { label: "Rejoindre un terminal partagé…", icon: <Users size={14} />, onClick: () => setJoinPicker(true) },
              "separator",
              {
                label: "Diffuser la saisie à plusieurs terminaux…",
                icon: <Radio size={14} />,
                disabled: Object.keys(useBroadcast.getState().panes).length < 2,
                onClick: () => setBroadcastPicker(true),
              },
            ]}
          />
          <Button size="sm" variant="ghost" icon={<History size={14} />} disabled={!runner} onClick={() => runner && setSessionsOf(runner)} title="Sessions persistantes (tmux) du serveur">
            <Lbl>Sessions</Lbl>
          </Button>
        </div>
      </div>

      {!vertical && tabs.length > 0 && (
        <TabStrip
          activeTab={activeTab}
          trailing={
            <IconButton size="sm" title={newTabTitle} disabled={!activeServerId} onClick={() => activeServerId && openTab(activeServerId)}>
              <Plus size={15} />
            </IconButton>
          }
        >
          {tabs.map((t) => {
            const active = t.key === activeTab;
            return (
              <div
                key={t.key}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                {...tabProps(t)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActiveTab(t.key)}
                className={`group flex h-[26px] max-w-60 min-w-28 shrink-0 cursor-default items-center gap-2 rounded-md pr-1 pl-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  active ? "bg-panel font-medium text-fg ring-1 ring-border-strong/70" : "text-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <TabIcon tab={t} />
                <span className="flex-1 truncate">{t.title}</span>
                <TabFlags tab={t} />
                {closeButton(t, active)}
              </div>
            );
          })}
        </TabStrip>
      )}

      <div className="flex min-h-0 flex-1">
        {vertical && tabs.length > 0 && (
          <TabList
            tabs={tabs}
            onActivate={setActiveTab}
            onNew={activeServerId ? () => openTab(activeServerId) : undefined}
            newTitle={newTabTitle}
            renderRow={(t, grouped) => {
              const active = t.key === activeTab;
              const s = serverOf(t.serverId);
              const sub = t.join ? "partagé avec moi" : t.grid ? `${t.grid.length} serveurs` : grouped ? `${s?.username}@${s?.host}` : `${s?.name ?? "?"} · ${s?.username}@${s?.host}`;
              return (
                <div
                  key={t.key}
                  role="option"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  {...tabProps(t)}
                  className={`group relative flex cursor-default items-center gap-2 rounded-md py-1 pr-1 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    active ? "bg-accent/12 text-fg" : "text-muted hover:bg-hover hover:text-fg"
                  }`}
                >
                  <span className="absolute top-1.5 bottom-1.5 left-1 w-[3px] rounded-full" style={{ background: t.join || t.grid ? "var(--color-accent)" : (s?.color ?? "var(--color-accent)") }} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate text-[12.5px] ${active ? "font-medium" : ""}`}>{t.title}</span>
                    <span className="truncate font-mono text-[10.5px] text-faint">{sub}</span>
                  </span>
                  <TabFlags tab={t} />
                  {closeButton(t, active)}
                </div>
              );
            }}
            renderRail={(t) => (
              <button
                key={t.key}
                type="button"
                role="option"
                aria-selected={t.key === activeTab}
                tabIndex={t.key === activeTab ? 0 : -1}
                {...tabProps(t)}
                className={`relative flex size-8 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent ${t.key === activeTab ? "bg-accent/12" : "hover:bg-hover"}`}
              >
                <TabIcon tab={t} />
              </button>
            )}
          />
        )}
        <div className="relative min-w-0 flex-1">
          {tabs.length === 0 && (
            <EmptyState
              icon={<SquareTerminal />}
              title="Aucun terminal ouvert"
              action={
                activeServerId ? (
                  <>
                    <Button variant="primary" icon={<Plus size={15} />} onClick={() => openTab(activeServerId)}>
                      Terminal sur {serverOf(activeServerId)?.name}
                    </Button>
                    {servers.length > 1 && (
                      <Button icon={<LayoutGrid size={14} />} onClick={() => setMultiPicker(true)}>
                        Plusieurs serveurs en grille
                      </Button>
                    )}
                    <Button variant="ghost" icon={<Users size={14} />} onClick={() => setJoinPicker(true)}>
                      Rejoindre un partage
                    </Button>
                  </>
                ) : undefined
              }
            >
              {activeServerId
                ? `Sessions persistantes (tmux) : elles continuent sur le serveur quand Zenytt est fermé. ${display(shortcutOf("newTab"))} ouvre un nouvel onglet.`
                : "Ajoute d'abord un serveur dans la section Serveurs."}
            </EmptyState>
          )}
          {tabs.map((t) => {
            const show = visible && t.key === activeTab;
            return (
              <div key={t.key} className={`absolute inset-0 flex ${t.splitDir === "rows" ? "flex-col" : ""} ${t.key === activeTab ? "" : "invisible"}`}>
                {t.join ? (
                  <TerminalPane
                    serverId=""
                    join={t.join}
                    paneId={`${t.key}:0`}
                    label={labelOf(t)}
                    visible={show}
                    onTitle={(title) => setTitles((x) => ({ ...x, [t.key]: title }))}
                  />
                ) : t.grid ? (
                  <GridPanes tab={t} visible={show} />
                ) : (
                  <>
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={t.split != null ? { flex: `${splitRatios[t.key] ?? 0.5} 1 0%` } : undefined}>
                      {/* Seul, le terminal est décrit dans la barre d'outils ; divisé, chaque moitié garde son en-tête. */}
                      {t.split != null && <PaneHeader serverId={t.serverId} />}
                      <div className="min-h-0 flex-1">
                        <TerminalPane
                          serverId={t.serverId}
                          command={t.command}
                          tmux={t.tmux}
                          paneId={`${t.key}:0`}
                          label={labelOf(t)}
                          visible={show}
                          onTitle={(title) => setTitles((x) => ({ ...x, [t.key]: title }))}
                        />
                      </div>
                    </div>
                    {t.split != null && (
                      <>
                        <div
                          role="separator"
                          aria-orientation={t.splitDir === "rows" ? "horizontal" : "vertical"}
                          aria-label="Redimensionner les deux terminaux"
                          title="Glisser pour redimensionner"
                          className={`shrink-0 bg-border hover:bg-accent/40 ${t.splitDir === "rows" ? "h-1 cursor-row-resize" : "w-1 cursor-col-resize"}`}
                          onPointerDown={startSplitResize(t.key, t.splitDir === "rows")}
                        />
                        <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${1 - (splitRatios[t.key] ?? 0.5)} 1 0%` }}>
                          <PaneHeader serverId={t.splitServerId ?? t.serverId} />
                          <div className="min-h-0 flex-1">
                            <TerminalPane serverId={t.splitServerId ?? t.serverId} tmux={t.split || undefined} paneId={`${t.key}:1`} label={labelOf(t, true)} visible={show} />
                          </div>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {dock && (
          <>
            <ResizeHandle {...dockSize.handle} />
            <aside className="flex shrink-0 flex-col border-l border-border bg-subtle" style={{ width: dockSize.size }} aria-label="Panneau du terminal">
              <nav className="flex shrink-0 items-center border-b border-border px-1.5" role="tablist">
                {DOCK_TABS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="tab"
                    aria-selected={dock === d.id}
                    aria-label={d.label || "Enregistrements"}
                    title={d.label || "Enregistrements"}
                    onClick={() => setDock(d.id)}
                    className={`flex h-9 min-w-0 items-center gap-1.5 border-b-2 px-2 text-[12px] ${dock === d.id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
                  >
                    {d.icon}
                    {d.label && <span className="truncate">{d.label}</span>}
                  </button>
                ))}
                <IconButton size="sm" className="ml-auto" title="Fermer le panneau" onClick={() => setDock(null)}>
                  <X size={14} />
                </IconButton>
              </nav>
              <div className="min-h-0 flex-1">
                {dock === "files" &&
                  (activePane && !current?.join ? (
                    <TerminalFiles paneId={activePane} visible={visible} />
                  ) : (
                    <p className="p-4 text-xs text-muted">Ouvre un terminal connecté pour parcourir ses fichiers.</p>
                  ))}
                {dock === "snippets" && <SnippetsPanel />}
                {dock === "history" &&
                  (runner && !current?.join ? (
                    <div className="h-full p-3">
                      <Suspense fallback={null}>
                        <HistoryList
                          key={runner}
                          serverId={runner}
                          compact
                          onPick={(command, run) => {
                            if (focusedTerminal.id == null) return notify("Clique d'abord dans un terminal connecté.", "info");
                            void api.termWrite(focusedTerminal.id, run ? command + "\r" : command);
                            focusedTerminal.focus?.();
                          }}
                        />
                      </Suspense>
                    </div>
                  ) : (
                    <p className="p-4 text-xs text-muted">Ouvre un terminal pour lire l'historique de son shell.</p>
                  ))}
                {dock === "recordings" && <RecordingsPanel activePane={activePane} />}
              </div>
            </aside>
          </>
        )}
      </div>
      <TransfersBar />
      {settings.terminalStatusBar && activePaneServer && <TerminalStatusBar serverId={activePaneServer} visible={visible} />}

      {joinPicker && (
        <JoinPicker
          onClose={() => setJoinPicker(false)}
          onJoin={(code, title) => {
            setJoinPicker(false);
            openJoinTab(code, title);
          }}
        />
      )}
      {multiPicker && (
        <MultiServerPicker
          onClose={() => setMultiPicker(false)}
          onOpen={async (ids, broadcastOn) => {
            setMultiPicker(false);
            // Un serveur après l'autre : un seul dialogue de connexion à la fois.
            const ready: string[] = [];
            for (const id of ids) if (await ensureConnected(id, { force: true })) ready.push(id);
            if (ready.length < ids.length) notify(`${ids.length - ready.length} serveur(s) non connecté(s), laissé(s) de côté`, "info");
            if (!ready.length) return;
            const key = openGridTab(ready);
            if (broadcastOn && ready.length > 1) useBroadcast.getState().setActive(true, ready.map((_, i) => `${key}:g${i}`));
          }}
        />
      )}

      {ctx.menu}
      {broadcastPicker && <BroadcastPicker onClose={() => setBroadcastPicker(false)} />}
      {sessionsOf && (
        <SessionsModal
          serverId={sessionsOf}
          openNames={tabs.flatMap((t) => tabSessions(t).map((x) => x.name))}
          onOpen={(name) => {
            const existing = tabs.find((t) => tabSessions(t).some((x) => x.name === name));
            if (existing) setActiveTab(existing.key);
            else openTab(sessionsOf, { title: `${serverOf(sessionsOf)?.name} (reprise)`, tmux: name });
            setSessionsOf(null);
          }}
          onClose={() => setSessionsOf(null)}
          notify={notify}
        />
      )}
    </div>
  );
}

/** Contexte du terminal affiché, à gauche de la barre d'outils : serveur du panneau actif, grille ou partage reçu. */
function TermContext({ tab, serverId }: { tab: TermTab | undefined; serverId: string | undefined }) {
  const s = useApp((st) => st.servers.find((x) => x.id === serverId));
  if (!tab) return <div className="flex-1" />;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px]">
      {tab.join ? (
        <>
          <Share2 size={13} className="shrink-0 text-accent" />
          <span className="truncate font-medium">Terminal partagé avec moi</span>
        </>
      ) : (
        <>
          {tab.grid && (
            <span className="flex shrink-0 items-center gap-1.5 text-muted">
              <LayoutGrid size={13} className="text-accent" />
              Grille de {tab.grid.length}
              <span className="text-faint">·</span>
            </span>
          )}
          <span className="size-[7px] shrink-0 rounded-full" style={{ background: s?.color ?? "var(--color-accent)" }} />
          <span className="shrink-0 font-medium">{s?.name ?? "?"}</span>
          <span className="truncate font-mono text-[11.5px] text-muted">
            {s?.username}@{s?.host}
          </span>
        </>
      )}
    </div>
  );
}

/** Pastille du serveur, ou icône d'une grille / d'un partage reçu. */
function TabIcon({ tab }: { tab: TermTab }) {
  const color = useApp((st) => st.servers.find((x) => x.id === tab.serverId)?.color);
  if (tab.join) return <Share2 size={12} className="shrink-0 text-accent" />;
  if (tab.grid) return <LayoutGrid size={12} className="shrink-0 text-accent" />;
  return <span className="size-[7px] shrink-0 rounded-full" style={{ background: color ?? "var(--color-accent)" }} />;
}

/** Indicateurs d'un terminal : enregistrement, partage en cours, session tmux. */
function TabFlags({ tab }: { tab: TermTab }) {
  const ids = tabPaneIds(tab);
  const recording = usePaneStatus((s) => ids.some((id) => id in s.recording));
  const shared = usePaneStatus((s) => ids.some((id) => id in s.shared));
  return (
    <>
      {recording && <span className="size-2 shrink-0 animate-pulse rounded-full bg-danger" title="Enregistrement en cours" />}
      {shared && <Share2 size={11} className="shrink-0 text-accent" aria-label="Partagé" />}
      {tab.tmux && <Badge tone="ok" className="h-4! px-1.5! text-[10px]!" title="Session persistante (tmux) : elle survit à la fermeture de Zenytt">tmux</Badge>}
    </>
  );
}

/** Rangée d'onglets sous la barre d'outils : défilement horizontal (molette comprise) avec bords estompés quand elle déborde. */
function TabStrip({ activeTab, trailing, children }: { activeTab: string | null; trailing: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ l: false, r: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((p) => (p.l === l && p.r === r ? p : { l, r }));
  }, []);
  // Après chaque rendu (onglet ouvert, fermé, renommé) et à chaque redimensionnement.
  useEffect(measure);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [measure]);
  useEffect(() => {
    if (activeTab) ref.current?.querySelector(`[data-tab="${CSS.escape(activeTab)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);
  const mask = `linear-gradient(to right, ${edges.l ? "transparent" : "#000"}, #000 28px, #000 calc(100% - 28px), ${edges.r ? "transparent" : "#000"})`;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-subtle pr-1.5 pl-1.5">
      <div
        ref={ref}
        role="tablist"
        aria-label="Terminaux ouverts"
        onScroll={measure}
        onWheel={(e) => {
          if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY;
        }}
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden py-1 [&::-webkit-scrollbar]:hidden"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {children}
      </div>
      {trailing}
    </div>
  );
}

/**
 * Colonne des terminaux (présentation verticale) : redimensionnable, réductible en rail d'icônes,
 * regroupée par serveur dès que plusieurs serveurs sont ouverts. ↑/↓ déplacent le focus, Entrée ouvre.
 */
function TabList({
  tabs,
  onActivate,
  onNew,
  newTitle,
  renderRow,
  renderRail,
}: {
  tabs: TermTab[];
  onActivate: (key: string) => void;
  onNew?: () => void;
  newTitle: string;
  renderRow: (t: TermTab, grouped: boolean) => React.ReactNode;
  renderRail: (t: TermTab) => React.ReactNode;
}) {
  const servers = useApp((s) => s.servers);
  const width = useResizable("terminal-tabs", 220, 160, 420, "right");
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("zenytt.terminal.tabsCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem("zenytt.terminal.tabsCollapsed", collapsed ? "" : "1");
    } catch {
      /* préférence non retenue */
    }
  };
  const groups = groupTabsByServer(tabs);
  const grouped = groups.length > 1;
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role=option]"));
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, moves[e.key]))]?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && i >= 0) {
      e.preventDefault();
      onActivate(rows[i].dataset.tab!);
    }
  };
  const groupName = (id: string) => (id === "grid" ? "Grilles" : id === "join" ? "Partagés avec moi" : (servers.find((s) => s.id === id)?.name ?? "Serveur supprimé"));

  if (collapsed)
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-panel py-1.5" aria-label="Terminaux ouverts">
        <IconButton size="sm" title="Afficher la liste des terminaux" onClick={toggle}>
          <PanelLeftOpen size={15} />
        </IconButton>
        <IconButton size="sm" title={newTitle} disabled={!onNew} onClick={onNew}>
          <Plus size={15} />
        </IconButton>
        <div className="mx-2 my-0.5 h-px self-stretch bg-border" />
        <div role="listbox" aria-label="Terminaux ouverts" className="scroll-thin flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-auto [&::-webkit-scrollbar]:hidden" onKeyDown={onKey}>
          {tabs.map(renderRail)}
        </div>
      </aside>
    );
  return (
    <>
      <aside className="flex shrink-0 flex-col border-r border-border bg-panel" style={{ width: width.size }} aria-label="Terminaux ouverts">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} disabled={!onNew} onClick={onNew} title={newTitle}>
            Nouveau terminal
          </Button>
          <span className="ml-auto text-[11px] text-faint tabular-nums">{tabs.length}</span>
          <IconButton size="sm" title="Réduire la liste" onClick={toggle}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>
        <div role="listbox" aria-label="Terminaux ouverts" className="scroll-thin flex min-h-0 flex-1 flex-col gap-px overflow-auto p-1" onKeyDown={onKey}>
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={grouped ? groupName(g.id) : undefined} className="flex flex-col gap-px">
              {grouped && (
                <div className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">
                  <span className="truncate">{groupName(g.id)}</span>
                  <span className="ml-auto tabular-nums">{g.tabs.length}</span>
                </div>
              )}
              {g.tabs.map((t) => renderRow(t, grouped))}
            </div>
          ))}
        </div>
      </aside>
      <ResizeHandle {...width.handle} />
    </>
  );
}

/** Nom, couleur et `utilisateur@hôte` du serveur, en tête de chaque moitié d'un terminal divisé et de chaque case d'une grille. */
function PaneHeader({ serverId }: { serverId: string }) {
  const s = useApp((st) => st.servers.find((x) => x.id === serverId));
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-rail px-3 text-[11.5px]">
      <span className="size-[7px] rounded-full" style={{ background: s?.color ?? "var(--color-accent)" }} />
      <span className="font-medium">{s?.name ?? "?"}</span>
      <span className="truncate font-mono text-muted">
        {s?.username}@{s?.host}
      </span>
    </div>
  );
}

/** Onglet multi-serveurs : un terminal par serveur, en grille. */
function GridPanes({ tab, visible }: { tab: TermTab; visible: boolean }) {
  const servers = useApp((s) => s.servers);
  const grid = tab.grid ?? [];
  const cols = grid.length <= 1 ? 1 : grid.length <= 4 ? 2 : 3;
  return (
    <div className="grid min-w-0 flex-1 gap-px bg-border" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }}>
      {grid.map((g, i) => (
        <div key={i} className="flex min-h-0 min-w-0 flex-col bg-bg">
          <PaneHeader serverId={g.serverId} />
          <div className="min-h-0 flex-1">
            <TerminalPane
              serverId={g.serverId}
              tmux={g.tmux}
              paneId={`${tab.key}:g${i}`}
              label={servers.find((s) => s.id === g.serverId)?.name ?? "?"}
              visible={visible}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Choix des serveurs d'un onglet multi-serveurs. */
function MultiServerPicker({ onClose, onOpen }: { onClose: () => void; onOpen: (ids: string[], broadcast: boolean) => void }) {
  const servers = useApp((s) => s.servers);
  const [selected, setSelected] = useState<string[]>([]);
  const [broadcastOn, setBroadcastOn] = useState(true);
  return (
    <Modal
      title="Terminaux multi-serveurs"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<LayoutGrid size={14} />} disabled={selected.length < 2} onClick={() => onOpen(selected, broadcastOn)}>
            Ouvrir {selected.length} terminaux
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">Un terminal par serveur, affichés côte à côte dans un même onglet. Pratique pour lancer la même commande sur plusieurs hôtes et comparer les résultats.</p>
      <ul className="mb-3 flex flex-col gap-1">
        {servers.map((s) => (
          <li key={s.id}>
            <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover">
              <Checkbox
                className="flex-1"
                checked={selected.includes(s.id)}
                onChange={(v) => setSelected((prev) => (v ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
                label={
                  <span className="flex items-center gap-2">
                    <span className="size-[7px] rounded-full" style={{ background: s.color ?? "var(--color-accent)" }} />
                    {s.name}
                  </span>
                }
              />
              <span className="font-mono text-xs text-muted">
                {s.username}@{s.host}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="rounded-lg border border-border p-3">
        <Checkbox
          checked={broadcastOn}
          onChange={setBroadcastOn}
          label="Diffuser la saisie à tous les terminaux"
          hint="Les commandes sensibles (rm -rf, reboot…) demandent confirmation. Arrêt avec « Arrêter la diffusion »."
        />
      </div>
    </Modal>
  );
}

/** Saisie d'une invitation reçue (terminal partagé par quelqu'un d'autre). */
function JoinPicker({ onClose, onJoin }: { onClose: () => void; onJoin: (code: string, title: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const valid = code.trim().startsWith("zenytt-term:");
  return (
    <Modal
      title="Rejoindre un terminal partagé"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Users size={14} />} disabled={!valid} onClick={() => onJoin(code.trim(), name.trim() || "Terminal partagé")}>
            Rejoindre
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Colle l'invitation reçue (elle commence par <span className="font-mono">zenytt-term:</span>). Tu verras le terminal de la personne en
        direct ; si elle a partagé le contrôle, tu pourras aussi y taper.
      </p>
      <Textarea
        className="h-28 resize-none font-mono text-xs"
        placeholder="zenytt-term:…"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <div className="mt-3">
        <Field label="Nom de l'onglet (facultatif)">
          <Input value={name} placeholder="Terminal de …" onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function BroadcastPicker({ onClose }: { onClose: () => void }) {
  const { panes, setActive } = useBroadcast();
  const ids = Object.keys(panes).filter((id) => panes[id].termId != null);
  const [selected, setSelected] = useState<Set<string>>(new Set(ids));
  return (
    <Modal
      title="Diffuser la saisie"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="danger"
            icon={<Radio size={14} />}
            disabled={selected.size < 2}
            onClick={() => {
              setActive(true, [...selected]);
              onClose();
            }}
          >
            Diffuser à {selected.size} terminaux
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Tout ce que tu taperas dans l'un de ces terminaux sera envoyé à tous. Les commandes sensibles (rm -rf, reboot, docker rm…) demanderont une confirmation. La diffusion s'arrête quand tu quittes le terminal.
      </p>
      <ul className="flex flex-col gap-1">
        {ids.map((id) => (
          <li key={id}>
            <div className="rounded-lg px-2 py-1.5 hover:bg-hover">
              <Checkbox
                checked={selected.has(id)}
                onChange={(v) => {
                  const next = new Set(selected);
                  if (v) next.add(id);
                  else next.delete(id);
                  setSelected(next);
                }}
                label={panes[id].label}
              />
            </div>
          </li>
        ))}
        {ids.length < 2 && <li className="text-sm text-muted">Ouvre et connecte au moins deux terminaux.</li>}
      </ul>
    </Modal>
  );
}

function SessionsModal({
  serverId,
  openNames,
  onOpen,
  onClose,
  notify,
}: {
  serverId: string;
  openNames: string[];
  onOpen: (name: string) => void;
  onClose: () => void;
  notify: (m: string, k?: "info" | "error" | "success") => void;
}) {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [list, setList] = useState<TmuxSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.tmuxSessions(serverId).then(setList, (e) => setError(errorMessage(e)));
  }, [serverId]);
  useEffect(load, [load]);

  return (
    <Modal title={`Sessions persistantes sur ${server?.name}`} width="max-w-2xl" onClose={onClose}>
      <p className="mb-3 text-sm text-muted">
        Ces terminaux continuent de tourner sur le serveur, même app fermée. Rouvre-les pour reprendre exactement là où tu en étais.
      </p>
      {error && <ErrorState message={error} onRetry={load} />}
      {!list && !error && <Skeleton rows={3} />}
      {list && list.length === 0 && <p className="text-[13px] text-muted">Aucune session Zenytt sur ce serveur.</p>}
      <ul className="flex flex-col gap-2">
        {list?.map((s) => (
          <li key={s.name} className="flex items-center gap-3 rounded-lg border border-border bg-subtle px-3 py-2 text-[13px]">
            <span className="font-mono text-xs">{s.name}</span>
            <Badge tone={SHELLS.includes(s.command) ? "muted" : "accent"}>{s.command}</Badge>
            {openNames.includes(s.name) ? <Badge tone="ok">ouverte</Badge> : s.attached ? <Badge tone="warn">ouverte ailleurs</Badge> : null}
            <span className="ml-auto text-xs text-muted">{new Date(s.created * 1000).toLocaleString("fr-FR")}</span>
            <Button size="sm" onClick={() => onOpen(s.name)}>
              Ouvrir
            </Button>
            <IconButton
              title="Fermer la session"
              onClick={async () => {
                try {
                  await api.tmuxKill(serverId, s.name);
                  load();
                } catch (e) {
                  notify(errorMessage(e), "error");
                }
              }}
            >
              <X size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Onglet « Enregistrements » du dock : sessions en cours d'enregistrement et lancement sur le terminal actif. */
function RecordingsPanel({ activePane }: { activePane: string | null }) {
  const recording = usePaneStatus((s) => s.recording);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const entries = Object.entries(recording);
  const elapsed = (since: number) => {
    const s = Math.floor((Date.now() - since) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const act = paneActions(activePane);
  return (
    <div className="flex flex-col gap-3 p-3 text-[13px]">
      <p className="text-xs text-muted">
        Enregistre ce qui s'affiche dans un terminal au format asciicast (<span className="font-mono">.cast</span>), relisible avec asciinema. Pratique pour documenter une intervention.
      </p>
      {entries.length === 0 ? (
        <Button variant="primary" icon={<Circle size={13} />} disabled={!act || (activePane != null && activePane in recording)} onClick={() => void act?.toggleRecording()}>
          Enregistrer le terminal actif
        </Button>
      ) : (
        entries.map(([pane, r]) => (
          <div key={pane} className="flex flex-col gap-2 rounded-xl border border-danger/35 bg-danger/8 p-3">
            <div className="flex items-center gap-2">
              <span className="size-2 animate-pulse rounded-full bg-danger" />
              <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
              <span className="font-mono text-xs text-muted">{elapsed(r.since)}</span>
            </div>
            <Button size="sm" variant="danger" icon={<Square size={12} fill="currentColor" />} onClick={() => void paneActions(pane)?.toggleRecording()}>
              Arrêter et enregistrer le fichier
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

/** Libellé des boutons de la barre : masqué quand elle est étroite (assistant ouvert, petite fenêtre), l'icône et l'infobulle restent. */
function Lbl({ children }: { children: string }) {
  return <span className="hidden @[52rem]/termbar:inline">{children}</span>;
}
