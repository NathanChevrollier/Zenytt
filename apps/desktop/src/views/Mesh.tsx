// Réseau privé : des serveurs de différents hébergeurs reliés par WireGuard, chacun avec une
// adresse privée en 10.x. Zenytt orchestre par SSH ; l'état des liens est lu sur chaque serveur.
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Network, Plus, RefreshCw, Trash2, Wrench } from "lucide-react";
import { api, errorMessage, type MeshMemberStatus, type MeshNetwork, type MeshReport } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { memberLinks, summary, type LinkState } from "../lib/mesh";
import { usePolling } from "../lib/poll";
import { useCachedState } from "../lib/cache";
import { useAppPick } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, MenuButton, ResultBanner, Section, StatusDot } from "../components/ui";
import PageLayout from "../components/PageLayout";
import MeshCreateDialog from "./mesh/MeshCreateDialog";
import type { NetworkPage } from "./Network";

/** Au-delà, un lien jamais établi n'est plus « en cours de liaison » : on explique quoi vérifier. */
const HINT_AFTER_MS = 60_000;

const LINK_LOOK: Record<LinkState | "absent", { dot: string; label: string }> = {
  ok: { dot: "bg-ok", label: "relié" },
  stale: { dot: "bg-warn", label: "lien tombé (aucun échange depuis plus de 3 min)" },
  never: { dot: "bg-hover-strong", label: "jamais relié" },
  absent: { dot: "border border-dashed border-faint", label: "pas de lien direct (deux serveurs derrière un NAT)" },
};

