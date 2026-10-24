// Tiroir « Alertes » : l'agent zenyttd (installer, mettre à jour, désinstaller), ses règles, les sites
// surveillés, les canaux (Discord, ntfy, webhook, test), les notifications Windows et le journal.
import { useEffect, useState } from "react";
import { BellRing, CheckCircle2, Download, OctagonAlert, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage, type AgentConfig, type AgentInfo, type AlertMetric } from "../../lib/api";
import { useApp, useAppPick } from "../../lib/store";
import { Badge, Button, Checkbox, Drawer, ErrorState, Field, IconButton, Input, Loading, Select } from "../../components/ui";

const METRICS: { id: AlertMetric; label: string; unit: string }[] = [
  { id: "cpu", label: "CPU", unit: "%" },
  { id: "memory", label: "Mémoire", unit: "%" },
  { id: "disk", label: "Disque", unit: "%" },
  { id: "load", label: "Charge (1 min)", unit: "" },
];

export default function AlertsDrawer({ serverId, agent, reload, onClose }: { serverId: string; agent: AgentInfo | null; reload: () => Promise<void>; onClose: () => void }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const winNotify = useApp((s) => s.settings.alertNotifications);
  const setSettings = useApp((s) => s.setSettings);
  const [busy, setBusy] = useState<string | null>(null);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);

  useEffect(() => {
    setCfg(agent?.status ? structuredClone(agent.status.config) : null);
  }, [agent]);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) notify(success, "success");
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const install = () =>
    run("install", async () => {
      const out = await api.agentInstall(serverId);
      notify(`Agent installé (${out.trim().split("\n").pop()})`, "success");
    });

  const uninstall = async () => {
    const ok = await ask({
      title: "Désinstaller l'agent zenyttd ?",
      body: "Le service, sa configuration et tout l'historique des métriques seront supprimés du serveur.",
      confirmLabel: "Désinstaller",
      danger: true,
    });
    if (ok) await run("uninstall", () => api.agentUninstall(serverId), "Agent désinstallé");
  };

  const winToggle = (
    <Checkbox checked={winNotify} onChange={(v) => setSettings({ alertNotifications: v })} label="Notifications Windows (Zenytt ouvert)" hint="Nouvelles alertes des serveurs connectés, sans agent requis pour l'affichage." />
  );

  if (!agent)
    return (
      <Drawer title="Alertes" width={880} onClose={onClose}>
        <Loading label="Vérification de l'agent…" />
      </Drawer>
    );

  if (!agent.installed || !agent.running) {
    return (
      <Drawer title="Alertes" subtitle={agent.installed ? "agent zenyttd installé mais muet" : "agent zenyttd absent"} width={880} onClose={onClose}>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-3">
              <ShieldCheck size={26} className="shrink-0 text-accent" />
              <div>
                <h3 className="font-semibold">{agent.installed ? "L'agent zenyttd ne répond pas" : "Installer l'agent zenyttd"}</h3>
                <p className="text-sm text-muted">Historique sur 30 jours et alertes, même quand ton PC est éteint.</p>
              </div>
            </div>
            {agent.error && <pre className="rounded-lg border border-warn/35 bg-warn/8 p-3 font-mono text-xs whitespace-pre-wrap text-warn">{agent.error}</pre>}
            <div className="flex gap-2">
              <Button variant="primary" icon={<Download size={14} />} loading={busy === "install"} onClick={() => void install()}>
                {agent.installed ? "Réinstaller et redémarrer" : "Installer l'agent"}
              </Button>
              {agent.installed && (
                <Button variant="ghost" loading={busy === "uninstall"} onClick={() => void uninstall()}>
                  Désinstaller
                </Button>
              )}
            </div>
            <div className="mt-2 border-t border-border pt-3">{winToggle}</div>
          </section>
          <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-subtle p-4">
            <h3 className="text-[13px] font-semibold">Ce qui est installé</h3>
            <ul className="flex flex-col gap-1.5 text-[13px] text-muted">
              <li>• Binaire statique d'environ 2 Mo, installé dans /usr/local/bin/zenyttd.</li>
              <li>• Tourne sous un utilisateur système dédié, avec un service systemd durci et limité à 64 Mo de RAM.</li>
              <li>
                • N'ouvre <strong className="text-fg">aucun port</strong> : il ne répond que sur un socket local, joint à travers ta connexion SSH.
              </li>
              <li>• Ne touche ni à nginx, ni à Docker, ni à tes sites.</li>
            </ul>
            <p className="text-xs text-faint">Nécessite les droits root : connexion en root ou mot de passe sudo renseigné dans le profil du serveur.</p>
          </section>
        </div>
      </Drawer>
    );
  }

  const st = agent.status!;
  if (!cfg) return null;
  const set = (patch: Partial<AgentConfig>) => setCfg({ ...cfg, ...patch });
  const dirty = JSON.stringify(cfg) !== JSON.stringify(st.config);

  return (
    <Drawer
      title="Alertes"
      subtitle={
        <span className="flex items-center gap-1.5">
          <CheckCircle2 size={13} className="text-ok" />
          zenyttd {st.version} actif sur <span className="font-mono">{st.hostname}</span> · démarré le {new Date(st.startedAt).toLocaleString("fr-FR")}
        </span>
      }
      width={880}
      onClose={onClose}
      actions={
        <>
          <Button size="sm" loading={busy === "install"} onClick={() => void install()}>
            Mettre à jour l'agent
          </Button>
          <Button size="sm" variant="ghost" loading={busy === "uninstall"} onClick={() => void uninstall()}>
            Désinstaller
          </Button>
        </>
      }
      footer={
        <>
          {dirty && <span className="mr-auto text-xs text-muted">Modifications non enregistrées : l'agent les applique dans les secondes qui suivent.</span>}
          <Button variant="ghost" disabled={!dirty} onClick={() => setCfg(structuredClone(st.config))}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Save size={14} />} disabled={!dirty} loading={busy === "save"} onClick={() => void run("save", () => api.agentSaveConfig(serverId, cfg), "Configuration enregistrée")}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {st.configError && <ErrorState message={st.configError} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-panel p-4 lg:col-span-2">
          <h3 className="mb-1 text-[13px] font-semibold">Règles d'alerte</h3>
          <p className="mb-3 text-xs text-muted">Une alerte part quand le seuil est dépassé pendant toute la durée indiquée, puis un message « résolu » quand ça redescend.</p>
          <div className="flex flex-col gap-2">
            {cfg.rules.map((r, i) => {
              const upd = (patch: Partial<typeof r>) => set({ rules: cfg.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              const unit = METRICS.find((m) => m.id === r.metric)?.unit;
              return (
                <div key={i} className={`flex flex-wrap items-center gap-2 text-[13px] ${r.enabled ? "" : "opacity-60"}`}>
                  <span title="Activer la règle">
                    <Checkbox checked={r.enabled} onChange={(v) => upd({ enabled: v })} />
                  </span>
                  <Select<AlertMetric> className="w-40" value={r.metric} onChange={(v) => upd({ metric: v })} options={METRICS.map((m) => ({ value: m.id, label: m.label }))} aria-label="Mesure" />
                  <span className="text-muted">&gt;</span>
                  <Input className="!w-20" type="number" value={r.threshold} onChange={(e) => upd({ threshold: Number(e.target.value) })} />
                  <span className="w-3 text-muted">{unit}</span>
                  <span className="text-muted">pendant</span>
                  <Input className="!w-20" type="number" value={Math.round(r.forSecs / 60)} onChange={(e) => upd({ forSecs: Number(e.target.value) * 60 })} />
                  <span className="text-muted">min</span>
                  <IconButton title="Supprimer la règle" className="ml-auto" onClick={() => set({ rules: cfg.rules.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              );
            })}
            <Button size="sm" variant="ghost" className="self-start" icon={<Plus size={13} />} onClick={() => set({ rules: [...cfg.rules, { metric: "cpu", threshold: 90, forSecs: 300, enabled: true }] })}>
              Ajouter une règle
            </Button>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-panel p-4">
          <h3 className="mb-1 text-[13px] font-semibold">Sites surveillés</h3>
          <p className="mb-3 text-xs text-muted">
            L'agent appelle chaque URL toutes les {cfg.httpCheckIntervalSecs} s et alerte après 2 échecs consécutifs (erreur réseau ou code HTTP ≥ 400).
          </p>
          <div className="flex flex-col gap-2">
            {cfg.httpChecks.map((c, i) => {
              const upd = (patch: Partial<typeof c>) => set({ httpChecks: cfg.httpChecks.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className={`flex items-center gap-2 ${c.enabled ? "" : "opacity-60"}`}>
                  <span title="Activer la vérification">
                    <Checkbox checked={c.enabled} onChange={(v) => upd({ enabled: v })} />
                  </span>
                  <Input className="!w-36" placeholder="Nom" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                  <Input className="font-mono text-xs" placeholder="https://monsite.fr" value={c.url} onChange={(e) => upd({ url: e.target.value })} />
                  <IconButton title="Retirer" onClick={() => set({ httpChecks: cfg.httpChecks.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              );
            })}
            <Button size="sm" variant="ghost" className="self-start" icon={<Plus size={13} />} onClick={() => set({ httpChecks: [...cfg.httpChecks, { name: "", url: "https://", enabled: true }] })}>
              Ajouter un site
            </Button>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-panel p-4">
          <h3 className="mb-3 text-[13px] font-semibold">Canaux de notification</h3>
          <div className="flex flex-col gap-3">
            <Field label="Nom du serveur dans les messages" hint={`Par défaut : ${st.hostname}`}>
              <Input value={cfg.serverName ?? ""} onChange={(e) => set({ serverName: e.target.value || null })} />
            </Field>
            <Field label="Webhook Discord" hint="Paramètres du salon → Intégrations → Webhooks → Copier l'URL.">
              <Input className="font-mono text-xs" placeholder="https://discord.com/api/webhooks/…" value={cfg.notifiers.discordWebhook ?? ""} onChange={(e) => set({ notifiers: { ...cfg.notifiers, discordWebhook: e.target.value || null } })} />
            </Field>
            <Field label="ntfy (notifications push sur téléphone)" hint="Installe l'app ntfy, abonne-toi à un nom de topic difficile à deviner, et colle ici son URL.">
              <Input className="font-mono text-xs" placeholder="https://ntfy.sh/mon-topic-secret" value={cfg.notifiers.ntfyUrl ?? ""} onChange={(e) => set({ notifiers: { ...cfg.notifiers, ntfyUrl: e.target.value || null } })} />
            </Field>
            <Field label="Webhook générique (POST JSON)">
              <Input className="font-mono text-xs" placeholder="https://…" value={cfg.notifiers.webhookUrl ?? ""} onChange={(e) => set({ notifiers: { ...cfg.notifiers, webhookUrl: e.target.value || null } })} />
            </Field>
            <Button
              size="sm"
              className="self-start"
              icon={<BellRing size={13} />}
              loading={busy === "test"}
              disabled={dirty}
              title={dirty ? "Enregistre d'abord la configuration" : undefined}
              onClick={() => void run("test", async () => notify(await api.agentTestNotify(serverId), "success"))}
            >
              Envoyer une notification de test
            </Button>
            <div className="border-t border-border pt-3">{winToggle}</div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-panel p-4 lg:col-span-2">
          <h3 className="mb-3 text-[13px] font-semibold">Journal des alertes</h3>
          {st.recentEvents.length === 0 ? (
            <p className="text-sm text-muted">Aucune alerte pour l'instant.</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-2 overflow-auto">
              {st.recentEvents.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  {e.resolved ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" /> : <OctagonAlert size={14} className="mt-0.5 shrink-0 text-danger" />}
                  <div className="min-w-0">
                    <div className="truncate">{e.title}</div>
                    <div className="text-xs text-muted">
                      {new Date(e.t).toLocaleString("fr-FR")} · {e.message}
                    </div>
                  </div>
                  <Badge tone={e.resolved ? "ok" : "danger"}>{e.resolved ? "résolu" : "alerte"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      </div>
    </Drawer>
  );
}
