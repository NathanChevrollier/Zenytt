import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight, Tag, CircleCheck, CircleX, ExternalLink, FileCode2, Globe, History, Loader2, Lock, LockOpen, Plus, Power, PowerOff, RefreshCw, ShieldCheck, Trash2, Zap,
} from "lucide-react";
import {
  api, ENGINE_LABELS, errorMessage, type Certificate, type Container, type NginxState, type DomainInfo, type ServerBlock, type SiteFile,
  type WebEngine,
} from "../lib/api";
import { useApp, useAppPick } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Loading, MenuButton, Modal, ResultBanner, Segmented } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { confirmDestructive, groupByClient, lockKey, useItemFolders, useLocks } from "../lib/folders";
import { ClientFilter, clientMenuItems } from "../components/ClientTools";

const NginxEditor = lazy(() => import("../components/NginxEditor"));
const NewSiteWizard = lazy(() => import("../components/NewSiteWizard"));
const NginxHistory = lazy(() => import("../components/NginxHistory"));

export default function SitesView() {
  return <ServerGate title="Sites" guide="sites">{(serverId) => <Sites key={serverId} serverId={serverId} />}</ServerGate>;
}

const EMAIL_KEY = "zenytt.certbotEmail";

const DAY = 86400;
function certTone(c: Certificate): "ok" | "warn" | "danger" {
  const days = (c.notAfter - Date.now() / 1000) / DAY;
  return days < 7 ? "danger" : days < 21 ? "warn" : "ok";
}

/** Site affiché : un domaine principal et ses server blocks (HTTP + HTTPS). */
interface Site {
  file: SiteFile;
  domain: string;
  aliases: string[];
  blocks: ServerBlock[];
  /** Entrée de configuration qui n'est pas un site : masquée sauf demande explicite. */
  technique: boolean;
}

function sitesOf(files: SiteFile[]): Site[] {
  return files.map((file) => {
    const names = [...new Set(file.servers.flatMap((s) => s.serverNames))].filter((n) => n !== "_" && n !== "localhost");
    const domain = names[0] ?? file.path.split("/").pop()!;
    return { file, domain, aliases: names.slice(1), blocks: file.servers, technique: !names.length || technicalName(file, domain) };
  });
}

/**
 * Entrée technique : elle apparaît dans la configuration sans être un site à administrer — bloc
 * attrape-tout du serveur (`default`), fragment inclus depuis `conf.d` sans nom de domaine,
 * redirections internes. On la masque par défaut, sans la supprimer de la liste.
 */
function technicalName(file: SiteFile, domain: string): boolean {
  const nom = domain.toLowerCase();
  if (/^(00-)?default(\.conf)?$/.test(nom) || nom === "default_server") return true;
  // Un nom de fichier en guise de domaine : aucun server_name exploitable n'a été trouvé.
  if (/\.(conf|inc)$/.test(nom)) return true;
  return !nom.includes(".") && !file.path.includes("/sites-enabled/");
}

/**
 * Lien d'activation d'un site (sites-enabled), ou `null` pour un fichier inclus directement
 * (conf.d) : il ne peut alors pas être désactivé sans être supprimé.
 */
function linkFor(file: SiteFile): string | null {
  if (file.path.includes("/sites-enabled/")) return file.path;
  if (file.realPath.includes("/sites-available/")) return file.realPath.replace("/sites-available/", "/sites-enabled/");
  return null;
}

