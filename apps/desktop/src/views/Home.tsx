// Accueil : le centre de contrôle. D'un coup d'œil, la santé de chaque serveur, ce qui demande une
// action (classé par gravité, avec le bouton qui répare) et ce qui s'est passé récemment.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowRight, ChevronRight, LayoutDashboard, LayoutGrid, List, Plus, RotateCw, SquareTerminal, TriangleAlert } from "lucide-react";
import { useDoctor } from "../components/ConnectionDoctor";
import { api, hasShell, fullestDisk, errorMessage, formatBytes, formatDuration, type AuditEntry, type ContainerCondition, type DashboardSummary, type ServerView } from "../lib/api";
import { ensureConnected, useAppPick } from "../lib/store";
import { navigate, useShell } from "../lib/shell";
import { fetchHealth, useHealth } from "../lib/health";
import { usePolling } from "../lib/poll";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import {
  Avatar, Badge, Button, Card, DataTable, EmptyState, ErrorState, LabeledMeter, MenuButton, Section, Segmented, Select, StatTile, StatusDot, type MenuItem, type Tone,
} from "../components/ui";
import PageLayout from "../components/PageLayout";
import type { SectionId } from "../sections";

const CONCURRENCY = 4;
const REFRESH_MS = 30_000;
const CERT_WARN_DAYS = 21;
const DAY = 86_400;
const VIEW_KEY = "zenytt.home.view";

/** Libellé d'une panne de conteneur. */
const CONDITION_LABEL: Partial<Record<ContainerCondition, string>> = {
  unhealthy: "healthcheck en échec",
  crashLoop: "redémarre en boucle",
  crashed: "planté",
  outOfMemory: "manque de mémoire",
};

/** Point qui demande une action, affiché dans la colonne « À traiter ». */
interface Todo {
  key: string;
  level: "critique" | "attention" | "suggestion";
  title: string;
  detail?: ReactNode;
  mono?: boolean;
  actions: { label: string; primary?: boolean; run: () => void | Promise<void> }[];
}

/** Derniers totaux (tendance des tuiles), gardés le temps de la session. */
const trends: Record<"online" | "running" | "stopped" | "alerts", number[]> = { online: [], running: [], stopped: [], alerts: [] };
function pushTrend(k: keyof typeof trends, v: number) {
  const t = trends[k];
  if (t[t.length - 1] === v && t.length > 1) return;
  t.push(v);
  if (t.length > 16) t.shift();
}

