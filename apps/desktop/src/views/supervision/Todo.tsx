// « À traiter » : tout ce qui demande une action, en lignes courtes menant à l'endroit où agir
// (alertes, services en échec, mises à jour, redémarrage requis, constats d'audit sérieux, IP
// bannies, agent absent). Une seule ligne verte quand tout va bien.
import type { ReactNode } from "react";
import { CheckCircle2, EyeOff, Loader2, Wrench } from "lucide-react";
import type { AgentInfo, Finding, Service, SystemInfo, SystemUpdate } from "../../lib/api";
import { formatAt, updateGroup } from "../../lib/system";
import { Button, Card, IconButton, StatusDot, type Tone } from "../../components/ui";
import type { PowerState } from "./Power";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const ago = (t: number) => {
  const min = Math.round((Date.now() - t) / 60_000);
  return min < 1 ? "à l'instant" : min < 60 ? `il y a ${min} min` : `il y a ${Math.round(min / 60)} h`;
};

function Line({ tone, children, action, onClick }: { tone: Tone; children: ReactNode; action?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <StatusDot tone={tone} className="shrink-0" />
      <span className="min-w-0 flex-1 text-[13px]">{children}</span>
    </>
  );
  return (
    <li className="flex min-h-10 items-center gap-2.5 px-4 py-1.5">
      {onClick ? (
        <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:text-accent">
          {body}
        </button>
      ) : (
        body
      )}
      {action}
    </li>
  );
}

const Go = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <Button size="sm" variant="ghost" className="h-6! shrink-0 text-muted" onClick={onClick}>
    {label} ›
  </Button>
);

export interface TodoProps {
  agent: AgentInfo | null;
  info: SystemInfo | null;
  services: Service[] | null | undefined;
  updates: SystemUpdate[] | null;
  updatesError: string | null;
  audit: { score: number; problems: Finding[]; serious: Finding[]; at: number | null; loading: boolean; error: string | null } | null;
  banned: number | null;
  power: PowerState | null;
  findings: { ignore: (f: Finding) => void; startFix: (f: Finding) => void };
  onOpenAlerts: () => void;
  onShowActivity: () => void;
  onShowUpdates: () => void;
  onShowSecurity: () => void;
  onShowAudit: () => void;
  onShowFail2ban: () => void;
}