function Sites({ serverId }: { serverId: string }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  // « active » et « disabled » : anciens identifiants d'onglets, repris par les liens existants.
  const [rawTab, setTab] = useTabIntent<"sites" | "active" | "disabled" | "certificates">("sites", "sites");
  const tab = rawTab === "certificates" ? "certificates" : "sites";
  const [etat, setEtat] = useState<"all" | "active" | "disabled">(rawTab === "disabled" ? "disabled" : "all");
  useEffect(() => {
    if (rawTab === "disabled") setEtat("disabled");
    if (rawTab === "disabled" || rawTab === "active") setTab("sites");
  }, [rawTab]);
  const [certbotBusy, setCertbotBusy] = useState<string | null>(null);
  // Serveur web affiché : nginx, ou Apache quand il est présent.
  const [engine, setEngine] = useCachedState<WebEngine>(`sitesEngine:${serverId}`, "nginx");
  const web = ENGINE_LABELS[engine];
  const [state, setState] = useCachedState<NginxState | null>(`sites-${engine}:${serverId}`, null);
  const [containers, setContainers] = useCachedState<Container[]>(`sitesContainers:${serverId}`, []);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SiteFile | null>(null);
  const [wizard, setWizard] = useState(false);
  const [history, setHistory] = useState(false);
  const [output, setOutput] = useState<{ title: string; text: string; ok: boolean } | null>(null);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [dns, setDns] = useCachedState<Record<string, DomainInfo>>(`sitesDns:${serverId}`, {});
  const clients = useItemFolders("sites", serverId);
  const locks = useLocks(serverId);
  const [clientFilter, setClientFilter] = useState("");
  const siteLock = (domain: string) => lockKey("site", domain);

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.sitesState(serverId, engine), api.dockerOverview(serverId).catch(() => null)]);
      // Pas de nginx mais Apache présent : on passe directement à Apache.
      if (engine === "nginx" && !s.installed && s.others.includes("Apache")) {
        setEngine("apache");
        return;
      }
      setState(s);
      setContainers(d?.containers ?? []);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId, engine]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh(
    (auto) =>
      auto
        ? Promise.all([api.sitesState(serverId, engine), api.dockerOverview(serverId).catch(() => null)]).then(([s, d]) => {
            setState(s);
            setContainers(d?.containers ?? []);
          }, () => {})
        : load(),
    { serverId },
  );

  const certFor = useCallback(
    (block: ServerBlock) => state?.certificates.find((c) => c.path === block.sslCertificate),
    [state],
  );
  const containerOnPort = (port: number) => containers.find((c) => c.ports.some((p) => p.hostPort === port));
  const tousLesSites = useMemo(() => sitesOf(state?.files ?? []), [state]);
  const [showTechnical, setShowTechnical] = useState(false);
  const masques = tousLesSites.filter((s) => s.technique).length;
  const sites = showTechnical ? tousLesSites : tousLesSites.filter((s) => !s.technique);
  const disabled = useMemo(() => sitesOf(state?.disabled ?? []), [state]);
  const entries = [
    ...(etat === "disabled" ? [] : sites.map((site) => ({ site, off: false }))),
    ...(etat === "active" ? [] : disabled.map((site) => ({ site, off: true }))),
  ];

  // DNS et expiration des domaines, vérifiés depuis le PC après l'affichage (sans le ralentir).
  const domainList = useMemo(() => sites.map((s) => s.domain).filter((d) => d.includes(".")).join(","), [sites]);
  useEffect(() => {
    if (!domainList) return;
    void api
      .domainsCheck(serverId, domainList.split(","))
      .then((list) => setDns(Object.fromEntries(list.map((d) => [d.domain, d]))))
      .catch(() => {});
  }, [serverId, domainList]);

  const runApply = async (label: string, fn: () => Promise<{ ok: boolean; log: string; backup: string | null }>) => {
    try {
      const r = await fn();
      if (r.ok) notify(`${label} : OK (sauvegarde ${r.backup})`, "success");
      else setOutput({ title: `${label} : refusé par ${web}, rien n'a changé`, text: r.log, ok: false });
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Certificat Let's Encrypt pour un domaine (première émission ou nouvelle tentative). */
  const runCertbot = async (domain: string) => {
    let saved = "";
    try {
      saved = localStorage.getItem(EMAIL_KEY) ?? "";
    } catch {
      /* rien */
    }
    const email = await ask({
      title: `Certificat HTTPS pour ${domain}`,
      body: "certbot demande un certificat Let's Encrypt et configure la redirection vers HTTPS. Le domaine doit déjà pointer vers ce serveur et le port 80 être joignable.",
      input: { label: "E-mail (avertissements d'expiration de Let's Encrypt)", initial: saved },
      confirmLabel: "Obtenir le certificat",
    });
    if (typeof email !== "string" || !email.includes("@")) return;
    try {
      localStorage.setItem(EMAIL_KEY, email);
    } catch {
      /* rien */
    }
    setCertbotBusy(domain);
    try {
      const out = await api.sitesCertbot(serverId, domain, email, engine);
      setOutput({ title: `certbot · ${domain}`, text: out || "Certificat obtenu.", ok: true });
      await load();
    } catch (e) {
      setOutput({ title: `certbot · ${domain} : échec`, text: errorMessage(e), ok: false });
    } finally {
      setCertbotBusy(null);
    }
  };

  const layout = (children: React.ReactNode) => (
    <PageLayout title="Sites" guide="sites" context={server && <ServerContext server={server} />}>
      {children}
    </PageLayout>
  );
  if (error && !state) return layout(<div className="p-7"><ErrorState message={`Impossible de lire la configuration : ${error}`} onRetry={() => void load()} /></div>);
  if (!state) return layout(<div className="p-7"><Loading rows={6} /></div>);
  if (!state.installed)
    return layout(
      <EmptyState
        icon={<Globe />}
        title={`${web} n'est pas installé sur ce serveur`}
        action={engine === "apache" ? <Button onClick={() => setEngine("nginx")}>Revenir à nginx</Button> : undefined}
      >
        {state.others.length > 0
          ? `Serveur web détecté : ${state.others.join(", ")}. Zenytt gère nginx et Apache ; les autres sections (Docker, Pare-feu, Journaux…) restent utilisables.`
          : "Aucun serveur web détecté."}
      </EmptyState>,
    );
  // Les deux serveurs web cohabitent : on peut passer de l'un à l'autre.
  const other: WebEngine | null = engine === "nginx" ? (state.others.includes("Apache") ? "apache" : null) : "nginx";
  const soon = state.certificates.filter((c) => (c.notAfter - Date.now() / 1000) / DAY < 21).length;
  const extra = state.others.filter((o) => o !== "Apache" && o !== "nginx");

  return (
    <PageLayout
      title="Sites"
      guide="sites"
      context={server && <ServerContext server={server} />}
      subtitle="Sous-domaines, certificats et conteneurs derrière le serveur web"
      status={
        <>
          {other && (
            <Segmented
              size="sm"
              label="Serveur web"
              value={engine}
              onChange={setEngine}
              options={(["nginx", "apache"] as const).map((e) => ({ value: e, label: ENGINE_LABELS[e] }))}
            />
          )}
          <Badge>{state.version}</Badge>
          {state.running ? <Badge tone="ok">{web} actif</Badge> : <Badge tone="danger">{web} arrêté</Badge>}
          {state.certbot ? <Badge>certbot installé</Badge> : <Badge tone="warn">certbot absent</Badge>}
          {extra.length > 0 && <Badge tone="warn">aussi détecté : {extra.join(", ")}</Badge>}
          {masques > 0 && (
            <span className="ml-auto" title="Blocs attrape-tout, fragments inclus, redirections internes">
              <Checkbox className="text-xs text-muted" checked={showTechnical} onChange={setShowTechnical} label={`Afficher les ${masques} entrée(s) technique(s)`} />
            </span>
          )}
        </>
      }
      tabs={[
        { id: "sites", label: "Sites", count: sites.length + disabled.length },
        { id: "certificates", label: "Certificats", count: soon ? `${soon} bientôt` : state.certificates.length, tone: soon ? "warn" : undefined },
      ]}
      activeTab={tab}
      onTab={setTab}
      actions={
        <>
          <MenuButton
            label={web}
            icon={<ShieldCheck size={14} />}
            title={`Actions sur ${web}`}
            items={[
              {
                label: "Tester la configuration",
                icon: <ShieldCheck size={14} />,
                onClick: async () => {
                  const r = await api.sitesTest(serverId, engine).catch((e) => ({ ok: false, output: errorMessage(e) }));
                  setOutput({ title: r.ok ? "Configuration valide" : "Configuration invalide", text: r.output, ok: r.ok });
                },
              },
              {
                label: `Recharger ${web}`,
                icon: <Zap size={14} />,
                onClick: async () => {
                  try {
                    await api.sitesReload(serverId, engine);
                    notify(`${web} rechargé`, "success");
                  } catch (e) {
                    setOutput({ title: "Rechargement refusé", text: errorMessage(e), ok: false });
                  }
                },
              },
              ...(state.certbot
                ? [
                    {
                      label: "Renouveler les certificats",
                      hint: "certbot renew",
                      icon: <RefreshCw size={14} />,
                      onClick: async () => {
                        notify("Renouvellement des certificats en cours…");
                        const out = await api.sitesRenew(serverId).catch(errorMessage);
                        setOutput({ title: "certbot renew", text: out, ok: true });
                        void load();
                      },
                    },
                  ]
                : []),
              "separator" as const,
              { label: "Historique des configurations…", icon: <History size={14} />, onClick: () => setHistory(true) },
            ]}
          />
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setWizard(true)}>
            Nouveau site
          </Button>
        </>
      }
    >
      <div className="px-7 py-5">
        {tab === "sites" && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] gap-3.5">
            <div className="col-span-full flex flex-wrap items-center gap-2">
              <Segmented
                size="sm"
                label="État"
                value={etat}
                onChange={setEtat}
                options={[
                  { value: "all", label: `Tous ${sites.length + disabled.length}` },
                  { value: "active", label: `Actifs ${sites.length}` },
                  { value: "disabled", label: `Désactivés ${disabled.length}` },
                ]}
              />
              {clients.names.length > 0 && <ClientFilter names={clients.names} value={clientFilter} onChange={setClientFilter} />}
            </div>
            {entries.length === 0 && (
              <div className="col-span-full">
                {(etat === "disabled" ? (
                  <EmptyState icon={<PowerOff />} title="Aucun site désactivé">
                    Un site désactivé n'est plus servi, mais sa configuration reste dans sites-available pour être réactivée d'un clic.
                  </EmptyState>
                ) : (
                  <EmptyState
                    icon={<Globe />}
                    title={etat === "active" ? "Aucun site actif" : "Aucun site"}
                    action={
                      <Button variant="primary" icon={<Plus size={14} />} onClick={() => setWizard(true)}>
                        Nouveau site
                      </Button>
                    }
                  >
                    L'assistant crée le conteneur (ou pointe vers un port existant), le vhost et le certificat HTTPS, puis vérifie que le site répond.
                  </EmptyState>
                ))}
              </div>
            )}
            {groupByClient(entries, (x) => clients.folderOf(x.site.domain), clientFilter).flatMap(([client, list]) => [
              clients.names.length > 0 ? (
                <h3 key={`client:${client}`} className="col-span-full flex items-center gap-1.5 text-xs font-medium text-muted">
                  <Tag size={12} /> {client || "Sans client"}
                </h3>
              ) : null,
              ...list.map(({ site, off }) => {
                if (off)
                  return (
                    <Card key={site.file.path} className="flex flex-col gap-3.5 border-dashed opacity-70">
                      <div className="flex items-start gap-2.5">
                        <PowerOff size={17} className="mt-0.5 shrink-0 text-faint" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">{site.domain}</span>
                            {locks.isLocked(siteLock(site.domain)) && (
                              <Badge tone="warn" title="Verrouillé : désactivation et suppression à confirmer en retapant le nom">
                                <Lock size={10} /> verrouillé
                              </Badge>
                            )}
                            {clients.folderOf(site.domain) && <Badge title="Client">{clients.folderOf(site.domain)}</Badge>}
                          </div>
                          {site.aliases.length > 0 && <div className="truncate text-xs text-muted">+ {site.aliases.join(", ")}</div>}
                          <div className="truncate font-mono text-[11px] text-faint">{site.file.realPath}</div>
                        </div>
                        <Badge>désactivé</Badge>
                      </div>
                      <div className="mt-auto flex flex-wrap items-center gap-1.5">
                        <Button
                          size="sm"
                          icon={<Power size={12} />}
                          onClick={() => void runApply(`Activation de ${site.domain}`, () => api.sitesSetEnabled(serverId, site.file.realPath, linkFor(site.file) ?? "", true, engine))}
                        >
                          Activer
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          icon={<Trash2 size={12} />}
                          onClick={async () => {
                            const ok = await confirmDestructive({
                              title: `Supprimer la configuration de ${site.domain} ?`,
                              body: `Le fichier est supprimé de sites-available (une sauvegarde de ${state.confRoot} est faite avant). Les conteneurs et certificats ne sont pas touchés.`,
                              confirmLabel: "Supprimer",
                              name: site.domain,
                              locked: locks.isLocked(siteLock(site.domain)),
                            });
                            if (ok) await runApply(`Suppression de ${site.domain}`, () => api.sitesDelete(serverId, site.file.realPath, linkFor(site.file) ?? "", engine));
                          }}
                        >
                          Supprimer définitivement
                        </Button>
                      </div>
                    </Card>
                  );
                const httpsBlock = site.blocks.find((b) => b.ssl);
                const cert = httpsBlock ? certFor(httpsBlock) : undefined;
                const ports = [...new Set(site.blocks.flatMap((b) => b.upstreamPorts))];
                const statics = site.blocks.flatMap((b) => (b.root ? [b.root] : b.locations.filter((l) => l.root).map((l) => l.root!)));
                const redirectsOnly = site.blocks.every((b) => b.returns && !b.locations.length);
                const days = cert ? Math.floor((cert.notAfter - Date.now() / 1000) / DAY) : null;
                const check = checks[site.domain];
                const isDefault = /\/(default|000-default\.conf|default-ssl\.conf)$/.test(site.file.path);
                const link = linkFor(site.file);
                const tone = cert ? certTone(cert) : httpsBlock ? "warn" : undefined;
                const c = ports.length ? containerOnPort(ports[0]) : undefined;
                const target = ports.length ? ports.map((x) => `:${x}`).join(" ") : statics.length ? statics[0] : redirectsOnly ? "redirection" : "—";
                return (
                  <Card key={site.file.path} tone={tone === "danger" ? "danger" : tone === "warn" ? "warn" : undefined} className="flex flex-col gap-3.5">
                    <div className="flex items-start gap-2.5">
                      {httpsBlock ? <Lock size={17} className="mt-0.5 shrink-0 text-ok" /> : <LockOpen size={17} className="mt-0.5 shrink-0 text-warn" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{site.domain}</span>
                          {locks.isLocked(siteLock(site.domain)) && (
                            <Badge tone="warn" title="Verrouillé : désactivation et suppression à confirmer en retapant le nom">
                              <Lock size={10} /> verrouillé
                            </Badge>
                          )}
                          {clients.folderOf(site.domain) && <Badge title="Client">{clients.folderOf(site.domain)}</Badge>}
                        </div>
                        {site.aliases.length > 0 && <div className="truncate text-xs text-muted">+ {site.aliases.join(", ")}</div>}
                        <div className="truncate font-mono text-[11px] text-faint">{site.file.realPath}</div>
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        <DomainBadges info={dns[site.domain]} />
                        {cert ? (
                          <Badge tone={certTone(cert)}>{days! < 0 ? "certificat expiré" : `certificat ${days} j`}</Badge>
                        ) : httpsBlock ? (
                          <Badge tone="warn">certificat illisible</Badge>
                        ) : (
                          <Badge>HTTP seulement</Badge>
                        )}
                      </div>
                    </div>

                    {/* Chaîne : domaine → serveur web → cible → conteneur */}
                    <div className="grid grid-cols-[minmax(0,1fr)_12px_minmax(0,0.8fr)_12px_minmax(0,1fr)_12px_minmax(0,1fr)] items-center gap-1.5 text-xs">
                      <ChainNode label="Domaine" value={site.domain} />
                      <ArrowRight size={12} className="text-faint" />
                      <ChainNode label={web} value={httpsBlock ? ":443 · :80" : ":80"} />
                      <ArrowRight size={12} className="text-faint" />
                      <ChainNode label={ports.length ? "127.0.0.1" : statics.length ? "Dossier" : "Cible"} value={target} mono />
                      <ArrowRight size={12} className="text-faint" />
                      {c ? (
                        <ChainNode label="Conteneur" value={c.name} dot={c.state === "running" ? "ok" : "danger"} />
                      ) : (
                        <ChainNode label="Conteneur" value={ports.length && containers.length > 0 ? "aucun sur ce port" : "—"} dashed warn={ports.length > 0 && containers.length > 0} />
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => setEditing(site.file)}>
                        Éditer la config
                      </Button>
                      <Button size="sm" icon={<ExternalLink size={12} />} onClick={() => void openUrl(`${httpsBlock ? "https" : "http"}://${site.domain}`)} disabled={isDefault}>
                        Ouvrir
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isDefault}
                        title="Appelle l'URL depuis le serveur et affiche le code HTTP"
                        onClick={async () => {
                          setChecks((x) => ({ ...x, [site.domain]: "…" }));
                          try {
                            const code = await api.sitesCheck(serverId, site.domain);
                            setChecks((x) => ({ ...x, [site.domain]: code }));
                          } catch (e) {
                            setChecks((x) => ({ ...x, [site.domain]: "" }));
                            notify(errorMessage(e), "error");
                          }
                        }}
                      >
                        Tester l'URL
                      </Button>
                      {check === "…" && <Loader2 size={13} className="animate-spin text-muted" />}
                      {check && check !== "…" && (
                        <span className={`flex items-center gap-1 text-xs ${/^[23]/.test(check) ? "text-ok" : "text-danger"}`}>
                          {/^[23]/.test(check) ? <CircleCheck size={13} /> : <CircleX size={13} />} HTTP {check}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-1">
                        {state.certbot && !isDefault && (!httpsBlock || (days !== null && days < 21)) && (
                          <Button size="sm" variant="outline" className="border-warn/50 text-warn" loading={certbotBusy === site.domain} onClick={() => void runCertbot(site.domain)}>
                            {httpsBlock ? "Renouveler" : "Activer HTTPS"}
                          </Button>
                        )}
                        <MenuButton
                          size="sm"
                          items={[
                            ...clientMenuItems(clients, site.domain, locks.isLocked(siteLock(site.domain)), () => locks.toggle(siteLock(site.domain))),
                            "separator" as const,
                            ...(state.certbot && !isDefault ? [{ label: httpsBlock ? "Relancer certbot pour ce domaine…" : "Activer HTTPS (certbot)…", icon: <Lock size={14} />, onClick: () => void runCertbot(site.domain) }] : []),
                            { label: "Historique des configurations…", icon: <History size={14} />, onClick: () => setHistory(true) },
                            ...(link
                              ? [
                                  "separator" as const,
                                  {
                                    label: "Désactiver le site…",
                                    icon: <PowerOff size={14} />,
                                    danger: true,
                                    onClick: async () => {
                                      const ok = await confirmDestructive({
                                        title: `Désactiver ${site.domain} ?`,
                                        body: `Le site ne sera plus servi par ${web}. Sa configuration est conservée dans sites-available et peut être réactivée (filtre Désactivés de l'onglet Sites).`,
                                        confirmLabel: "Désactiver",
                                        name: site.domain,
                                        locked: locks.isLocked(siteLock(site.domain)),
                                      });
                                      if (ok) await runApply(`Désactivation de ${site.domain}`, () => api.sitesSetEnabled(serverId, site.file.realPath, link, false, engine));
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </span>
                    </div>
                  </Card>
                );
              }),
            ])}
          </div>
        )}

        {tab === "certificates" &&
          (state.certificates.length === 0 ? (
            <EmptyState icon={<Lock />} title="Aucun certificat">
              {state.certbot ? "Active HTTPS depuis la carte d'un site : certbot obtient et renouvelle le certificat." : "certbot n'est pas installé sur ce serveur."}
            </EmptyState>
          ) : (
            <Card padded={false} className="overflow-hidden">
              <DataTable
                rows={state.certificates}
                rowKey={(c) => c.path}
                initialSort={{ key: "expires", dir: "asc" }}
                columns={[
                  { key: "domains", header: "Domaines", width: "minmax(0,1.3fr)", sortValue: (c) => c.domains[0] ?? c.subject, render: (c) => <span>{c.domains.join(", ") || c.subject}</span> },
                  {
                    key: "expires",
                    header: "Expire",
                    width: "200px",
                    sortValue: (c) => c.notAfter,
                    render: (c) => {
                      const days = Math.floor((c.notAfter - Date.now() / 1000) / DAY);
                      return (
                        <span className="flex items-center gap-2">
                          <Badge tone={certTone(c)}>{days < 0 ? "expiré" : `dans ${days} j`}</Badge>
                          <span className="text-xs text-muted">{new Date(c.notAfter * 1000).toLocaleDateString("fr-FR")}</span>
                        </span>
                      );
                    },
                  },
                  { key: "issuer", header: "Émetteur", width: "minmax(0,0.8fr)", render: (c) => <span className="text-xs text-muted">{c.issuer.replace(/^.*O = /, "").replace(/,.*$/, "")}</span> },
                  { key: "path", header: "Fichier", render: (c) => <span className="font-mono text-[11px] text-faint">{c.path}</span> },
                ]}
                rowMenu={
                  state.certbot
                    ? (c) => [{ label: "Relancer certbot pour ce domaine…", icon: <RefreshCw size={14} />, disabled: !c.domains[0], onClick: () => c.domains[0] && void runCertbot(c.domains[0]) }]
                    : undefined
                }
              />
            </Card>
          ))}
      </div>

      <Suspense fallback={null}>
        {editing && <NginxEditor serverId={serverId} engine={engine} path={editing.realPath} onClose={() => setEditing(null)} onApplied={() => void load()} />}
        {wizard && <NewSiteWizard serverId={serverId} engine={engine} confRoot={state.confRoot} onClose={() => setWizard(false)} onDone={() => void load()} />}
        {history && <NginxHistory serverId={serverId} engine={engine} onClose={() => setHistory(false)} onRestored={() => void load()} />}
      </Suspense>
      {output && (
        <Modal title={output.title} width="max-w-3xl" onClose={() => setOutput(null)}>
          <ResultBanner tone={output.ok ? "ok" : "danger"} title={output.ok ? "Terminé" : "Échec : rien n'a été modifié"}>
            <pre className="max-h-[55vh] overflow-auto font-mono text-xs whitespace-pre-wrap">{output.text}</pre>
          </ResultBanner>
        </Modal>
      )}
    </PageLayout>
  );
}

/** Étape de la chaîne d'un site (domaine → serveur web → cible → conteneur). */
function ChainNode({ label, value, mono, dot, dashed, warn }: { label: string; value: string; mono?: boolean; dot?: "ok" | "danger"; dashed?: boolean; warn?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-px rounded-lg border bg-subtle px-2.5 py-1.5 ${dashed ? "border-dashed" : ""} ${warn ? "border-warn/50" : "border-border"}`}>
      <span className="text-[10px] text-faint">{label}</span>
      <span className={`flex min-w-0 items-center gap-1.5 ${mono ? "font-mono" : ""} ${warn ? "text-warn" : dashed ? "text-faint" : ""}`}>
        {dot && <span className={`size-1.5 shrink-0 rounded-full ${dot === "ok" ? "bg-ok" : "bg-danger"}`} />}
        <span className="truncate" title={value}>
          {value}
        </span>
      </span>
    </div>
  );
}

/** DNS du domaine (pointe-t-il vers ce serveur ?) et expiration de son enregistrement. */
function DomainBadges({ info }: { info?: DomainInfo }) {
  if (!info) return null;
  const days = info.expires ? Math.floor((Date.parse(info.expires) - Date.now()) / 86_400_000) : null;
  const dnsBadge =
    info.dns === "ok" ? null : (
      <span title={`${info.dnsDetail}${info.ips.length ? ` (${info.ips.join(", ")})` : ""}`}>
        <Badge tone={info.dns === "missing" ? "danger" : "warn"}>{info.dns === "missing" ? "DNS absent" : info.dns === "elsewhere" ? "DNS ailleurs" : "DNS ?"}</Badge>
      </span>
    );
  return (
    <>
      {dnsBadge}
      {days !== null && days < 60 && (
        <span title={`${info.registrable} expire le ${new Date(info.expires!).toLocaleDateString("fr-FR")} : pense à le renouveler chez ton registrar`}>
          <Badge tone={days < 15 ? "danger" : "warn"}>{days < 0 ? "domaine expiré" : `domaine ${days} j`}</Badge>
        </span>
      )}
    </>
  );
}
