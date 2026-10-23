// Sécurité (onglet de Système) : audit (score et constats par gravité), pare-feu, fail2ban et accès SSH.
// L'audit et les constats ignorés viennent de la page Système, qui en tire aussi le résumé de la vue d'ensemble.
import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, AlertTriangle, CheckCircle2, Info, OctagonAlert, RefreshCw, Wrench } from "lucide-react";
import { api, errorMessage, type Finding, type FixPlan, type IgnoredFinding, type SecurityReport, type Severity } from "../../lib/api";
import { auditSummary, PENALTY, scoreVerdict } from "../../lib/system";
import { useAppPick } from "../../lib/store";
import { Badge, Button, Card, ErrorState, Loading, Modal, ResultBanner, Section, Segmented } from "../../components/ui";
import Fail2ban from "../security/Fail2ban";
import Firewall from "../security/Firewall";
import Access from "../security/Access";

export type SecTab = "audit" | "firewall" | "fail2ban" | "access";
export const SEC_TABS: SecTab[] = ["audit", "firewall", "fail2ban", "access"];

const LABEL: Record<Severity, string> = { critical: "critique", high: "élevé", medium: "moyen", low: "faible", ok: "OK" };
const TONE: Record<Severity, "danger" | "warn" | "accent" | "muted" | "ok"> = { critical: "danger", high: "danger", medium: "warn", low: "muted", ok: "ok" };
const GROUPS: { title: string; severities: Severity[] }[] = [
  { title: "À corriger en priorité", severities: ["critical", "high"] },
  { title: "À prévoir", severities: ["medium"] },
  { title: "Améliorations", severities: ["low"] },
];

function SeverityIcon({ s }: { s: Severity }) {
  if (s === "ok") return <CheckCircle2 size={16} className="text-ok" />;
  if (s === "critical" || s === "high") return <OctagonAlert size={16} className="text-danger" />;
  if (s === "medium") return <AlertTriangle size={16} className="text-warn" />;
  return <Info size={16} className="text-muted" />;
}

