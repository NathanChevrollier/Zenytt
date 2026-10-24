// Vue d'ensemble de Supervision : fiche du serveur (nom d'hôte et fuseau modifiables sur place), six
// chiffres clés, quatre courbes sur la période choisie (seuils des règles d'alerte en pointillés),
// disques et processus les plus actifs ; à droite, le rail fourni par la page (À traiter, Alimentation).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, Pencil, SlidersHorizontal, X } from "lucide-react";
import { api, diskCounts, errorMessage, formatBytes, formatDuration, fullestDisk, type AgentInfo, type AlertMetric, type Disk, type DiskRule, type HistoryPoint, type Metrics, type Process, type SystemInfo } from "../../lib/api";
import { validHostname } from "../../lib/system";
import { diskTone, useMetrics } from "../../lib/metrics";
import { useApp } from "../../lib/store";
import { usePolling } from "../../lib/poll";
import { useCachedState } from "../../lib/cache";
import TimeChart, { SERIES_COLORS } from "../../components/TimeChart";
import { Badge, Button, Card, ErrorState, IconButton, Input, Loading, Meter, StatTile, meterTone } from "../../components/ui";
import DiskRuleDialog from "./DiskRuleDialog";

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
const ratio = (used: number, total: number) => (total ? (used / total) * 100 : 0);

/** Seuil d'une règle d'alerte active de l'agent (le plus bas s'il y en a plusieurs). */
export function ruleThreshold(agent: AgentInfo | null, metric: AlertMetric): number | undefined {
  const t = agent?.running ? agent.status?.config.rules.filter((r) => r.enabled && r.metric === metric).map((r) => r.threshold) : undefined;
  return t?.length ? Math.min(...t) : undefined;
}

