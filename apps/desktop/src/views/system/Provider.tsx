// Hébergeur : alimentation du serveur via l'API du fournisseur, sans passer par SSH.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Power, PowerOff, RefreshCw, RotateCw, Zap } from "lucide-react";
import { api, errorMessage, type ProviderAction, type ProviderKind, type ProviderStatus, type ProviderView } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, ErrorState, FOCUS_RING, Field, IconButton, Input, Loading, Section, StatusDot, type Tone } from "../../components/ui";
import { PowerRow } from "./Overview";

const KINDS: { value: ProviderKind; label: string; mark: string; color: string; creds: string }[] = [
  { value: "hetzner", label: "Hetzner Cloud", mark: "H", color: "#e5484d", creds: "Jeton d'API" },
  { value: "scaleway", label: "Scaleway", mark: "S", color: "#a35cf0", creds: "Clé secrète et zone" },
  { value: "digitalOcean", label: "DigitalOcean", mark: "DO", color: "#2f8cff", creds: "Jeton d'API" },
  { value: "ovh", label: "OVH (VPS)", mark: "OVH", color: "#4f7cff", creds: "Trois clés d'API" },
];
const STATE: Record<ProviderStatus["state"], [string, Tone]> = {
  running: ["en marche", "ok"],
  off: ["éteint", "danger"],
  starting: ["démarrage", "warn"],
  stopping: ["arrêt en cours", "warn"],
  unknown: ["inconnu", "muted"],
};
const ZONE: Partial<Record<ProviderKind, [string, string]>> = { scaleway: ["Zone", "fr-par-1"], ovh: ["Région de l'API", "ovh-eu"] };

