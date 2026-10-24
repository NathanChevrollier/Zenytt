import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, OctagonAlert, SlidersHorizontal } from "lucide-react";
import { api, diskCounts, errorMessage, formatBytes, formatDuration, fullestDisk, type AgentInfo, type Disk, type DiskRule, type HistoryPoint, type Metrics } from "../../lib/api";
import TimeChart, { SERIES_COLORS } from "../../components/TimeChart";
import { Badge, Button, Card, ErrorState, IconButton, Meter, StatTile, meterTone } from "../../components/ui";
import DiskRuleDialog from "../supervision/DiskRuleDialog";
import { usePolling } from "../../lib/poll";
import { useMetrics } from "../../lib/metrics";

export const RANGES = [
  { id: "live", label: "Direct", secs: 0 },
  { id: "1h", label: "1 h", secs: 3600 },
  { id: "24h", label: "24 h", secs: 86400 },
  { id: "7d", label: "7 j", secs: 7 * 86400 },
  { id: "30d", label: "30 j", secs: 30 * 86400 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

const pct = (v: number) => `${v.toFixed(0)} %`;
const rate = (v: number) => `${formatBytes(v)}/s`;

function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Card className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </Card>
  );
}

function Legend({ items }: { items: string[] }) {
  return (
    <div className="flex gap-3 text-xs text-muted">
      {items.map((label, i) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES_COLORS[i] }} />
          {label}
        </span>
      ))}
    </div>
  );
}