export default function Todo(p: TodoProps) {
  const { agent, info, services, updates, audit, banned, power, findings } = p;
  const alerts = agent?.status?.activeAlerts ?? [];
  const failed = (services ?? []).filter((s) => s.active === "failed");
  const kernel = updates?.filter((u) => updateGroup(u.name) === "kernel").length ?? 0;
  const agentAbsent = agent && !agent.running;
  const lines: ReactNode[] = [];

  if (info?.scheduled)
    lines.push(
      <Line
        key="scheduled"
        tone="warn"
        action={
          <Button size="sm" loading={power?.cancelling} disabled={!power} onClick={() => void power?.cancelScheduled()}>
            Annuler
          </Button>
        }
      >
        {info.scheduled.mode === "reboot" ? "Redémarrage" : "Extinction"} programmé à {formatAt(info.scheduled.at)}
      </Line>,
    );
  for (const a of alerts)
    lines.push(
      <Line key={`alert:${a.key}`} tone="danger" onClick={p.onOpenAlerts}>
        <span className="font-medium">{a.title}</span>
        <span className="block truncate text-xs text-muted" title={a.message}>
          {a.message} · depuis {new Date(a.since).toLocaleString("fr-FR")}
        </span>
      </Line>,
    );
  if (failed.length)
    lines.push(
      <Line key="failed" tone="danger" action={<Go label="Activité" onClick={p.onShowActivity} />}>
        {plural(failed.length, "service en échec", "services en échec")}
        <span className="block truncate text-xs text-muted">{failed.map((s) => s.unit.replace(/\.service$/, "")).join(", ")}</span>
      </Line>,
    );
  if (info?.rebootRequired && !power?.waitStart)
    lines.push(
      <Line
        key="reboot"
        tone="warn"
        action={
          <Button size="sm" disabled={!power} onClick={() => power?.setModal("reboot")}>
            Redémarrer…
          </Button>
        }
      >
        Redémarrage requis par des mises à jour installées
      </Line>,
    );
  if (updates?.length)
    lines.push(
      <Line key="updates" tone={kernel ? "warn" : "accent"} action={<Go label="Mises à jour" onClick={p.onShowUpdates} />}>
        {plural(updates.length, "mise à jour", "mises à jour")}
        {kernel ? ", dont le noyau" : ""}
      </Line>,
    );
  else if (!updates && p.updatesError)
    lines.push(
      <Line key="updates" tone="muted" action={<Go label="Mises à jour" onClick={p.onShowUpdates} />}>
        <span className="block truncate text-muted" title={p.updatesError}>
          Mises à jour : liste indisponible
        </span>
      </Line>,
    );
  if (audit?.problems.length) {
    lines.push(
      <Line key="audit" tone={audit.serious.length ? "danger" : "warn"} action={<Go label="Sécurité" onClick={p.onShowSecurity} />}>
        Sécurité {audit.score} / 100 · {plural(audit.problems.length, "point à traiter", "points à traiter")}
      </Line>,
    );
    for (const f of audit.serious.slice(0, 4))
      lines.push(
        <li key={`f:${f.id}`} className="flex items-center gap-2 py-1 pr-3 pl-9 text-xs">
          <span className="min-w-0 flex-1 truncate" title={f.detail || f.title}>
            {f.title}
          </span>
          <IconButton size="sm" title="Ignorer ce constat…" onClick={() => findings.ignore(f)}>
            <EyeOff size={13} />
          </IconButton>
          {f.fix && (
            <Button size="sm" variant="outline" icon={<Wrench size={12} />} onClick={() => findings.startFix(f)}>
              {f.fix === "apply-updates" ? "Mises à jour" : "Corriger…"}
            </Button>
          )}
        </li>,
      );
    if (audit.serious.length > 4)
      lines.push(
        <li key="f:more" className="py-1 pl-9 text-xs">
          <button type="button" className="text-accent hover:underline" onClick={p.onShowAudit}>
            + {audit.serious.length - 4} autres constats prioritaires
          </button>
        </li>,
      );
  }
  else if (audit?.error)
    lines.push(
      <Line key="audit" tone="muted" action={<Go label="Sécurité" onClick={p.onShowSecurity} />}>
        <span className="block truncate text-muted" title={audit.error}>
          Audit de sécurité indisponible
        </span>
      </Line>,
    );
  if (banned)
    lines.push(
      <Line key="banned" tone="muted" action={<Go label="fail2ban" onClick={p.onShowFail2ban} />}>
        {plural(banned, "IP bannie", "IP bannies")} par fail2ban
      </Line>,
    );
  if (agentAbsent)
    lines.push(
      <Line key="agent" tone="warn" action={<Go label="Installer" onClick={p.onOpenAlerts} />}>
        {agent.installed ? "L'agent zenyttd ne répond pas" : "Pas d'agent : ni historique, ni alerte Zenytt fermé"}
      </Line>,
    );
  if (!lines.length && audit && !audit.loading && updates)
    lines.push(
      <Line key="ok" tone="ok" action={<Go label="Sécurité" onClick={p.onShowSecurity} />}>
        Rien à traiter · sécurité {audit.score} / 100
      </Line>,
    );
  else if (!lines.length)
    lines.push(
      <li key="wait" className="flex min-h-10 items-center gap-2.5 px-4 text-[13px] text-muted">
        <Loader2 size={13} className="animate-spin" /> Vérification…
      </li>,
    );

  const rules = agent?.status?.config.rules.filter((r) => r.enabled).length ?? 0;
  const n = agent?.status?.config.notifiers;
  const channels = [n?.discordWebhook && "Discord", n?.ntfyUrl && "ntfy", n?.webhookUrl && "webhook"].filter(Boolean).join(", ");

  return (
    <Card padded={false} tone={alerts.length || failed.length ? "danger" : undefined} className="min-w-0">
      <h2 className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-[13px] font-semibold">
        À traiter
        {audit?.at && <span className="text-[11.5px] font-normal text-muted">audit {ago(audit.at)}</span>}
      </h2>
      <ul className="divide-y divide-line">{lines}</ul>
      <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted">
        {agent?.running ? <CheckCircle2 size={13} className="shrink-0 text-ok" /> : null}
        <span className="min-w-0 flex-1 truncate">
          Alertes :{" "}
          {!agent?.running
            ? "sans agent, seulement quand Zenytt est ouvert"
            : `${alerts.length ? plural(alerts.length, "en cours", "en cours") : "aucune en cours"} · ${plural(rules, "règle")}${channels ? `, ${channels}` : ", aucun canal"}`}
        </span>
        <Button size="sm" variant="ghost" className="h-6! text-accent" onClick={p.onOpenAlerts}>
          Régler…
        </Button>
      </div>
    </Card>
  );
}
