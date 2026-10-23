// Système : alimentation, nom d'hôte, fuseau horaire, mises à jour et pilotage par l'hébergeur.
// La section « Hébergeur » reste utilisable quand SSH ne répond pas : c'est tout son intérêt.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Power, PowerOff, RefreshCw, RotateCw } from "lucide-react";
import { api, errorMessage, formatBytes, formatDuration, type SystemInfo, type SystemUpdate } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, Card, CodeBlock, DataTable, ErrorState, Field, Input, KeyValue, Modal, ResultBanner, Section, type Column } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import Provider from "./system/Provider";
import Inventory from "./system/Inventory";

export default function SystemView() {
  const serverId = useApp((s) => s.activeServerId);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  const [ready, setReady] = useState(false);
  const [trying, setTrying] = useState(false);

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
    void connect();
  }, [serverId, connect]);

  if (!serverId || !server) return <ServerGate title="Système">{() => null}</ServerGate>;
  return (
    <PageLayout title="Système" guide={undefined} context={<ServerContext server={server} />} subtitle="Alimentation, réglages et mises à jour du serveur.">
      <div className="flex flex-col gap-6 pb-6">
        {ready ? (
          <SshPanels key={serverId} serverId={serverId} name={server.name} />
        ) : (
          <Card className="flex items-center gap-3 text-[13px] text-muted">
            {trying ? <Loader2 size={16} className="animate-spin" /> : null}
            {trying ? `Connexion à ${server.name}…` : `${server.name} n'est pas joignable en SSH. Tu peux quand même le piloter via l'hébergeur ci-dessous.`}
            {!trying && (
              <Button className="ml-auto" onClick={() => void connect(true)}>
                Se connecter
              </Button>
            )}
          </Card>
        )}
        <Provider key={`p${serverId}`} serverId={serverId} serverName={server.name} />
      </div>
    </PageLayout>
  );
}

type PowerKind = "reboot" | "poweroff";

