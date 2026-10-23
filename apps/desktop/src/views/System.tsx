// Système : vue d'ensemble et alimentation, sécurité, mises à jour, inventaire et pilotage par l'hébergeur.
// L'onglet « Hébergeur » reste utilisable quand SSH ne répond pas : c'est tout son intérêt.
import { useCallback, useEffect, useState } from "react";
import { Cloud, Loader2, PlugZap } from "lucide-react";
import { api, errorMessage, type IgnoredFinding, type SecurityReport, type SystemInfo, type SystemUpdate } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { auditSummary, splitTab } from "../lib/system";
import { Button, EmptyState } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import Overview from "./system/Overview";
import Security, { SEC_TABS, type SecTab } from "./system/Security";
import Updates from "./system/Updates";
import Inventory from "./system/Inventory";
import Provider from "./system/Provider";

type TabId = "overview" | "security" | "updates" | "inventory" | "provider";
type Badges = { updates?: number; problems?: number; serious?: number };

export default function SystemView() {
  const serverId = useApp((s) => s.activeServerId);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  // `navigate("system", "security/fail2ban")` ouvre Sécurité sur son sous-onglet.
  const [rawTab, setRawTab] = useTabIntent<string>("system", "overview");
  const [main, wanted] = splitTab(rawTab);
  const tab = main as TabId;
  const [secTab, setSecTab] = useState<SecTab>("audit");
  const [ready, setReady] = useState(false);
  const [trying, setTrying] = useState(false);
  const [badges, setBadges] = useState<Badges>({});

  useEffect(() => {
    if (wanted && SEC_TABS.includes(wanted as SecTab)) setSecTab(wanted as SecTab);
    if (wanted) setRawTab(main);
  }, [main, wanted, setRawTab]);

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
        { id: "overview", label: "Vue d'ensemble" },
        { id: "security", label: "Sécurité", count: badges.problems || undefined, tone: badges.serious ? "danger" : badges.problems ? "warn" : undefined },
        { id: "updates", label: "Mises à jour", count: badges.updates || undefined, tone: badges.updates ? "warn" : undefined },
        { id: "inventory", label: "Inventaire" },
        { id: "provider", label: "Hébergeur" },
      ]}
      activeTab={tab}
      onTab={setRawTab}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-7 py-5">
        {/* Toujours monté une fois connecté : l'attente du redémarrage survit à un détour par l'onglet Hébergeur. */}
        {ready ? (
          <SshTabs key={serverId} serverId={serverId} name={server.name} tab={tab} setTab={setRawTab} secTab={secTab} setSecTab={setSecTab} onBadges={setBadges} />
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
 * (résumés dans la vue d'ensemble) et restent montés. Les panneaux de sécurité (pare-feu, fail2ban,
 * accès) ne sont lus qu'à la première visite de l'onglet Sécurité.
 */
function SshTabs({
  serverId,
  name,
  tab,
  setTab,
  secTab,
  setSecTab,
  onBadges,
}: {
  serverId: string;
  name: string;
  tab: TabId;
  setTab: (t: string) => void;
  secTab: SecTab;
  setSecTab: (t: SecTab) => void;
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

  const showUpdates = useCallback(() => setTab("updates"), [setTab]);
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
          onShowUpdates={showUpdates}
          security={summary && { ...summary, banned }}
          auditing={auditing}
          onShowSecurity={(sub) => {
            if (sub) setSecTab(sub);
            setTab("security");
          }}
        />
      </div>
      {secMounted && (
        <div className={show("security")}>
          <Security
            serverId={serverId}
            sub={secTab}
            onSub={setSecTab}
            report={report}
            error={auditError}
            loading={auditing}
            reload={() => void loadAudit()}
            ignored={ignored}
            reloadIgnored={loadIgnored}
            onShowUpdates={showUpdates}
            onBanned={setBanned}
          />
        </div>
      )}
      <div className={show("updates")}>
        <Updates
          serverId={serverId}
          updates={updates}
          error={updatesError}
          checking={checking}
          packageManager={info?.packageManager ?? null}
          refresh={() => void loadUpdates(true)}
          onApplied={() => void Promise.all([loadUpdates(false), loadInfo(), loadAudit()])}
        />
      </div>
      <div className={show("inventory")}>
        <Inventory serverId={serverId} onShowUpdates={showUpdates} />
      </div>
    </>
  );
}
