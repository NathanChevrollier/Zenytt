// Supervision : la page d'un serveur, en trois onglets sans sous-onglet. Elle réunit l'ancienne
// Supervision et l'ancien Système (sécurité, logiciels, alimentation, hébergeur).
//   Vue d'ensemble : fiche, chiffres, courbes, disques, processus, « À traiter » et Alimentation.
//   Activité : services et tâches planifiées ; journal d'un service et processus en tiroir.
//   Sécurité et mises à jour : score, paquets et versions, pare-feu, accès SSH, fail2ban.
// L'alimentation par l'hébergeur reste utilisable quand SSH ne répond pas : c'est tout son intérêt.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { api, errorMessage, type AgentInfo, type IgnoredFinding, type SecurityReport, type ServerView, type SystemInfo, type SystemUpdate } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { useCachedState, peekCached } from "../lib/cache";
import { usePolling } from "../lib/poll";
import { useAutoRefresh } from "../lib/refresh";
import { auditSummary, resolveSupervisionLink, type SecuritySection, type SupervisionDrawer, type SupervisionTab } from "../lib/system";
import { bannedAddresses } from "../lib/fail2ban";
import type { F2bState } from "../lib/api";
import { Badge, Button, Drawer, EmptyState, Segmented } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import { useDoctor } from "../components/ConnectionDoctor";
import Overview, { RANGES, type RangeId } from "./supervision/Overview";
import Todo from "./supervision/Todo";
import { PowerCard, usePower } from "./supervision/Power";
import { ProviderDrawer, STATE, KINDS, useProvider } from "./supervision/Provider";
import Activity from "./supervision/Activity";
import Security from "./supervision/Security";
import AlertsDrawer from "./supervision/Alerts";
import Processes from "./supervision/Processes";
import { AuditChecks, AuditFindings, useFindingActions } from "./supervision/Audit";
import type { ServiceList } from "./supervision/Services";

/** Un audit relu à chaque ouverture coûte cher (une vingtaine de commandes) : gardé 15 min. */
const AUDIT_TTL = 15 * 60_000;

export default function SupervisionView() {
  const serverId = useApp((s) => s.activeServerId);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  if (!serverId || !server) return <ServerGate title="Supervision" guide="monitoring">{() => null}</ServerGate>;
  return <Supervision key={serverId} serverId={serverId} server={server} />;
}

