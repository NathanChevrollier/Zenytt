// Sélecteur de serveur : recherche, dossiers, état de chaque serveur, et de quoi prendre la main
// sans changer de page (terminal, fichiers, supervision, écran ou console des VM, bureaux à distance).
// Ouvert depuis le haut de la barre latérale, le fil d'Ariane ou par raccourci. Choisir un serveur
// change le contexte de tout le groupe « Serveur ».
//
// Les écrans (VM, bureaux) s'ouvrent comme le veut Réglages › Général › Écrans distants ; l'autre
// moyen reste au clic droit.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, MonitorPlay, Plus, Search, Settings2, TerminalSquare } from "lucide-react";
import { ensureConnected, useApp } from "../../lib/store";
import { badgesOf, useHealth } from "../../lib/health";
import { fuzzyMatch } from "../../lib/fuzzy";
import { navigate, useShell } from "../../lib/shell";
import { display, shortcutOf } from "../../lib/shortcuts";
import { api, errorMessage, hasShell, protocolBadge, type DesktopView, type ServerView, type Vm } from "../../lib/api";
import { openVmScreen, useRdp, type ScreenMode } from "../../lib/rdp";
import { useItemFolders } from "../../lib/folders";
import { stateLabel } from "../../lib/vm";
import { canOpenInside, openDesktop, useDesktops } from "../RemoteDesktops";
import { toggleCollapsed } from "../Folders";
import { Badge, FOCUS_RING, Kbd, StatusDot, useContextMenu, type MenuItem } from "../ui";

/** VM d'un serveur, chargées à la demande (dépliage) : libvirt peut demander sudo et prendre du temps. */
type VmState = { loading: true } | { loading: false; vms: Vm[]; error?: string };

const OTHER: Record<ScreenMode, ScreenMode> = { internal: "external", external: "internal" };
const MODE_LABEL: Record<ScreenMode, string> = { internal: "dans Zenytt", external: "dans le client du système" };

