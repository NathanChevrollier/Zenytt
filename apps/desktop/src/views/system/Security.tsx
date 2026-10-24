// Sécurité (onglet de Système) : pare-feu, fail2ban et accès SSH. L'audit (score et constats) vit dans la vue d'ensemble.
import { useEffect, useMemo, useState } from "react";
import { Segmented } from "../../components/ui";
import Fail2ban from "../security/Fail2ban";
import Firewall from "../security/Firewall";
import Access from "../security/Access";

export type SecTab = "firewall" | "fail2ban" | "access";
export const SEC_TABS: SecTab[] = ["firewall", "fail2ban", "access"];

export default function Security({
  serverId,
  sub,
  onSub,
  onAudit,
  onBanned,
}: {
  serverId: string;
  sub: SecTab;
  onSub: (t: SecTab) => void;
  /** Mène au bloc d'audit de la vue d'ensemble (installer ou activer un outil passe par ses corrections). */
  onAudit: () => void;
  onBanned: (n: number) => void;
}) {
  const [counts, setCounts] = useState<{ firewall?: number; fail2ban?: number; access?: number }>({});
  // Rappels stables : les panneaux remontent leur compteur sans relancer de rendu en boucle.
  const onCount = useMemo(() => {
    const make = (k: "firewall" | "fail2ban" | "access") => (n: number) => setCounts((c) => (c[k] === n ? c : { ...c, [k]: n }));
    return { firewall: make("firewall"), fail2ban: make("fail2ban"), access: make("access") };
  }, []);
  useEffect(() => {
    if (counts.fail2ban != null) onBanned(counts.fail2ban);
  }, [counts.fail2ban, onBanned]);

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
            { value: "firewall", label: <>Pare-feu{count(counts.firewall, "bg-warn/16 text-warn")}</> },
            { value: "fail2ban", label: <>fail2ban{count(counts.fail2ban)}</> },
            { value: "access", label: <>Accès SSH{count(counts.access)}</> },
          ]}
        />
      </div>

      {/* Les trois panneaux restent montés : leurs compteurs s'affichent dans le sélecteur, et revenir
          sur un panneau ne relance pas sa lecture. */}
      <div className={sub === "firewall" ? "contents" : "hidden"}>
        <Firewall serverId={serverId} onCount={onCount.firewall} onAudit={onAudit} />
      </div>
      <div className={sub === "fail2ban" ? "contents" : "hidden"}>
        <Fail2ban serverId={serverId} onCount={onCount.fail2ban} onAudit={onAudit} />
      </div>
      <div className={sub === "access" ? "contents" : "hidden"}>
        <Access serverId={serverId} onCount={onCount.access} />
      </div>
    </>
  );
}
