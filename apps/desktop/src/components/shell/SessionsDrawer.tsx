// Tiroir « Sessions ouvertes », à droite : reprendre un écran distant ou un terminal en cours sans
// quitter la page. Pour ouvrir une nouvelle session (terminal, écran d'une VM, bureau à distance),
// c'est le sélecteur de serveur.
import { useState } from "react";
import { MonitorPlay, PanelRight, Search, SquareTerminal, X } from "lucide-react";
import { useApp } from "../../lib/store";
import { useShell } from "../../lib/shell";
import { useRdp } from "../../lib/rdp";
import { IconButton, Input } from "../ui";
import { display, shortcutOf } from "../../lib/shortcuts";

export default function SessionsDrawer() {
  const servers = useApp((s) => s.servers);
  const tabs = useApp((s) => s.tabs);
  const activeTab = useApp((s) => s.activeTab);
  const section = useApp((s) => s.section);
  const remote = useRdp((s) => s.desktop);
  const remoteVm = useRdp((s) => s.vm);
  const remoteOrigin = useRdp((s) => s.origin);
  const [filter, setFilter] = useState("");
  const close = () => useShell.getState().setMachinesOpen(false);

  const f = filter.trim().toLowerCase();
  const match = (...texts: (string | null | undefined)[]) => !f || texts.some((t) => t?.toLowerCase().includes(f));
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "";

  const goTab = (key: string) => {
    useApp.getState().setActiveTab(key);
    useApp.getState().setSection("terminal");
  };

  const remoteSub = remoteVm ? `VM · ${serverName(remoteVm.serverId)}` : remote?.host;
  const showRemote = remote && match(remote.name, remoteSub);
  const openTabs = tabs.filter((t) => match(t.title, serverName(t.serverId)));

  return (
    <aside className="relative z-30 flex w-[300px] max-w-[40vw] shrink-0 flex-col border-l border-border bg-panel" aria-label="Sessions ouvertes">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <PanelRight size={15} className="text-accent" />
        <h2 className="flex-1 text-[13px] font-semibold">Sessions ouvertes</h2>
        <span className="font-mono text-[10px] text-faint">{display(shortcutOf("machines"))}</span>
        <IconButton size="sm" title="Fermer le tiroir" onClick={close}>
          <X size={15} />
        </IconButton>
      </header>
      {(tabs.length > 0 || remote) && (
        <div className="border-b border-border p-2.5">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <Input size_="sm" className="pl-7" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          </div>
        </div>
      )}

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2.5">
        {!remote && tabs.length === 0 && (
          <p className="px-2 py-4 text-[13px] text-muted">
            Aucune session ouverte. Terminal, écran d'une VM ou bureau à distance s'ouvrent depuis le sélecteur de serveur ({display(shortcutOf("switcher"))}).
          </p>
        )}
        {showRemote && (
          <Group title="Écrans distants">
            <Row
              icon={<MonitorPlay size={14} className="text-accent" />}
              label={remote.name}
              sub={remoteSub}
              active={section === remoteOrigin}
              action="Afficher"
              onClick={() => remoteOrigin && useApp.getState().setSection(remoteOrigin)}
              onClose={() => useRdp.getState().close()}
            />
          </Group>
        )}
        {openTabs.length > 0 && (
          <Group title="Terminaux">
            {openTabs.map((t) => {
              const active = t.key === activeTab && section === "terminal";
              return (
                <Row
                  key={t.key}
                  icon={<SquareTerminal size={14} className={active ? "text-accent" : "text-muted"} />}
                  label={t.title}
                  sub={t.join ? "terminal partagé" : t.grid ? `${t.grid.length} serveurs` : serverName(t.serverId)}
                  active={active}
                  action="Prendre la main"
                  onClick={() => goTab(t.key)}
                />
              );
            })}
          </Group>
        )}
      </div>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-2 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  icon,
  label,
  sub,
  active,
  action,
  onClick,
  onClose,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  active?: boolean;
  action: string;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div className={`group flex items-center gap-1 rounded-lg hover:bg-hover ${active ? "bg-hover-soft" : ""}`}>
      <button type="button" title={action} onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left">
        <span className="shrink-0">{icon}</span>
        <span className="flex min-w-0 flex-col">
          <span className={`truncate text-[13px] ${active ? "font-medium" : ""}`}>{label}</span>
          {sub && <span className="truncate text-[10.5px] text-muted">{sub}</span>}
        </span>
        <span className="ml-auto shrink-0 text-[11.5px] text-accent opacity-0 group-hover:opacity-100">{action}</span>
      </button>
      {onClose && (
        <IconButton size="sm" title="Fermer la session" onClick={onClose}>
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}