export default function Provider({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { ask, notify } = useApp.getState();
  const [view, setView] = useState<ProviderView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<ProviderKind>("hetzner");
  const [ref, setRef] = useState("");
  const [zone, setZone] = useState("");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [consumer, setConsumer] = useState("");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ovh = kind === "ovh";

  const ready = (v: ProviderView | null) => !!v?.link && v.hasToken && (v.link.kind !== "ovh" || (v.hasSecret && v.hasConsumer));

  /** État chez l'hébergeur ; une erreur reste affichée à côté de la pastille, sans toast. */
  const test = useCallback(async () => {
    setBusy("status");
    try {
      setStatus(await api.providerTest(serverId));
      setStatusError(null);
    } catch (e) {
      setStatus(null);
      setStatusError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [serverId]);

  const load = useCallback(async () => {
    try {
      const v = await api.providerGet(serverId);
      setView(v);
      setLoadError(null);
      if (v.link) {
        setKind(v.link.kind);
        setRef(v.link.serverRef);
        setZone(v.link.zone ?? "");
      }
      return v;
    } catch (e) {
      setLoadError(errorMessage(e));
      return null;
    }
  }, [serverId]);

  useEffect(() => {
    void load().then((v) => ready(v) && void test());
  }, [load, test]);

  /** Exécute un appel à l'hébergeur en gardant le bouton occupé. */
  const call = async (label: string, fn: () => Promise<ProviderStatus | void>, ok?: string) => {
    setBusy(label);
    try {
      const r = await fn();
      if (r) setStatus(r);
      if (ok) notify(ok, "success");
      return true;
    } catch (e) {
      notify(errorMessage(e), "error");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const done = await call(
      "save",
      async () => {
        // Champ vide = inchangé ; les secrets déjà enregistrés ne sont jamais relus.
        await api.providerSet(serverId, { kind, serverRef: ref.trim(), zone: zone.trim() || null }, {
          token: token || undefined,
          secret: secret || undefined,
          consumer: consumer || undefined,
        });
        setToken("");
        setSecret("");
        setConsumer("");
      },
      "Hébergeur enregistré",
    );
    if (done && ready(await load())) void test();
  };

  const unlink = async () => {
    if (!(await ask({ title: "Délier l'hébergeur ?", body: "Les identifiants enregistrés pour ce serveur seront supprimés du coffre.", confirmLabel: "Délier", danger: true }))) return;
    await call("unlink", async () => {
      await api.providerSet(serverId, null, {});
      setRef("");
      setZone("");
      setStatus(null);
      setStatusError(null);
      await load();
    });
  };

  const act = async (action: ProviderAction, confirm: string, body: string, ok: string) => {
    if (!(await ask({ title: `${confirm} ?`, body, confirmLabel: confirm, danger: true }))) return;
    await call(action, () => api.providerAction(serverId, action), ok);
  };

  if (loadError && !view) return <ErrorState message={loadError} onRetry={() => void load()} />;
  if (!view) return <Loading rows={4} />;

  const linkedKind = view.link?.kind;
  const sameKind = linkedKind === kind;
  const [label, tone] = status ? STATE[status.state] : ["", "muted" as Tone];

  return (
    // Grand écran : choix et identifiants à gauche, état et alimentation à droite.
    <div className="grid min-w-0 items-start gap-5 @5xl:grid-cols-2">
      <div className="@container flex min-w-0 flex-col gap-5">
        <Section title="Fournisseur" description="Pilote l'alimentation par l'API, même quand SSH ne répond plus">
          <div role="radiogroup" aria-label="Fournisseur" className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
            {KINDS.map((k) => {
              const on = k.value === kind;
              return (
                <button
                  key={k.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setKind(k.value)}
                  className={`flex min-w-0 items-center gap-3 rounded-xl border bg-panel px-3.5 py-3 text-left transition-colors ${FOCUS_RING} ${
                    on ? "border-accent ring-1 ring-accent/50" : "border-border hover:border-border-strong"
                  }`}
                >
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-[28%] text-[11px] font-bold tracking-tight"
                    style={{ background: `color-mix(in srgb, ${k.color} 16%, transparent)`, color: k.color }}
                  >
                    {k.mark}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-medium">{k.label}</span>
                    <span className="truncate text-[11.5px] text-faint">{k.creds}</span>
                  </span>
                  {linkedKind === k.value && (
                    <Badge tone="ok" className="ml-auto">
                      lié
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Identifiants" description="Gardés dans le coffre, jamais réaffichés">
          <Card className="flex flex-col gap-4">
            <form
              className="grid gap-3 @xl:grid-cols-2"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                if (ref.trim()) void save();
              }}
            >
              <Field label={ovh ? "Nom du service" : "Identifiant du serveur"} hint={ovh ? "Par exemple vps-1234.vps.ovh.net" : "Visible dans la console de l'hébergeur"}>
                <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={ovh ? "vps-1234.vps.ovh.net" : "123456"} />
              </Field>
              {ZONE[kind] && (
                <Field label={ZONE[kind]![0]}>
                  <Input value={zone} onChange={(e) => setZone(e.target.value)} placeholder={ZONE[kind]![1]} />
                </Field>
              )}
              <Secret label={ovh ? "Clé d'application" : "Jeton d'API"} stored={sameKind && view.hasToken} value={token} onChange={setToken} />
              {ovh && (
                <>
                  <Secret label="Secret d'application" stored={sameKind && view.hasSecret} value={secret} onChange={setSecret} />
                  <Secret label="Clé de consommateur" stored={sameKind && view.hasConsumer} value={consumer} onChange={setConsumer} />
                </>
              )}
              <button type="submit" hidden />
            </form>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button variant="primary" loading={busy === "save"} disabled={!ref.trim()} onClick={() => void save()}>
                Enregistrer
              </Button>
              <Button loading={busy === "status"} disabled={!ready(view)} onClick={() => void test()} title={ready(view) ? "Lit l'état du serveur chez l'hébergeur" : "Enregistre d'abord l'identifiant et les clés"}>
                Tester la connexion
              </Button>
              {view.link && (
                <Button variant="ghost" className="ml-auto" loading={busy === "unlink"} onClick={() => void unlink()}>
                  Délier
                </Button>
              )}
            </div>
          </Card>
        </Section>
      </div>

      <Section
        title="Alimentation via l'hébergeur"
        actions={
          ready(view) && (
            <span className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
              {status ? (
                <Badge tone={tone} title={status.state === "unknown" ? status.raw : undefined}>
                  <StatusDot tone={tone} pulse={status.state === "starting" || status.state === "stopping"} />
                  {label}
                </Badge>
              ) : statusError ? (
                <Badge tone="danger" title={statusError}>
                  injoignable
                </Badge>
              ) : (
                busy === "status" && <span>lecture de l'état…</span>
              )}
              <IconButton size="sm" title="Relire l'état" disabled={busy === "status"} onClick={() => void test()}>
                <RefreshCw size={13} className={busy === "status" ? "animate-spin" : ""} />
              </IconButton>
            </span>
          )
        }
      >
        {!ready(view) ? (
          <Card className="text-[13px] text-muted">Enregistre l'identifiant du serveur et ses clés d'API pour redémarrer, allumer ou éteindre {serverName} sans SSH.</Card>
        ) : (
          <>
            {statusError && <ErrorState message={statusError} onRetry={() => void test()} />}
            <Card padded={false} tone="danger" className="divide-y divide-border">
              <PowerRow icon={<RotateCw size={16} />} title="Redémarrer" text="Redémarrage logiciel demandé à l'hébergeur.">
                <ActionButton icon={<RotateCw size={14} />} busy={busy === "reboot"} onClick={() => void act("reboot", "Redémarrer", `Demande à l'hébergeur un redémarrage logiciel de ${serverName}.`, "Redémarrage demandé")}>
                  Redémarrer…
                </ActionButton>
              </PowerRow>
              <PowerRow icon={<Zap size={16} />} title="Reset forcé" text="Coupe et rallume sans arrêt propre, quand le système est bloqué.">
                <ActionButton icon={<Zap size={14} />} busy={busy === "reset"} onClick={() => void act("reset", "Reset forcé", `Coupe et rallume ${serverName} sans arrêt propre : risque de perte de données. Chez Scaleway et OVH, c'est un simple redémarrage.`, "Reset demandé")}>
                  Reset forcé…
                </ActionButton>
              </PowerRow>
              <PowerRow icon={<Power size={16} />} title="Allumer" text="Démarre le serveur s'il est éteint.">
                <ActionButton icon={<Power size={14} />} busy={busy === "powerOn"} disabled={status?.state === "running"} onClick={() => void act("powerOn", "Allumer", `Allume ${serverName} chez l'hébergeur.`, "Démarrage demandé")}>
                  Allumer…
                </ActionButton>
              </PowerRow>
              <PowerRow icon={<PowerOff size={16} className="text-danger" />} title="Éteindre" text="Il ne répondra plus tant qu'il ne sera pas rallumé.">
                <ActionButton danger icon={<PowerOff size={14} />} busy={busy === "powerOff"} disabled={status?.state === "off"} onClick={() => void act("powerOff", "Éteindre", `Éteint ${serverName} chez l'hébergeur. Il ne répondra plus tant qu'il ne sera pas rallumé.`, "Extinction demandée")}>
                  Éteindre…
                </ActionButton>
              </PowerRow>
            </Card>
          </>
        )}
      </Section>
    </div>
  );
}

/** Champ secret en écriture seule : vide = valeur enregistrée conservée. */
function Secret({ label, stored, value, onChange }: { label: string; stored: boolean; value: string; onChange: (v: string) => void }) {
  return (
    <Field
      label={
        <span className="flex items-center gap-1.5">
          {label}
          {stored && (
            <Badge tone="ok">
              <Check size={11} strokeWidth={3} />
              configuré
            </Badge>
          )}
        </span>
      }
      hint={stored ? "Laisse vide pour conserver la valeur enregistrée" : undefined}
    >
      <Input type="password" autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} placeholder={stored ? "••••••••••••" : ""} />
    </Field>
  );
}

function ActionButton({ danger, busy, ...rest }: { danger?: boolean; busy: boolean; icon: ReactNode; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <Button variant={danger ? "danger" : "outline"} loading={busy} {...rest} />;
}
