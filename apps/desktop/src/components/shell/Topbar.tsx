// Barre du haut : où l'on est (fil d'Ariane), la barre de commande, et les outils globaux
// (actualiser, notifications, assistant).
import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, PanelRight, RefreshCw, Search, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { formatAgo } from "../../lib/api";
import { useApp, type NotificationEntry } from "../../lib/store";
import { useShell } from "../../lib/shell";
import { refreshAll, useRefresh } from "../../lib/refresh";
import { useAssistant } from "../../lib/assistant";
import { display, shortcutOf } from "../../lib/shortcuts";
import { SECTIONS } from "../../sections";
import { Button, EmptyState, FOCUS_RING, IconButton, Kbd, StatusDot } from "../ui";

export default function Topbar() {
  const section = useApp((s) => s.section);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  const crumb = useShell((s) => s.crumb);
  const openPalette = useShell((s) => s.openPalette);
  const setSwitcher = useShell((s) => s.setSwitcherOpen);
  const meta = SECTIONS.find((s) => s.id === section);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <nav aria-label="Fil d'Ariane" className="flex min-w-0 flex-1 basis-0 items-center gap-2 text-[13px]">
        {meta?.perServer && server ? (
          <button
            type="button"
            onClick={() => setSwitcher(true)}
            title="Changer de serveur"
            className={`flex h-6 max-w-[40%] shrink-0 items-center gap-1.5 truncate rounded-md border border-border bg-panel px-2 font-medium hover:border-border-strong ${FOCUS_RING}`}
          >
            <StatusDot tone={server.connected ? "ok" : "muted"} />
            {server.name}
          </button>
        ) : (
          <span className="shrink-0 text-faint">Poste</span>
        )}
        <span className="text-border-strong">/</span>
        <span className={`truncate ${crumb && crumb !== meta?.label ? "text-muted" : "font-medium"}`}>{meta?.label}</span>
        {crumb && crumb !== meta?.label && (
          <>
            <span className="text-border-strong">/</span>
            <span className="truncate font-medium">{crumb}</span>
          </>
        )}
      </nav>

      <button
        type="button"
        onClick={() => openPalette()}
        className={`flex h-8 w-full max-w-[320px] min-w-0 shrink 2xl:max-w-[460px] items-center gap-2.5 rounded-lg border border-border bg-panel px-2.5 text-[13px] text-muted transition-colors hover:border-border-strong ${FOCUS_RING}`}
      >
        <Search size={15} className="shrink-0" />
        <span className="flex-1 truncate text-left">Rechercher, ouvrir, lancer…</span>
        <Kbd className="shrink-0">{display(shortcutOf("palette"))}</Kbd>
      </button>

      <div className="flex min-w-fit flex-1 basis-0 items-center justify-end gap-1">
        <RefreshButton />
        <NotificationsButton />
        <MachinesButton />
        <AssistantButton />
      </div>
    </header>
  );
}

/** Actualise la page affichée et l'état des serveurs (aussi F5). */
function RefreshButton() {
  const tick = useRefresh((s) => s.tick);
  const [spin, setSpin] = useState(false);
  useEffect(() => {
    if (!tick) return;
    setSpin(true);
    const t = setTimeout(() => setSpin(false), 700);
    return () => clearTimeout(t);
  }, [tick]);
  return (
    <IconButton title="Actualiser (F5)" onClick={refreshAll}>
      <RefreshCw size={16} className={spin ? "animate-spin" : ""} />
    </IconButton>
  );
}

/** Tiroir des machines : prendre la main sur un serveur, une VM ou un bureau distant. */
function MachinesButton() {
  const open = useShell((s) => s.machinesOpen);
  return (
    <IconButton title={`Machines : changer de machine (${display(shortcutOf("machines"))})`} aria-pressed={open} className={open ? "text-accent" : ""} onClick={() => useShell.getState().setMachinesOpen(!open)}>
      <PanelRight size={16} />
    </IconButton>
  );
}

function AssistantButton() {
  const open = useAssistant((s) => s.open);
  return (
    <Button
      variant={open ? "subtle" : "outline"}
      onClick={() => useAssistant.getState().setOpen(!open)}
      title={`Assistant IA (${display(shortcutOf("assistant"))})`}
      aria-pressed={open}
      icon={<Sparkles size={15} className="text-accent" />}
      className="ml-1"
    >
      Assistant
    </Button>
  );
}

const ICONS = {
  info: <Info size={15} className="text-accent" />,
  warn: <TriangleAlert size={15} className="text-warn" />,
  error: <CircleAlert size={15} className="text-danger" />,
  success: <CircleCheck size={15} className="text-ok" />,
};

function timeLabel(at: number) {
  const ms = Date.now() - at;
  if (ms < 3_600_000) return formatAgo(ms);
  return new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Centre de notifications : tout ce qui est passé en notification pendant la session. */
function NotificationsButton() {
  const open = useShell((s) => s.notificationsOpen);
  const setOpen = useShell((s) => s.setNotificationsOpen);
  const unread = useApp((s) => s.unreadNotifications);
  const hasError = useApp((s) => s.notifications.slice(0, s.unreadNotifications).some((n) => n.kind === "error"));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    useApp.getState().markNotificationsRead();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div ref={ref} className="relative">
      <IconButton title={unread ? `Notifications (${unread} non lues)` : "Notifications"} active={open} onClick={() => setOpen(!open)} className="relative">
        <Bell size={16} />
        {unread > 0 && <span className={`absolute top-1.5 right-1.5 size-2 rounded-full border-2 border-bg ${hasError ? "bg-danger" : "bg-accent"}`} />}
      </IconButton>
      {open && <NotificationsPanel />}
    </div>
  );
}

function NotificationsPanel() {
  const list = useApp((s) => s.notifications);
  const servers = useApp((s) => s.servers);
  const clear = useApp((s) => s.clearNotifications);
  return (
    <div role="dialog" aria-label="Notifications" className="animate-pop-in absolute top-full right-0 z-50 mt-1.5 flex max-h-[70vh] w-[380px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex-1 text-[13px] font-semibold">Notifications</h2>
        {list.length > 0 && (
          <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={clear}>
            Tout effacer
          </Button>
        )}
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<CheckCheck />} title="Rien de nouveau">
          Les confirmations et erreurs de la session s'affichent ici.
        </EmptyState>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {list.map((n: NotificationEntry) => (
            <li key={n.id} className="flex gap-2.5 px-4 py-2 text-[13px] hover:bg-hover-soft">
              <span className="mt-0.5 shrink-0">{ICONS[n.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="break-words select-text">{n.message}</p>
                <p className="mt-0.5 text-[11px] text-faint">
                  {timeLabel(n.at)}
                  {n.serverId && ` · ${servers.find((s) => s.id === n.serverId)?.name ?? ""}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
