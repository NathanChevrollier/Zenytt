// Alimentation : un seul bloc, par SSH (redémarrer, programmer, éteindre, avec l'attente du retour)
// et par l'hébergeur (état, redémarrage API, reset forcé, allumer, éteindre), utilisable SSH coupé.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, errorMessage, formatDuration, type SystemInfo } from "../../lib/api";
import { formatAt } from "../../lib/system";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, Field, IconButton, Input, Meter, Modal, Segmented, StatusDot, type Tone } from "../../components/ui";
import { KINDS, STATE, type ProviderState } from "./Provider";

type PowerKind = "reboot" | "poweroff";
export type PowerModalMode = PowerKind | "schedule";
/** Délai d'attente du retour, en secondes (celui de `systemWaitOnline`). */
const WAIT_TIMEOUT = 600;

/** Actions d'alimentation par SSH, partagées entre le bloc Alimentation et « À traiter ». */
export function usePower(serverId: string, name: string, info: SystemInfo | null, reload: () => Promise<void>) {
  const { notify, refreshServers } = useApp.getState();
  const [modal, setModal] = useState<PowerModalMode | null>(null);
  const [waitStart, setWaitStart] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Chaque attente a son numéro : « Arrêter d'attendre » rend la réponse en cours caduque.
  const waitId = useRef(0);

  const cancelScheduled = async () => {
    setCancelling(true);
    try {
      await api.systemCancelPower(serverId);
      notify("Programmation annulée", "success");
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setCancelling(false);
    }
  };

  const doPower = async (kind: PowerKind, delay: number) => {
    setModal(null);
    try {
      await api.systemPower(serverId, kind, delay);
    } catch (e) {
      notify(errorMessage(e), "error");
      return;
    }
    if (delay > 0) {
      notify(`${kind === "reboot" ? "Redémarrage" : "Extinction"} programmé dans ${delay} min`, "success");
      void reload();
      return;
    }
    if (kind === "poweroff") {
      notify(`${name} s'éteint`, "info");
      setTimeout(() => void refreshServers(), 6000);
      return;
    }
    const id = ++waitId.current;
    setWaitStart(Date.now());
    try {
      const secs = await api.systemWaitOnline(serverId, info?.bootTime, WAIT_TIMEOUT);
      if (id !== waitId.current) return;
      notify(`${name} est de retour après ${formatDuration(secs)}`, "success");
      void refreshServers();
      void reload();
    } catch (e) {
      if (id === waitId.current) notify(errorMessage(e), "error");
    } finally {
      if (id === waitId.current) setWaitStart(null);
    }
  };

  const stopWaiting = () => {
    waitId.current++;
    setWaitStart(null);
    void refreshServers();
  };

  const dialog = modal && <PowerModal mode={modal} name={name} onClose={() => setModal(null)} onConfirm={(k, d) => void doPower(k, d)} />;
  return { modal, setModal, waitStart, stopWaiting, cancelScheduled, cancelling, dialog };
}

export type PowerState = ReturnType<typeof usePower>;

function Row({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-4 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      {children}
    </div>
  );
}

