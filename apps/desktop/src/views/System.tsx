// Système : vue d'ensemble et alimentation, mises à jour, inventaire et pilotage par l'hébergeur.
// L'onglet « Hébergeur » reste utilisable quand SSH ne répond pas : c'est tout son intérêt.
import { useCallback, useEffect, useState } from "react";
import { Cloud, Loader2, PlugZap } from "lucide-react";
import { api, errorMessage, type SystemInfo, type SystemUpdate } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { Button, EmptyState } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import Overview from "./system/Overview";
import Updates from "./system/Updates";
import Inventory from "./system/Inventory";
import Provider from "./system/Provider";

type TabId = "overview" | "updates" | "inventory" | "provider";

export default function SystemView() {
  const serverId = useApp((s) => s.activeServerId);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  const [tab, setTab] = useTabIntent<TabId>("system", "overview");
  const [ready, setReady] = useState(false);
  const [trying, setTrying] = useState(false);
  const [updatesCount, setUpdatesCount] = useState<number | undefined>();

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
    setUpdatesCount(undefined);
    void connect();
  }, [serverId, connect]);

  if (!serverId || !server) return <ServerGate title="Système">{() => null}</ServerGate>;
  const sshTab = tab !== "provider";
  return (
    <PageLayout
      title="Système"
      context={<ServerContext server={server} />}
      subtitle="Alimentation, réglages et mises à jour du serveur."
      tabs={[
        { id: "overview", label: "Vue d'ensemble" },
        { id: "updates", label: "Mises à jour", count: updatesCount || undefined, tone: updatesCount ? "warn" : undefined },
        { id: "inventory", label: "Inventaire" },
        { id: "provider", label: "Hébergeur" },
      ]}
      activeTab={tab}
      onTab={setTab}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-7 py-5">
        {/* Toujours monté une fois connecté : l'attente du redémarrage survit à un détour par l'onglet Hébergeur. */}
        {ready ? (
          <SshTabs key={serverId} serverId={serverId} name={server.name} tab={tab} setTab={setTab} onUpdatesCount={setUpdatesCount} />
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
                  <Button icon={<Cloud size={14} />} onClick={() => setTab("provider")}>
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

/** Les trois onglets SSH partagent la fiche du serveur et la liste des mises à jour ; ils restent montés. */
function SshTabs({ serverId, name, tab, setTab, onUpdatesCount }: { serverId: string; name: string; tab: TabId; setTab: (t: TabId) => void; onUpdatesCount: (n: number | undefined) => void }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<SystemUpdate[] | null>(null);
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

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
        const list = await api.systemUpdates(serverId, refresh);
        setUpdates(list);
        setUpdatesError(null);
        onUpdatesCount(list.length);
      } catch (e) {
        setUpdatesError(errorMessage(e));
      } finally {
        setChecking(false);
      }
    },
    [serverId, onUpdatesCount],
  );

  useEffect(() => {
    void loadInfo();
    void loadUpdates(false);
  }, [loadInfo, loadUpdates]);

  return (
    <>
      <div className={tab === "overview" ? "contents" : "hidden"}>
        <Overview serverId={serverId} name={name} info={info} error={infoError} reload={loadInfo} updates={updates} onShowUpdates={() => setTab("updates")} />
      </div>
      <div className={tab === "updates" ? "contents" : "hidden"}>
        <Updates
          serverId={serverId}
          updates={updates}
          error={updatesError}
          checking={checking}
          packageManager={info?.packageManager ?? null}
          refresh={() => void loadUpdates(true)}
          onApplied={() => void Promise.all([loadUpdates(false), loadInfo()])}
        />
      </div>
      <div className={tab === "inventory" ? "contents" : "hidden"}>
        <Inventory serverId={serverId} onShowUpdates={() => setTab("updates")} />
      </div>
    </>
  );
}
