// Système : vue d'ensemble (alimentation, audit de sécurité), sécurité, logiciels et pilotage par l'hébergeur.
// L'onglet « Hébergeur » reste utilisable quand SSH ne répond pas : c'est tout son intérêt.
import { useCallback, useEffect, useState } from "react";
import { Cloud, Loader2, PlugZap } from "lucide-react";
import { api, errorMessage, type IgnoredFinding, type SecurityReport, type SystemInfo, type SystemUpdate } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { auditSummary, resolveSystemTab, type SystemTab } from "../lib/system";
import { Button, EmptyState } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import Overview from "./system/Overview";
import Security, { SEC_TABS, type SecTab } from "./system/Security";
import Software from "./system/Software";
import Provider from "./system/Provider";

type TabId = SystemTab;
type Badges = { updates?: number; problems?: number; serious?: number };

export default function SystemView() {
  const serverId = useApp((s) => s.activeServerId);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  // `navigate("system", "security/fail2ban")` ouvre Sécurité sur son sous-onglet ; les anciens noms
  // (« updates », « inventory », « security » seul = l'audit) sont traduits par `resolveSystemTab`.
  const [rawTab, setRawTab] = useTabIntent<string>("system", "overview");
  const { tab, sub: wanted, audit: toAudit } = resolveSystemTab(rawTab);
  const [secTab, setSecTab] = useState<SecTab>("firewall");
  const [auditFocus, setAuditFocus] = useState(0);
  const [ready, setReady] = useState(false);
  const [trying, setTrying] = useState(false);
  const [badges, setBadges] = useState<Badges>({});

  useEffect(() => {
    if (wanted && SEC_TABS.includes(wanted as SecTab)) setSecTab(wanted as SecTab);
    if (toAudit) setAuditFocus((n) => n + 1);
    // Forme stable une fois traitée : un nouveau lien vers le même onglet repasse donc par ici.
    // Pour Sécurité, « security » seul voudrait dire l'audit : « security/current » garde le sous-onglet.
    const settled = tab === "security" ? "security/current" : tab;
    if (rawTab !== settled) setRawTab(settled);
  }, [rawTab, tab, wanted, toAudit, setRawTab]);

  const connect = useCallback(
    async (force = false) => {
      if (!serverId) return;
      setTrying(true);
      setReady(await ensureConnected(serverId, { force }));
      setTrying(false);
    },
    [serverId],
  );
  useEffect(() => {
    setReady(!!useApp.getState().servers.find((x) => x.id === serverId)?.connected);
    setBadges({});
    void connect();
  }, [serverId, connect]);

  if (!serverId || !server) return <ServerGate title="Système">{() => null}</ServerGate>;
  const sshTab = tab !== "provider";
  return (
    <PageLayout
      title="Système"
      guide={tab === "security" ? "security" : undefined}
      context={<ServerContext server={server} />}
      subtitle="Alimentation, sécurité, mises à jour et réglages du serveur."
      tabs={[
        // Le compteur de la vue d'ensemble = constats d'audit à traiter (l'audit y vit désormais).
        { id: "overview", label: "Vue d'ensemble", count: badges.problems || undefined, tone: badges.serious ? "danger" : badges.problems ? "warn" : undefined },
        { id: "security", label: "Sécurité" },
        { id: "software", label: "Logiciels", count: badges.updates || undefined, tone: badges.updates ? "warn" : undefined },
        { id: "provider", label: "Hébergeur" },
      ]}
      activeTab={tab}
      // « security » seul désigne l'audit (anciens liens) : un clic sur l'onglet garde le sous-onglet courant.
      onTab={(t) => setRawTab(t === "security" ? `security/${secTab}` : t)}
    >
      {/* Pleine largeur : chaque onglet range ses blocs en colonnes selon la place (requêtes de conteneur). */}
      <div className="@container flex w-full min-w-0 flex-col gap-5 px-7 py-5">
        {/* Toujours monté une fois connecté : l'attente du redémarrage survit à un détour par l'onglet Hébergeur. */}
        {ready ? (
          <SshTabs key={serverId} serverId={serverId} name={server.name} tab={tab} setTab={setRawTab} secTab={secTab} setSecTab={setSecTab} auditFocus={auditFocus} onBadges={setBadges} />
        ) : (
          sshTab &&
          (trying ? (
            <EmptyState icon={<Loader2 className="animate-spin" />} title={`Connexion à ${server.name}…`}>
              Ouverture de la session SSH.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<PlugZap />}
              title={`${server.name} ne répond pas en SSH`}
              action={
                <>
                  <Button variant="primary" onClick={() => void connect(true)}>
                    Se connecter
                  </Button>
                  <Button icon={<Cloud size={14} />} onClick={() => setRawTab("provider")}>
                    Piloter via l'hébergeur
                  </Button>
                </>
              }
            >
              Cet onglet passe par SSH. L'onglet Hébergeur reste disponible pour redémarrer ou rallumer le serveur.
            </EmptyState>
          ))
        )}
        {tab === "provider" && <Provider key={`p${serverId}`} serverId={serverId} serverName={server.name} />}
      </div>
    </PageLayout>
  );
}

