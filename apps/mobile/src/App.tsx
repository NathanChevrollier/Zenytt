import { useCallback, useEffect, useState } from "react";
import { Bell, Server as ServerIcon, Settings } from "lucide-react";
import { api, type Server } from "./lib/api";
import { useViewport } from "./lib/hooks";
import { ServerForm } from "./views/ServerForm";
import { ServerScreen } from "./views/ServerScreen";
import { ServersView } from "./views/Servers";
import { AlertsView } from "./views/Alerts";
import { SettingsView } from "./views/Settings";

type Tab = "servers" | "alerts" | "settings";

const TABS: { id: Tab; label: string; icon: typeof Bell }[] = [
  { id: "servers", label: "Serveurs", icon: ServerIcon },
  { id: "alerts", label: "Alertes", icon: Bell },
  { id: "settings", label: "Réglages", icon: Settings },
];

export default function App() {
  useViewport();
  const [tab, setTab] = useState<Tab>("servers");
  const [servers, setServers] = useState<Server[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<Server | "new" | null>(null);

  const refresh = useCallback(() => api.servers().then(setServers).catch(() => {}), []);
  useEffect(() => void refresh(), [refresh]);

  const open = servers.find((s) => s.id === openId) ?? null;
  const goto = (t: Tab) => {
    setTab(t);
    setOpenId(null);
  };

  return (
    <>
      {tab === "servers" && open ? (
        <ServerScreen server={open} onBack={() => setOpenId(null)} onEdit={() => setForm(open)} />
      ) : tab === "servers" ? (
        <ServersView servers={servers} onOpen={(s) => setOpenId(s.id)} onAdd={() => setForm("new")} onChanged={refresh} />
      ) : tab === "alerts" ? (
        <AlertsView servers={servers} onOpen={(s) => { setTab("servers"); setOpenId(s.id); }} />
      ) : (
        <SettingsView onChanged={refresh} />
      )}
      <nav className="bottom-nav" aria-label="Navigation">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => goto(id)}>
            <Icon size={22} />
            {label}
          </button>
        ))}
      </nav>
      {form && (
        <ServerForm
          server={form === "new" ? null : form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void refresh();
          }}
          onDeleted={() => {
            setForm(null);
            setOpenId(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}