export default function MeshView({ page }: { page: NetworkPage }) {
  const { servers, notify, ask } = useAppPick("servers", "notify", "ask");
  const [networks, setNetworks] = useCachedState<MeshNetwork[]>("mesh:list", []);
  const [statuses, setStatuses] = useState<Record<string, MeshMemberStatus[]>>({});
  const [dialog, setDialog] = useState<{ network?: MeshNetwork } | null>(null);
  const [report, setReport] = useState<{ title: string; report: MeshReport } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lastAction = useRef(Date.now());

  const load = useCallback(() => api.meshList().then(setNetworks), [setNetworks]);
  const refreshStatuses = useCallback(async () => {
    const list = await api.meshList();
    setNetworks(list);
    const entries = await Promise.all(list.map(async (n) => [n.id, await api.meshStatus(n.id).catch(() => [])] as const));
    setStatuses(Object.fromEntries(entries));
  }, [setNetworks]);
  usePolling(refreshStatuses, 10_000, []);
  useEffect(() => page.onCount(networks.length), [networks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "serveur supprimé";

  const done = (title: string, r: MeshReport) => {
    lastAction.current = Date.now();
    setReport({ title, report: r });
    void refreshStatuses();
  };

  const act = async (networkId: string, title: string, fn: () => Promise<MeshReport>) => {
    setBusy(networkId);
    try {
      done(title, await fn());
    } catch (e) {
      notify(errorMessage(e), "error");
      void load();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (n: MeshNetwork, serverId: string) => {
    const ok = await ask({
      title: `Retirer ${serverName(serverId)} de « ${n.name} » ?`,
      body: "Son interface zenytt et sa clé sont supprimées ; les autres serveurs cessent de l'accepter. Les services qui utilisent son adresse privée ne le joindront plus.",
      confirmLabel: "Retirer",
      danger: true,
    });
    if (ok) await act(n.id, `${serverName(serverId)} retiré du réseau`, () => api.meshRemove(n.id, serverId));
  };

  const destroy = async (n: MeshNetwork) => {
    const ok = await ask({
      title: `Supprimer le réseau « ${n.name} » ?`,
      body: "Les serveurs quittent le réseau privé : l'interface zenytt et sa clé sont supprimées. Les services qui utilisent les adresses 10.x ne les joindront plus.",
      confirmLabel: "Supprimer le réseau",
      danger: true,
    });
    if (ok) await act(n.id, `Réseau « ${n.name} » supprimé`, () => api.meshDelete(n.id));
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const failed = report ? report.report.results.filter((r) => !r.ok) : [];

  return (
    <PageLayout
      title="Réseau"
      tabs={page.tabs}
      activeTab={page.activeTab}
      onTab={page.onTab}
      subtitle="Relie tes serveurs de différents hébergeurs dans un réseau privé chiffré (WireGuard), sans rien exposer sur Internet."
      guide="mesh"
      actions={
        <Button variant="primary" icon={<Plus size={14} />} disabled={servers.length < 2} onClick={() => setDialog({})}>
          Nouveau réseau privé
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-7 py-6">
        {report && (
          <ResultBanner
            tone={failed.length ? "danger" : report.report.warnings.length ? "warn" : "ok"}
            title={failed.length ? `${report.title} — ${failed.length} serveur${failed.length > 1 ? "s" : ""} en échec` : report.title}
            action={
              <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
                Fermer
              </Button>
            }
          >
            {failed.map((r) => (
              <p key={r.serverId} className="select-text">
                <span className="font-medium">{serverName(r.serverId)}</span> : {r.message}
              </p>
            ))}
            {report.report.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </ResultBanner>
        )}

        {networks.length === 0 ? (
          <EmptyState
            icon={<Network />}
            title="Relie tes serveurs"
            action={
              servers.length >= 2 ? (
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => setDialog({})}>
                  Nouveau réseau privé
                </Button>
              ) : undefined
            }
          >
            Exemple : ton app tourne chez un hébergeur et sa base chez un autre. Dans un réseau privé, l'app joint la base sur{" "}
            <span className="font-mono">10.77.0.2</span>, chiffré par WireGuard, sans que la base soit exposée sur Internet.
            {servers.length < 2 && " Ajoute d'abord au moins deux serveurs."}
          </EmptyState>
        ) : (
          networks.map((n) => {
            const st = statuses[n.id] ?? [];
            const { linked, expected } = summary(n, st, nowSec);
            const neverLinked = st.some((s) => memberLinks(n, s, nowSec).some((l) => l.state === "never"));
            const showHint = neverLinked && Date.now() - lastAction.current > HINT_AFTER_MS;
            const working = busy === n.id;
            return (
              <Section
                key={n.id}
                title={
                  <>
                    {n.name} <span className="ml-1 font-mono text-xs font-normal text-faint">{n.cidr}</span>
                  </>
                }
                count={
                  st.length > 0 ? (
                    <Badge tone={linked === expected ? "ok" : "warn"}>
                      {linked}/{expected} lien{expected > 1 ? "s" : ""}
                    </Badge>
                  ) : undefined
                }
                actions={
                  <div className="flex items-center gap-2">
                    <Button size="sm" icon={<Plus size={13} />} disabled={working} onClick={() => setDialog({ network: n })}>
                      Ajouter un serveur
                    </Button>
                    <Button size="sm" icon={working ? <RefreshCw size={13} className="animate-spin" /> : <Wrench size={13} />} disabled={working} onClick={() => void act(n.id, "Configuration réappliquée", () => api.meshRepair(n.id))}>
                      Réparer
                    </Button>
                    <MenuButton size="sm" items={[{ label: "Supprimer le réseau…", icon: <Trash2 size={14} />, danger: true, onClick: () => void destroy(n) }]} />
                  </div>
                }
              >
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {n.members.map((m) => {
                    const s = st.find((x) => x.serverId === m.serverId);
                    const tone = s?.error ? "danger" : s?.status?.up ? "ok" : s ? "warn" : "muted";
                    return (
                      <div key={m.serverId} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-3 px-4 py-2.5">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <StatusDot tone={tone} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{serverName(m.serverId)}</span>
                            <span className="block truncate text-xs text-muted" title={s?.error ?? undefined}>
                              {s?.error ? s.error : s?.status ? (s.status.up ? "interface active" : "interface arrêtée") : "état en cours de lecture…"}
                            </span>
                          </span>
                        </span>
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate font-mono text-xs select-text">{m.address}</span>
                          <IconButton
                            size="sm"
                            title="Copier l'adresse privée"
                            onClick={() => {
                              void writeClipboard(m.address);
                              notify(`Adresse copiée : ${m.address}`, "success");
                            }}
                          >
                            <Copy size={12} />
                          </IconButton>
                        </span>
                        <span className="truncate font-mono text-xs text-muted" title={m.endpoint ? "Adresse publique utilisée par les autres serveurs" : "Joint les serveurs publics, sans être joignable de l'extérieur"}>
                          {m.endpoint ? `${m.endpoint}:${m.port}` : "derrière un NAT"}
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {memberLinks(n, s ?? { serverId: m.serverId, error: null, status: null }, nowSec).map((l) => (
                            <span key={l.serverId} title={`${serverName(l.serverId)} : ${s?.status ? LINK_LOOK[l.state].label : "état inconnu"}`} className="flex items-center gap-1 text-xs text-muted">
                              <span className={`size-2.5 rounded-full ${s?.status ? LINK_LOOK[l.state].dot : "bg-hover-strong"}`} />
                              {serverName(l.serverId)}
                            </span>
                          ))}
                        </span>
                        <IconButton size="sm" title="Retirer du réseau" disabled={working} onClick={() => void remove(n, m.serverId)}>
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    );
                  })}
                </div>
                {showHint && (
                  <p className="mt-2 text-xs text-warn">
                    Pas encore de liaison entre certains serveurs : vérifie que le port UDP de chaque serveur public (affiché ci-dessus, 51820 par défaut) est ouvert dans le
                    pare-feu de ton hébergeur (OVH, Hetzner, AWS…).
                  </p>
                )}
              </Section>
            );
          })
        )}
      </div>
      {dialog && (
        <MeshCreateDialog
          network={dialog.network}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            done(dialog.network ? `Serveur ajouté à « ${dialog.network.name} »` : `Réseau « ${r.network?.name ?? ""} » créé`, r);
          }}
        />
      )}
    </PageLayout>
  );
}
