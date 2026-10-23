// Vue d'ensemble : fiche du serveur (nom d'hôte et fuseau modifiables sur place), états à traiter
// et zone d'alimentation (redémarrer, programmer, éteindre), avec l'attente du retour après un redémarrage.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Check, Clock, Cpu, Globe, HardDrive, Loader2, MemoryStick, Pencil, PowerOff, RotateCw, Server, ShieldCheck, X } from "lucide-react";
import { api, diskCounts, errorMessage, formatBytes, formatDuration, type Disk, type SystemInfo, type SystemUpdate } from "../../lib/api";
import { formatAt, scoreVerdict, updateGroup, validHostname } from "../../lib/system";
import { ScoreGauge, type SecTab } from "./Security";
import { useApp } from "../../lib/store";
import { Button, Card, ErrorState, Field, IconButton, Input, Loading, Meter, Modal, ResultBanner, Section, Segmented } from "../../components/ui";

type PowerKind = "reboot" | "poweroff";
/** Délai d'attente du retour, en secondes (celui de `systemWaitOnline`). */
const WAIT_TIMEOUT = 600;

export default function Overview({
  serverId,
  name,
  info,
  error,
  reload,
  updates,
  onShowUpdates,
  security,
  auditing,
  onShowSecurity,
}: {
  serverId: string;
  name: string;
  info: SystemInfo | null;
  error: string | null;
  reload: () => Promise<void>;
  updates: SystemUpdate[] | null;
  onShowUpdates: () => void;
  security: { score: number; problems: unknown[]; serious: number; banned: number | null } | null;
  auditing: boolean;
  onShowSecurity: (sub?: SecTab) => void;
}) {
  const { notify, refreshServers } = useApp.getState();
  const [zones, setZones] = useState<string[]>([]);
  const [modal, setModal] = useState<PowerKind | "schedule" | null>(null);
  const [waitStart, setWaitStart] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Chaque attente a son numéro : « Arrêter d'attendre » rend la réponse en cours caduque.
  const waitId = useRef(0);

  useEffect(() => void api.systemTimezones(serverId).then(setZones, () => {}), [serverId]);

  /** Enregistre un réglage puis relit la fiche ; renvoie vrai si c'est passé. */
  const save = (fn: (v: string) => Promise<void>, ok: string) => async (v: string) => {
    try {
      await fn(v);
      notify(ok, "success");
      await reload();
      return true;
    } catch (e) {
      notify(errorMessage(e), "error");
      return false;
    }
  };

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

  if (error && !info) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!info) return <Loading rows={5} />;

  const kernelUpdates = updates?.filter((u) => updateGroup(u.name) === "kernel").length ?? 0;
  const tzError = (v: string) => (zones.length && !zones.includes(v) ? "Fuseau inconnu du serveur" : null);

  return (
    <>
      <Card padded={false} className="overflow-hidden">
        <div className="flex items-center gap-4 px-5 py-4">
          <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
            <Server size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <InlineEdit
              label="le nom d'hôte"
              value={info.hostname}
              textClass="text-[19px] font-semibold tracking-tight"
              validate={(v) => (validHostname(v) ? null : "Lettres, chiffres et tirets, 63 caractères au plus")}
              onSave={save((v) => api.systemSetHostname(serverId, v), "Nom d'hôte modifié")}
            />
            <p className="truncate text-[13px] text-muted" title={`${info.os} · noyau ${info.kernel}`}>
              {info.os} <span className="text-faint">·</span> noyau <span className="font-mono text-xs">{info.kernel}</span>
            </p>
          </div>
        </div>
        <dl className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          <Fact icon={<Clock size={13} />} label="En marche depuis" detail={`Démarré le ${new Date(info.bootTime * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}`}>
            {formatDuration(info.uptimeSecs)}
          </Fact>
          <Fact icon={<Globe size={13} />} label="Fuseau horaire">
            <InlineEdit label="le fuseau horaire" value={info.timezone} list={zones} validate={tzError} onSave={save((v) => api.systemSetTimezone(serverId, v), "Fuseau horaire modifié")} />
          </Fact>
          <Fact icon={<Cpu size={13} />} label="Processeur" detail={info.cpuModel}>
            {info.cpuCount} cœur{info.cpuCount > 1 ? "s" : ""}
          </Fact>
          <Fact icon={<MemoryStick size={13} />} label="Mémoire" detail={`Paquets : ${info.packageManager ?? "gestionnaire inconnu"}`}>
            {formatBytes(info.memoryTotal)}
          </Fact>
        </dl>
      </Card>

      <Storage serverId={serverId} />

      {(info.scheduled || info.rebootRequired || updates) && (
        <div className="flex flex-col gap-2">
          {info.scheduled && (
            <ResultBanner
              tone="warn"
              title={`${info.scheduled.mode === "reboot" ? "Redémarrage" : "Extinction"} programmé à ${formatAt(info.scheduled.at)}`}
              action={
                <Button size="sm" loading={cancelling} onClick={() => void cancelScheduled()}>
                  Annuler
                </Button>
              }
            >
              Les sessions et les services seront coupés à cette heure.
            </ResultBanner>
          )}
          {info.rebootRequired && !waitStart && (
            <ResultBanner
              tone="warn"
              title="Redémarrage requis"
              action={
                <Button size="sm" icon={<RotateCw size={13} />} onClick={() => setModal("reboot")}>
                  Redémarrer…
                </Button>
              }
            >
              Des mises à jour installées (noyau ou bibliothèques système) ne seront actives qu'après un redémarrage.
            </ResultBanner>
          )}
          {updates && updates.length > 0 && (
            <ResultBanner
              tone="accent"
              title={`${updates.length} mise${updates.length > 1 ? "s" : ""} à jour disponible${updates.length > 1 ? "s" : ""}`}
              action={
                <Button size="sm" onClick={onShowUpdates}>
                  Voir la liste
                </Button>
              }
            >
              {kernelUpdates ? `Dont ${kernelUpdates} pour le noyau ou le démarrage : un redémarrage suivra.` : "Paquets du système, applicables depuis l'onglet Mises à jour."}
            </ResultBanner>
          )}
          {updates && updates.length === 0 && <ResultBanner tone="ok" title="Système à jour" />}
        </div>
      )}

      <SecuritySummary security={security} auditing={auditing} onOpen={onShowSecurity} />

      <Section title="Alimentation" description="Coupe les sessions et les services en cours">
        {waitStart ? (
          <Waiting name={name} start={waitStart} onStop={stopWaiting} />
        ) : (
          <Card padded={false} tone="danger" className="divide-y divide-border">
            <PowerRow icon={<RotateCw size={16} />} title="Redémarrer" text="Maintenant. Zenytt attend le retour du serveur puis se reconnecte.">
              <Button icon={<RotateCw size={14} />} onClick={() => setModal("reboot")}>
                Redémarrer…
              </Button>
            </PowerRow>
            <PowerRow icon={<CalendarClock size={16} />} title="Programmer" text="Redémarrage ou extinction différé, annulable jusqu'à l'heure prévue.">
              <Button icon={<CalendarClock size={14} />} onClick={() => setModal("schedule")}>
                Programmer…
              </Button>
            </PowerRow>
            <PowerRow icon={<PowerOff size={16} className="text-danger" />} title="Éteindre" text="Le serveur ne répondra plus tant qu'il n'est pas rallumé depuis l'hébergeur.">
              <Button variant="danger" icon={<PowerOff size={14} />} onClick={() => setModal("poweroff")}>
                Éteindre…
              </Button>
            </PowerRow>
          </Card>
        )}
      </Section>

      {modal && <PowerModal mode={modal} name={name} onClose={() => setModal(null)} onConfirm={(k, d) => void doPower(k, d)} />}
    </>
  );
}

