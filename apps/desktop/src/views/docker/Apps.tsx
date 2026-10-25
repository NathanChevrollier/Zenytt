// Onglet Applications : projets compose et conteneurs, en cartes par projet ou en tableau.
import { useState } from "react";
import { FolderPlus, Search } from "lucide-react";
import type { DockerOverview } from "../../lib/api";
import { appsViewOf, projectDir, type AppsView } from "../../lib/compose";
import { NO_CLIENT, useItemFolders } from "../../lib/folders";
import { askFolderName } from "../../components/Folders";
import { ClientFilter } from "../../components/ClientTools";
import { IconButton, Input, Segmented, Select } from "../../components/ui";
import Compose from "./Compose";
import Containers, { type StateFilter } from "./Containers";
import { useContainerFolders } from "./shared";

const VIEW_KEY = "zenytt.docker.groupBy";

export default function Apps({ serverId, data, docker, reload, onNew, onCatalog }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void>; onNew: () => void; onCatalog: () => void }) {
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<StateFilter>("all");
  const [clientFilter, setClientFilter] = useState("");
  // Ancienne préférence « grouper par projet compose » : devient l'affichage en cartes.
  const [view, setViewState] = useState<AppsView>(() => {
    try {
      return appsViewOf(localStorage.getItem(VIEW_KEY));
    } catch {
      return "cards";
    }
  });
  const clients = useItemFolders("compose", serverId);
  const folders = useContainerFolders(serverId);

  const setView = (v: AppsView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* préférence non retenue */
    }
  };

  const counts: Record<string, number> = {};
  for (const p of data.projects) counts[clients.folderOf(projectDir(p))] = (counts[clients.folderOf(projectDir(p))] ?? 0) + 1;
  // Un filtre sur un client supprimé ou renommé retombe sur « Tous ».
  const client = clientFilter === NO_CLIENT || clients.names.includes(clientFilter) ? clientFilter : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-7 py-2.5">
        <label className="relative w-72">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input className="pl-8" placeholder="Filtrer : nom, image, projet, port" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <Segmented
          label="État"
          value={state}
          onChange={setState}
          options={[
            { value: "all", label: "Tous" },
            { value: "running", label: "En cours" },
            { value: "stopped", label: "Arrêtés" },
          ]}
        />
        {view === "cards" && <ClientFilter names={clients.names} value={client} onChange={setClientFilter} counts={counts} />}
        <span className="ml-auto text-xs text-muted tabular-nums">
          {data.projects.length} projet{data.projects.length > 1 ? "s" : ""} · {data.containers.length} conteneur{data.containers.length > 1 ? "s" : ""}
        </span>
        <span className="text-xs text-muted">Affichage</span>
        <Select<AppsView>
          className="w-56"
          value={view}
          onChange={setView}
          options={[
            { value: "cards", label: "Cartes par projet" },
            { value: "folder", label: "Tableau · par dossier (local)" },
            { value: "none", label: "Tableau · sans groupe" },
          ]}
        />
        {view === "folder" && (
          <IconButton
            title="Nouveau dossier de conteneurs"
            onClick={async () => {
              const name = await askFolderName("Nouveau dossier de conteneurs");
              if (name) folders.create(name);
            }}
          >
            <FolderPlus size={15} />
          </IconButton>
        )}
      </div>
      {view === "cards" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Compose serverId={serverId} data={data} docker={docker} reload={reload} onNew={onNew} onCatalog={onCatalog} filter={filter} state={state} clientFilter={client} />
        </div>
      ) : (
        <Containers serverId={serverId} data={data} docker={docker} reload={reload} filter={filter} state={state} groupBy={view} />
      )}
    </div>
  );
}
