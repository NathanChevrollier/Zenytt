// Hébergeur : alimentation du serveur via l'API du fournisseur, sans passer par SSH.
// `useProvider` porte l'état (lien, état du serveur, actions) partagé entre la puce de l'en-tête,
// le bloc Alimentation de la vue d'ensemble et le tiroir de configuration.
import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, CircleCheck } from "lucide-react";
import { api, errorMessage, type ProviderAction, type ProviderKind, type ProviderStatus, type ProviderView } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, Drawer, ErrorState, FOCUS_RING, Field, Input, Loading, Section, type Tone } from "../../components/ui";

export const KINDS: { value: ProviderKind; label: string; mark: string; color: string; creds: string }[] = [
  { value: "hetzner", label: "Hetzner Cloud", mark: "H", color: "#e5484d", creds: "Jeton d'API" },
  { value: "scaleway", label: "Scaleway", mark: "S", color: "#a35cf0", creds: "Clé secrète et zone" },
  { value: "digitalOcean", label: "DigitalOcean", mark: "DO", color: "#2f8cff", creds: "Jeton d'API" },
  { value: "ovh", label: "OVH (VPS)", mark: "OVH", color: "#4f7cff", creds: "Trois clés d'API" },
];
export const STATE: Record<ProviderStatus["state"], [string, Tone]> = {
  running: ["en marche", "ok"],
  off: ["éteint", "danger"],
  starting: ["démarrage", "warn"],
  stopping: ["arrêt en cours", "warn"],
  unknown: ["inconnu", "muted"],
};
const ZONE: Partial<Record<ProviderKind, [string, string]>> = { scaleway: ["Zone", "fr-par-1"], ovh: ["Région de l'API", "ovh-eu"] };

const isReady = (v: ProviderView | null) => !!v?.link && v.hasToken && (v.link.kind !== "ovh" || (v.hasSecret && v.hasConsumer));

export type ProviderState = ReturnType<typeof useProvider>;