export default function Overview({
  serverId,
  info,
  infoError,
  reloadInfo,
  agent,
  visible,
  range,
  rail,
  onAllProcesses,
  onProcCount,
}: {
  serverId: string;
  info: SystemInfo | null;
  infoError: string | null;
  reloadInfo: () => Promise<void>;
  agent: AgentInfo | null;
  visible: boolean;
  range: RangeId;
  rail: ReactNode;
  onAllProcesses: () => void;
  onProcCount: (n: number) => void;
}) {
  const notify = useApp((s) => s.notify);
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => void api.systemTimezones(serverId).then(setZones, () => {}), [serverId]);

  /** Enregistre un réglage puis relit la fiche ; renvoie vrai si c'est passé. */
  const save = (fn: (v: string) => Promise<void>, ok: string) => async (v: string) => {
    try {
      await fn(v);
      notify(ok, "success");
      await reloadInfo();
      return true;
    } catch (e) {
      notify(errorMessage(e), "error");
      return false;
    }
  };

  const { samples: live, error: liveError } = useMetrics(serverId, 2000, visible);
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const agentOk = !!agent?.running;
  const rangeSecs = RANGES.find((x) => x.id === range)!.secs;
  useEffect(() => {
    if (!rangeSecs || !agentOk) setHistory(null);
  }, [rangeSecs, agentOk]);
  // Résultat périmé (période changée entre-temps) : ignoré.
  const historyKey = useRef("");
  historyKey.current = `${serverId}|${range}`;
  usePolling(
    () => {
      const key = historyKey.current;
      return api
        .agentHistory(serverId, rangeSecs)
        .then((h) => historyKey.current === key && (setHistory(h), setHistoryError(null)))
        .catch((e) => historyKey.current === key && setHistoryError(errorMessage(e)));
    },
    30_000,
    [serverId, range],
    !!rangeSecs && agentOk && visible,
  );

  const [diskRules, setDiskRules] = useState<DiskRule[]>([]);
  const [editingDisk, setEditingDisk] = useState<Disk | null>(null);
  const loadDiskRules = useCallback(() => void api.diskRules(serverId).then(setDiskRules, () => setDiskRules([])), [serverId]);
  useEffect(loadDiskRules, [loadDiskRules]);

  // Processus les plus actifs (et leur nombre), relus toutes les 10 s tant que la vue est affichée.
  const [procs, setProcs] = useCachedState<Process[]>(`processes:${serverId}`, []);
  usePolling(() => api.processes(serverId).then(setProcs, () => {}), 10_000, [serverId], visible);
  useEffect(() => {
    if (procs.length) onProcCount(procs.length);
  }, [procs.length, onProcCount]);
  const top = useMemo(() => [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, 5), [procs]);

  // Le premier relevé direct d'une série n'a pas forcément de CPU calculé : on l'écarte des graphiques.
  const points: HistoryPoint[] = useMemo(() => {
    if (history) return history;
    return live.slice(1).map((m) => ({
      t: m.timestamp,
      cpu: m.cpuPercent,
      mem: ratio(m.memUsed, m.memTotal),
      disk: Math.max(0, ...m.disks.filter(diskCounts).map((d) => ratio(d.used, d.total))),
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

  const m: Metrics | undefined = live[live.length - 1];
  const prevOk = live.length > 1;
  const memPct = m ? ratio(m.memUsed, m.memTotal) : 0;
  const swapPct = m ? ratio(m.swapUsed, m.swapTotal) : 0;
  const full = fullestDisk(m?.disks);
  const fullPct = full ? ratio(full.used, full.total) : 0;
  const loadPct = m ? (m.load[0] / Math.max(m.cpuCount, 1)) * 100 : 0;
  const cpuRule = ruleThreshold(agent, "cpu");
  const memRule = ruleThreshold(agent, "memory");
  const diskRule = ruleThreshold(agent, "disk");
  const loadRule = ruleThreshold(agent, "load");

  // Tendance des tuiles : les 40 derniers relevés directs.
  const recent = live.slice(-40);
  const trend = (f: (m: Metrics) => number) => (recent.length > 2 ? recent.slice(1).map(f) : undefined);
  const flag = (v: number, rule?: number) => (rule != null ? (v >= rule ? "alerte" : undefined) : v >= 90 ? "critique" : v >= 80 ? "élevé" : undefined);
  const error = liveError || historyError;
  const tzError = (v: string) => (zones.length && !zones.includes(v) ? "Fuseau inconnu du serveur" : null);

  return (
    <div className="@container flex min-w-0 flex-col">
      {/* Fiche : une rangée sur grand écran ; le nom d'hôte prend deux cases sinon (jamais de case orpheline). */}
      {infoError && !info ? (
        <div className="border-b border-border px-7 py-3">
          <ErrorState message={infoError} onRetry={() => void reloadInfo()} />
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-px border-b border-border bg-border @3xl:grid-cols-4 @7xl:grid-cols-7">
          <Fact label="Nom d'hôte" className="col-span-2 @7xl:col-span-1 @7xl:pl-7">
            {info ? (
              <InlineEdit
                label="le nom d'hôte"
                value={info.hostname}
                textClass="font-semibold"
                validate={(v) => (validHostname(v) ? null : "Lettres, chiffres et tirets, 63 caractères au plus")}
                onSave={save((v) => api.systemSetHostname(serverId, v), "Nom d'hôte modifié")}
              />
            ) : (
              "…"
            )}
          </Fact>
          <Fact label="Système">{info?.os ?? "…"}</Fact>
          <Fact label="Noyau">
            <span className="font-mono text-xs">{info?.kernel ?? "…"}</span>
          </Fact>
          <Fact label="En marche depuis" title={info ? `Démarré le ${new Date(info.bootTime * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}` : undefined}>
            {info ? formatDuration(info.uptimeSecs) : m ? formatDuration(m.uptimeSecs) : "…"}
          </Fact>
          <Fact label="Fuseau">
            {info ? <InlineEdit label="le fuseau horaire" value={info.timezone} list={zones} validate={tzError} onSave={save((v) => api.systemSetTimezone(serverId, v), "Fuseau horaire modifié")} /> : "…"}
          </Fact>
          <Fact label="Processeur" title={info?.cpuModel}>
            {info ? `${info.cpuCount} cœur${info.cpuCount > 1 ? "s" : ""}${info.cpuModel ? ` · ${info.cpuModel}` : ""}` : "…"}
          </Fact>
          <Fact label="Mémoire">{info ? formatBytes(info.memoryTotal) : "…"}</Fact>
        </dl>
      )}

      <div className="grid min-w-0 items-start gap-5 px-7 py-5 @min-[1100px]:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
        <section aria-label="Santé" className="@container flex min-w-0 flex-col gap-4">
          {error && <ErrorState message={error} />}
          <div className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-6">
            <StatTile label="CPU" value={prevOk ? pct(m.cpuPercent) : "…"} hint={m ? `${m.cpuCount} cœur${m.cpuCount > 1 ? "s" : ""}` : undefined} tone={prevOk ? meterTone(m.cpuPercent) : undefined} flag={prevOk ? flag(m.cpuPercent, cpuRule) : undefined} trend={trend((x) => x.cpuPercent)} trendMax={100} />
            <StatTile
              label="Mémoire"
              value={m ? pct(memPct) : "…"}
              hint={m ? `${formatBytes(m.memUsed)} / ${formatBytes(m.memTotal)}${m.swapTotal ? ` · swap ${pct(swapPct)}` : ""}` : undefined}
              tone={m ? meterTone(memPct) : undefined}
              flag={m ? flag(memPct, memRule) : undefined}
              trend={trend((x) => ratio(x.memUsed, x.memTotal))}
              trendMax={100}
            />
            <StatTile
              label="Disque le plus plein"
              value={full ? pct(fullPct) : "…"}
              hint={full ? `${full.mount} · ${formatBytes(Math.max(0, full.total - full.used))} libres` : undefined}
              tone={full ? diskTone(fullPct, diskRule) : undefined}
              flag={full ? flag(fullPct, diskRule) : undefined}
            />
            <StatTile
              label="Charge 1 min"
              value={m ? m.load[0].toFixed(2) : "…"}
              hint={m ? `${Math.round(loadPct)} % de ${m.cpuCount} cœur${m.cpuCount > 1 ? "s" : ""} · 5 min ${m.load[1].toFixed(2)} · 15 min ${m.load[2].toFixed(2)}` : undefined}
              tone={m ? (loadPct >= 200 ? "danger" : loadPct >= 100 ? "warn" : "accent") : undefined}
              trend={trend((x) => x.load[0])}
            />
            <StatTile label="Réseau" value={prevOk ? `↓ ${rate(m.netRxRate)}` : "…"} hint={prevOk ? `↑ ${rate(m.netTxRate)}` : undefined} tone="ok" trend={trend((x) => x.netRxRate)} />
            <StatTile label="Processus" value={procs.length || "…"} hint={top[0] ? `le plus actif : ${top[0].name}` : undefined} onClick={onAllProcesses} />
          </div>

          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
            <Chart title="CPU" note={cpuRule != null ? `seuil d'alerte ${cpuRule} %` : undefined}>
              <TimeChart times={times} series={cpuSeries} format={pct} max={100} height={150} threshold={cpuRule} />
            </Chart>
            <Chart title="Mémoire" note={memRule != null ? `seuil d'alerte ${memRule} %` : undefined}>
              <TimeChart times={times} series={memSeries} format={pct} max={100} height={150} threshold={memRule} />
            </Chart>
            <Chart title="Réseau" note={<Legend items={["↓ réception", "↑ émission"]} />}>
              <TimeChart times={times} series={netSeries} format={rate} height={150} />
            </Chart>
            <Chart title="Charge" note={m ? (loadRule != null ? `seuil d'alerte ${loadRule}` : `ligne = ${m.cpuCount} cœur${m.cpuCount > 1 ? "s" : ""}`) : undefined}>
              <TimeChart times={times} series={loadSeries} format={(v) => v.toFixed(2)} height={150} threshold={loadRule ?? m?.cpuCount} />
            </Chart>
          </div>

          <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-2">
            <Card padded={false} className="min-w-0">
              <h2 className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">Disques</h2>
              {!m ? (
                <div className="px-4 py-3">
                  <Loading rows={2} />
                </div>
              ) : m.disks.length === 0 ? (
                <p className="px-4 py-2.5 text-[13px] text-muted">Aucun volume lu.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {m.disks.map((d) => {
                    const p = ratio(d.used, d.total);
                    const counts = diskCounts(d);
                    const manual = diskRules.some((r) => r.mount === d.mount && (r.total != null || r.used != null));
                    return (
                      <li key={d.mount} className={`grid grid-cols-[minmax(0,1fr)_minmax(60px,120px)_2.75rem_auto] items-center gap-3 py-1.5 pr-2 pl-4 text-[13px] ${counts ? "" : "text-muted"}`} title={`${d.mount} (${d.device}) · ${formatBytes(d.used)} / ${formatBytes(d.total)}`}>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-mono text-xs">{d.mount}</span>
                          {d.readOnly && <Badge tone="muted" title="Lecture seule : plein par nature, hors alerte">lecture seule</Badge>}
                          {d.ignored && <Badge tone="muted" title="Écarté des alertes (réglage)">ignoré</Badge>}
                          {manual && <Badge tone="accent" title="Taille saisie à la main">manuel</Badge>}
                          <span className="ml-auto shrink-0 truncate text-xs text-faint tabular-nums">
                            {formatBytes(d.used)} / {formatBytes(d.total)}
                          </span>
                        </span>
                        <Meter value={p} height={6} tone={counts ? diskTone(p, diskRule) : "muted"} />
                        <span className="text-right text-xs tabular-nums">{pct(p)}</span>
                        <IconButton size="sm" title="Régler ce point de montage (ignorer dans les alertes, taille réelle)" onClick={() => setEditingDisk(d)}>
                          <SlidersHorizontal size={13} />
                        </IconButton>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card padded={false} className="min-w-0">
              <h2 className="flex items-center justify-between border-b border-border px-4 py-2 text-[13px] font-semibold">
                Processus les plus actifs
                <Button size="sm" variant="ghost" className="h-6!" onClick={onAllProcesses}>
                  Tout voir
                </Button>
              </h2>
              {top.length === 0 ? (
                <div className="px-4 py-3">
                  <Loading rows={2} />
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {top.map((p) => (
                    <li key={p.pid} className="grid grid-cols-[minmax(0,1fr)_4rem_4.5rem] items-center gap-3 px-4 py-1.5 text-[13px]" title={p.command}>
                      <span className="truncate font-mono text-xs">{p.command}</span>
                      <span className={`text-right text-xs tabular-nums ${p.cpu >= 50 ? "text-warn" : ""}`}>{p.cpu.toFixed(1)} %</span>
                      <span className="text-right text-xs text-muted tabular-nums">{formatBytes(p.rss)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </section>

        <aside aria-label="À traiter et alimentation" className="flex min-w-0 flex-col gap-4">
          {rail}
        </aside>
      </div>
      {editingDisk && <DiskRuleDialog serverId={serverId} disk={editingDisk} rule={diskRules.find((r) => r.mount === editingDisk.mount)} onClose={() => setEditingDisk(null)} onSaved={loadDiskRules} />}
    </div>
  );
}

function Chart({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {note && <span className="truncate text-[11.5px] text-muted">{note}</span>}
      </div>
      {children}
    </Card>
  );
}

function Legend({ items }: { items: string[] }) {
  return (
    <span className="flex gap-3">
      {items.map((label, i) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES_COLORS[i] }} />
          {label}
        </span>
      ))}
    </span>
  );
}

function Fact({ label, title, className = "", children }: { label: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col justify-center gap-0.5 bg-subtle px-4 py-2.5 ${className}`} title={title}>
      <dt className="text-[11.5px] text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-[13px] font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** Valeur affichée avec un crayon ; Entrée enregistre, Échap annule. `list` propose des valeurs (recherche native). */
function InlineEdit({ label, value, onSave, validate, list, textClass = "" }: { label: string; value: string; onSave: (v: string) => Promise<boolean>; validate: (v: string) => string | null; list?: string[]; textClass?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const listId = useId();
  if (draft === null) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <span className={`truncate select-text ${textClass}`}>{value}</span>
        <IconButton size="sm" title={`Modifier ${label}`} className="size-6! shrink-0 text-faint" onClick={() => setDraft(value)}>
          <Pencil size={12} />
        </IconButton>
      </div>
    );
  }
  const v = draft.trim();
  const problem = v && v !== value ? validate(v) : null;
  const submit = async () => {
    if (!v || problem) return;
    if (v === value) return setDraft(null);
    setSaving(true);
    if (await onSave(v)) setDraft(null);
    setSaving(false);
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          size_="sm"
          aria-label={`Nouveau ${label.replace(/^l[ea] /, "")}`}
          aria-invalid={!!problem}
          list={list?.length ? listId : undefined}
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
          className="min-w-0 max-w-64"
        />
        {list && list.length > 0 && (
          <datalist id={listId}>
            {list.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        )}
        <IconButton type="submit" size="sm" title="Enregistrer" disabled={saving || !v || !!problem}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        </IconButton>
        <IconButton size="sm" title="Annuler" onClick={() => setDraft(null)}>
          <X size={14} />
        </IconButton>
      </div>
      {problem && <span className="text-xs font-normal whitespace-normal text-danger">{problem}</span>}
    </form>
  );
}