function SecuritySummary({ security, auditing, onOpen }: { security: { score: number; problems: unknown[]; serious: number; banned: number | null } | null; auditing: boolean; onOpen: (sub?: SecTab) => void }) {
  if (!security) {
    if (!auditing) return null;
    return (
      <Card className="flex items-center gap-3 text-[13px] text-muted">
        <Loader2 size={16} className="animate-spin" />
        Audit de sécurité en cours… (lecture seule)
      </Card>
    );
  }
  const n = security.problems.length;
  return (
    <Card tone={security.serious ? "danger" : undefined} className="flex flex-wrap items-center gap-4 !py-3">
      <ScoreGauge score={security.score} small />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{scoreVerdict(security.score)}</div>
        <div className="text-xs text-muted">
          {n ? `${n} point${n > 1 ? "s" : ""} à traiter${security.serious ? `, dont ${security.serious} prioritaire${security.serious > 1 ? "s" : ""}` : ""}` : "Aucun problème détecté par l'audit"}
          {security.banned != null && (
            <>
              {", "}
              <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-fg" onClick={() => onOpen("fail2ban")}>
                {security.banned} IP bannie{security.banned > 1 ? "s" : ""} par fail2ban
              </button>
            </>
          )}
        </div>
      </div>
      <Button size="sm" icon={<ShieldCheck size={13} />} onClick={() => onOpen("audit")}>
        {n ? "Voir l'audit" : "Ouvrir la sécurité"}
      </Button>
    </Card>
  );
}

function Fact({ icon, label, detail, children }: { icon: ReactNode; label: string; detail?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-panel px-5 py-3.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted">
        <span aria-hidden className="text-faint">
          {icon}
        </span>
        {label}
      </dt>
      <dd className="min-w-0 text-[15px] font-medium tabular-nums">{children}</dd>
      {detail && (
        <dd className="truncate text-[11.5px] text-faint" title={detail}>
          {detail}
        </dd>
      )}
    </div>
  );
}

