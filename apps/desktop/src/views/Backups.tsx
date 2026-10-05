// Sauvegardes restic : tableau de bord (dernière exécution, prochaine, destination, frise des
// 30 derniers jours), explorateur de sauvegardes avec restauration, configuration en assistant.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { DatabaseBackup, Download, HardDrive, Play, Settings2, ShieldCheck } from "lucide-react";
import { api, errorMessage, type BackupOverview, type Snapshot } from "../lib/api";
import { useApp, useAppPick } from "../lib/store";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, MenuButton, Modal, ResultBanner, Section, StatTile } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import SnapshotsBrowser from "./backups/Snapshots";
import LocalCopy from "./backups/LocalCopy";

const ConfigWizard = lazy(() => import("./backups/ConfigWizard"));

export default function BackupsView() {
  return <ServerGate title="Sauvegardes" guide="backups">{(serverId) => <Backups key={serverId} serverId={serverId} />}</ServerGate>;
}

const DAY = 86_400_000;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function Backups({ serverId }: { serverId: string }) {
  const { notify, openTab } = useAppPick("notify", "openTab");
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [data, setData] = useCachedState<BackupOverview | null>(`backups:${serverId}`, null);
  const [snaps, setSnaps] = useCachedState<Snapshot[] | null>(`backups:snaps:${serverId}`, null);
  const [snapsError, setSnapsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkOut, setCheckOut] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<{ ok: boolean; text: string } | null>(null);

  const loadSnapshots = useCallback(async () => {
    try {
      setSnaps(await api.backupSnapshots(serverId));
      setSnapsError(null);
    } catch (e) {
      setSnaps((s) => s ?? []);
      setSnapsError(errorMessage(e));
    }
  }, [serverId]);

  const load = useCallback(async () => {
    try {
      const d = await api.backupOverview(serverId);
      setData(d);
      setError(null);
      // L'actualisation relit aussi la liste des sauvegardes : une exécution manuelle vient
      // peut-être d'en ajouter une.
      if (d.status.config) void loadSnapshots();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId, loadSnapshots]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh(load, { serverId, auto: false });

  const check = async () => {
    setChecking(true);
    try {
      setCheckOut(await api.backupCheck(serverId));
    } catch (e) {
      setCheckOut(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  /** Installe restic tout de suite (sans attendre la première configuration). */
  const installRestic = async () => {
    setInstalling(true);
    try {
      const log = await api.backupInstallRestic(serverId);
      setInstallLog({ ok: true, text: log });
      await load();
    } catch (e) {
      setInstallLog({ ok: false, text: errorMessage(e) });
    } finally {
      setInstalling(false);
    }
  };
  const installButton = !data?.status.restic && (
    <Button icon={<Download size={13} />} loading={installing} onClick={() => void installRestic()}>
      Installer restic
    </Button>
  );

  const runNow = () =>
    openTab(serverId, { title: "Sauvegarde", command: "sudo /etc/zenytt-backup/run.sh; echo; echo 'Tu peux fermer cet onglet puis actualiser la page Sauvegardes.'; exec \"$SHELL\" -l" });

  const context = server && <ServerContext server={server} />;
  const layout = (children: React.ReactNode) => (
    <PageLayout title="Sauvegardes" guide="backups" context={context}>
      {children}
    </PageLayout>
  );

  if (error && !data) return layout(<div className="p-7"><ErrorState message={error} onRetry={() => void load()} /></div>);
  if (!data) return layout(<div className="p-7"><Loading rows={6} /></div>);

  const { status } = data;
  const config = status.config;
  const last = status.last;

  return (
    <>
      <PageLayout
        title="Sauvegardes"
        guide="backups"
        context={context}
        subtitle="Chiffrées et dédupliquées avec restic ; bases exportées sans arrêt du service."
        status={
          <>
            {status.restic ? <Badge tone="muted">{status.restic.split(" ").slice(0, 2).join(" ")}</Badge> : <Badge tone="warn">restic non installé</Badge>}
            {config && <Badge tone="accent">chiffré</Badge>}
            {config && last && <Badge tone={last.ok ? "ok" : "danger"}>{last.ok ? "dernière exécution réussie" : "dernière exécution en échec"}</Badge>}
            {error && <Badge tone="danger" title={error}>actualisation en échec</Badge>}
          </>
        }
        actions={
          config ? (
            <>
              <MenuButton
                items={[
                  { label: "Vérifier l'intégrité du dépôt", icon: <ShieldCheck size={14} />, onClick: () => void check() },
                  { label: "Modifier la configuration…", icon: <Settings2 size={14} />, onClick: () => setEditing(true) },
                ]}
              />
              <Button variant="primary" icon={<Play size={13} />} onClick={runNow}>
                Sauvegarder maintenant
              </Button>
            </>
          ) : (
            <>
              {installButton}
              <Button variant="primary" icon={<Settings2 size={14} />} onClick={() => setEditing(true)}>
                Configurer les sauvegardes
              </Button>
            </>
          )
        }
      >
        {!config ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-7 py-10">
            <EmptyState
              icon={<DatabaseBackup />}
              title="Aucune sauvegarde configurée"
              action={
                <Button variant="primary" icon={<Settings2 size={14} />} onClick={() => setEditing(true)}>
                  Configurer en 4 étapes
                </Button>
              }
            >
              Une sauvegarde quotidienne, chiffrée, avec rétention automatique. Zenytt installe restic si besoin (ou tout de suite avec « Installer restic ») et planifie tout.
            </EmptyState>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Bases de données détectées" value={data.databases.length} hint={data.databases.map((d) => d.container).join(", ") || "aucune"} />
              <StatTile label="Volumes Docker" value={data.volumes.length} hint={data.volumes.slice(0, 3).join(", ") || "aucun"} />
              <StatTile label="Dossiers proposés" value={data.defaultConfig.paths.length} hint={data.defaultConfig.paths.slice(0, 3).join(", ")} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6 px-7 py-5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
              <StatTile
                label="Dernière sauvegarde"
                tone={!last ? "muted" : last.ok ? "ok" : "danger"}
                value={last ? relative(last.finishedAt * 1000) : "Jamais"}
                hint={last ? <span title={last.message}>{new Date(last.finishedAt * 1000).toLocaleString("fr-FR")} · {last.message}</span> : "Pas encore exécutée"}
              />
              <StatTile label="Prochaine exécution" value={status.nextRun ?? config.schedule} hint={`chaque jour à ${config.schedule}`} />
              <StatTile
                label="Destination"
                value={config.destination.kind === "s3" ? "S3" : "Local"}
                tone={config.destination.kind === "local" ? "warn" : undefined}
                hint={config.destination.kind === "s3" ? `${config.destination.bucket}${config.destination.prefix ? `/${config.destination.prefix}` : ""}` : config.destination.path}
              />
              <StatTile
                label="Contenu"
                value={`${config.paths.length + config.volumes.length + config.databases.length} éléments`}
                hint={`${config.databases.length} base(s) · ${config.volumes.length} volume(s) · ${config.paths.length} dossier(s)`}
              />
            </div>

            {config.destination.kind === "local" && (
              <ResultBanner
                tone="warn"
                title="Les sauvegardes sont sur le serveur lui-même"
                action={
                  <Button size="sm" icon={<HardDrive size={13} />} onClick={() => setEditing(true)}>
                    Ajouter un stockage S3
                  </Button>
                }
              >
                Elles protègent des erreurs (fichier supprimé, mise à jour ratée), pas de la perte du serveur. Une copie sur ce PC ou un stockage S3 en garde un double ailleurs.
              </ResultBanner>
            )}

            {config.destination.kind === "local" && <LocalCopy serverId={serverId} />}

            <Section title="30 derniers jours" description={`Rétention : ${config.keepDaily} j · ${config.keepWeekly} sem. · ${config.keepMonthly} mois`}>
              <Timeline snaps={snaps} onPick={(id) => setSelected(id)} />
            </Section>

            <SnapshotsBrowser
              serverId={serverId}
              snaps={snaps}
              error={snapsError}
              onRetry={() => void loadSnapshots()}
              selected={selected}
              onSelect={setSelected}
              databases={config.databases}
              notify={notify}
            />
          </div>
        )}
      </PageLayout>
      {editing && (
        <Suspense fallback={null}>
          <ConfigWizard
            serverId={serverId}
            data={data}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              void load();
            }}
          />
        </Suspense>
      )}
      {installLog && (
        <Modal title={installLog.ok ? "restic est installé" : "Installation de restic impossible"} width="max-w-2xl" onClose={() => setInstallLog(null)} footer={<Button variant="primary" onClick={() => setInstallLog(null)}>Fermer</Button>}>
          <div className="flex flex-col gap-3 text-sm">
            {!installLog.ok && <p className="text-muted">Le paquet de la distribution puis le binaire officiel (vérifié par son empreinte SHA-256) ont été essayés. Détail :</p>}
            <pre className="max-h-[50vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{installLog.text}</pre>
          </div>
        </Modal>
      )}
      {(checking || checkOut !== null) && (
        <Modal title="Vérification du dépôt" width="max-w-3xl" onClose={() => (setCheckOut(null), setChecking(false))}>
          {checking ? (
            <Loading label="restic check en cours…" />
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{checkOut}</pre>
          )}
        </Modal>
      )}
    </>
  );
}

/** Une case par jour : pleine s'il existe au moins une sauvegarde ce jour-là. */
function Timeline({ snaps, onPick }: { snaps: Snapshot[] | null; onPick: (id: string) => void }) {
  const days = useMemo(() => {
    const byDay = new Map<string, Snapshot[]>();
    for (const s of snaps ?? []) {
      const k = dayKey(new Date(s.time));
      byDay.set(k, [...(byDay.get(k) ?? []), s]);
    }
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today.getTime() - (29 - i) * DAY);
      return { date: d, snaps: byDay.get(dayKey(d)) ?? [] };
    });
  }, [snaps]);

  if (snaps === null) return <Loading rows={1} />;
  const missed = days.slice(0, -1).filter((d) => d.snaps.length === 0).length;

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex h-10 items-stretch gap-[3px]">
        {days.map((d, i) => {
          const has = d.snaps.length > 0;
          const isToday = i === days.length - 1;
          return (
            <button
              key={i}
              type="button"
              disabled={!has}
              title={`${d.date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} · ${has ? `${d.snaps.length} sauvegarde(s)` : "aucune sauvegarde"}`}
              onClick={() => has && onPick(d.snaps[d.snaps.length - 1].short_id)}
              className={`flex-1 rounded-[3px] transition-colors ${has ? "bg-ok/70 hover:bg-ok" : isToday ? "border border-dashed border-border-strong" : "bg-raised"}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] text-faint">
        <span>il y a 30 jours</span>
        <span>{snaps.length === 0 ? "aucune sauvegarde" : missed ? `${missed} jour(s) sans sauvegarde` : "une sauvegarde chaque jour"}</span>
        <span>aujourd'hui</span>
      </div>
    </Card>
  );
}

function relative(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 3_600_000) return `il y a ${Math.max(1, Math.round(diff / 60_000))} min`;
  if (diff < DAY) return `il y a ${Math.round(diff / 3_600_000)} h`;
  return `il y a ${Math.round(diff / DAY)} j`;
}
