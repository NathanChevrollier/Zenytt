// Onglet « Sécurité et mises à jour » : une seule page en sections, sans sous-onglet. À gauche, le
// score de l'audit (la liste complète des constats s'ouvre dans un tiroir) et le sommaire des sections,
// qui reste visible au défilement ; à droite, chaque section sur toute la largeur.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import type { IgnoredFinding, SecurityReport, SystemUpdate } from "../../lib/api";
import { auditSummary, scoreVerdict, updateGroup, type SecuritySection } from "../../lib/system";
import { Badge, Button, Loading } from "../../components/ui";
import { ScoreGauge } from "./Audit";
import type { TocInfo } from "./Panel";
import Software from "./Software";
import Fail2ban from "../security/Fail2ban";
import Firewall from "../security/Firewall";
import Access from "../security/Access";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const SECTIONS: { id: SecuritySection; label: string }[] = [
  { id: "updates", label: "Mises à jour" },
  { id: "fail2ban", label: "fail2ban" },
  { id: "firewall", label: "Pare-feu" },
  { id: "access", label: "Accès SSH" },
];

export default function Security({
  serverId,
  report,
  auditAt,
  auditError,
  auditing,
  reloadAudit,
  ignored,
  updates,
  updatesError,
  checking,
  packageManager,
  refreshUpdates,
  onApplied,
  onBanned,
  focus,
  onOpenAudit,
  imagesOpen,
  onImagesOpen,
}: {
  serverId: string;
  report: SecurityReport | null;
  auditAt: number | null;
  auditError: string | null;
  auditing: boolean;
  reloadAudit: () => void;
  ignored: IgnoredFinding[];
  updates: SystemUpdate[] | null;
  updatesError: string | null;
  checking: boolean;
  packageManager: string | null;
  refreshUpdates: () => Promise<void>;
  onApplied: () => void;
  onBanned: (n: number) => void;
  /** Section à faire défiler à l'écran ; `n` change à chaque demande. */
  focus: { section: SecuritySection; n: number } | null;
  onOpenAudit: () => void;
  imagesOpen: boolean;
  onImagesOpen: (open: boolean) => void;
}) {
  const refs = { updates: useRef<HTMLDivElement>(null), fail2ban: useRef<HTMLDivElement>(null), firewall: useRef<HTMLDivElement>(null), access: useRef<HTMLDivElement>(null) };
  const [active, setActive] = useState<SecuritySection>("updates");
  // Après un clic, le défilement animé traverse d'autres sections : l'entrée choisie reste allumée.
  const lockUntil = useRef(0);
  const scrollTo = (s: SecuritySection) => {
    setActive(s);
    lockUntil.current = Date.now() + 1000;
    refs[s].current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  useEffect(() => {
    if (focus) scrollTo(focus.section);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Entrée du sommaire mise en évidence : la première section présente dans le haut de la zone visible.
  useEffect(() => {
    const visible = new Set<string>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
        const first = SECTIONS.find((s) => visible.has(`sec-${s.id}`));
        if (first && Date.now() > lockUntil.current) setActive(first.id);
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    for (const s of SECTIONS) if (refs[s.id].current) obs.observe(refs[s.id].current!);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [toc, setToc] = useState<Partial<Record<SecuritySection, TocInfo>>>({});
  const onSummary = useMemo(() => {
    const set = (s: SecuritySection) => (i: TocInfo) => setToc((t) => ({ ...t, [s]: i }));
    return { fail2ban: set("fail2ban"), firewall: set("firewall"), access: set("access") };
  }, []);
  const onF2b = useCallback(
    (i: TocInfo) => {
      onSummary.fail2ban(i);
      onBanned(i.count ?? 0);
    },
    [onSummary, onBanned],
  );

  const summary = useMemo(() => (report ? auditSummary(report.findings, ignored.map((i) => i.findingId)) : null), [report, ignored]);
  const n = updates?.length ?? 0;
  const kernel = updates?.filter((u) => updateGroup(u.name) === "kernel").length ?? 0;
  const updatesToc: TocInfo = updatesError && !updates
    ? { count: null, sub: "indisponibles", tone: "danger" }
    : !updates
      ? { count: null, sub: "lecture…" }
      : { count: n, sub: n ? (kernel ? "noyau concerné" : "paquets en attente") : "système à jour", tone: n ? "warn" : "ok" };
  const tocOf = (s: SecuritySection) => (s === "updates" ? updatesToc : toc[s]);

  return (
    <div className="@container min-w-0">
      <div className="flex min-w-0 flex-col @min-[1000px]:flex-row">
        <aside className="shrink-0 border-b border-border @min-[1000px]:w-[256px] @min-[1000px]:border-r @min-[1000px]:border-b-0">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4 px-7 py-5 @min-[1000px]:sticky @min-[1000px]:top-0 @min-[1000px]:flex-col @min-[1000px]:flex-nowrap @min-[1000px]:items-stretch @min-[1000px]:px-4">
            <div className="flex w-80 max-w-full min-w-0 flex-col gap-2.5 @min-[1000px]:w-full">
              <div className="flex min-w-0 items-center gap-3">
                {summary ? <ScoreGauge score={summary.score} small /> : <span className="h-[42px] w-[72px] shrink-0" />}
                <div className={`min-w-0 text-[13.5px] leading-snug font-semibold ${summary?.serious ? "text-danger" : ""}`}>
                  {summary ? scoreVerdict(summary.score) : auditError ? "Audit indisponible" : "Audit en cours…"}
                </div>
              </div>
              <p className="text-xs text-muted" title={auditError ?? "Lecture seule : chaque correction montre son script et attend ton accord."}>
                {summary
                  ? `${summary.problems.length ? `${plural(summary.problems.length, "point")} à traiter${summary.serious ? `, dont ${plural(summary.serious, "prioritaire")}` : ""}` : "Aucun problème détecté par l'audit"} · ${plural(summary.ok.length, "conforme")}${ignored.length ? ` · ${plural(ignored.length, "ignoré")}` : ""}${auditAt ? ` · contrôlé à ${new Date(auditAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}`
                  : (auditError ?? "Lecture seule, rien n'est modifié.")}
              </p>
              {report && (
                <p className="truncate text-[11.5px] text-faint" title={`${report.os} · SSH port ${report.sshPorts.join(", ") || "?"}`}>
                  {report.os} · SSH port {report.sshPorts.join(", ") || "?"}
                </p>
              )}
              {!report && auditing && <Loading label="Audit en cours… (lecture seule)" rows={1} />}
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" icon={<ListChecks size={13} />} disabled={!report} onClick={onOpenAudit}>
                  Voir les {report ? report.findings.length : ""} constats
                </Button>
                <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={auditing ? "animate-spin" : ""} />} disabled={auditing} onClick={reloadAudit} title="Relance l'audit (lecture seule)">
                  Relancer l'audit
                </Button>
              </div>
            </div>

            <nav aria-label="Sommaire" className="flex min-w-0 flex-1 flex-wrap gap-1 @min-[1000px]:flex-col @min-[1000px]:border-t @min-[1000px]:border-border @min-[1000px]:pt-3">
              {SECTIONS.map((s) => {
                const t = tocOf(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={active === s.id ? "true" : undefined}
                    onClick={() => scrollTo(s.id)}
                    className={`flex min-w-40 flex-1 flex-col rounded-md px-2.5 py-1.5 text-left @min-[1000px]:flex-none ${active === s.id ? "bg-accent/12 text-fg" : "text-muted hover:bg-hover-soft hover:text-fg"}`}
                  >
                    <span className="flex items-center justify-between gap-2 text-[13px] font-medium">
                      {s.label}
                      {t?.count != null && <Badge tone={t.count ? (t.tone ?? "muted") : "muted"}>{t.count}</Badge>}
                    </span>
                    <span className={`truncate text-xs ${t?.tone === "danger" && t.count == null ? "text-danger" : "text-faint"}`}>{t?.sub ?? "…"}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-5 px-7 py-5">
          <div id="sec-updates" ref={refs.updates} className="scroll-mt-5">
            <Software
              serverId={serverId}
              updates={updates}
              error={updatesError}
              checking={checking}
              packageManager={packageManager}
              refresh={refreshUpdates}
              onApplied={onApplied}
              imagesOpen={imagesOpen}
              onImagesOpen={onImagesOpen}
            />
          </div>
          <div id="sec-fail2ban" ref={refs.fail2ban} className="scroll-mt-5">
            <Fail2ban serverId={serverId} onSummary={onF2b} onAudit={onOpenAudit} />
          </div>
          <div id="sec-firewall" ref={refs.firewall} className="scroll-mt-5">
            <Firewall serverId={serverId} onSummary={onSummary.firewall} onAudit={onOpenAudit} />
          </div>
          <div id="sec-access" ref={refs.access} className="scroll-mt-5">
            <Access serverId={serverId} onSummary={onSummary.access} />
          </div>
        </div>
      </div>
    </div>
  );
}
