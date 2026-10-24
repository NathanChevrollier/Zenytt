// Audit de sécurité : score, constats à traiter (corriger ou ignorer) et, à part, points conformes et
// constats ignorés. L'audit lui-même est lu (et gardé 15 min) par la page Supervision.
import { useState } from "react";
import { AlertTriangle, Archive, ArchiveRestore, CheckCircle2, EyeOff, Info, OctagonAlert, RefreshCw, Wrench } from "lucide-react";
import { api, errorMessage, type Finding, type FixPlan, type IgnoredFinding, type SecurityReport, type Severity } from "../../lib/api";
import { auditSummary, PENALTY, scoreVerdict } from "../../lib/system";
import { useAppPick } from "../../lib/store";
import { Badge, Button, Card, ErrorState, IconButton, Loading, Modal, ResultBanner } from "../../components/ui";
import type { SecuritySection } from "../../lib/system";

export type AuditProps = {
  serverId: string;
  report: SecurityReport | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  ignored: IgnoredFinding[];
  reloadIgnored: () => void;
  /** IP bannies par fail2ban, connues après la première visite de Sécurité. */
  banned: number | null;
  onShowUpdates: () => void;
  onShowSecurity: (sub: SecuritySection) => void;
};

export const LABEL: Record<Severity, string> = { critical: "critique", high: "élevé", medium: "moyen", low: "faible", ok: "OK" };
export const TONE: Record<Severity, "danger" | "warn" | "accent" | "muted" | "ok"> = { critical: "danger", high: "danger", medium: "warn", low: "muted", ok: "ok" };
const GROUPS: { title: string; severities: Severity[] }[] = [
  { title: "À corriger en priorité", severities: ["critical", "high"] },
  { title: "À prévoir", severities: ["medium"] },
  { title: "Améliorations", severities: ["low"] },
];

