// Alimentation : un menu du bandeau, par SSH (redémarrer, programmer, éteindre, avec l'attente du
// retour) et par l'hébergeur (redémarrage API, reset forcé, allumer, éteindre), utilisable SSH coupé.
import { useEffect, useRef, useState } from "react";
import { Clock, Loader2, Power, RefreshCw, RotateCcw, Settings2, Zap } from "lucide-react";
import { api, errorMessage, formatDuration, type SystemInfo } from "../../lib/api";
import { formatAt } from "../../lib/system";
import { useApp } from "../../lib/store";
import { MenuButton, type MenuItem } from "../../components/ContextMenu";
import { Button, Field, Input, Modal, Segmented } from "../../components/ui";
import { KINDS, STATE, type ProviderState } from "./Provider";

type PowerKind = "reboot" | "poweroff";
export type PowerModalMode = PowerKind | "schedule";
/** Délai d'attente du retour, en secondes (celui de `systemWaitOnline`). */
const WAIT_TIMEOUT = 600;

/** Actions d'alimentation par SSH, partagées entre le menu Alimentation et « À traiter ». */
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

/**
 * Menu « Alimentation » du bandeau de la page : par SSH (redémarrer, programmer, éteindre) et par
 * l'hébergeur (utilisable SSH coupé). `power` absent : SSH indisponible. Pendant l'attente du
 * retour après un redémarrage, le menu laisse la place au chronomètre.
 */
export function PowerMenu({ name, power, provider, onConfigure }: { name: string; power: PowerState | null; provider: ProviderState; onConfigure: () => void }) {
  const { view, status, statusError, busy, ready, test, act } = provider;
  if (power?.waitStart) return <Waiting name={name} start={power.waitStart} onStop={power.stopWaiting} />;
  const kind = KINDS.find((k) => k.value === view?.link?.kind)?.label;
  const state = status ? STATE[status.state][0] : statusError ? "injoignable" : busy === "status" ? "lecture de l'état…" : "";
  const items = (): MenuItem[] => [
    { heading: "Par SSH" },
    ...(power
      ? [
          { label: "Redémarrer maintenant…", icon: <RotateCcw size={14} />, hint: "attend le retour", onClick: () => power.setModal("reboot") },
          { label: "Programmer un redémarrage ou une extinction…", icon: <Clock size={14} />, onClick: () => power.setModal("schedule") },
          { label: "Éteindre le serveur…", icon: <Power size={14} />, danger: true, onClick: () => power.setModal("poweroff") },
        ]
      : [{ label: "SSH ne répond pas : passe par l'hébergeur", disabled: true, onClick: () => {} }]),
    "separator",
    { heading: `Par l'hébergeur${kind ? ` · ${kind}` : ""}${ready && state ? ` · ${state}` : ""}` },
    ...(!view
      ? [{ label: "Lecture…", disabled: true, onClick: () => {} }]
      : !ready
        ? [{ label: "Configurer l'hébergeur…", icon: <Settings2 size={14} />, hint: "redémarrer ou rallumer sans SSH", onClick: onConfigure }]
        : [
            { label: "Redémarrer (API)…", icon: <RotateCcw size={14} />, disabled: !!busy, onClick: () => void act("reboot") },
            { label: "Reset forcé…", icon: <Zap size={14} />, hint: "système bloqué", disabled: !!busy, onClick: () => void act("reset") },
            { label: "Allumer…", icon: <Power size={14} />, disabled: !!busy || status?.state === "running", onClick: () => void act("powerOn") },
            { label: "Éteindre…", icon: <Power size={14} />, danger: true, disabled: !!busy || status?.state === "off", onClick: () => void act("powerOff") },
            "separator" as const,
            { label: "Relire l'état", icon: <RefreshCw size={14} />, disabled: busy === "status", onClick: () => void test() },
            { label: "Configurer…", icon: <Settings2 size={14} />, onClick: onConfigure },
          ]),
  ];
  return <MenuButton label={busy && busy !== "status" ? "Alimentation…" : "Alimentation"} icon={<Power size={14} />} title="Redémarrer, programmer, éteindre (SSH ou hébergeur)" items={items} />;
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
    <div
      className="flex h-8 items-center gap-2 rounded-lg border border-border bg-subtle pr-1 pl-2.5 text-[13px]"
      role="status"
      aria-live="polite"
      title={`${secs < 10 ? "Arrêt en cours…" : "Nouvelle tentative de connexion toutes les 5 s."} Abandon après ${WAIT_TIMEOUT / 60} min ; muet, vérifie l'état chez l'hébergeur.`}
    >
      <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
      <span className="whitespace-nowrap">Retour de {name} attendu</span>
      <span className="font-semibold tabular-nums" aria-label={`${secs} secondes écoulées`}>
        {clock}
      </span>
      <Button size="sm" variant="ghost" onClick={onStop}>
        Arrêter d'attendre
      </Button>
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