export default function HomeView({ visible }: { visible: boolean }) {
  const { servers, setSection, openTab, notify } = useAppPick("servers", "setSection", "openTab", "notify");
  const summaries = useHealth((s) => s.summaries);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [activity, setActivity] = useCachedState<AuditEntry[]>("home:activity", []);
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [folder, setFolder] = useState("");
  const ids = servers.filter((s) => hasShell(s)).map((s) => s.id).join(",");
  const running = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* préférence non retenue */
    }
  }, [view]);

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const queue = ids.split(",").filter(Boolean);
    setPending(new Set(queue.filter((id) => !useHealth.getState().summaries[id])));
    // Au plus 4 serveurs interrogés en même temps.
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        await fetchHealth(id, 5_000);
        setPending((p) => {
          const n = new Set(p);
          n.delete(id);
          return n;
        });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    void api.auditList(8).then(setActivity).catch(() => {});
    running.current = false;
    // Dépend des seuls identifiants : un serveur qui se connecte ne relance pas tout le tour.
  }, [ids]);

  usePolling(refresh, REFRESH_MS, [refresh], visible);
  useAutoRefresh(refresh, { auto: false, enabled: visible });

  const groups = useMemo(() => [...new Set(servers.map((s) => s.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "fr")), [servers]);

  if (servers.length === 0) {
    return (
      <PageLayout title="Bienvenue dans Zenytt" context="Poste">
        <EmptyState
          icon={<LayoutDashboard />}
          title="Ajoute ton premier serveur"
          action={
            <Button
              variant="primary"
              icon={<Plus size={15} />}
              onClick={() => {
                useShell.getState().requestNewServer(true);
                setSection("servers");
              }}
            >
              Ajouter un serveur
            </Button>
          }
        >
          Hôte, utilisateur et clé SSH suffisent. Les sessions PuTTY et le fichier <span className="font-mono">~/.ssh/config</span> peuvent aussi être importés d'un clic depuis Serveurs.
        </EmptyState>
      </PageLayout>
    );
  }

  const go = (s: ServerView, section: SectionId, tab?: string) => navigate(section, tab, s.id);
  const known = servers.map((s) => ({ server: s, r: summaries[s.id] as DashboardSummary | undefined }));
  const online = known.filter((x) => x.r?.connected);
  const nRunning = online.reduce((n, x) => n + x.r!.containersRunning, 0);
  const nStopped = online.reduce((n, x) => n + x.r!.containersStopped, 0);
  const nFailed = online.reduce((n, x) => n + (x.r!.failed?.length ?? 0), 0);
  const nAlerts = online.reduce((n, x) => n + x.r!.alerts.length, 0);
  // Tendance enregistrée seulement quand tous les serveurs ont répondu : sinon la courbe partirait de 0.
  if (pending.size === 0 && known.every((x) => x.r)) {
    pushTrend("online", online.length);
    pushTrend("running", nRunning);
    pushTrend("stopped", nFailed);
    pushTrend("alerts", nAlerts);
  }
  const now = Date.now() / 1000;

  const restartStopped = async (s: ServerView, names: string[]) => {
    try {
      for (const name of names) await api.dockerAction(s.id, name, "start");
      notify(`${names.length} conteneur${names.length > 1 ? "s" : ""} relancé${names.length > 1 ? "s" : ""} sur ${s.name}`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
    await fetchHealth(s.id, 0);
  };

  // Tout ce qui demande une action, du plus urgent au moins urgent.
  const todos: Todo[] = [];
  for (const { server: s, r } of known) {
    if (!r) continue;
    if (!r.connected) {
      const auth = /AUTH_BLOCKED|Authentification échouée/.test(r.error ?? "");
      const needsUser = /NEED_PASSWORD|UNKNOWN_HOST_KEY|HOST_KEY_MISMATCH/.test(r.error ?? "");
      todos.push({
        key: `down:${s.id}`,
        level: "critique",
        title: needsUser ? `${s.name} : connexion à valider` : auth ? `${s.name} : authentification refusée` : `${s.name} injoignable`,
        detail: auth ? "Zenytt ne réessaie plus tout seul, pour ne pas déclencher fail2ban." : needsUser ? "Une clé d'hôte ou un mot de passe attend ton accord." : r.error?.replace(/^.*?: /, ""),
        actions: [
          { label: "Se connecter", primary: true, run: async () => void ((await ensureConnected(s.id, { force: true })) && fetchHealth(s.id, 0)) },
          ...(auth || needsUser ? [] : [{ label: "Diagnostiquer", run: () => useDoctor.getState().open(s.id) }]),
        ],
      });
      continue;
    }
    for (const a of r.alerts) {
      todos.push({ key: `alert:${s.id}:${a.key}`, level: "critique", title: `${s.name} : ${a.title}`, detail: a.message, actions: [{ label: "Supervision", primary: true, run: () => go(s, "monitoring") }] });
    }
    const failed = r.failed ?? [];
    if (failed.length > 0) {
      todos.push({
        key: `failed:${s.id}`,
        level: "attention",
        title: `${failed.length} conteneur${failed.length > 1 ? "s" : ""} en panne sur ${s.name}`,
        detail: failed.map((f) => `${f.name} (${CONDITION_LABEL[f.condition] ?? f.condition})`).join(" · "),
        mono: true,
        actions: [
          { label: "Relancer", primary: true, run: () => restartStopped(s, failed.map((f) => f.name)) },
          { label: "Docker", run: () => go(s, "docker") },
        ],
      });
    }
    // Arrêt sans erreur (code 0, docker stop fait ailleurs…) : peut-être voulu, on demande sans alarmer.
    if (r.containersStopped > 0) {
      todos.push({
        key: `stopped:${s.id}`,
        level: "suggestion",
        title: `${r.containersStopped} conteneur${r.containersStopped > 1 ? "s" : ""} arrêté${r.containersStopped > 1 ? "s" : ""} sans erreur sur ${s.name}`,
        detail: r.stoppedNames.join(" · "),
        mono: true,
        actions: [
          {
            label: "C'est voulu",
            primary: true,
            run: async () => {
              try {
                await api.dockerOnPurposeSet(s.id, r.stoppedKeys ?? [], true);
                notify("Ces conteneurs ne seront plus signalés tant qu'ils restent arrêtés.", "success");
              } catch (e) {
                notify(errorMessage(e), "error");
              }
              await fetchHealth(s.id, 0);
            },
          },
          { label: "Relancer", run: () => restartStopped(s, r.stoppedNames) },
          { label: "Docker", run: () => go(s, "docker") },
        ],
      });
    }
    for (const c of r.certificates.filter((c) => (c.notAfter - now) / DAY < CERT_WARN_DAYS)) {
      const days = Math.floor((c.notAfter - now) / DAY);
      todos.push({
        key: `cert:${s.id}:${c.domains[0]}`,
        level: days < 7 ? "critique" : "attention",
        title: `Certificat ${c.domains[0] ?? ""}`,
        detail: days < 0 ? "Expiré : les visiteurs voient une alerte de sécurité." : `Expire dans ${days} jour${days > 1 ? "s" : ""}.`,
        actions: [{ label: "Voir le site", primary: true, run: () => go(s, "sites") }],
      });
    }
  }
  for (const { server: s } of online.filter((x) => !x.r!.agent)) {
    todos.push({
      key: `agent:${s.id}`,
      level: "suggestion",
      title: `${s.name} sans agent zenyttd`,
      detail: "Historique sur 30 jours et alertes même quand Zenytt est fermé.",
      actions: [{ label: "Installer l'agent", primary: true, run: () => go(s, "monitoring", "agent") }],
    });
  }
  const failedTargets = online.filter((x) => (x.r!.failed?.length ?? 0) > 0);

  const shown = folder ? known.filter((x) => (x.server.group ?? "") === folder) : known;
  const healthOf = (r: DashboardSummary | undefined) => {
    const m = r?.metrics;
    const mem = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : null;
    const root = fullestDisk(m?.disks);
    const disk = root && root.total ? (root.used / root.total) * 100 : null;
    return { m, mem, root, disk };
  };

  const serverMenu = (s: ServerView): MenuItem[] => [
    { label: "Terminal", icon: <SquareTerminal size={14} />, onClick: () => openTab(s.id) },
    { label: "Supervision", icon: <Activity size={14} />, onClick: () => go(s, "monitoring") },
    { label: "Docker", onClick: () => go(s, "docker") },
    { label: "Sites", onClick: () => go(s, "sites") },
    { label: "Fichiers", onClick: () => go(s, "files") },
    { label: "Sécurité", onClick: () => go(s, "system", "security") },
    "separator",
    { label: "Actualiser", icon: <RotateCw size={14} />, onClick: () => void fetchHealth(s.id, 0) },
    { label: "Diagnostiquer la connexion", onClick: () => useDoctor.getState().open(s.id) },
  ];

  return (
    <PageLayout
      title="Centre de contrôle"
      context="Poste"
      subtitle={`${servers.length} serveur${servers.length > 1 ? "s" : ""} · ${online.length} en ligne · actualisation toutes les 30 s`}
      scroll={false}
      actions={
        <>
          <Segmented
            label="Affichage"
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: <LayoutGrid size={14} />, title: "Grille" },
              { value: "list", label: <List size={14} />, title: "Liste" },
            ]}
          />
          {groups.length > 0 && (
            <Select value={folder} onChange={setFolder} aria-label="Dossier" className="w-44" options={[{ value: "", label: "Tous les dossiers" }, ...groups.map((g) => ({ value: g, label: g }))]} />
          )}
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              useShell.getState().requestNewServer(true);
              setSection("servers");
            }}
          >
            Ajouter un serveur
          </Button>
        </>
      }
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <section className="@container flex min-h-0 min-w-0 flex-col gap-5 overflow-auto px-7 py-5">
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
            <StatTile label="Serveurs en ligne" value={`${online.length} / ${servers.length}`} tone="ok" trend={trends.online} hint={servers.length - online.length ? `${servers.length - online.length} hors ligne` : "Tous joignables"} />
            <StatTile label="Conteneurs actifs" value={nRunning} tone="accent" trend={trends.running} hint={`Sur ${online.filter((x) => x.r!.docker).length} serveur(s) Docker`} />
            <StatTile
              label="Conteneurs en panne"
              value={nFailed}
              tone={nFailed ? "warn" : "muted"}
              trend={trends.stopped}
              hint={nFailed ? failedTargets.map((x) => x.server.name).join(", ") : nStopped ? `${nStopped} arrêté${nStopped > 1 ? "s" : ""} sans erreur` : "Aucun"}
            />
            <StatTile label="Alertes actives" value={nAlerts} tone={nAlerts ? "danger" : "muted"} trend={trends.alerts} hint={nAlerts ? "Voir « À traiter »" : "Aucune alerte"} />
          </div>

          <Section title="Serveurs" count={shown.length}>
            {view === "grid" ? (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-3">
                {shown.map(({ server: s, r }) => {
                  const h = healthOf(r);
                  const certs = r?.certificates ?? [];
                  const minCert = certs.length ? Math.floor((Math.min(...certs.map((c) => c.notAfter)) - now) / DAY) : null;
                  const loading = !r || pending.has(s.id);
                  return (
                    <Card key={s.id} tone={r && !r.connected ? "danger" : undefined} className="flex flex-col gap-3.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={s.name} color={s.color} size={34} />
                        <button type="button" onClick={() => go(s, "monitoring")} className="min-w-0 flex-1 text-left" title="Ouvrir la supervision">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold">{s.name}</span>
                            {loading && !r ? <Badge>interrogation…</Badge> : r?.connected ? <Badge tone="ok">en ligne</Badge> : <Badge tone="danger">hors ligne</Badge>}
                          </div>
                          <div className="truncate font-mono text-[11px] text-muted">
                            {s.username}@{s.host}
                            {h.m ? ` · en ligne depuis ${formatDuration(h.m.uptimeSecs)}` : ""}
                          </div>
                        </button>
                        <MenuButton size="sm" items={serverMenu(s)} />
                      </div>
                      {r?.connected ? (
                        <>
                          <div className="grid grid-cols-3 gap-3">
                            <LabeledMeter label="CPU" value={h.m ? h.m.cpuPercent : null} detail={h.m ? `charge ${h.m.load[0].toFixed(2)}` : undefined} />
                            <LabeledMeter label="Mémoire" value={h.mem} detail={h.m ? formatBytes(h.m.memUsed) : undefined} />
                            <LabeledMeter label="Disque /" value={h.disk} detail={h.root ? `${formatBytes(h.root.total - h.root.used)} libres` : undefined} />
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2.5 text-xs text-muted">
                            {r.docker ? (
                              <button type="button" className="text-fg hover:text-accent" onClick={() => go(s, "docker")}>
                                {r.containersRunning} conteneur{r.containersRunning > 1 ? "s" : ""}
                                {(r.failed?.length ?? 0) > 0 && <span className="text-warn"> · {r.failed.length} en panne</span>}
                                {r.containersStopped > 0 && <span className="text-muted"> · {r.containersStopped} arrêté{r.containersStopped > 1 ? "s" : ""}</span>}
                              </button>
                            ) : (
                              <span>Pas de Docker</span>
                            )}
                            <span className={minCert != null && minCert < CERT_WARN_DAYS ? "text-warn" : ""}>
                              {certs.length ? `${certs.length} certificat${certs.length > 1 ? "s" : ""} · ${minCert} j min.` : "Aucun certificat"}
                            </span>
                            <span>{r.agent ? "Agent actif" : "Sans agent"}</span>
                            <button type="button" onClick={() => openTab(s.id)} className="ml-auto flex items-center gap-1 text-accent hover:underline">
                              Terminal <ChevronRight size={13} />
                            </button>
                          </div>
                        </>
                      ) : r ? (
                        <div className="flex flex-col gap-2.5">
                          <ErrorState message={r.error?.replace(/^.*?: /, "").slice(0, 140) || "Non connecté"} />
                          <div className="flex gap-2">
                            <Button size="sm" variant="primary" onClick={async () => void ((await ensureConnected(s.id, { force: true })) && fetchHealth(s.id, 0))}>
                              Se connecter
                            </Button>
                            <Button size="sm" onClick={() => useDoctor.getState().open(s.id)}>
                              Diagnostiquer
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 gap-3 opacity-60">
                          <LabeledMeter label="CPU" value={null} />
                          <LabeledMeter label="Mémoire" value={null} />
                          <LabeledMeter label="Disque /" value={null} />
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Card padded={false} className="overflow-hidden">
                <DataTable
                  rows={shown}
                  rowKey={(x) => x.server.id}
                  onRowClick={(x) => go(x.server, "monitoring")}
                  rowMenu={(x) => serverMenu(x.server)}
                  actionsWidth={150}
                  rowActions={(x) => (
                    <Button size="sm" variant="ghost" icon={<SquareTerminal size={13} />} onClick={() => openTab(x.server.id)}>
                      Terminal
                    </Button>
                  )}
                  columns={[
                    {
                      key: "name",
                      header: "Serveur",
                      width: "minmax(0,1.6fr)",
                      sortValue: (x) => x.server.name,
                      render: (x) => (
                        <span className="flex items-center gap-2.5">
                          <StatusDot tone={x.r?.connected ? "ok" : x.r ? "danger" : "muted"} />
                          <span className="font-medium">{x.server.name}</span>
                          <span className="truncate font-mono text-[11px] text-faint">{x.server.host}</span>
                        </span>
                      ),
                    },
                    ...(["cpu", "mem", "disk"] as const).map((k) => ({
                      key: k,
                      header: k === "cpu" ? "CPU" : k === "mem" ? "Mémoire" : "Disque /",
                      width: "130px",
                      sortValue: (x: (typeof shown)[number]) => {
                        const h = healthOf(x.r);
                        return k === "cpu" ? (h.m?.cpuPercent ?? -1) : k === "mem" ? (h.mem ?? -1) : (h.disk ?? -1);
                      },
                      render: (x: (typeof shown)[number]) => {
                        const h = healthOf(x.r);
                        const v = k === "cpu" ? (h.m?.cpuPercent ?? null) : k === "mem" ? h.mem : h.disk;
                        return <LabeledMeter label="" value={x.r?.connected ? v : null} />;
                      },
                    })),
                    {
                      key: "containers",
                      header: "Conteneurs",
                      width: "120px",
                      sortValue: (x) => x.r?.containersRunning ?? -1,
                      render: (x) =>
                        x.r?.connected && x.r.docker ? (
                          <span className="tabular-nums">
                            {x.r.containersRunning}
                            {(x.r.failed?.length ?? 0) > 0 && <span className="text-warn"> · {x.r.failed.length} en panne</span>}
                            {x.r.containersStopped > 0 && <span className="text-muted"> · {x.r.containersStopped} arrêté(s)</span>}
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        ),
                    },
                    {
                      key: "alerts",
                      header: "Alertes",
                      width: "90px",
                      sortValue: (x) => x.r?.alerts.length ?? 0,
                      render: (x) => (x.r?.alerts.length ? <Badge tone="danger">{x.r.alerts.length}</Badge> : <span className="text-faint">—</span>),
                    },
                  ]}
                />
              </Card>
            )}
          </Section>
        </section>

        <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-l border-border bg-subtle px-5 py-5" aria-label="À traiter">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              À traiter <span className="font-normal text-faint">· {todos.length}</span>
            </h2>
            {failedTargets.length > 0 && (
              <Button size="sm" variant="ghost" className="text-accent" title="Relance les conteneurs en panne (pas ceux arrêtés sans erreur)" onClick={() => void Promise.all(failedTargets.map((x) => restartStopped(x.server, x.r!.failed.map((f) => f.name))))}>
                Relancer les pannes
              </Button>
            )}
          </div>
          {todos.length === 0 && <Card className="text-[13px] text-muted">Rien à signaler : tout tourne normalement.</Card>}
          {(["critique", "attention", "suggestion"] as const).map((level) => {
            const items = todos.filter((t) => t.level === level);
            if (!items.length) return null;
            const tone: Tone = level === "critique" ? "danger" : level === "attention" ? "warn" : "accent";
            const border = level === "critique" ? "border-l-danger" : level === "attention" ? "border-l-warn" : "border-l-accent";
            return (
              <div key={level} className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">
                  <StatusDot tone={tone} />
                  {level}
                </div>
                {items.map((t) => (
                  <div key={t.key} className={`flex flex-col gap-1 rounded-xl border border-l-2 border-border bg-panel px-3 py-2.5 ${border}`}>
                    <div className="text-[13px] font-medium">{t.title}</div>
                    {t.detail && <div className={`text-xs break-words text-muted ${t.mono ? "font-mono" : ""}`}>{t.detail}</div>}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {t.actions.map((a) => (
                        <Button key={a.label} size="sm" variant={a.primary ? "primary" : "outline"} onClick={() => void a.run()}>
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          <div className="mt-1 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Activité</h2>
            <button type="button" onClick={() => navigate("settings", "journal")} className="flex items-center gap-1 text-xs text-accent hover:underline">
              Tout le journal <ArrowRight size={12} />
            </button>
          </div>
          {activity.length === 0 ? (
            <p className="text-xs text-muted">Aucune action enregistrée pour l'instant.</p>
          ) : (
            <ol className="flex flex-col gap-3 border-l border-border-strong/60 pl-4">
              {activity.map((a, i) => (
                <li key={i} className="relative min-w-0 text-[12.5px]" title={`${a.action} ${a.detail}${a.error ? ` : ${a.error}` : ""}`}>
                  <span
                    className={`absolute top-1 -left-[21px] size-2.5 rounded-full border-2 border-subtle ${!a.ok ? "bg-danger" : a.origin === "mcp" ? "bg-accent" : "bg-ok"}`}
                  />
                  <div className="flex gap-2 text-[11px] text-faint">
                    <span className="font-mono">{new Date(a.t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="truncate">
                      {a.origin === "mcp" ? "IA · " : ""}
                      {a.serverName}
                    </span>
                  </div>
                  <div className={`truncate ${a.ok ? "" : "text-danger"}`}>
                    {!a.ok && <TriangleAlert size={12} className="mr-1 inline" />}
                    {actionLabel(a.action)}
                    {a.ok ? "" : " (échec)"}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </PageLayout>
  );
}

/** Libellé lisible d'une action du journal (le détail complet reste dans l'infobulle et le journal). */
const ACTIONS: Record<string, string> = {
  "ssh.trust_host": "Clé du serveur approuvée",
  "tmux.install": "Installation de tmux",
  "tmux.kill": "Session tmux fermée",
  "file.write": "Fichier modifié",
  "nginx.write": "Configuration nginx appliquée",
  "fail2ban.unban": "IP débloquée",
  "fail2ban.ignoreip": "Exceptions fail2ban modifiées",
  "fail2ban.ban": "IP bannie",
  "fail2ban.settings": "Réglages fail2ban modifiés",
  "firewall.allow": "Port ouvert dans le pare-feu",
  "firewall.delete": "Règle de pare-feu supprimée",
  "ssh.key.add": "Clé SSH ajoutée",
  "ssh.key.remove": "Clé SSH retirée",
  "crontab.save": "Crontab modifiée",
  "timer.run": "Tâche planifiée lancée",
};

function actionLabel(action: string): string {
  const l = ACTIONS[action] ?? action.replace(/[._]/g, " ");
  return l.charAt(0).toUpperCase() + l.slice(1);
}
