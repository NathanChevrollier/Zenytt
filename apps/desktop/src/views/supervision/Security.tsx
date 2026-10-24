// Onglet « Sécurité et mises à jour » : une seule page en sections, sans sous-onglet. En tête, le
// score de l'audit (la liste complète des constats s'ouvre dans un tiroir) ; puis mises à jour et
// versions, pare-feu et accès SSH, fail2ban.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import type { IgnoredFinding, SecurityReport, SystemUpdate } from "../../lib/api";
import { auditSummary, scoreVerdict, type SecuritySection } from "../../lib/system";
import { Button, Card, Loading } from "../../components/ui";
import { ScoreGauge } from "./Audit";
import Software from "./Software";
import Fail2ban from "../security/Fail2ban";
import Firewall from "../security/Firewall";
import Access from "../security/Access";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

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
  const refs = { updates: useRef<HTMLElement>(null), fail2ban: useRef<HTMLElement>(null), firewall: useRef<HTMLElement>(null), access: useRef<HTMLElement>(null) };
  const scrollTo = (s: SecuritySection) => refs[s].current?.scrollIntoView({ block: "start", behavior: "smooth" });
  useEffect(() => {
    if (focus) scrollTo(focus.section);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const [banned, setBanned] = useState<number | null>(null);
  const [exposed, setExposed] = useState<number | null>(null);
  const summary = useMemo(() => (report ? auditSummary(report.findings, ignored.map((i) => i.findingId)) : null), [report, ignored]);
  const n = updates?.length ?? 0;
  const onF2b = (c: number) => {
    setBanned(c);
    onBanned(c);
  };

  return (
    <div className="@container flex min-w-0 flex-col gap-5 px-7 py-5">
      <Card padded={false} tone={summary?.serious ? "danger" : undefined} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        {summary ? <ScoreGauge score={summary.score} /> : <span className="h-[70px] w-[120px]" />}
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{summary ? scoreVerdict(summary.score) : auditError ? "Audit indisponible" : "Audit en cours…"}</div>
          <div className="truncate text-xs text-muted" title={auditError ?? "Lecture seule : chaque correction montre son script et attend ton accord."}>
            {summary
              ? `${summary.problems.length ? `${plural(summary.problems.length, "point")} à traiter${summary.serious ? `, dont ${plural(summary.serious, "prioritaire")}` : ""}` : "Aucun problème détecté par l'audit"} · ${plural(summary.ok.length, "conforme")}${ignored.length ? ` · ${plural(ignored.length, "ignoré")}` : ""}${auditAt ? ` · dernier contrôle à ${new Date(auditAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}`
              : (auditError ?? "Lecture seule, rien n'est modifié.")}
          </div>
          {report && (
            <div className="truncate text-[11.5px] text-faint">
              {report.os} · SSH port {report.sshPorts.join(", ") || "?"}
            </div>
          )}
        </div>
        <nav aria-label="Raccourcis" className="flex flex-wrap items-center gap-x-1 text-[13px]">
          <Jump onClick={() => scrollTo("updates")}>{updates ? (n ? plural(n, "mise à jour", "mises à jour") : "système à jour") : "mises à jour"}</Jump>
          <span className="text-faint">·</span>
          <Jump onClick={() => scrollTo("fail2ban")}>{banned != null ? plural(banned, "IP bannie", "IP bannies") : "fail2ban"}</Jump>
          <span className="text-faint">·</span>
          <Jump onClick={() => scrollTo("firewall")}>{exposed != null ? `pare-feu · ${plural(exposed, "port exposé", "ports exposés")}` : "pare-feu"}</Jump>
          <span className="text-faint">·</span>
          <Jump onClick={() => scrollTo("access")}>accès SSH</Jump>
        </nav>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" icon={<ListChecks size={13} />} disabled={!report} onClick={onOpenAudit}>
            Voir les {report ? report.findings.length : ""} constats
          </Button>
          <Button size="sm" icon={<RefreshCw size={13} className={auditing ? "animate-spin" : ""} />} disabled={auditing} onClick={reloadAudit} title="Relance l'audit (lecture seule)">
            Relancer l'audit
          </Button>
        </div>
      </Card>

      {/* Large : mises à jour à gauche, pare-feu et accès à droite ; fail2ban en dessous, sur toute la largeur. */}
      <div className="grid min-w-0 items-start gap-5 @min-[1300px]:grid-cols-2">
        <Block id="updates" ref={refs.updates} title="Mises à jour">
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
        </Block>
        <div className="flex min-w-0 flex-col gap-5">
          <Block id="firewall" ref={refs.firewall} title="Pare-feu">
            <Firewall serverId={serverId} onCount={setExposed} onAudit={onOpenAudit} />
          </Block>
          <Block id="access" ref={refs.access} title="Accès SSH">
            <Access serverId={serverId} />
          </Block>
        </div>
      </div>
      <Block id="fail2ban" ref={refs.fail2ban} title="fail2ban">
        <Fail2ban serverId={serverId} onCount={onF2b} onAudit={onOpenAudit} />
      </Block>
      {!report && auditing && <Loading label="Audit en cours… (lecture seule)" rows={1} />}
    </div>
  );
}

function Jump({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="rounded px-1 text-accent hover:underline">
      {children}
    </button>
  );
}

function Block({ id, ref, title, children }: { id: string; ref: React.RefObject<HTMLElement | null>; title: string; children: ReactNode }) {
  return (
    <section id={`sec-${id}`} ref={ref} aria-label={title} className="flex min-w-0 scroll-mt-4 flex-col gap-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