function PowerModal({ kind, name, onClose, onConfirm }: { kind: PowerKind; name: string; onClose: () => void; onConfirm: (delay: number) => void }) {
  const [delay, setDelay] = useState("0");
  const [typed, setTyped] = useState("");
  const off = kind === "poweroff";
  const minutes = Math.max(0, Math.floor(Number(delay) || 0));
  return (
    <Modal
      title={off ? `Éteindre ${name} ?` : `Redémarrer ${name} ?`}
      width="max-w-md"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="danger" disabled={off && typed !== name} onClick={() => onConfirm(minutes)}>
            {off ? "Éteindre" : "Redémarrer"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-muted">
          {off
            ? "Le serveur s'éteint et ne répondra plus tant qu'il n'est pas rallumé (depuis le panneau de l'hébergeur ou via l'API)."
            : "Toutes les sessions et tous les services sont interrompus le temps du redémarrage."}
        </p>
        <Field label="Délai en minutes" hint="0 = immédiat">
          <Input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} />
        </Field>
        {off && (
          <Field label={`Tape « ${name} » pour confirmer`}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function SshPanels({ serverId, name }: { serverId: string; name: string }) {
  const { notify, ask, refreshServers } = useApp.getState();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [power, setPower] = useState<PowerKind | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [hostname, setHostname] = useState("");
  const [tz, setTz] = useState("");
  const [zones, setZones] = useState<string[]>([]);
  const [updates, setUpdates] = useState<SystemUpdate[] | null>(null);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const i = await api.systemInfo(serverId);
      setInfo(i);
      setHostname(i.hostname);
      setTz(i.timezone);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId]);

  const loadUpdates = useCallback(
    async (refresh: boolean) => {
      setBusy("updates");
      try {
        setUpdates(await api.systemUpdates(serverId, refresh));
      } catch (e) {
        setUpdates(null);
        notify(errorMessage(e), "error");
      } finally {
        setBusy(null);
      }
    },
    [serverId, notify],
  );

  useEffect(() => {
    void load();
    void loadUpdates(false);
    void api.systemTimezones(serverId).then(setZones, () => {});
  }, [serverId, load, loadUpdates]);

  /** Lance une action d'écriture : bouton occupé, erreur en toast. */
  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try {
      await fn();
      if (ok) notify(ok, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const doPower = async (kind: PowerKind, delay: number) => {
    setPower(null);
    try {
      await api.systemPower(serverId, kind, delay);
    } catch (e) {
      notify(errorMessage(e), "error");
      return;
    }
    if (delay > 0) {
      notify(`${kind === "reboot" ? "Redémarrage" : "Extinction"} planifié dans ${delay} min`, "success");
      void load();
      return;
    }
    if (kind === "poweroff") {
      notify(`${name} s'éteint`, "info");
      setTimeout(() => void refreshServers(), 6000);
      return;
    }
    setWaiting(true);
    try {
      const secs = await api.systemWaitOnline(serverId, info?.bootTime);
      notify(`${name} est de retour après ${formatDuration(secs)}`, "success");
      void refreshServers();
      void load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setWaiting(false);
    }
  };

  const apply = async () => {
    if (!(await ask({ title: `Appliquer ${updates?.length ?? 0} mises à jour ?`, body: "Les paquets sont mis à jour sans interaction. Certains services peuvent redémarrer, et un redémarrage du serveur peut ensuite être nécessaire.", confirmLabel: "Appliquer", danger: true }))) return;
    await run("apply", async () => {
      setOutput("");
      setOutput(await api.systemApplyUpdates(serverId));
      await loadUpdates(false);
    }, "Mises à jour appliquées");
  };

  const columns: Column<SystemUpdate>[] = [
    { key: "name", header: "Paquet", render: (u) => <span className="font-mono text-xs">{u.name}</span>, sortValue: (u) => u.name },
    { key: "current", header: "Actuelle", width: "minmax(0,1fr)", render: (u) => <span className="font-mono text-xs text-muted">{u.current || "—"}</span> },
    { key: "candidate", header: "Disponible", width: "minmax(0,1fr)", render: (u) => <span className="font-mono text-xs">{u.candidate}</span> },
  ];

  if (error && !info) return <ErrorState message={error} onRetry={() => void load()} />;
  return (
    <>
      {waiting && <ResultBanner tone="accent" title="En attente du retour du serveur…">Reconnexion automatique toutes les 5 secondes.</ResultBanner>}
      <Section
        title="Informations"
        actions={
          <>
            <Button size="sm" icon={<RotateCw size={13} />} disabled={waiting} onClick={() => setPower("reboot")}>
              Redémarrer
            </Button>
            <Button size="sm" variant="danger" icon={<PowerOff size={13} />} disabled={waiting} onClick={() => setPower("poweroff")}>
              Éteindre
            </Button>
          </>
        }
      >
        <Card className="flex flex-col gap-3">
          {info && (
            <KeyValue
              items={[
                ["Nom d'hôte", info.hostname],
                ["Système", info.os],
                ["Noyau", info.kernel],
                ["En marche depuis", `${formatDuration(info.uptimeSecs)} (démarré le ${new Date(info.bootTime * 1000).toLocaleString()})`],
                ["Fuseau horaire", info.timezone],
                ["Processeur", `${info.cpuModel} × ${info.cpuCount}`],
                ["Mémoire", formatBytes(info.memoryTotal)],
                ["Gestionnaire de paquets", info.packageManager ?? "inconnu"],
              ]}
            />
          )}
          {info?.rebootRequired && <Badge tone="warn">Redémarrage nécessaire (mises à jour installées)</Badge>}
          {info?.scheduled && (
            <ResultBanner
              tone="warn"
              title={`${info.scheduled.mode === "reboot" ? "Redémarrage" : "Extinction"} planifié le ${new Date(info.scheduled.at * 1000).toLocaleString()}`}
              action={
                <Button size="sm" loading={busy === "cancel"} onClick={() => void run("cancel", () => api.systemCancelPower(serverId), "Planification annulée")}>
                  Annuler
                </Button>
              }
            />
          )}
        </Card>
      </Section>

      <Section title="Réglages">
        <Card className="grid gap-4 md:grid-cols-2">
          <Field label="Nom d'hôte" hint="Lettres, chiffres et tirets (63 caractères au plus)">
            <div className="flex gap-2">
              <Input value={hostname} onChange={(e) => setHostname(e.target.value)} />
              <Button loading={busy === "host"} disabled={!hostname || hostname === info?.hostname} onClick={() => void run("host", () => api.systemSetHostname(serverId, hostname), "Nom d'hôte modifié")}>
                Appliquer
              </Button>
            </div>
          </Field>
          <Field label="Fuseau horaire">
            <div className="flex gap-2">
              <Input list="zenytt-timezones" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Europe/Paris" />
              <datalist id="zenytt-timezones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <Button loading={busy === "tz"} disabled={!tz || tz === info?.timezone} onClick={() => void run("tz", () => api.systemSetTimezone(serverId, tz), "Fuseau horaire modifié")}>
                Appliquer
              </Button>
            </div>
          </Field>
        </Card>
      </Section>

      <Inventory serverId={serverId} />

      <div id="system-updates" className="scroll-mt-4">
      <Section
        title="Mises à jour"
        count={updates?.length}
        actions={
          <>
            <Button size="sm" icon={<RefreshCw size={13} />} loading={busy === "updates"} disabled={!!busy} onClick={() => void loadUpdates(true)}>
              Actualiser
            </Button>
            <Button size="sm" variant="primary" icon={<Power size={13} />} loading={busy === "apply"} disabled={!updates?.length || !!busy} onClick={() => void apply()}>
              Appliquer
            </Button>
          </>
        }
      >
        <Card padded={false}>
          <div className="flex h-64 flex-col">
            <DataTable
              className="min-h-0 flex-1"
              rows={updates ?? []}
              rowKey={(u) => u.name}
              columns={columns}
              rowHeight={34}
              empty={updates ? "Le système est à jour." : "Liste indisponible (apt et dnf sont pris en charge)."}
            />
          </div>
        </Card>
        {output && <CodeBlock code={output.split("\n").slice(-200).join("\n")} />}
      </Section>
      </div>

      {power && <PowerModal kind={power} name={name} onClose={() => setPower(null)} onConfirm={(d) => void doPower(power, d)} />}
    </>
  );
}