export default function Overview({
  serverId,
  agent,
  visible,
  range,
  onOpenAgent,
}: {
  serverId: string;
  agent: AgentInfo | null;
  visible: boolean;
  range: RangeId;
  onOpenAgent: () => void;
}) {
  const { samples: live, error: liveError } = useMetrics(serverId, 2000, visible);
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diskRules, setDiskRules] = useState<DiskRule[]>([]);
  const [editingDisk, setEditingDisk] = useState<Disk | null>(null);
  const loadDiskRules = useCallback(() => void api.diskRules(serverId).then(setDiskRules, () => setDiskRules([])), [serverId]);
  useEffect(loadDiskRules, [loadDiskRules]);
  const agentOk = !!agent?.running;

  const rangeSecs = RANGES.find((x) => x.id === range)!.secs;
  useEffect(() => {
    if (!rangeSecs || !agentOk) setHistory(null);
  }, [rangeSecs, agentOk]);
  // Résultat périmé (autre serveur ou période choisis entre-temps) : ignoré.
  const historyKey = useRef("");
  historyKey.current = `${serverId}|${range}`;
  usePolling(
    () => {
      const key = historyKey.current;
      return api
        .agentHistory(serverId, rangeSecs)
        .then((h) => historyKey.current === key && setHistory(h))
        .catch((e) => historyKey.current === key && setError(errorMessage(e)));
    },
    30_000,
    [serverId, range],
    !!rangeSecs && agentOk && visible,
  );

  // Le premier relevé direct n'a pas de CPU calculé : on l'écarte des graphiques.
  const points: HistoryPoint[] = useMemo(() => {
    if (history) return history;
    return live.slice(1).map((m) => ({
      t: m.timestamp,
      cpu: m.cpuPercent,
      mem: m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0,
      disk: Math.max(0, ...m.disks.filter(diskCounts).map((d) => (d.total ? (d.used / d.total) * 100 : 0))),
      load: m.load[0],
      rx: m.netRxRate,
      tx: m.netTxRate,
    }));
  }, [history, live]);

  const times = useMemo(() => points.map((p) => p.t), [points]);
  const cpuSeries = useMemo(() => [{ label: "CPU", values: points.map((p) => p.cpu) }], [points]);
  const memSeries = useMemo(() => [{ label: "Mémoire", values: points.map((p) => p.mem) }], [points]);
  const netSeries = useMemo(
    () => [
      { label: "Réception", values: points.map((p) => p.rx) },
      { label: "Émission", values: points.map((p) => p.tx) },
    ],
    [points],
  );
  const loadSeries = useMemo(() => [{ label: "Charge 1 min", values: points.map((p) => p.load) }], [points]);

  const m = live[live.length - 1];
  const prevOk = live.length > 1;
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const rootDisk = fullestDisk(m?.disks);
  const diskPct = rootDisk && rootDisk.total ? (rootDisk.used / rootDisk.total) * 100 : 0;

  // Tendance des tuiles : les 40 derniers relevés directs.
  const recent = live.slice(-40);
  const trend = (f: (m: Metrics) => number) => (recent.length > 2 ? recent.slice(1).map(f) : undefined);
  const flag = (v: number) => (v >= 90 ? "critique" : v >= 80 ? "élevé" : undefined);
  const loadPct = m ? (m.load[0] / Math.max(m.cpuCount, 1)) * 100 : 0;

  return (
    <div className="@container flex flex-col gap-4">
      {(error || liveError) && <ErrorState message={(error || liveError)!} />}

      {/* Six tuiles : deux rangées de trois, ou une seule rangée quand la place le permet (jamais une tuile orpheline). */}
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @7xl:grid-cols-6">
        <StatTile label="CPU" value={prevOk ? pct(m.cpuPercent) : "…"} hint={m ? `${m.cpuCount} cœurs` : undefined} tone={prevOk ? meterTone(m.cpuPercent) : undefined} flag={prevOk ? flag(m.cpuPercent) : undefined} trend={trend((x) => x.cpuPercent)} trendMax={100} />
        <StatTile
          label="Mémoire"
          value={m ? pct(memPct) : "…"}
          hint={m ? `${formatBytes(m.memUsed)} / ${formatBytes(m.memTotal)}` : undefined}
          tone={m ? meterTone(memPct) : undefined}
          flag={m ? flag(memPct) : undefined}
          trend={trend((x) => (x.memTotal ? (x.memUsed / x.memTotal) * 100 : 0))}
          trendMax={100}
        />
        <StatTile
          label={`Disque ${rootDisk?.mount ?? ""}`}
          value={rootDisk ? pct(diskPct) : "…"}
          hint={rootDisk ? `${formatBytes(rootDisk.total - rootDisk.used)} libres` : undefined}
          tone={rootDisk ? meterTone(diskPct) : undefined}
          flag={rootDisk ? flag(diskPct) : undefined}
        />
        <StatTile
          label="Charge"
          value={m ? m.load[0].toFixed(2) : "…"}
          hint={m ? `5 min ${m.load[1].toFixed(2)} · 15 min ${m.load[2].toFixed(2)}` : undefined}
          tone={m ? (loadPct >= 200 ? "danger" : loadPct >= 100 ? "warn" : "accent") : undefined}
          trend={trend((x) => x.load[0])}
        />
        <StatTile label="Réseau" value={prevOk ? `↓ ${rate(m.netRxRate)}` : "…"} hint={prevOk ? `↑ ${rate(m.netTxRate)}` : undefined} tone="ok" trend={trend((x) => x.netRxRate)} />
        <StatTile label="En ligne depuis" value={m ? formatDuration(m.uptimeSecs) : "…"} hint={m ? `depuis le ${new Date(m.timestamp - m.uptimeSecs * 1000).toLocaleDateString("fr-FR")}` : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Processeur" right={<Legend items={["utilisation"]} />}>
          <TimeChart times={times} series={cpuSeries} format={pct} max={100} />
        </Panel>
        <Panel title="Mémoire" right={<Legend items={["utilisée"]} />}>
          <TimeChart times={times} series={memSeries} format={pct} max={100} />
        </Panel>
        <Panel title="Réseau" right={<Legend items={["Réception", "Émission"]} />}>
          <TimeChart times={times} series={netSeries} format={rate} />
        </Panel>
        <Panel title="Charge système (1 min)">
          <TimeChart times={times} series={loadSeries} format={(v) => v.toFixed(2)} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {m && m.disks.length > 0 && (
          <Panel title="Disques">
            <div className="flex flex-col gap-3">
              {m.disks.map((d) => {
                const p = d.total ? (d.used / d.total) * 100 : 0;
                return (
                  <div key={d.mount} className={`grid grid-cols-[minmax(90px,140px)_minmax(0,110px)_minmax(0,1fr)_120px_28px] items-center gap-3 text-[13px] ${diskCounts(d) ? "" : "opacity-60"}`}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-xs" title={d.mount}>
                        {d.mount}
                      </span>
                      {(d.readOnly || d.ignored || diskRules.some((r) => r.mount === d.mount && (r.total != null || r.used != null))) && (
                        <span className="flex flex-wrap gap-1">
                          {d.readOnly && <Badge tone="muted" title="Lecture seule : plein par nature, hors alerte">lecture seule</Badge>}
                          {d.ignored && <Badge tone="muted" title="Écarté des alertes (réglage)">ignoré</Badge>}
                          {diskRules.some((r) => r.mount === d.mount && (r.total != null || r.used != null)) && <Badge tone="accent" title="Taille saisie à la main">manuel</Badge>}
                        </span>
                      )}
                    </span>
                    <span className="truncate font-mono text-[11px] text-faint">{d.device}</span>
                    <div className="flex items-center gap-2">
                      <Meter value={p} className="flex-1" height={6} tone={diskCounts(d) ? undefined : "muted"} />
                      <span className="w-10 text-right text-xs tabular-nums">{pct(p)}</span>
                    </div>
                    <span className="text-right text-xs text-muted tabular-nums">
                      {formatBytes(d.used)} / {formatBytes(d.total)}
                    </span>
                    <IconButton size="sm" title="Régler ce point de montage (ignorer dans les alertes, taille réelle)" onClick={() => setEditingDisk(d)}>
                      <SlidersHorizontal size={13} />
                    </IconButton>
                  </div>
                );
              })}
            </div>
          </Panel>
        )}
        {editingDisk && (
          <DiskRuleDialog serverId={serverId} disk={editingDisk} rule={diskRules.find((r) => r.mount === editingDisk.mount)} onClose={() => setEditingDisk(null)} onSaved={loadDiskRules} />
        )}
        <Panel title={agent?.status?.activeAlerts.length ? "Alertes en cours" : "Alertes"}>
          {!agent?.running ? (
            <div className="flex flex-col items-start gap-2 text-[13px] text-muted">
              Sans l'agent zenyttd, pas d'alerte quand Zenytt est fermé.
              <Button size="sm" onClick={onOpenAgent}>
                Installer l'agent
              </Button>
            </div>
          ) : agent.status && agent.status.activeAlerts.length === 0 ? (
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <CheckCircle2 size={15} className="text-ok" /> Aucune alerte en cours.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {agent.status?.activeAlerts.map((a) => (
                <li key={a.key} className="flex items-start gap-2 text-[13px]">
                  <OctagonAlert size={15} className="mt-0.5 shrink-0 text-danger" />
                  <div>
                    <div className="font-medium">{a.title}</div>
                    <div className="text-xs text-muted">
                      {a.message} · depuis {new Date(a.since).toLocaleString("fr-FR")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