export function SeverityIcon({ s }: { s: Severity }) {
  if (s === "critical" || s === "high") return <OctagonAlert size={15} className="shrink-0 text-danger" />;
  if (s === "medium") return <AlertTriangle size={15} className="shrink-0 text-warn" />;
  return <Info size={15} className="shrink-0 text-muted" />;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

/** « Corriger » (script montré avant) et « Ignorer » (raison facultative) : partagés par la liste et « À traiter ». */
export function useFindingActions({ serverId, reload, reloadIgnored, onShowUpdates }: Pick<AuditProps, "serverId" | "reload" | "reloadIgnored" | "onShowUpdates">) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [fixing, setFixing] = useState<{ finding: Finding; plan: FixPlan } | null>(null);

  /** Met un constat de côté, avec une raison facultative : il rejoint les constats ignorés. */
  const ignore = async (f: Finding) => {
    const reason = await ask({
      title: `Ignorer « ${f.title} » ?`,
      body: "Ce constat n'apparaîtra plus dans les problèmes de ce serveur. Il reste consultable dans les constats ignorés, où tu peux le réactiver.",
      input: { label: "Raison (facultatif)", initial: "" },
      confirmLabel: "Ignorer",
    });
    if (reason === null || reason === false) return;
    try {
      await api.findingIgnore(serverId, f.id, f.title, typeof reason === "string" ? reason : "");
      reloadIgnored();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const startFix = async (f: Finding) => {
    // Un seul chemin pour les paquets : la section Mises à jour (application non interactive et journal).
    if (f.fix === "apply-updates") return onShowUpdates();
    try {
      setFixing({ finding: f, plan: await api.securityFixPlan(f.fix!) });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const dialog = fixing && (
    <FixDialog
      serverId={serverId}
      finding={fixing.finding}
      plan={fixing.plan}
      onClose={() => setFixing(null)}
      onDone={() => {
        setFixing(null);
        reload();
      }}
    />
  );
  return { ignore, startFix, dialog };
}

/** Score et constats à traiter, groupés par priorité, avec « Corriger » et « Ignorer ». */
export function AuditFindings({ serverId, report, error, loading, reload, ignored, reloadIgnored, banned, onShowUpdates, onShowSecurity }: AuditProps) {
  const { ignore, startFix, dialog } = useFindingActions({ serverId, reload, reloadIgnored, onShowUpdates });

  const summary = report ? auditSummary(report.findings, ignored.map((i) => i.findingId)) : null;

  return (
    <Card padded={false} tone={summary?.serious ? "danger" : undefined} className="min-w-0 overflow-hidden">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
        {summary && <ScoreGauge score={summary.score} small />}
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">{summary ? `Sécurité · ${scoreVerdict(summary.score)}` : "Audit de sécurité"}</h2>
          {summary && report && (
            <p className="truncate text-xs text-muted" title="Lecture seule : chaque correction montre son script et attend ton accord.">
              {summary.problems.length ? `${plural(summary.problems.length, "point")} à traiter` : "Aucun problème"}
              {summary.serious ? `, dont ${plural(summary.serious, "prioritaire")}` : ""} · {plural(summary.ok.length, "conforme")}
              {ignored.length ? ` · ${plural(ignored.length, "ignoré")}` : ""} · {report.os} · SSH port {report.sshPorts.join(", ") || "?"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {banned != null && (
            <Button size="sm" variant="ghost" onClick={() => onShowSecurity("fail2ban")}>
              {plural(banned, "IP bannie")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onShowSecurity("firewall")}>
            Pare-feu
          </Button>
          <IconButton size="sm" title="Relancer l'audit (lecture seule)" disabled={loading} onClick={reload}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </IconButton>
        </div>
      </div>

      {error && !report ? (
        <div className="p-3">
          <ErrorState message={error} onRetry={reload} retryLabel="Relancer l'audit" />
        </div>
      ) : !summary ? (
        <div className="px-4 py-3">
          <Loading label="Audit en cours… (lecture seule)" rows={3} />
        </div>
      ) : summary.problems.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
          <CheckCircle2 size={15} className="text-ok" /> Aucun problème détecté.
        </p>
      ) : (
        GROUPS.map((g) => {
          const list = summary.problems.filter((f) => g.severities.includes(f.severity)).sort((x, y) => PENALTY[y.severity] - PENALTY[x.severity]);
          if (!list.length) return null;
          return (
            <section key={g.title} className="border-b border-border last:border-b-0">
              <h3 className="flex h-7 items-center gap-2 border-b border-border bg-subtle px-4 text-xs font-semibold">
                {g.title} <span className="font-normal text-faint">{list.length}</span>
              </h3>
              <ul className="divide-y divide-line">
                {list.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-1.5 hover:bg-hover-soft">
                    <SeverityIcon s={f.severity} />
                    <Badge tone={TONE[f.severity]} className="w-14 justify-center">
                      {LABEL[f.severity]}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{f.title}</div>
                      {f.detail && (
                        <p className="truncate text-xs text-muted" title={f.detail}>
                          {f.detail}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <IconButton size="sm" title="Ignorer ce constat…" onClick={() => void ignore(f)}>
                        <EyeOff size={14} />
                      </IconButton>
                      {f.fix && (
                        <Button size="sm" variant={g.severities.includes("critical") ? "primary" : "outline"} icon={<Wrench size={13} />} onClick={() => void startFix(f)}>
                          {f.fix === "apply-updates" ? "Voir les mises à jour" : f.fixLabel}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      {dialog}
    </Card>
  );
}

/** Points conformes et constats ignorés (repliés) : remplit la colonne d'actions, défile si besoin. */
export function AuditChecks({ serverId, report, ignored, reloadIgnored, className = "" }: Pick<AuditProps, "serverId" | "report" | "ignored" | "reloadIgnored"> & { className?: string }) {
  const notify = useAppPick("notify").notify;
  const [showIgnored, setShowIgnored] = useState(false);
  if (!report) return null;
  const ok = report.findings.filter((f) => f.severity === "ok");
  if (!ok.length && !ignored.length) return null;

  const unignore = async (f: IgnoredFinding) => {
    try {
      await api.findingUnignore(serverId, f.findingId);
      reloadIgnored();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <Card padded={false} className={`flex min-w-0 flex-col overflow-hidden ${className}`}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ok.length > 0 && (
          <>
            <h3 className="sticky top-0 flex h-8 items-center gap-2 border-b border-border bg-subtle px-4 text-xs font-semibold">
              Points conformes <span className="font-normal text-faint">{ok.length}</span>
            </h3>
            <ul className="divide-y divide-line">
              {ok.map((f) => (
                <li key={f.id} className="flex items-center gap-2 px-4 py-1.5 text-xs">
                  <CheckCircle2 size={12} className="shrink-0 text-ok" />
                  <span className="truncate" title={f.title}>
                    {f.title}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {showIgnored && (
          <ul className="divide-y divide-line border-t border-border">
            {ignored.map((f) => {
              const current = report.findings.find((x) => x.id === f.findingId);
              return (
                <li key={f.findingId} className="flex items-center gap-2 py-1.5 pr-2 pl-4 text-xs">
                  <Archive size={13} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium">{current?.title ?? f.title}</span>
                      {current && current.severity !== "ok" ? <Badge tone={TONE[current.severity]}>{LABEL[current.severity]}</Badge> : <Badge tone="ok">réglé depuis</Badge>}
                    </div>
                    <div className="truncate text-faint" title={f.reason || undefined}>
                      le {new Date(f.at).toLocaleDateString("fr-FR")}
                      {f.reason ? ` · ${f.reason}` : ""}
                    </div>
                  </div>
                  <IconButton size="sm" title="Réafficher ce constat" onClick={() => void unignore(f)}>
                    <ArchiveRestore size={14} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {ignored.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border bg-subtle pr-2 pl-4 text-xs font-semibold">
          Constats ignorés <span className="font-normal text-faint">{ignored.length}</span>
          <Button size="sm" variant="ghost" className="ml-auto h-6!" aria-expanded={showIgnored} onClick={() => setShowIgnored((v) => !v)}>
            {showIgnored ? "Masquer" : "Afficher"}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Jauge en demi-cercle : 100 = rien à signaler, chaque constat retire des points selon sa gravité. */
export function ScoreGauge({ score, small }: { score: number; small?: boolean }) {
  const r = 44;
  const len = Math.PI * r;
  const color = score >= 90 ? "var(--color-ok)" : score >= 70 ? "var(--color-accent)" : score >= 40 ? "var(--color-warn)" : "var(--color-danger)";
  return (
    <div className={`relative shrink-0 ${small ? "h-[42px] w-[72px]" : "h-[70px] w-[120px]"}`} role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label="Score de sécurité">
      <svg viewBox="0 0 120 70" className="h-full w-full">
        <path d={`M 16 62 A ${r} ${r} 0 0 1 104 62`} fill="none" stroke="var(--color-raised)" strokeWidth="10" strokeLinecap="round" />
        <path
          d={`M 16 62 A ${r} ${r} 0 0 1 104 62`}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(len * score) / 100} ${len}`}
          style={{ transition: "stroke-dasharray 600ms ease" }}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <span className={`${small ? "text-[15px]" : "text-[22px]"} leading-none font-semibold tabular-nums`}>{score}</span>
        {!small && <span className="text-xs text-muted">/100</span>}
      </div>
    </div>
  );
}

function FixDialog({ serverId, finding, plan, onClose, onDone }: { serverId: string; finding: Finding; plan: FixPlan; onClose: () => void; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null);

  const apply = async () => {
    setRunning(true);
    try {
      setResult(await api.securityFixApply(serverId, plan.id));
    } catch (e) {
      setResult({ ok: false, output: errorMessage(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={finding.fixLabel ?? "Correction"}
      width="max-w-3xl"
      onClose={running ? () => {} : result ? onDone : onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onDone}>
            Fermer
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={running} onClick={onClose}>
              Annuler
            </Button>
            <Button variant="primary" loading={running} onClick={() => void apply()}>
              Appliquer
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <ResultBanner tone={result.ok ? "ok" : "danger"} title={result.ok ? "Correction appliquée." : "Correction non appliquée (ou annulée automatiquement)."} />
          <pre className="max-h-80 overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{result.output}</pre>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{plan.description}</p>
          {plan.needsVerification && (
            <ResultBanner tone="warn" title="Cette correction touche l'accès au serveur">
              <span className="text-xs text-muted">Zenytt garde ta connexion actuelle ouverte, en ouvre une nouvelle pour vérifier que tu peux toujours te connecter, et annule tout sinon.</span>
            </ResultBanner>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted">Voir le script exécuté en root</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-bg p-3 font-mono text-[11px] whitespace-pre-wrap select-text">{plan.script}</pre>
          </details>
        </div>
      )}
    </Modal>
  );
}