/**
 * Onglets SSH : ils partagent la fiche du serveur, la liste des mises à jour et l'audit de sécurité
 * (affiché dans la vue d'ensemble) et restent montés. Les panneaux de sécurité (pare-feu, fail2ban,
 * accès) ne sont lus qu'à la première visite de l'onglet Sécurité.
 */
function SshTabs({
  serverId,
  name,
  tab,
  setTab,
  secTab,
  setSecTab,
  auditFocus,
  onBadges,
}: {
  serverId: string;
  name: string;
  tab: TabId;
  setTab: (t: string) => void;
  secTab: SecTab;
  setSecTab: (t: SecTab) => void;
  auditFocus: number;
  onBadges: (b: Badges) => void;
}) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<SystemUpdate[] | null>(null);
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useCachedState<SecurityReport | null>(`security:${serverId}`, null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [ignored, setIgnored] = useState<IgnoredFinding[]>([]);
  const [banned, setBanned] = useState<number | null>(null);
  const [secMounted, setSecMounted] = useState(tab === "security");
  useEffect(() => {
    if (tab === "security") setSecMounted(true);
  }, [tab]);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api.systemInfo(serverId));
      setInfoError(null);
    } catch (e) {
      setInfoError(errorMessage(e));
    }
  }, [serverId]);

  const loadUpdates = useCallback(
    async (refresh: boolean) => {
      setChecking(true);
      try {
        setUpdates(await api.systemUpdates(serverId, refresh));
        setUpdatesError(null);
      } catch (e) {
        setUpdatesError(errorMessage(e));
      } finally {
        setChecking(false);
      }
    },
    [serverId],
  );

  const loadAudit = useCallback(async () => {
    setAuditing(true);
    setAuditError(null);
    try {
      setReport(await api.securityAudit(serverId));
    } catch (e) {
      setAuditError(errorMessage(e));
    } finally {
      setAuditing(false);
    }
  }, [serverId, setReport]);

  const loadIgnored = useCallback(() => void api.findingsIgnored(serverId).then(setIgnored, () => {}), [serverId]);

  useEffect(() => {
    void loadInfo();
    void loadUpdates(false);
    void loadAudit();
    loadIgnored();
  }, [loadInfo, loadUpdates, loadAudit, loadIgnored]);
  useAutoRefresh(() => Promise.all([loadInfo(), loadUpdates(false), loadAudit()]), { serverId, auto: false });

  const summary = report ? auditSummary(report.findings, ignored.map((i) => i.findingId)) : null;
  useEffect(() => {
    onBadges({ updates: updates?.length, problems: summary?.problems.length, serious: summary?.serious });
  }, [updates?.length, summary?.problems.length, summary?.serious, onBadges]);

  const showUpdates = useCallback(() => setTab("software"), [setTab]);
  const showAudit = useCallback(() => setTab("security/audit"), [setTab]);
  const show = (t: TabId) => (tab === t ? "contents" : "hidden");

  return (
    <>
      <div className={show("overview")}>
        <Overview
          serverId={serverId}
          name={name}
          info={info}
          error={infoError}
          reload={loadInfo}
          updates={updates}
          updatesError={updatesError}
          visible={tab === "overview"}
          onShowUpdates={showUpdates}
          audit={{
            serverId,
            report,
            error: auditError,
            loading: auditing,
            reload: () => void loadAudit(),
            ignored,
            reloadIgnored: loadIgnored,
            banned,
            onShowUpdates: showUpdates,
            onShowSecurity: (sub) => setTab(`security/${sub}`),
            focus: auditFocus,
          }}
        />
      </div>
      {secMounted && (
        <div className={show("security")}>
          <Security serverId={serverId} sub={secTab} onSub={setSecTab} onAudit={showAudit} onBanned={setBanned} />
        </div>
      )}
      <div className={show("software")}>
        <Software
          serverId={serverId}
          updates={updates}
          error={updatesError}
          checking={checking}
          packageManager={info?.packageManager ?? null}
          refresh={() => loadUpdates(true)}
          onApplied={() => void Promise.all([loadUpdates(false), loadInfo(), loadAudit()])}
        />
      </div>
    </>
  );
}