export function useProvider(serverId: string, serverName: string) {
  const { ask, notify } = useApp.getState();
  const [view, setView] = useState<ProviderView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** État chez l'hébergeur ; renvoie l'erreur éventuelle (le bouton « Tester » l'affiche). */
  const test = useCallback(async (): Promise<{ ok: true; status: ProviderStatus } | { ok: false; error: string }> => {
    setBusy("status");
    try {
      const s = await api.providerTest(serverId);
      setStatus(s);
      setStatusError(null);
      return { ok: true, status: s };
    } catch (e) {
      const msg = errorMessage(e);
      setStatus(null);
      setStatusError(msg);
      return { ok: false, error: msg };
    } finally {
      setBusy(null);
    }
  }, [serverId]);

  const load = useCallback(async () => {
    try {
      const v = await api.providerGet(serverId);
      setView(v);
      setLoadError(null);
      return v;
    } catch (e) {
      setLoadError(errorMessage(e));
      return null;
    }
  }, [serverId]);

  useEffect(() => {
    void load().then((v) => isReady(v) && void test());
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

  const act = async (action: PowerAction) => {
    const [confirm, body, ok] = ACTIONS[action](serverName);
    if (!(await ask({ title: `${confirm} ?`, body, confirmLabel: confirm, danger: true }))) return;
    await call(action, () => api.providerAction(serverId, action), ok);
  };

  return { view, loadError, status, statusError, busy, ready: isReady(view), load, test, call, act, setStatus, setStatusError };
}

type PowerAction = Exclude<ProviderAction, "status">;
const ACTIONS: Record<PowerAction, (name: string) => [string, string, string]> = {
  reboot: (n) => ["Redémarrer", `Demande à l'hébergeur un redémarrage logiciel de ${n}.`, "Redémarrage demandé"],
  reset: (n) => ["Reset forcé", `Coupe et rallume ${n} sans arrêt propre : risque de perte de données. Chez Scaleway et OVH, c'est un simple redémarrage.`, "Reset demandé"],
  powerOn: (n) => ["Allumer", `Allume ${n} chez l'hébergeur.`, "Démarrage demandé"],
  powerOff: (n) => ["Éteindre", `Éteint ${n} chez l'hébergeur. Il ne répondra plus tant qu'il ne sera pas rallumé.`, "Extinction demandée"],
};

/** Tiroir de configuration : fournisseur, identifiants (écriture seule), test et délier. */
export function ProviderDrawer({ serverId, serverName, provider, onClose }: { serverId: string; serverName: string; provider: ProviderState; onClose: () => void }) {
  const { ask } = useApp.getState();
  const { view, loadError, busy, load, test, call, setStatus, setStatusError } = provider;
  const [kind, setKind] = useState<ProviderKind>(view?.link?.kind ?? "hetzner");
  const [ref, setRef] = useState(view?.link?.serverRef ?? "");
  const [zone, setZone] = useState(view?.link?.zone ?? "");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [consumer, setConsumer] = useState("");
  /** Résultat du dernier test, affiché à côté du bouton jusqu'à ce qu'un champ change. */
  const [tested, setTested] = useState<{ ok: true; status: ProviderStatus } | { ok: false; error: string } | null>(null);
  const notify = useApp((s) => s.notify);
  const ovh = kind === "ovh";
  useEffect(() => setTested(null), [kind, ref, zone, token, secret, consumer]);
  const link = view?.link;
  useEffect(() => {
    if (!link) return;
    setKind(link.kind);
    setRef(link.serverRef);
    setZone(link.zone ?? "");
  }, [link]);

  const manualTest = async () => {
    const r = await test();
    setTested(r);
    if (r.ok) notify(`Connexion réussie${r.status.name ? ` : ${r.status.name}` : ""} (${STATE[r.status.state][0]})`, "success");
    else notify(`Test de l'hébergeur : ${r.error}`, "error");
  };

  const save = async () => {
    const done = await call(
      "save",
      async () => {
        // Champ vide = inchangé ; les secrets déjà enregistrés ne sont jamais relus.
        await api.providerSet(serverId, { kind, serverRef: ref.trim(), zone: zone.trim() || null }, { token: token || undefined, secret: secret || undefined, consumer: consumer || undefined });
        setToken("");
        setSecret("");
        setConsumer("");
      },
      "Hébergeur enregistré",
    );
    if (done && isReady(await load())) void test();
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

  const linkedKind = view?.link?.kind;
  const sameKind = linkedKind === kind;

  return (
    <Drawer title="Hébergeur" subtitle={`Pilote l'alimentation de ${serverName} par l'API, même quand SSH ne répond plus`} width={640} onClose={onClose}>
      {loadError && !view ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : !view ? (
        <Loading rows={4} />
      ) : (
        <div className="flex flex-col gap-5">
          <Section title="Fournisseur">
            <div role="radiogroup" aria-label="Fournisseur" className="grid grid-cols-2 gap-2">
              {KINDS.map((k) => {
                const on = k.value === kind;
                return (
                  <button
                    key={k.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setKind(k.value)}
                    className={`flex min-w-0 items-center gap-3 rounded-xl border bg-panel px-3.5 py-3 text-left transition-colors ${FOCUS_RING} ${on ? "border-accent ring-1 ring-accent/50" : "border-border hover:border-border-strong"}`}
                  >
                    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[28%] text-[11px] font-bold tracking-tight" style={{ background: `color-mix(in srgb, ${k.color} 16%, transparent)`, color: k.color }}>
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
                className="grid gap-3 sm:grid-cols-2"
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
                <Button loading={busy === "status"} disabled={!isReady(view)} onClick={() => void manualTest()} title={isReady(view) ? "Lit l'état du serveur chez l'hébergeur" : "Enregistre d'abord l'identifiant et les clés"}>
                  Tester la connexion
                </Button>
                <span role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-xs">
                  {busy === "status" && !tested ? (
                    <span className="text-muted">Interrogation de l'API…</span>
                  ) : tested?.ok ? (
                    <>
                      <CircleCheck size={14} className="shrink-0 text-ok" />
                      <span className="truncate">
                        {KINDS.find((k) => k.value === linkedKind)?.label}
                        {tested.status.name && (
                          <>
                            {" · "}
                            <span className="font-medium">{tested.status.name}</span>
                          </>
                        )}
                        {` · ${STATE[tested.status.state][0]}`}
                      </span>
                    </>
                  ) : tested ? (
                    <>
                      <CircleAlert size={14} className="shrink-0 text-danger" />
                      <span className="truncate text-danger" title={tested.error}>
                        {tested.error}
                      </span>
                    </>
                  ) : null}
                </span>
                {view.link && (
                  <Button variant="ghost" className="ml-auto" loading={busy === "unlink"} onClick={() => void unlink()}>
                    Délier
                  </Button>
                )}
              </div>
            </Card>
          </Section>
        </div>
      )}
    </Drawer>
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
