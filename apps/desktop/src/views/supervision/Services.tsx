// Services systemd : filtre, inactifs masqués, en échec d'abord, actions ; un clic ouvre le journal.
import { useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ExternalLink, Play, RotateCw, ScrollText, Search, Square } from "lucide-react";
import { api, errorMessage, type Service } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, Checkbox, DataTable, Drawer, EmptyState, IconButton, Input, Loading, type Column } from "../../components/ui";
import { navigate } from "../../lib/shell";
import { useAutoRefresh } from "../../lib/refresh";

export type ServiceList = Service[] | null | undefined;

/** `list` : `undefined` en lecture, `null` sans systemd. Partagée avec la page (compteur « en échec »). */
export default function Services({ serverId, list, setList, extra }: { serverId: string; list: ServiceList; setList: Dispatch<SetStateAction<ServiceList>>; extra?: ReactNode }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [filter, setFilter] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [logsOf, setLogsOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.services(serverId));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [serverId, notify, setList]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh((auto) => (auto ? api.services(serverId).then(setList, () => {}) : load()), { serverId });

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    return (list ?? []).filter(
      (s) =>
        (!onlyActive || s.active !== "inactive" || s.enabled === "enabled") &&
        (!f || s.unit.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)),
    );
  }, [list, filter, onlyActive]);

  const act = async (s: Service, action: string, label: string) => {
    if (action !== "start") {
      const ok = await ask({
        title: `${label} ${s.unit} ?`,
        body: "Les sites qui dépendent de ce service peuvent être indisponibles pendant l'opération.",
        confirmLabel: label,
        danger: action === "stop",
      });
      if (!ok) return;
    }
    setBusy(s.unit);
    try {
      await api.serviceAction(serverId, s.unit, action);
      notify(`${s.unit} : ${label.toLowerCase()} OK`, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (list === null) {
    return (
      <EmptyState icon={<ScrollText />} title="systemd indisponible">
        Ce serveur n'utilise pas systemd (conteneur ou autre système d'init) : la gestion des services n'est pas possible.
      </EmptyState>
    );
  }

  const tone = (s: Service) => (s.active === "active" ? "ok" : s.active === "failed" ? "danger" : "muted");

  const columns: Column<Service>[] = [
    { key: "unit", header: "Service", width: "minmax(0,1.2fr)", sortValue: (s) => s.unit, render: (s) => <span className="font-mono text-xs">{s.unit.replace(/\.service$/, "")}</span> },
    {
      key: "state",
      header: "État",
      width: "170px",
      sortValue: (s) => `${s.active === "failed" ? 0 : s.active === "active" ? 1 : 2}${s.unit}`,
      render: (s) => (
        <Badge tone={tone(s)}>
          {s.active} · {s.sub}
        </Badge>
      ),
    },
    { key: "enabled", header: "Démarrage", width: "110px", sortValue: (s) => s.enabled, render: (s) => <span className="text-xs text-muted">{s.enabled}</span> },
    { key: "description", header: "Description", width: "minmax(0,2fr)", render: (s) => <span className="text-xs text-muted">{s.description}</span> },
  ];

  const failed = (list ?? []).filter((s) => s.active === "failed").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2">
        <h2 className="text-[13px] font-semibold">
          Services
          {failed > 0 ? <span className="ml-1 font-normal text-danger">· {failed} en échec</span> : list && <span className="ml-1 font-normal text-faint">· {list.length}</span>}
        </h2>
        <label className="relative w-64 min-w-40">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input className="pl-8" placeholder="Filtrer les services" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <Checkbox checked={onlyActive} onChange={setOnlyActive} label="Masquer les inactifs non activés" />
        <span className="ml-auto">{extra}</span>
      </div>
      {list === undefined ? (
        <div className="p-7">
          <Loading rows={8} />
        </div>
      ) : (
        <DataTable
          className="min-h-0 flex-1"
          rows={rows}
          rowKey={(s) => s.unit}
          columns={columns}
          rowHeight={38}
          initialSort={{ key: "state", dir: "asc" }}
          onRowClick={(s) => setLogsOf(s.unit)}
          actionsWidth={76}
        rowActions={(s) =>
            s.active === "active" ? (
              <IconButton size="sm" title="Redémarrer" disabled={!!busy} onClick={() => void act(s, "restart", "Redémarrer")}>
                <RotateCw size={14} className={busy === s.unit ? "animate-spin" : ""} />
              </IconButton>
            ) : (
              <IconButton size="sm" title="Démarrer" disabled={!!busy} onClick={() => void act(s, "start", "Démarrer")}>
                <Play size={14} />
              </IconButton>
            )
          }
          rowMenu={(s) => [
            ...(s.active === "active"
              ? [
                  { label: "Redémarrer", icon: <RotateCw size={14} />, onClick: () => void act(s, "restart", "Redémarrer") },
                  { label: "Arrêter", icon: <Square size={13} />, danger: true, onClick: () => void act(s, "stop", "Arrêter") },
                ]
              : [{ label: "Démarrer", icon: <Play size={14} />, onClick: () => void act(s, "start", "Démarrer") }]),
            "separator" as const,
            { label: "Journaux", icon: <ScrollText size={14} />, onClick: () => setLogsOf(s.unit) },
          ]}
          empty={filter ? "Aucun service ne correspond." : "Aucun service."}
        />
      )}
      {logsOf && <LogsDrawer serverId={serverId} unit={logsOf} onClose={() => setLogsOf(null)} />}
    </div>
  );
}

function LogsDrawer({ serverId, unit, onClose }: { serverId: string; unit: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [lines, setLines] = useState(300);
  useEffect(() => {
    setText(null);
    api.serviceLogs(serverId, unit, lines).then(setText, (e) => setText(errorMessage(e)));
  }, [serverId, unit, lines]);
  return (
    <Drawer
      title={`Journaux de ${unit}`}
      subtitle={`journalctl -u ${unit} · ${lines} dernières lignes`}
      width={720}
      modal={false}
      onClose={onClose}
      actions={
        <>
          <Button size="sm" onClick={() => setLines((l) => l + 700)}>
            Charger plus
          </Button>
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => navigate("logs", `unit:${unit}`)}>
            Ouvrir dans Journaux
          </Button>
        </>
      }
    >
      {text === null ? <Loading rows={10} /> : <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap select-text">{text}</pre>}
    </Drawer>
  );
}