export default function ServerSwitcher({ onClose }: { onClose: () => void }) {
  const servers = useApp((s) => s.servers);
  const activeId = useApp((s) => s.activeServerId);
  const setActive = useApp((s) => s.setActiveServer);
  const setSection = useApp((s) => s.setSection);
  const collapsed = useApp((s) => s.folders.collapsed);
  const mode: ScreenMode = useApp((s) => s.settings.vmScreen) ?? "internal";
  const summaries = useHealth((s) => s.summaries);
  const { list: desktops, reload: reloadDesktops } = useDesktops();
  const remoteId = useRdp((s) => s.desktop?.id);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [vms, setVms] = useState<Record<string, VmState>>({});
  const menu = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void reloadDesktops().catch(() => {});
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[aria-haspopup=dialog]")) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [onClose, reloadDesktops]);

  // Ordre : dossiers par ordre alphabétique, « sans dossier » à la fin ; filtré par la recherche.
  const list = useMemo(() => {
    const q = query.trim();
    const matched = servers
      .map((s) => ({ s, score: q ? (fuzzyMatch(`${s.name} ${s.host} ${s.username} ${s.group ?? ""}`, q)?.score ?? -1) + 1 : 1 }))
      .filter((x) => x.score > 0);
    if (q) return matched.sort((a, b) => b.score - a.score).map((x) => x.s);
    return matched
      .map((x) => x.s)
      .sort((a, b) => {
        const ga = a.group || "￿";
        const gb = b.group || "￿";
        return ga.localeCompare(gb, "fr") || a.name.localeCompare(b.name, "fr");
      });
  }, [servers, query]);
  // Dossiers repliés (les mêmes que la page Serveurs) : leurs serveurs ne sont plus parcourus au clavier.
  const shut = (s: ServerView) => !query && !!s.group && collapsed.includes(`servers:${s.group}`);
  const reachable = list.filter((s) => !shut(s));
  const q = query.trim().toLowerCase();
  const shownDesktops = desktops.filter((d) => !q || `${d.name} ${d.host}`.toLowerCase().includes(q));

  useEffect(() => setIndex(0), [query]);

  const pick = (s: ServerView | undefined) => {
    if (!s) return;
    setActive(s.id);
    onClose();
  };
  const go = (fn: () => void) => {
    fn();
    onClose();
  };

  /** Prendre la main : son terminal s'il y en a déjà un (le dernier ouvert), sinon un nouveau. */
  const takeOver = (serverId: string) => {
    const app = useApp.getState();
    app.setActiveServer(serverId);
    const existing = [...app.tabs].reverse().find((t) => t.serverId === serverId && !t.command && !t.grid && !t.join);
    if (existing) {
      app.setActiveTab(existing.key);
      app.setSection("terminal");
    } else app.openTab(serverId);
  };

  const toggleVms = async (serverId: string) => {
    const next = !open[serverId];
    setOpen((o) => ({ ...o, [serverId]: next }));
    if (!next || vms[serverId]) return;
    setVms((v) => ({ ...v, [serverId]: { loading: true } }));
    try {
      if (!(await ensureConnected(serverId))) throw new Error("serveur non connecté");
      const o = await api.vmOverview(serverId);
      setVms((v) => ({ ...v, [serverId]: { loading: false, vms: o.vms, error: o.access === "unavailable" ? (o.reason ?? "libvirt indisponible") : undefined } }));
    } catch (e) {
      setVms((v) => ({ ...v, [serverId]: { loading: false, vms: [], error: errorMessage(e) } }));
    }
  };

  const serial = async (serverId: string, vm: Vm) => {
    onClose();
    try {
      const command = await api.vmSerialCommand(serverId, vm.uuid);
      useApp.getState().openTab(serverId, { title: `${vm.name} (console)`, command });
    } catch (e) {
      useApp.getState().notify(errorMessage(e), "error");
    }
  };

  const vmMenu = (serverId: string, vm: Vm): MenuItem[] => [
    { heading: vm.name },
    { label: "Écran dans Zenytt", icon: <MonitorPlay size={14} />, onClick: () => go(() => void openVmScreen(serverId, vm, "internal")) },
    { label: "Écran dans le client du système", icon: <ExternalLink size={14} />, onClick: () => go(() => void openVmScreen(serverId, vm, "external")) },
    { label: "Console série", icon: <TerminalSquare size={14} />, onClick: () => void serial(serverId, vm) },
  ];

  const desktopMenu = (d: DesktopView): MenuItem[] => [
    { heading: d.name },
    ...(canOpenInside(d) ? [{ label: "Ouvrir dans Zenytt", icon: <MonitorPlay size={14} />, onClick: () => go(() => void openDesktop(d, "internal")) }] : []),
    { label: "Ouvrir dans le client du système", icon: <ExternalLink size={14} />, onClick: () => go(() => void openDesktop(d, "external")) },
  ];

  const hintOf = (s: ServerView) => {
    const sum = summaries[s.id];
    if (!s.connected) return sum && !sum.connected && sum.error ? { text: "injoignable", tone: "text-danger" } : { text: "hors ligne", tone: "text-faint" };
    const b = badgesOf(sum);
    if (b.alerts) return { text: `${b.alerts} alerte${b.alerts > 1 ? "s" : ""}`, tone: "text-danger" };
    if (b.failed) return { text: `${b.failed} en panne`, tone: "text-warn" };
    return null;
  };
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "";

  let lastGroup: string | null | undefined;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Changer de serveur"
      className="animate-pop-in absolute top-full left-0 z-50 mt-1.5 flex max-h-[75vh] w-[440px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setIndex((i) => Math.min(i + 1, reachable.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter" && e.target === input.current) {
          e.preventDefault();
          pick(reachable[index]);
        }
      }}
    >
      <div className="border-b border-border p-2.5">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-accent/70 bg-bg px-2.5 text-[13px]">
          <Search size={14} className="text-faint" />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Changer de serveur…" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
          <Kbd>{display(shortcutOf("switcher"))}</Kbd>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <div role="listbox" aria-label="Serveurs">
          {list.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted">Aucun serveur ne correspond.</p>}
          {list.map((s) => {
            const heading = !query && s.group !== lastGroup ? (s.group || "Sans dossier") : null;
            lastGroup = s.group;
            const folderKey = `servers:${s.group}`;
            const hidden = shut(s);
            const i = reachable.indexOf(s);
            const hint = hintOf(s);
            const shell = hasShell(s);
            return (
              <div key={s.id}>
                {heading &&
                  (s.group ? (
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(folderKey)}
                      aria-expanded={!hidden}
                      className="flex w-full items-center gap-1.5 px-4 pt-2.5 pb-1 text-left text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase hover:text-fg"
                    >
                      <span className={`inline-block w-2.5 transition-transform ${hidden ? "-rotate-90" : ""}`}>▾</span>
                      {heading}
                    </button>
                  ) : (
                    <div className="px-4 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">{heading}</div>
                  ))}
                {!hidden && (
                  <>
                    <div
                      role="option"
                      aria-selected={i === index}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => pick(s)}
                      className={`group mx-1.5 flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${i === index ? "bg-hover-strong" : ""} ${s.id === activeId ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""}`}
                    >
                      <StatusDot tone={s.connected ? "ok" : summaries[s.id]?.error ? "danger" : "muted"} className="size-2!" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium">{s.name}</span>
                        <span className="truncate font-mono text-[10.5px] text-muted">
                          {s.username}@{s.host}
                          {protocolBadge(s) ? ` · ${protocolBadge(s)}` : ""}
                        </span>
                      </span>
                      {hint && <span className={`shrink-0 text-[11px] ${hint.tone}`}>{hint.text}</span>}
                      <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                        {shell && (
                          <QuickAction title={`Terminal sur ${s.name} : le sien s'il y en a un, sinon un nouveau`} onClick={() => go(() => takeOver(s.id))}>
                            Terminal
                          </QuickAction>
                        )}
                        <QuickAction title={`Fichiers de ${s.name}`} onClick={() => go(() => navigate("files", undefined, s.id))}>
                          Fichiers
                        </QuickAction>
                        {shell && (
                          <>
                            <QuickAction title={`Supervision de ${s.name}`} onClick={() => go(() => navigate("monitoring", undefined, s.id))}>
                              Supervision
                            </QuickAction>
                            <button
                              type="button"
                              title={open[s.id] ? "Masquer ses machines virtuelles" : "Ses machines virtuelles"}
                              aria-expanded={!!open[s.id]}
                              onClick={() => void toggleVms(s.id)}
                              className={`flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg ${FOCUS_RING}`}
                            >
                              {open[s.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    {open[s.id] && (
                      <VmList
                        server={s}
                        state={vms[s.id]}
                        mode={mode}
                        onScreen={(vm) => go(() => void openVmScreen(s.id, vm, mode))}
                        onSerial={(vm) => void serial(s.id, vm)}
                        onMenu={(e, vm) => menu.open(e, vmMenu(s.id, vm))}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {shownDesktops.length > 0 && (
          <section aria-label="Bureaux à distance">
            <div className="px-4 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">Bureaux à distance</div>
            {shownDesktops.map((d) => {
              // Un bureau qui ne s'ouvre pas dans Zenytt (SPICE, RDP sans mot de passe) part dans le client du système.
              const effective: ScreenMode = mode === "internal" && !canOpenInside(d) ? "external" : mode;
              return (
                <div
                  key={d.id}
                  onContextMenu={(e) => menu.open(e, desktopMenu(d))}
                  className={`mx-1.5 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-hover ${remoteId === d.id ? "bg-hover-soft" : ""}`}
                >
                  <span className="w-11 shrink-0 rounded bg-hover-strong px-1 text-center font-mono text-[9.5px] font-medium text-muted">{(d.protocol ?? "rdp").toUpperCase()}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium">{d.name}</span>
                    <span className="truncate font-mono text-[10.5px] text-muted">
                      {d.host}
                      {d.viaServerId ? ` · via ${serverName(d.viaServerId)}` : ""}
                    </span>
                  </span>
                  <QuickAction title={`Ouvrir ${MODE_LABEL[effective]} (clic droit : autres choix)`} onClick={() => go(() => void openDesktop(d, effective))}>
                    Ouvrir
                  </QuickAction>
                </div>
              );
            })}
          </section>
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-border p-1.5">
        <button
          type="button"
          onClick={() => go(() => setSection("servers"))}
          className={`flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg ${FOCUS_RING}`}
        >
          <Settings2 size={14} /> Gérer les serveurs
        </button>
        <button
          type="button"
          onClick={() =>
            go(() => {
              setSection("servers");
              useShell.getState().requestNewServer(true);
            })
          }
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-accent hover:bg-accent/10 ${FOCUS_RING}`}
        >
          <Plus size={14} /> Ajouter
        </button>
        <span className="ml-auto truncate px-2 text-[11px] text-faint" title="Écrans des VM et bureaux : le moyen par défaut se règle dans Réglages › Général › Écrans distants">
          écrans {MODE_LABEL[mode]} · clic droit : {MODE_LABEL[OTHER[mode]]}
        </span>
      </div>
      {menu.menu}
    </div>
  );
}

function QuickAction({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className={`rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-accent ${FOCUS_RING}`}>
      {children}
    </button>
  );
}

/** Machines virtuelles d'un serveur une fois dépliées, rangées dans leurs dossiers. */
function VmList({
  server: s,
  state,
  mode,
  onScreen,
  onSerial,
  onMenu,
}: {
  server: ServerView;
  state: VmState | undefined;
  mode: ScreenMode;
  onScreen: (vm: Vm) => void;
  onSerial: (vm: Vm) => void;
  onMenu: (e: React.MouseEvent, vm: Vm) => void;
}) {
  const folders = useItemFolders("vms", s.id);
  const collapsed = useApp((x) => x.folders.collapsed);
  const groups = useMemo(() => {
    if (!state || state.loading) return [];
    const names = [...new Set(state.vms.map((v) => folders.folderOf(v.uuid)))].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b, "fr")));
    return names.map((name) => ({ name, list: state.vms.filter((v) => folders.folderOf(v.uuid) === name) }));
  }, [state, folders.folderOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = (vm: Vm) => {
    const st = stateLabel(vm.state);
    const running = vm.state === "running";
    return (
      <div key={vm.uuid} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-hover" onContextMenu={(e) => onMenu(e, vm)}>
        <StatusDot tone={running ? "ok" : "muted"} className="size-1.5!" />
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={`${vm.name} · ${st.label}`}>
          <span className="text-faint">VM </span>
          {vm.name}
        </span>
        {!running && <Badge tone={st.tone}>{st.label}</Badge>}
        {running && (
          <>
            <QuickAction title={`Écran ${MODE_LABEL[mode]} (clic droit : ${MODE_LABEL[OTHER[mode]]})`} onClick={() => onScreen(vm)}>
              Écran
            </QuickAction>
            <QuickAction title="Console série" onClick={() => onSerial(vm)}>
              Console série
            </QuickAction>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="mr-1.5 mb-1 ml-7 flex flex-col border-l border-line pl-2">
      {state?.loading && <p className="px-2 py-1 text-xs text-faint">Lecture des VM…</p>}
      {state && !state.loading && state.error && <p className="px-2 py-1 text-xs text-faint">{state.error}</p>}
      {state && !state.loading && !state.error && state.vms.length === 0 && <p className="px-2 py-1 text-xs text-faint">Aucune machine virtuelle.</p>}
      {groups.length > 1 || groups[0]?.name
        ? groups.map((g) => {
            const key = `vms:${s.id}:${g.name}`;
            const shut = !!g.name && collapsed.includes(key);
            return (
              <div key={g.name || "\u0000"} className="flex flex-col">
                <button
                  type="button"
                  disabled={!g.name}
                  onClick={() => toggleCollapsed(key)}
                  aria-expanded={g.name ? !shut : undefined}
                  className="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[11px] text-faint enabled:hover:text-fg"
                >
                  <span className={`inline-block w-2.5 text-[10px] transition-transform ${shut ? "-rotate-90" : ""}`}>{g.name ? "▾" : ""}</span>
                  <span className={`truncate ${g.name ? "font-semibold text-muted" : ""}`}>{g.name || "Sans dossier"}</span>
                  <span className="ml-auto tabular-nums">{g.list.length}</span>
                </button>
                {!shut && <div className={g.name ? "ml-2" : ""}>{g.list.map(row)}</div>}
              </div>
            );
          })
        : groups[0]?.list.map(row)}
    </div>
  );
}