export function PowerRow({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span aria-hidden className="text-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-xs text-muted">{text}</div>
      </div>
      {children}
    </div>
  );
}

/** Valeur affichée avec un crayon ; Entrée enregistre, Échap annule. `list` propose des valeurs (recherche native). */
function InlineEdit({
  label,
  value,
  onSave,
  validate,
  list,
  textClass = "",
}: {
  label: string;
  value: string;
  onSave: (v: string) => Promise<boolean>;
  validate: (v: string) => string | null;
  list?: string[];
  textClass?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const listId = useId();
  if (draft === null) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <span className={`truncate select-text ${textClass}`}>{value}</span>
        <IconButton size="sm" title={`Modifier ${label}`} className="size-6! text-faint" onClick={() => setDraft(value)}>
          <Pencil size={13} />
        </IconButton>
      </div>
    );
  }
  const v = draft.trim();
  const problem = v && v !== value ? validate(v) : null;
  const submit = async () => {
    if (!v || problem) return;
    if (v === value) return setDraft(null);
    setSaving(true);
    if (await onSave(v)) setDraft(null);
    setSaving(false);
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          size_="sm"
          aria-label={`Nouveau ${label.replace(/^l[ea] /, "")}`}
          aria-invalid={!!problem}
          list={list?.length ? listId : undefined}
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
          className="max-w-64"
        />
        {list && list.length > 0 && (
          <datalist id={listId}>
            {list.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        )}
        <IconButton type="submit" size="sm" title="Enregistrer" disabled={saving || !v || !!problem}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        </IconButton>
        <IconButton size="sm" title="Annuler" onClick={() => setDraft(null)}>
          <X size={14} />
        </IconButton>
      </div>
      {problem && <span className="text-xs font-normal text-danger">{problem}</span>}
    </form>
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
    <Card tone="accent" className="flex flex-col gap-3">
      <div className="flex items-center gap-3" role="status" aria-live="polite">
        <Loader2 size={18} className="shrink-0 animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">En attente du retour de {name}</div>
          <div className="text-xs text-muted">{secs < 10 ? "Arrêt en cours…" : "Redémarrage : nouvelle tentative de connexion toutes les 5 s."}</div>
        </div>
        <span className="text-xl font-semibold tabular-nums" aria-label={`${secs} secondes écoulées`}>
          {clock}
        </span>
        <Button size="sm" variant="ghost" onClick={onStop}>
          Arrêter d'attendre
        </Button>
      </div>
      <Meter value={(secs / WAIT_TIMEOUT) * 100} tone="accent" />
      <p className="text-[11.5px] text-faint">Abandon automatique après {WAIT_TIMEOUT / 60} min. Si le serveur reste muet, vérifie son état dans l'onglet Hébergeur.</p>
    </Card>
  );
}

function PowerModal({ mode, name, onClose, onConfirm }: { mode: PowerKind | "schedule"; name: string; onClose: () => void; onConfirm: (kind: PowerKind, delay: number) => void }) {
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
          {off
            ? "Le serveur s'éteint et ne répondra plus tant qu'il n'est pas rallumé (panneau ou API de l'hébergeur)."
            : "Toutes les sessions et tous les services sont interrompus le temps du redémarrage."}
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

/** Espace disque des volumes suivis (mêmes règles que la supervision : lecture seule et volumes écartés masqués). */
function Storage({ serverId }: { serverId: string }) {
  const [disks, setDisks] = useState<Disk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDisks(null);
    setError(null);
    api.metrics(serverId).then(
      (m) => setDisks(m.disks.filter(diskCounts).sort((a, b) => a.mount.localeCompare(b.mount))),
      (e) => setError(errorMessage(e)),
    );
  }, [serverId]);

  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-medium">
        <HardDrive size={14} className="text-muted" /> Stockage
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        {error ? (
          <p className="text-[13px] text-muted">Espace disque indisponible : {error}</p>
        ) : !disks ? (
          <Loading />
        ) : disks.length === 0 ? (
          <p className="text-[13px] text-muted">Aucun volume à suivre.</p>
        ) : (
          disks.map((d) => {
            const p = d.total ? (d.used / d.total) * 100 : 0;
            return (
              <div key={d.mount} className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
                <span className="truncate font-mono text-xs" title={`${d.mount} (${d.device})`}>
                  {d.mount}
                </span>
                <Meter value={p} height={6} />
                <span className="text-right text-xs text-muted tabular-nums">
                  {formatBytes(d.total - d.used)} libres sur {formatBytes(d.total)} · {Math.round(p)} %
                </span>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