function Supervision({ serverId, server }: { serverId: string; server: ServerView }) {
  // Lien demandé (`navigate("monitoring", "security/fail2ban")`, ancien ou nouveau) : traduit une fois
  // par `resolveSupervisionLink`, puis effacé pour qu'un même lien puisse resservir.
  const [raw, setRaw] = useTabIntent<string>("monitoring", "");
  const [tab, setTab] = useState<SupervisionTab>("overview");
  const [drawer, setDrawer] = useState<SupervisionDrawer | null>(null);
  const [secFocus, setSecFocus] = useState<{ section: SecuritySection; n: number } | null>(null);
  const [scheduleFocus, setScheduleFocus] = useState(0);
  const [mounted, setMounted] = useState<Record<SupervisionTab, boolean>>({ overview: true, activity: false, security: false });
  const [range, setRange] = useState<RangeId>("live");

  const showSecurity = useCallback((section?: SecuritySection) => {
    setTab("security");
    if (section) setSecFocus((f) => ({ section, n: (f?.n ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (!raw) return;
    const link = resolveSupervisionLink(raw);
    setTab(link.tab);
    setDrawer(link.drawer ?? null);
    if (link.section === "schedule") setScheduleFocus((n) => n + 1);
    else if (link.section) showSecurity(link.section);
    setRaw("");
  }, [raw, setRaw, showSecurity]);
  useEffect(() => setMounted((m) => (m[tab] ? m : { ...m, [tab]: true })), [tab]);

  // Connexion SSH : sans elle, seule l'alimentation par l'hébergeur reste disponible.
  const [ready, setReady] = useState(!!server.connected);
  const [trying, setTrying] = useState(false);
  const connect = useCallback(
    async (force = false) => {
      setTrying(true);
      setReady(await ensureConnected(serverId, { force }));
      setTrying(false);
    },
    [serverId],
  );
  useEffect(() => void connect(), [connect]);

  const provider = useProvider(serverId, server.name);

  // Agent et alertes, relus toutes les 30 s.
  const [agent, setAgent] = useCachedState<AgentInfo | null>(`agent:${serverId}`, null);
  const loadAgent = useCallback(async () => {
    try {
      setAgent(await api.agentInfo(serverId));
    } catch (e) {
      setAgent({ installed: false, running: false, status: null, error: errorMessage(e) });
    }
  }, [serverId, setAgent]);
  usePolling(loadAgent, 30_000, [loadAgent], ready);

  // Fiche du serveur, mises à jour, audit (gardé 15 min), constats ignorés, services.
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api.systemInfo(serverId));
      setInfoError(null);
    } catch (e) {
      setInfoError(errorMessage(e));
    }
  }, [serverId]);

  const [updates, setUpdates] = useState<SystemUpdate[] | null>(null);
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
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

  const [audit, setAudit] = useCachedState<{ report: SecurityReport; at: number } | null>(`security:${serverId}`, null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const loadAudit = useCallback(
    async (force: boolean) => {
      const cached = peekCached<{ report: SecurityReport; at: number } | null>(`security:${serverId}`);
      if (!force && cached && Date.now() - cached.at < AUDIT_TTL) return;
      setAuditing(true);
      setAuditError(null);
      try {
        setAudit({ report: await api.securityAudit(serverId), at: Date.now() });
      } catch (e) {
        setAuditError(errorMessage(e));
      } finally {
        setAuditing(false);
      }
    },
    [serverId, setAudit],
  );
  const [ignored, setIgnored] = useState<IgnoredFinding[]>([]);
  const loadIgnored = useCallback(() => void api.findingsIgnored(serverId).then(setIgnored, () => {}), [serverId]);
  const [services, setServices] = useCachedState<ServiceList>(`services:${serverId}`, undefined);

  useEffect(() => {
    if (!ready) return;
    void loadInfo();
    void loadUpdates(false);
    void loadAudit(false);
    loadIgnored();
    // Services en échec pour « À traiter » ; l'onglet Activité les relit ensuite lui-même.
    if (peekCached(`services:${serverId}`) === undefined) void api.services(serverId).then(setServices, () => {});
  }, [ready, serverId, loadInfo, loadUpdates, loadAudit, loadIgnored, setServices]);
  useAutoRefresh(() => Promise.all([loadInfo(), loadUpdates(false), loadAudit(true)]), { serverId, auto: false });

  // IP bannies : connues dès qu'un relevé fail2ban existe (onglet Sécurité visité, ou plus tôt).
  const [banned, setBanned] = useState<number | null>(() => {
    const f2b = peekCached<F2bState | null>(`fail2ban:${serverId}`);
    return f2b ? bannedAddresses(f2b.jails).size : null;
  });
  const [procCount, setProcCount] = useState<number | null>(null);

  const power = usePower(serverId, server.name, info, loadInfo);
  const report = audit?.report ?? null;
  const summary = useMemo(() => (report ? auditSummary(report.findings, ignored.map((i) => i.findingId)) : null), [report, ignored]);
  const showUpdates = useCallback(() => {
    setDrawer(null);
    showSecurity("updates");
  }, [showSecurity]);
  const findingActions = useFindingActions({ serverId, reload: () => void loadAudit(true), reloadIgnored: loadIgnored, onShowUpdates: showUpdates });

  const allProcesses = () => {
    setTab("activity");
    setDrawer("processes");
  };

  const alerts = agent?.status?.activeAlerts.length ?? 0;
  const failed = (services ?? []).filter((s) => s.active === "failed").length;
  const agentOk = !!agent?.running;
  const providerKind = KINDS.find((k) => k.value === provider.view?.link?.kind)?.label;
  const securityCount = (updates?.length ?? 0) + (summary?.problems.length ?? 0);

  const rail = (
    <>
      {ready && (
        <Todo
          agent={agent}
          info={info}
          services={services}
          updates={updates}
          updatesError={updatesError}
          audit={
            summary || auditError || auditing
              ? {
                  score: summary?.score ?? 0,
                  problems: summary?.problems ?? [],
                  serious: summary?.problems.filter((f) => f.severity === "critical" || f.severity === "high") ?? [],
                  at: audit?.at ?? null,
                  loading: auditing,
                  error: report ? null : auditError,
                }
              : null
          }
          banned={banned}
          power={power}
          findings={{ ignore: (f) => void findingActions.ignore(f), startFix: (f) => void findingActions.startFix(f) }}
          onOpenAlerts={() => setDrawer("alerts")}
          onShowActivity={() => setTab("activity")}
          onShowUpdates={showUpdates}
          onShowSecurity={() => showSecurity()}
          onShowAudit={() => setDrawer("audit")}
          onShowFail2ban={() => showSecurity("fail2ban")}
        />
      )}
      <PowerCard name={server.name} power={ready ? power : null} provider={provider} onConfigure={() => setDrawer("provider")} />
    </>
  );

  return (
    <PageLayout
      title="Supervision"
      guide={tab === "security" ? "security" : tab === "activity" ? "schedule" : "monitoring"}
      context={<ServerContext server={server} />}
      subtitle={`${server.username}@${server.host}`}
      status={
        <>
          {agentOk ? (
            <Badge tone="ok">agent zenyttd {agent?.status?.version ?? ""} · historique 30 j</Badge>
          ) : (
            agent && (
              <button type="button" onClick={() => setDrawer("alerts")} title="Installer l'agent : historique et alertes même Zenytt fermé">
                <Badge tone="muted">sans agent · mesures en direct</Badge>
              </button>
            )
          )}
          {provider.ready && (
            <button type="button" onClick={() => setDrawer("provider")}>
              <Badge tone={provider.status ? STATE[provider.status.state][1] : provider.statusError ? "danger" : "muted"}>
                hébergeur {providerKind} · {provider.status ? STATE[provider.status.state][0] : provider.statusError ? "injoignable" : "…"}
              </Badge>
            </button>
          )}
          {alerts > 0 && (
            <button type="button" onClick={() => setDrawer("alerts")}>
              <Badge tone="danger">
                {alerts} alerte{alerts > 1 ? "s" : ""} en cours
              </Badge>
            </button>
          )}
        </>
      }
      actions={
        tab === "overview" && ready ? (
          <Segmented
            label="Période"
            value={range}
            onChange={setRange}
            options={RANGES.map((r) => ({
              value: r.id,
              label: r.label,
              disabled: r.secs > 0 && !agentOk,
              title: r.secs > 0 && !agentOk ? "Installe l'agent zenyttd (Alertes › Régler…) pour conserver l'historique" : undefined,
            }))}
          />
        ) : undefined
      }
      tabs={[
        { id: "overview", label: "Vue d'ensemble", count: alerts || undefined, tone: alerts ? "danger" : undefined },
        { id: "activity", label: "Activité", count: failed || undefined, tone: failed ? "danger" : undefined },
        { id: "security", label: "Sécurité et mises à jour", count: securityCount || undefined, tone: summary?.serious ? "danger" : securityCount ? "warn" : undefined },
      ]}
      activeTab={tab}
      onTab={setTab}
      scroll={tab !== "activity"}
    >
      {!ready ? (
        <div className="@container flex min-w-0 flex-col gap-5 px-7 py-5">
          <div className="grid min-w-0 items-start gap-5 @min-[1100px]:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
            {trying ? (
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
                    <Button onClick={() => useDoctor.getState().open(server.id)}>Diagnostiquer</Button>
                  </>
                }
              >
                Les relevés, services et réglages passent par SSH. L'alimentation par l'hébergeur reste disponible.
              </EmptyState>
            )}
            <aside className="flex min-w-0 flex-col gap-4">{rail}</aside>
          </div>
        </div>
      ) : (
        <>
          <div className={tab === "overview" ? "contents" : "hidden"}>
            <Overview
              serverId={serverId}
              info={info}
              infoError={infoError}
              reloadInfo={loadInfo}
              agent={agent}
              visible={tab === "overview"}
              range={range}
              rail={rail}
              onAllProcesses={allProcesses}
              onProcCount={setProcCount}
            />
          </div>
          {mounted.activity && (
            <div className={tab === "activity" ? "flex min-h-0 w-full flex-1" : "hidden"}>
              <Activity serverId={serverId} services={services} setServices={setServices} procCount={procCount} onAllProcesses={() => setDrawer("processes")} focusSchedule={scheduleFocus} />
            </div>
          )}
          {mounted.security && (
            <div className={tab === "security" ? "contents" : "hidden"}>
              <Security
                serverId={serverId}
                report={report}
                auditAt={audit?.at ?? null}
                auditError={auditError}
                auditing={auditing}
                reloadAudit={() => void loadAudit(true)}
                ignored={ignored}
                updates={updates}
                updatesError={updatesError}
                checking={checking}
                packageManager={info?.packageManager ?? null}
                refreshUpdates={() => loadUpdates(true)}
                onApplied={() => void Promise.all([loadUpdates(false), loadInfo(), loadAudit(true)])}
                onBanned={setBanned}
                focus={secFocus}
                onOpenAudit={() => setDrawer("audit")}
                imagesOpen={drawer === "images"}
                onImagesOpen={(open) => setDrawer(open ? "images" : null)}
              />
            </div>
          )}
        </>
      )}

      {drawer === "alerts" && ready && <AlertsDrawer serverId={serverId} agent={agent} reload={loadAgent} onClose={() => setDrawer(null)} />}
      {drawer === "provider" && <ProviderDrawer serverId={serverId} serverName={server.name} provider={provider} onClose={() => setDrawer(null)} />}
      {drawer === "processes" && ready && (
        <Drawer title="Tous les processus" subtitle="Tri, filtre, SIGTERM et SIGKILL" width={1100} onClose={() => setDrawer(null)}>
          <div className="-m-5 flex h-[calc(100%+2.5rem)] min-h-0 flex-col">
            <Processes serverId={serverId} visible onCount={setProcCount} />
          </div>
        </Drawer>
      )}
      {drawer === "audit" && ready && (
        <Drawer title="Audit de sécurité" subtitle="Constats à traiter, points conformes et constats ignorés" width={880} onClose={() => setDrawer(null)}>
          <div className="flex flex-col gap-4">
            <AuditFindings
              serverId={serverId}
              report={report}
              error={auditError}
              loading={auditing}
              reload={() => void loadAudit(true)}
              ignored={ignored}
              reloadIgnored={loadIgnored}
              banned={banned}
              onShowUpdates={showUpdates}
              onShowSecurity={(s) => {
                setDrawer(null);
                showSecurity(s);
              }}
            />
            <AuditChecks serverId={serverId} report={report} ignored={ignored} reloadIgnored={loadIgnored} />
          </div>
        </Drawer>
      )}
      {power.dialog}
      {findingActions.dialog}
    </PageLayout>
  );
}
