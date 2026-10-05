// Machines virtuelles KVM/QEMU d'un serveur (libvirt) : liste, cycle de vie, écran (VNC par tunnel
// SSH, dans Zenytt) et console série (onglet terminal). Rien n'est exposé sur Internet.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, FolderInput, FolderPlus, Monitor, Pause, Pencil, Play, Power, PowerOff, RotateCw, SquareTerminal, Trash2, Zap } from "lucide-react";
import { api, errorMessage, type Vm, type VmAction, type VmOverview, type VmStats } from "../lib/api";
import { allowedActions, memoryText, needsConfirmation, removableDiskFiles, stateLabel } from "../lib/vm";
import { openVmScreen } from "../lib/rdp";
import { useItemFolders } from "../lib/folders";
import { startDrag } from "../lib/drag";
import { askFolderName, toggleCollapsed } from "../components/Folders";
import { useApp, useAppPick } from "../lib/store";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { usePolling } from "../lib/poll";
import { Badge, Button, Checkbox, DataTable, EmptyState, ErrorState, IconButton, Loading, MenuButton, Modal, type Column, type MenuItem } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import VmDrawer from "./vms/VmDrawer";

const ACTION_LOOK: Record<VmAction, { label: string; icon: React.ReactNode }> = {
  start: { label: "Démarrer", icon: <Play size={14} /> },
  shutdown: { label: "Éteindre", icon: <Power size={14} /> },
  reboot: { label: "Redémarrer", icon: <RotateCw size={14} /> },
  forceOff: { label: "Forcer l'arrêt…", icon: <Zap size={14} /> },
  suspend: { label: "Mettre en pause", icon: <Pause size={14} /> },
  resume: { label: "Reprendre", icon: <Play size={14} /> },
  autostartOn: { label: "Démarrer avec le serveur", icon: <Power size={14} /> },
  autostartOff: { label: "Ne plus démarrer avec le serveur", icon: <PowerOff size={14} /> },
};

export default function VmsView() {
  return <ServerGate title="Machines virtuelles" guide="vms">{(serverId) => <Vms key={serverId} serverId={serverId} />}</ServerGate>;
}

