import { useState } from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import type { Server } from "../lib/api";
import { Dashboard } from "./Dashboard";
import { Containers } from "./Containers";
import { Fail2ban } from "./Fail2ban";
import { Files } from "./Files";
import { TerminalView } from "./TerminalView";

const TABS = [
  { id: "dashboard", label: "Tableau de bord" },
  { id: "containers", label: "Conteneurs" },
  { id: "fail2ban", label: "Fail2ban" },
  { id: "files", label: "Fichiers" },
  { id: "terminal", label: "Terminal" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function ServerScreen({ server, onBack, onEdit }: { server: Server; onBack: () => void; onEdit: () => void }) {
  const [tab, setTab] = useState<Tab>("dashboard");
  return (
    <>
      <div className="header">
        <button className="btn icon" aria-label="Retour" onClick={onBack}>
          <ArrowLeft size={22} />
        </button>
        <h1>{server.name}</h1>
        <button className="btn icon" aria-label="Modifier le serveur" onClick={onEdit}>
          <Pencil size={18} />
        </button>
      </div>
      <div className="subtabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {/* Un seul onglet est monté à la fois : seul l'écran visible interroge le serveur. */}
      {tab === "dashboard" && <Dashboard server={server} onEdit={onEdit} />}
      {tab === "containers" && <Containers server={server} onEdit={onEdit} />}
      {tab === "fail2ban" && <Fail2ban server={server} onEdit={onEdit} />}
      {tab === "files" && <Files server={server} onEdit={onEdit} />}
      {tab === "terminal" && <TerminalView server={server} />}
    </>
  );
}
