// Barre latérale « serveur d'abord » : le serveur actif en tête (il donne le contexte de tout le
// groupe « Serveur »), puis les sections groupées, avec des badges sur ce qui demande une action.
import { useEffect, useState } from "react";
import { ChevronsUpDown, EyeOff, Lock, MessagesSquare, PanelLeftClose, PanelLeftOpen, Settings2, Sparkles, type LucideIcon } from "lucide-react";
import { AppLogo } from "../AppLogo";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../../lib/store";
import { navigate, useShell } from "../../lib/shell";
import { useLock } from "../../lib/lock";
import { useAssistant } from "../../lib/assistant";
import { badgesOf, useHealth } from "../../lib/health";
import { display, shortcutOf } from "../../lib/shortcuts";
import { hasShell, protocolBadge } from "../../lib/api";
import { ALWAYS_VISIBLE, needsShell, SECTIONS, type SectionId } from "../../sections";
import { Avatar, FOCUS_RING, StatusDot, useContextMenu } from "../ui";
import ServerSwitcher from "./ServerSwitcher";

const RAIL_KEY = "zenytt.rail";

export default function Sidebar({ version }: { version?: string }) {
  const section = useApp((s) => s.section);
  const setSection = useApp((s) => s.setSection);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  const summary = useHealth((s) => (server ? s.summaries[server.id] : undefined));
  const badges = badgesOf(summary);
  const lockConfigured = useLock((s) => s.configured);
  const assistantOpen = useAssistant((s) => s.open);
  const switcherOpen = useShell((s) => s.switcherOpen);
  const setSwitcher = useShell((s) => s.setSwitcherOpen);
  const tabCount = useApp((s) => s.tabs.length);

  // Colonne dépliée ou non : choix retenu d'une session à l'autre.
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, open ? "open" : "closed");
    } catch {
      /* stockage indisponible : la préférence ne sera pas retenue, sans conséquence */
    }
  }, [open]);

  const badgeFor = (id: SectionId): { n: number; tone: "danger" | "warn" | "muted" } | null => {
    if (id === "monitoring" && badges.alerts) return { n: badges.alerts, tone: "danger" };
    if (id === "docker" && badges.failed) return { n: badges.failed, tone: "warn" };
    if (id === "sites" && badges.certs) return { n: badges.certs, tone: "warn" };
    if (id === "terminal" && tabCount) return { n: tabCount, tone: "muted" };
    return null;
  };

  // Onglets masqués par l'utilisateur (Réglages) ; celui qu'on regarde reste affiché.
  const hidden = useApp((s) => s.settings.hiddenSections);
  const shown = (id: SectionId) => (hasShell(server) || !needsShell(id)) && (ALWAYS_VISIBLE.includes(id) || id === section || !hidden?.includes(id));
  const setSettings = useApp((s) => s.setSettings);
  const menu = useContextMenu();

  const item = (id: SectionId, disabled = false) => {
    const s = SECTIONS.find((x) => x.id === id)!;
    return (
      <NavItem
        key={id}
        label={s.label}
        icon={s.icon}
        active={section === id}
        expanded={open}
        disabled={disabled}
        badge={badgeFor(id)}
        onClick={() => setSection(id)}
        onContextMenu={
          ALWAYS_VISIBLE.includes(id)
            ? undefined
            : (e) =>
                menu.open(e, [
                  {
                    label: `Masquer « ${s.label} »`,
                    icon: <EyeOff size={14} />,
                    onClick: () => {
                      setSettings({ hiddenSections: [...(hidden ?? []).filter((h) => h !== id), id] });
                      if (section === id) setSection("home");
                    },
                  },
                  { label: "Choisir les onglets affichés…", icon: <Settings2 size={14} />, onClick: () => navigate("settings", "general") },
                ])
        }
      />
    );
  };

  return (
    <nav
      aria-label="Navigation principale"
      className={`relative flex shrink-0 flex-col border-r border-border bg-rail py-3 transition-[width] duration-150 ${open ? "w-[232px] px-2.5" : "w-[60px] items-center px-1.5"}`}
    >
      <div className={`mb-2.5 flex items-center ${open ? "gap-2 px-1.5" : "flex-col gap-1"}`}>
        <button
          type="button"
          onClick={() => setSection("home")}
          className={`flex size-8 items-center justify-center rounded-lg hover:bg-hover ${FOCUS_RING}`}
          title="Zenytt — accueil"
          aria-label="Zenytt, accueil"
        >
          <AppLogo size={26} />
        </button>
        {open && <span className="flex-1 text-[15px] font-semibold tracking-[0.01em]">Zenytt</span>}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={open ? "Replier la colonne" : "Déplier la colonne"}
          aria-label={open ? "Replier la colonne" : "Déplier la colonne"}
          aria-expanded={open}
          className={`flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg ${FOCUS_RING}`}
        >
          {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>

      {/* Serveur actif : le contexte de toutes les sections du groupe « Serveur ». */}
      <div className="relative mb-3.5 w-full">
        <button
          type="button"
          onClick={() => setSwitcher(!switcherOpen)}
          aria-haspopup="dialog"
          aria-expanded={switcherOpen}
          title={`Changer de serveur (${display(shortcutOf("switcher"))})`}
          className={`flex w-full items-center rounded-xl border border-border-strong/60 bg-panel shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-border-strong ${FOCUS_RING} ${
            open ? "gap-2.5 px-2.5 py-2" : "justify-center p-1.5"
          }`}
        >
          {server ? (
            <span className="relative">
              <Avatar name={server.name} color={server.color} size={30} />
              <StatusDot tone={server.connected ? "ok" : "muted"} className="absolute -right-0.5 -bottom-0.5 size-[9px]! border-2 border-panel" />
            </span>
          ) : (
            <span className="flex size-[30px] items-center justify-center rounded-lg border border-dashed border-border-strong text-faint">?</span>
          )}
          {open && (
            <>
              <span className="flex min-w-0 flex-1 flex-col text-left">
                <span className="flex items-center gap-1.5 truncate text-[13px] font-semibold">
                  {server?.name ?? "Choisir un serveur"}
                  {protocolBadge(server) && <span className="rounded bg-hover-strong px-1 font-mono text-[9.5px] font-medium text-muted">{protocolBadge(server)}</span>}
                </span>
                <span className="truncate font-mono text-[10.5px] text-muted">{server ? `${server.username}@${server.host}` : "aucun serveur actif"}</span>
              </span>
              <ChevronsUpDown size={14} className="shrink-0 text-muted" />
            </>
          )}
        </button>
        {switcherOpen && <ServerSwitcher onClose={() => setSwitcher(false)} />}
      </div>

      <div className="scroll-thin flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
        <GroupLabel expanded={open}>Poste</GroupLabel>
        {SECTIONS.filter((s) => s.group === "poste" && shown(s.id)).map((s) => item(s.id))}
        <GroupLabel expanded={open}>
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusDot tone={server?.connected ? "ok" : "muted"} className="size-1.5!" />
            <span className="truncate">Serveur{server ? ` · ${server.name}` : ""}</span>
          </span>
        </GroupLabel>
        {SECTIONS.filter((s) => s.group === "serveur" && shown(s.id)).map((s) => item(s.id, !server))}
      </div>

      <div className={`mt-2 flex w-full flex-col gap-0.5 border-t border-line pt-2 ${open ? "" : "items-center"}`}>
        <NavItem
          label="Assistant IA"
          icon={Sparkles}
          expanded={open}
          active={assistantOpen}
          hint={display(shortcutOf("assistant"))}
          onClick={() => useAssistant.getState().setOpen(!assistantOpen)}
        />
        {SECTIONS.filter((s) => s.group === "pied" && shown(s.id)).map((s) => item(s.id))}
        {lockConfigured && <NavItem label="Verrouiller" icon={Lock} expanded={open} active={false} hint={display(shortcutOf("lock"))} onClick={() => useLock.getState().lock()} />}
        {open ? (
          <div className="flex items-center justify-between px-2.5 pt-2 text-[11px] text-faint">
            <span>{version ? `Zenytt v${version}` : "Zenytt"}</span>
            <button type="button" className={`flex items-center gap-1 rounded hover:text-fg ${FOCUS_RING}`} onClick={() => void openUrl("https://discord.gg/ctEWWqCj9B")}>
              <MessagesSquare size={12} /> Discord
            </button>
          </div>
        ) : (
          <NavItem label="Discord de Zenytt" icon={MessagesSquare} expanded={false} active={false} onClick={() => void openUrl("https://discord.gg/ctEWWqCj9B")} />
        )}
      </div>
      {menu.menu}
    </nav>
  );
}