export default function Security({
  serverId,
  sub,
  onSub,
  report,
  error,
  loading,
  reload,
  ignored,
  reloadIgnored,
  onShowUpdates,
  onBanned,
}: {
  serverId: string;
  sub: SecTab;
  onSub: (t: SecTab) => void;
  report: SecurityReport | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  ignored: IgnoredFinding[];
  reloadIgnored: () => void;
  onShowUpdates: () => void;
  onBanned: (n: number) => void;
}) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [fixing, setFixing] = useState<{ finding: Finding; plan: FixPlan } | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [counts, setCounts] = useState<{ firewall?: number; fail2ban?: number; access?: number }>({});
  // Rappels stables : les panneaux remontent leur compteur sans relancer de rendu en boucle.
  const onCount = useMemo(() => {
    const make = (k: "firewall" | "fail2ban" | "access") => (n: number) => setCounts((c) => (c[k] === n ? c : { ...c, [k]: n }));
    return { firewall: make("firewall"), fail2ban: make("fail2ban"), access: make("access") };
  }, []);
  useEffect(() => {
    if (counts.fail2ban != null) onBanned(counts.fail2ban);
  }, [counts.fail2ban, onBanned]);
  const toAudit = () => onSub("audit");

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

  const unignore = async (f: IgnoredFinding) => {
    try {
      await api.findingUnignore(serverId, f.findingId);
      reloadIgnored();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const startFix = async (f: Finding) => {
    // Un seul chemin pour les paquets : l'onglet Mises à jour (application non interactive et journal).
    if (f.fix === "apply-updates") return onShowUpdates();
    try {
      setFixing({ finding: f, plan: await api.securityFixPlan(f.fix!) });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const summary = report ? auditSummary(report.findings, ignored.map((i) => i.findingId)) : null;
  const count = (n: number | undefined, tone = "bg-hover-strong text-muted") =>
    n ? <span className={`rounded-full px-1.5 text-[11px] leading-[17px] tabular-nums ${tone}`}>{n}</span> : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Sécurité"
          value={sub}
          onChange={onSub}
          options={[
            { value: "audit", label: <>Audit{count(summary?.problems.length, summary?.serious ? "bg-danger/16 text-danger" : "bg-warn/16 text-warn")}</> },
            { value: "firewall", label: <>Pare-feu{count(counts.firewall, "bg-warn/16 text-warn")}</> },
            { value: "fail2ban", label: <>fail2ban{count(counts.fail2ban)}</> },
            { value: "access", label: <>Accès SSH{count(counts.access)}</> },
          ]}
        />
        {sub === "audit" && (
          <Button size="sm" className="ml-auto" icon={<RefreshCw size={13} className={loading ? "animate-spin" : ""} />} disabled={loading} onClick={reload}>
            Relancer l'audit
          </Button>
        )}
      </div>

      {/* Les quatre panneaux restent montés : leurs compteurs s'affichent dans le sélecteur, et revenir
          sur un panneau ne relance pas sa lecture. */}
      <div className={sub === "audit" ? "flex flex-col gap-6" : "hidden"}>
        {error && <ErrorState message={error} onRetry={reload} retryLabel="Relancer l'audit" />}
        {!report && !error && <Loading label="Audit en cours… (lecture seule)" rows={5} />}
        {report && summary && (
          <>
            <Card className="flex flex-wrap items-center gap-6">
              <ScoreGauge score={summary.score} />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">{scoreVerdict(summary.score)}</h2>
                <p className="mt-0.5 text-[13px] text-muted">
                  {summary.problems.length === 0
                    ? "Aucun problème détecté."
                    : `${summary.problems.length} point${summary.problems.length > 1 ? "s" : ""} à traiter${summary.serious ? `, dont ${summary.serious} prioritaire${summary.serious > 1 ? "s" : ""}` : ""}.`}{" "}
                  {summary.ok.length} conforme{summary.ok.length > 1 ? "s" : ""}
                  {ignored.length ? `, ${ignored.length} ignoré${ignored.length > 1 ? "s" : ""}` : ""}.
                </p>
                <p className="mt-2 text-xs text-faint">
                  {report.os}, SSH sur le port {report.sshPorts.join(", ") || "?"}. Lecture seule : chaque correction montre son script et attend ton accord.
                </p>
              </div>
            </Card>

            {GROUPS.map((g) => {
              const list = summary.problems.filter((f) => g.severities.includes(f.severity)).sort((x, y) => PENALTY[y.severity] - PENALTY[x.severity]);
              if (!list.length) return null;
              return (
                <Section key={g.title} title={g.title} count={list.length}>
                  <Card padded={false} className="divide-y divide-border">
                    {list.map((f) => (
                      <div key={f.id} className="flex items-start gap-3 px-4 py-3">
                        <div className="mt-0.5">
                          <SeverityIcon s={f.severity} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-medium">{f.title}</span>
                            <Badge tone={TONE[f.severity]}>{LABEL[f.severity]}</Badge>
                          </div>
                          {f.detail && <p className="mt-0.5 text-xs text-muted">{f.detail}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => void ignore(f)}>
                            Ignorer
                          </Button>
                          {f.fix && (
                            <Button size="sm" variant={g.severities.includes("critical") ? "primary" : "outline"} icon={<Wrench size={13} />} onClick={() => void startFix(f)}>
                              {f.fix === "apply-updates" ? "Voir les mises à jour" : f.fixLabel}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </Card>
                </Section>
              );
            })}

            {summary.problems.length === 0 && (
              <ResultBanner tone="ok" title="Aucun problème détecté">
                Relance l'audit après une mise à jour ou un changement de configuration.
              </ResultBanner>
            )}

            {summary.ok.length > 0 && (
              <Section title="Points conformes" count={summary.ok.length}>
                <div className="flex flex-wrap gap-2">
                  {summary.ok.map((f) => (
                    <span key={f.id} className="flex items-center gap-1.5 rounded-full border border-ok/30 px-3 py-1 text-xs">
                      <CheckCircle2 size={12} className="text-ok" /> {f.title}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {ignored.length > 0 && (
              <Section
                title="Constats ignorés"
                count={ignored.length}
                actions={
                  <Button size="sm" variant="ghost" aria-expanded={showIgnored} onClick={() => setShowIgnored((v) => !v)}>
                    {showIgnored ? "Masquer" : "Afficher"}
                  </Button>
                }
              >
                {showIgnored && (
                  <Card padded={false} className="divide-y divide-border">
                    {ignored.map((f) => {
                      const current = report.findings.find((x) => x.id === f.findingId);
                      return (
                        <div key={f.findingId} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                          <Archive size={15} className="mt-0.5 shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{current?.title ?? f.title}</span>
                              {current && current.severity !== "ok" ? <Badge tone={TONE[current.severity]}>{LABEL[current.severity]}</Badge> : <Badge tone="ok">réglé depuis</Badge>}
                              <span className="text-xs text-muted">ignoré le {new Date(f.at).toLocaleDateString("fr-FR")}</span>
                            </div>
                            {f.reason && <p className="mt-0.5 text-xs text-muted">{f.reason}</p>}
                          </div>
                          <Button size="sm" variant="ghost" icon={<ArchiveRestore size={13} />} onClick={() => void unignore(f)}>
                            Réafficher
                          </Button>
                        </div>
                      );
                    })}
                  </Card>
                )}
              </Section>
            )}
          </>
        )}
      </div>
      <div className={sub === "firewall" ? "contents" : "hidden"}>
        <Firewall serverId={serverId} onCount={onCount.firewall} onAudit={toAudit} />
      </div>
      <div className={sub === "fail2ban" ? "contents" : "hidden"}>
        <Fail2ban serverId={serverId} onCount={onCount.fail2ban} onAudit={toAudit} />
      </div>
      <div className={sub === "access" ? "contents" : "hidden"}>
        <Access serverId={serverId} onCount={onCount.access} />
      </div>
      {fixing && (
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
      )}
    </>
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