function Vms({ serverId }: { serverId: string }) {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const { ask, notify, openTab, openGuide } = useAppPick("ask", "notify", "openTab", "openGuide");
  const [data, setData] = useCachedState<VmOverview | null>(`vms:${serverId}`, null);
  const [stats, setStats] = useState<Record<string, VmStats>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Vm | null>(null);
  const folders = useItemFolders("vms", serverId);
  const collapsed = useApp((s) => s.folders.collapsed);

  const load = useCallback(async () => {
    try {
      setData(await api.vmOverview(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId, setData]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh((auto) => (auto ? api.vmOverview(serverId).then(setData, () => {}) : load()), { serverId });

  const anyRunning = !!data?.vms.some((v) => v.state === "running");
  usePolling(
    async () => {
      const list = await api.vmStats(serverId).catch(() => []);
      setStats(Object.fromEntries(list.map((s) => [s.uuid, s])));
    },
    5000,
    [serverId],
    anyRunning,
  );

  const act = async (vm: Vm, action: VmAction) => {
    if (needsConfirmation(action)) {
      const ok = await ask({
        title: `Forcer l'arrêt de « ${vm.name} » ?`,
        body: "Équivaut à débrancher la machine : les données non enregistrées dans la VM sont perdues.",
        confirmLabel: "Forcer l'arrêt",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(vm.uuid);
    try {
      await api.vmAction(serverId, vm, action);
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const serial = async (vm: Vm) => {
    try {
      const command = await api.vmSerialCommand(serverId, vm.uuid);
      openTab(serverId, { title: `${vm.name} (console)`, command });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const screen = (vm: Vm) => void openVmScreen(serverId, vm, "internal");

  const moveItems = (vm: Vm): MenuItem[] => [
    { heading: "Ranger dans un dossier (local)" },
    ...folders.names.filter((f) => f !== folders.folderOf(vm.uuid)).map((f) => ({ label: f, icon: <FolderInput size={14} />, onClick: () => folders.move([vm.uuid], f) })),
    ...(folders.folderOf(vm.uuid) ? [{ label: "Sortir du dossier", onClick: () => folders.move([vm.uuid], null) }] : []),
    {
      label: "Nouveau dossier…",
      icon: <FolderPlus size={14} />,
      onClick: async () => {
        const name = await askFolderName("Nouveau dossier de machines virtuelles");
        if (name) folders.move([vm.uuid], name);
      },
    },
  ];

  const menu = (vm: Vm): MenuItem[] => [
    ...allowedActions(vm).map((a) => ({ label: ACTION_LOOK[a].label, icon: ACTION_LOOK[a].icon, danger: a === "forceOff", onClick: () => void act(vm, a) })),
    "separator" as const,
    ...(vm.state === "running"
      ? [
          { label: "Écran", icon: <Monitor size={14} />, onClick: () => screen(vm) },
          { label: "Écran dans le client du système", icon: <ExternalLink size={14} />, onClick: () => void openVmScreen(serverId, vm, "external") },
          { label: "Console série", icon: <SquareTerminal size={14} />, onClick: () => void serial(vm) },
          "separator" as const,
        ]
      : []),
    ...moveItems(vm),
    "separator" as const,
    { label: "Supprimer…", icon: <Trash2 size={14} />, danger: true, onClick: () => setDeleting(vm) },
  ];

  // Dossiers (propres à ce PC) : la liste est groupée dès qu'il en existe un.
  const grouped = folders.names.length > 0;
  const rows = useMemo(() => {
    const list = data?.vms ?? [];
    if (!grouped) return list;
    // Dossiers nommés d'abord (ordre alphabétique), « sans dossier » à la fin ; puis en marche d'abord.
    return [...list].sort((a, b) => {
      const fa = folders.folderOf(a.uuid) || "\uffff";
      const fb = folders.folderOf(b.uuid) || "\uffff";
      return fa.localeCompare(fb, "fr") || Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name, "fr");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, grouped, folders.folderOf]);

  const context = server && <ServerContext server={server} />;
  const layout = (children: React.ReactNode) => (
    <PageLayout title="Machines virtuelles" context={context} guide="vms">
      {children}
    </PageLayout>
  );

  if (error && !data) return layout(<div className="p-7"><ErrorState message={error} onRetry={() => void load()} /></div>);
  if (!data) return layout(<div className="p-7"><Loading rows={6} /></div>);
  if (data.access === "unavailable") {
    return layout(
      <EmptyState
        icon={<Monitor />}
        title="libvirt n'est pas accessible"
        action={
          <div className="flex gap-2">
            <Button onClick={() => void load()}>Réessayer</Button>
            <Button variant="ghost" onClick={() => openGuide("vms")}>
              Ouvrir le guide
            </Button>
          </div>
        }
      >
        {data.reason}
      </EmptyState>,
    );
  }

  const running = data.vms.filter((v) => v.state === "running").length;
  const columns: Column<Vm>[] = [
    {
      key: "name",
      header: "Machine",
      sortValue: (v) => v.name.toLowerCase(),
      render: (v) => (
        <span className="min-w-0">
          <span className="block truncate font-medium" title={v.name}>
            {v.name}
          </span>
          <span className="block truncate font-mono text-xs text-faint">{v.uuid}</span>
        </span>
      ),
    },
    {
      key: "state",
      header: "État",
      width: "130px",
      sortValue: (v) => (v.state === "running" ? 0 : 1),
      render: (v) => {
        const s = stateLabel(v.state);
        return <Badge tone={s.tone}>{s.label}</Badge>;
      },
    },
    { key: "vcpus", header: "vCPU", width: "70px", sortValue: (v) => v.vcpus, render: (v) => <span className="text-xs">{v.vcpus}</span> },
    { key: "memory", header: "Mémoire", width: "140px", sortValue: (v) => v.memoryKib, render: (v) => <span className="text-xs">{memoryText(v, stats[v.uuid])}</span> },
    {
      key: "cpu",
      header: "CPU",
      width: "80px",
      sortValue: (v) => stats[v.uuid]?.cpuPercent ?? -1,
      render: (v) => <span className="text-xs text-muted">{v.state === "running" && stats[v.uuid] ? `${stats[v.uuid].cpuPercent.toLocaleString("fr-FR")} %` : "—"}</span>,
    },
    { key: "autostart", header: "Démarrage auto", width: "130px", sortValue: (v) => (v.autostart ? 0 : 1), render: (v) => <span className="text-xs text-muted">{v.autostart ? "oui" : "non"}</span> },
  ];

  return (
    <>
      <PageLayout
        title="Machines virtuelles"
        context={context}
        guide="vms"
        scroll={data.vms.length === 0}
        actions={
          data.vms.length > 0 && (
            <IconButton
              title="Nouveau dossier de machines virtuelles"
              onClick={async () => {
                const name = await askFolderName("Nouveau dossier de machines virtuelles");
                if (name) folders.create(name);
              }}
            >
              <FolderPlus size={15} />
            </IconButton>
          )
        }
        status={
          <>
            <Badge tone={running ? "ok" : "muted"}>
              {running} en marche sur {data.vms.length}
            </Badge>
            <span className="text-xs text-muted">
              libvirt {data.version}
              {data.access === "sudo" ? " · via sudo" : ""} · écran par tunnel SSH, jamais exposé
            </span>
          </>
        }
      >
        {data.vms.length === 0 ? (
          <EmptyState icon={<Monitor />} title="Aucune machine virtuelle">
            libvirt est installé mais ce serveur n'a pas encore de VM. La création depuis Zenytt arrive dans une prochaine version ; en attendant, <span className="font-mono">virt-install</span> ou virt-manager.
          </EmptyState>
        ) : (
          <DataTable
            className="min-h-0 flex-1"
            rows={rows}
            rowKey={(v) => v.uuid}
            columns={columns}
            rowHeight={52}
            initialSort={grouped ? undefined : { key: "state", dir: "asc" }}
            onRowMouseDown={grouped ? (v, e) => startDrag(e, v.name, (folder) => folders.move([v.uuid], folder || null)) : undefined}
            groupBy={
              grouped
                ? {
                    key: (v) => folders.folderOf(v.uuid),
                    collapsed: (k) => collapsed.includes(`vms:${serverId}:${k}`),
                    header: (k, list) => {
                      const collapseKey = `vms:${serverId}:${k}`;
                      const isCollapsed = collapsed.includes(collapseKey);
                      return (
                        <div data-drop={k} className="flex h-9 items-center gap-2 border-b border-line bg-subtle px-3 text-xs text-muted">
                          <button type="button" onClick={() => toggleCollapsed(collapseKey)} aria-expanded={!isCollapsed} className="flex min-w-0 items-center gap-2">
                            <span className={`inline-block transition-transform ${isCollapsed ? "-rotate-90" : ""}`}>▾</span>
                            <span className={`truncate font-semibold ${k ? "text-fg" : ""}`}>{k || "Sans dossier"}</span>
                          </button>
                          <span className="ml-auto">
                            {list.filter((v) => v.state === "running").length} / {list.length} en marche
                          </span>
                          {k && (
                            <MenuButton
                              size="sm"
                              title={`Dossier ${k}`}
                              items={[
                                {
                                  label: "Renommer…",
                                  icon: <Pencil size={14} />,
                                  onClick: async () => {
                                    const next = await askFolderName(`Renommer « ${k} »`, k);
                                    if (next && next !== k) folders.rename(k, next);
                                  },
                                },
                                { label: "Supprimer le dossier", icon: <Trash2 size={14} />, danger: true, onClick: () => folders.remove(k) },
                              ]}
                            />
                          )}
                        </div>
                      );
                    },
                  }
                : undefined
            }
            onRowClick={(v) => setSelected(v.uuid)}
            isSelected={(v) => v.uuid === selected}
            actionsWidth={112}
            rowActions={(v) =>
              v.state === "running" ? (
                <>
                  <IconButton size="sm" title="Écran" onClick={() => screen(v)}>
                    <Monitor size={14} />
                  </IconButton>
                  <IconButton size="sm" title="Console série" onClick={() => void serial(v)}>
                    <SquareTerminal size={14} />
                  </IconButton>
                </>
              ) : (
                <IconButton size="sm" title="Démarrer" disabled={busy === v.uuid} onClick={() => void act(v, "start")}>
                  <Play size={14} />
                </IconButton>
              )
            }
            rowMenu={menu}
          />
        )}
      </PageLayout>
      {selected && data.vms.some((v) => v.uuid === selected) && (
        <VmDrawer serverId={serverId} vm={data.vms.find((v) => v.uuid === selected)!} onClose={() => setSelected(null)} menu={menu} />
      )}
      {deleting && (
        <DeleteVmDialog
          serverId={serverId}
          vm={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={async (withStorage) => {
            const left = await api.vmDelete(serverId, deleting, withStorage);
            setDeleting(null);
            setSelected(null);
            // Disques hors d'un pool libvirt : virsh ne les supprime pas, sans échouer. On le dit.
            if (left.length) notify(`« ${deleting.name} » supprimée, mais ces disques sont restés sur le serveur (hors d'un pool libvirt) : ${left.join(", ")}`, "error");
            else notify(`« ${deleting.name} » supprimée`, "success");
            await load();
          }}
        />
      )}
    </>
  );
}

function DeleteVmDialog({ serverId, vm, onClose, onConfirm }: { serverId: string; vm: Vm; onClose: () => void; onConfirm: (withStorage: boolean) => Promise<void> }) {
  const [withStorage, setWithStorage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Fichiers qui seraient supprimés avec la VM, affichés avant de confirmer. */
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    api.vmDetail(serverId, vm.uuid).then((d) => setFiles(removableDiskFiles(d)), () => setFiles([]));
  }, [serverId, vm.uuid]);
  return (
    <Modal
      title={`Supprimer « ${vm.name} » ?`}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(withStorage);
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Supprimer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">La VM est arrêtée si besoin, puis sa définition est supprimée de libvirt. Ses instantanés sont oubliés.</p>
        <Checkbox
          checked={withStorage}
          onChange={setWithStorage}
          disabled={busy}
          label="Supprimer aussi ses disques (définitif)"
          hint="Sans cette case, les fichiers de disque restent sur le serveur et peuvent servir à recréer la VM. Les ISO et les disques partagés ne sont jamais supprimés."
        />
        {withStorage && (
          <div className="rounded-md border border-border bg-subtle px-3 py-2 text-xs">
            {files === null ? (
              <span className="text-muted">Lecture des disques…</span>
            ) : files.length ? (
              <>
                <p className="mb-1 text-muted">Fichiers supprimés :</p>
                {files.map((f) => (
                  <p key={f} className="font-mono break-all select-text">
                    {f}
                  </p>
                ))}
              </>
            ) : (
              <span className="text-muted">Aucun disque propre à cette VM : rien d'autre ne sera supprimé.</span>
            )}
          </div>
        )}
        {error && <ErrorState message={error} />}
      </div>
    </Modal>
  );
}
