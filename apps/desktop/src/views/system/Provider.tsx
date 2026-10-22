// Hébergeur : alimentation du serveur via l'API du fournisseur, sans passer par SSH.
import { useCallback, useEffect, useState } from "react";
import { Power, PowerOff, RotateCw, Zap } from "lucide-react";
import { api, errorMessage, type ProviderAction, type ProviderKind, type ProviderStatus, type ProviderView } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, Field, Input, Section, Select, type Tone } from "../../components/ui";

const KINDS: { value: ProviderKind; label: string }[] = [
  { value: "hetzner", label: "Hetzner Cloud" },
  { value: "scaleway", label: "Scaleway" },
  { value: "digitalOcean", label: "DigitalOcean" },
  { value: "ovh", label: "OVH (VPS)" },
];
const STATE: Record<ProviderStatus["state"], [string, Tone]> = {
  running: ["en marche", "ok"],
  off: ["éteint", "danger"],
  starting: ["démarrage", "warn"],
  stopping: ["arrêt en cours", "warn"],
  unknown: ["inconnu", "muted"],
};
const ZONE_LABEL: Partial<Record<ProviderKind, string>> = { scaleway: "Zone (fr-par-1)", ovh: "Région de l'API (ovh-eu, ovh-ca, ovh-us)" };

export default function Provider({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { ask, notify } = useApp.getState();
  const [view, setView] = useState<ProviderView | null>(null);
  const [kind, setKind] = useState<ProviderKind>("hetzner");
  const [ref, setRef] = useState("");
  const [zone, setZone] = useState("");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [consumer, setConsumer] = useState("");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ovh = kind === "ovh";

  const load = useCallback(async () => {
    try {
      const v = await api.providerGet(serverId);
      setView(v);
      if (v.link) {
        setKind(v.link.kind);
        setRef(v.link.serverRef);
        setZone(v.link.zone ?? "");
      }
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [serverId, notify]);
  useEffect(() => void load(), [load]);

  /** Exécute un appel à l'hébergeur en gardant le bouton occupé. */
  const call = async (label: string, fn: () => Promise<ProviderStatus | void>, ok?: string) => {
    setBusy(label);
    try {
      const r = await fn();
      if (r) setStatus(r);
      if (ok) notify(ok, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    call("save", async () => {
      // Champ vide = inchangé ; les secrets déjà enregistrés ne sont jamais relus.
      await api.providerSet(serverId, { kind, serverRef: ref.trim(), zone: zone.trim() || null }, {
        token: token || undefined,
        secret: secret || undefined,
        consumer: consumer || undefined,
      });
      setToken("");
      setSecret("");
      setConsumer("");
      await load();
    }, "Hébergeur enregistré");

  const unlink = async () => {
    if (!(await ask({ title: "Délier l'hébergeur ?", body: "Les identifiants enregistrés pour ce serveur seront supprimés du coffre.", confirmLabel: "Délier", danger: true }))) return;
    await call("unlink", async () => {
      await api.providerSet(serverId, null, {});
      setRef("");
      setZone("");
      setStatus(null);
      await load();
    });
  };

  const act = async (action: ProviderAction, title: string, body: string, ok: string) => {
    if (!(await ask({ title, body, confirmLabel: title.replace(/ \?$/, ""), danger: true }))) return;
    await call(action, () => api.providerAction(serverId, action), ok);
  };

  const linked = !!view?.link;
  const hasCreds = view ? view.hasToken && (!ovh || (view.hasSecret && view.hasConsumer)) : false;
  const [label, tone] = status ? STATE[status.state] : ["", "muted" as Tone];

  return (
    <Section title="Hébergeur" description="Pilote l'alimentation par l'API du fournisseur, même quand SSH ne répond plus">
      <Card className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Fournisseur">
            <Select value={kind} onChange={setKind} options={KINDS} />
          </Field>
          <Field label={ovh ? "Nom du service (vps-1234.vps.ovh.net)" : "Identifiant du serveur"}>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={ovh ? "vps-1234.vps.ovh.net" : "123456"} />
          </Field>
          {ZONE_LABEL[kind] && (
            <Field label={ZONE_LABEL[kind]}>
              <Input value={zone} onChange={(e) => setZone(e.target.value)} placeholder={ovh ? "ovh-eu" : "fr-par-1"} />
            </Field>
          )}
          <Field label={ovh ? "Clé d'application" : "Jeton d'API"} hint={view?.hasToken ? "Enregistré — laisse vide pour le conserver" : undefined}>
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          {ovh && (
            <>
              <Field label="Secret d'application" hint={view?.hasSecret ? "Enregistré — laisse vide pour le conserver" : undefined}>
                <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </Field>
              <Field label="Clé de consommateur" hint={view?.hasConsumer ? "Enregistrée — laisse vide pour la conserver" : undefined}>
                <Input type="password" autoComplete="off" value={consumer} onChange={(e) => setConsumer(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={busy === "save"} disabled={!ref.trim()} onClick={() => void save()}>
            Enregistrer
          </Button>
          <Button loading={busy === "status"} disabled={!linked || !hasCreds} onClick={() => void call("status", () => api.providerTest(serverId))}>
            Tester
          </Button>
          {linked && (
            <Button variant="ghost" onClick={() => void unlink()}>
              Délier
            </Button>
          )}
          {status && (
            <span className="flex items-center gap-2 text-[13px] text-muted">
              État chez l'hébergeur <Badge tone={tone}>{label}</Badge>
              {status.state === "unknown" && <span className="text-faint">({status.raw})</span>}
            </span>
          )}
        </div>
        {linked && hasCreds && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button icon={<RotateCw size={14} />} loading={busy === "reboot"} onClick={() => void act("reboot", "Redémarrer (API) ?", `Demande à l'hébergeur un redémarrage logiciel de ${serverName}.`, "Redémarrage demandé")}>
              Redémarrer (API)
            </Button>
            <Button icon={<Zap size={14} />} loading={busy === "reset"} onClick={() => void act("reset", "Reset forcé ?", `Coupe et rallume ${serverName} sans arrêt propre : risque de perte de données. Chez Scaleway et OVH, c'est un simple redémarrage.`, "Reset demandé")}>
              Reset forcé
            </Button>
            <Button icon={<Power size={14} />} loading={busy === "powerOn"} onClick={() => void act("powerOn", "Allumer ?", `Allume ${serverName} chez l'hébergeur.`, "Démarrage demandé")}>
              Allumer
            </Button>
            <Button variant="danger" icon={<PowerOff size={14} />} loading={busy === "powerOff"} onClick={() => void act("powerOff", "Éteindre (API) ?", `Éteint ${serverName} chez l'hébergeur. Il ne répondra plus tant qu'il ne sera pas rallumé.`, "Extinction demandée")}>
              Éteindre
            </Button>
          </div>
        )}
      </Card>
    </Section>
  );
}