/** Bloc « Alimentation » du rail. `power` absent : SSH indisponible, seule la partie hébergeur agit. */
export function PowerCard({ name, power, provider, onConfigure }: { name: string; power: PowerState | null; provider: ProviderState; onConfigure: () => void }) {
  const { view, status, statusError, busy, ready, test, act } = provider;
  const kind = KINDS.find((k) => k.value === view?.link?.kind)?.label;
  const [label, tone] = status ? STATE[status.state] : ["", "muted" as Tone];
  return (
    <Card padded={false} tone="danger" className="flex min-w-0 flex-col">
      <h2 className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">Alimentation</h2>
      <div className="px-4 pt-2.5 text-[11.5px] text-muted">Par SSH</div>
      {!power ? (
        <p className="px-4 py-2 text-[13px] text-muted">SSH ne répond pas : passe par l'hébergeur.</p>
      ) : power.waitStart ? (
        <Waiting name={name} start={power.waitStart} onStop={power.stopWaiting} />
      ) : (
        <div className="pb-1.5">
          <Row title="Redémarrer maintenant">
            <Button size="sm" title="Coupe sessions et services ; Zenytt attend le retour puis se reconnecte" onClick={() => power.setModal("reboot")}>
              Redémarrer…
            </Button>
          </Row>
          <Row title="Redémarrage ou extinction différés">
            <Button size="sm" title="Différé, annulable jusqu'à l'heure prévue" onClick={() => power.setModal("schedule")}>
              Programmer…
            </Button>
          </Row>
          <Row title="Éteindre le serveur">
            <Button size="sm" variant="danger" title="Rallumage depuis l'hébergeur seulement" onClick={() => power.setModal("poweroff")}>
              Éteindre…
            </Button>
          </Row>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border px-4 pt-2.5 text-[11.5px] text-muted">
        <span className="truncate">Par l'hébergeur{kind ? ` · ${kind}` : ""}</span>
        {ready && (
          <button type="button" className="text-accent hover:underline" onClick={onConfigure}>
            Configurer
          </button>
        )}
        {ready && (
          <span className="ml-auto flex items-center gap-1.5" aria-live="polite">
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
        )}
      </div>
      {!view ? (
        <p className="px-4 py-2.5 text-[13px] text-muted">Lecture…</p>
      ) : !ready ? (
        <Row title={<span className="text-muted">Non configuré : redémarrer ou rallumer sans SSH</span>}>
          <Button size="sm" onClick={onConfigure}>
            Configurer…
          </Button>
        </Row>
      ) : (
        <>
          {statusError && (
            <p className="truncate px-4 pt-1 text-xs text-danger" title={statusError}>
              {statusError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-3">
            <Button size="sm" variant="outline" loading={busy === "reboot"} onClick={() => void act("reboot")} title="Redémarrage logiciel demandé à l'hébergeur">
              Redémarrer (API)…
            </Button>
            <Button size="sm" variant="outline" loading={busy === "reset"} onClick={() => void act("reset")} title="Coupe et rallume sans arrêt propre, quand le système est bloqué">
              Reset forcé…
            </Button>
            <Button size="sm" variant="outline" loading={busy === "powerOn"} disabled={status?.state === "running"} onClick={() => void act("powerOn")}>
              Allumer…
            </Button>
            <Button size="sm" variant="danger" loading={busy === "powerOff"} disabled={status?.state === "off"} onClick={() => void act("powerOff")}>
              Éteindre…
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function Waiting({ name, start, onStop }: { name: string; start: number; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((now - start) / 1000);
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5">
      <div className="flex items-center gap-3" role="status" aria-live="polite">
        <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">En attente du retour de {name}</div>
          <div className="text-xs text-muted">{secs < 10 ? "Arrêt en cours…" : "Nouvelle tentative de connexion toutes les 5 s."}</div>
        </div>
        <span className="text-lg font-semibold tabular-nums" aria-label={`${secs} secondes écoulées`}>
          {clock}
        </span>
      </div>
      <Meter value={(secs / WAIT_TIMEOUT) * 100} tone="accent" />
      <div className="flex items-center gap-2 text-[11.5px] text-faint">
        <span className="flex-1">Abandon après {WAIT_TIMEOUT / 60} min. Muet ? Vérifie l'état chez l'hébergeur ci-dessous.</span>
        <Button size="sm" variant="ghost" onClick={onStop}>
          Arrêter d'attendre
        </Button>
      </div>
    </div>
  );
}

function PowerModal({ mode, name, onClose, onConfirm }: { mode: PowerModalMode; name: string; onClose: () => void; onConfirm: (kind: PowerKind, delay: number) => void }) {
  const scheduling = mode === "schedule";
  const [kind, setKind] = useState<PowerKind>(scheduling ? "reboot" : mode);
  const [delay, setDelay] = useState("15");
  const [typed, setTyped] = useState("");
  const off = kind === "poweroff";
  const minutes = scheduling ? Math.max(0, Math.floor(Number(delay) || 0)) : 0;
  const blocked = (off && typed !== name) || (scheduling && minutes < 1);
  const verb = off ? "Éteindre" : "Redémarrer";
  return (
    <Modal
      title={scheduling ? `Programmer sur ${name}` : `${verb} ${name} ?`}
      width="max-w-md"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="danger" disabled={blocked} onClick={() => onConfirm(kind, minutes)}>
            {scheduling ? `Programmer ${off ? "l'extinction" : "le redémarrage"}` : verb}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onConfirm(kind, minutes);
        }}
      >
        {scheduling && (
          <>
            <Segmented
              label="Action"
              value={kind}
              onChange={setKind}
              options={[
                { value: "reboot", label: "Redémarrage" },
                { value: "poweroff", label: "Extinction" },
              ]}
            />
            <Field label="Dans combien de minutes ?" hint={minutes >= 1 ? `Prévu à ${formatAt(Date.now() / 1000 + minutes * 60)}` : "1 minute au moins"}>
              <Input type="number" min={1} value={delay} onChange={(e) => setDelay(e.target.value)} autoFocus={!off} />
            </Field>
          </>
        )}
        <p className="text-[13px] leading-relaxed text-muted">
          {off ? "Le serveur s'éteint et ne répondra plus tant qu'il n'est pas rallumé (panneau ou API de l'hébergeur)." : "Toutes les sessions et tous les services sont interrompus le temps du redémarrage."}
        </p>
        {off && (
          <Field label={`Tape « ${name} » pour confirmer`}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Field>
        )}
      </form>
    </Modal>
  );
}