function GroupLabel({ children, expanded }: { children: React.ReactNode; expanded: boolean }) {
  if (!expanded) return <div aria-hidden className="mx-auto my-2 h-px w-6 bg-border" />;
  return <div className="px-2.5 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase first:pt-1">{children}</div>;
}

function NavItem({
  label,
  icon: Icon,
  active,
  expanded,
  onClick,
  badge,
  hint,
  disabled,
  onContextMenu,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  badge?: { n: number; tone: "danger" | "warn" | "muted" } | null;
  hint?: string;
  disabled?: boolean;
}) {
  const tone = badge?.tone === "danger" ? "bg-danger/18 text-danger" : badge?.tone === "warn" ? "bg-warn/18 text-warn" : "bg-hover-strong text-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label={badge ? `${label} (${badge.n})` : label}
      aria-current={active ? "page" : undefined}
      title={expanded ? (disabled ? "Choisis d'abord un serveur" : undefined) : label}
      className={`group relative flex h-[34px] shrink-0 items-center rounded-lg text-[13.5px] transition-colors ${FOCUS_RING} ${expanded ? "w-full gap-2.5 px-2.5" : "w-10 justify-center"} ${
        active ? "bg-panel font-medium text-fg shadow-[inset_2px_0_0_var(--color-accent)]" : "text-muted hover:bg-hover hover:text-fg"
      } ${disabled ? "opacity-45" : ""}`}
    >
      <Icon size={17} className="shrink-0" />
      {expanded && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {expanded && hint && !badge && <span className="font-mono text-[10px] text-faint opacity-0 transition-opacity group-hover:opacity-100">{hint}</span>}
      {badge &&
        (expanded ? (
          <span className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${tone}`}>{badge.n}</span>
        ) : (
          <span className={`absolute top-1 right-1 size-2 rounded-full ${badge.tone === "danger" ? "bg-danger" : badge.tone === "warn" ? "bg-warn" : "bg-muted"}`} />
        ))}
      {!expanded && (
        <span className="pointer-events-none absolute left-full z-50 ml-2.5 rounded-md border border-border-strong bg-raised px-2 py-1 text-xs whitespace-nowrap text-fg opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          {label}
        </span>
      )}
    </button>
  );
}
