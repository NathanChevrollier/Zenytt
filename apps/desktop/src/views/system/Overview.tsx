// Vue d'ensemble en tableau de bord : fiche du serveur (nom d'hôte et fuseau modifiables sur place),
// ressources, audit de sécurité (score, constats à corriger ou ignorer), mises à jour en résumé et alimentation (redémarrer, programmer, éteindre), avec l'attente du retour après un redémarrage.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Check, Clock, Cpu, Globe, Loader2, MemoryStick, Pencil, PowerOff, RotateCw, Server, X } from "lucide-react";
import { api, diskCounts, errorMessage, formatBytes, formatDuration, type Metrics, type SystemInfo, type SystemUpdate } from "../../lib/api";
import { formatAt, updateGroup, validHostname } from "../../lib/system";
import { AuditChecks, AuditFindings, type AuditProps } from "./Audit";
import { useApp } from "../../lib/store";
import { usePolling } from "../../lib/poll";
import { Button, Card, CRIT_AT, ErrorState, Eyebrow, Field, IconButton, Input, Loading, Meter, Modal, ResultBanner, Segmented, StatusDot, WARN_AT, type Tone } from "../../components/ui";

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
  updatesError,
  visible,
  onShowUpdates,
  audit,
}: {
  serverId: string;
  name: string;
  info: SystemInfo | null;
  error: string | null;
  reload: () => Promise<void>;
  updates: SystemUpdate[] | null;
  updatesError: string | null;
  /** Onglet affiché : les ressources ne sont relues que dans ce cas. */
  visible: boolean;
  onShowUpdates: () => void;
  audit: AuditProps;
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
  const callouts = !!info.scheduled || (info.rebootRequired && !waitStart);
  const booted = new Date(info.bootTime * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

  // Tableau de bord : colonne principale (2/3) et colonne d'actions (1/3) dès que la place le permet ;
  // en dessous, une seule colonne, les points à traiter en tête.
  return (
    <div className="grid min-w-0 gap-4 @5xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] @5xl:grid-rows-[auto_1fr]">
      {callouts && (
        <div className="flex min-w-0 flex-col gap-2 @5xl:col-start-2 @5xl:row-start-1">
          {info.scheduled && (
            <ResultBanner
              tone="warn"
              title={`${info.scheduled.mode === "reboot" ? "Redémarrage" : "Extinction"} programmé à ${formatAt(info.scheduled.at)}`}
              action={
                <Button size="sm" loading={cancelling} onClick={() => void cancelScheduled()}>
                  Annuler
                </Button>
              }
            />
          )}
          {info.rebootRequired && !waitStart && (
            <ResultBanner
              tone="warn"
              title="Redémarrage requis"
              action={
                <Button size="sm" onClick={() => setModal("reboot")}>
                  Redémarrer…
                </Button>
              }
            >
              Des mises à jour installées attendent un redémarrage.
            </ResultBanner>
          )}
        </div>
      )}

      <div className="@container flex min-w-0 flex-col gap-4 @5xl:col-start-1 @5xl:row-span-2 @5xl:row-start-1">
        <Card padded={false} className="@container overflow-hidden">
          <dl className="grid grid-cols-2 gap-px bg-border @3xl:grid-cols-[minmax(0,1.7fr)_repeat(4,minmax(0,1fr))]">
            <div className="col-span-2 flex min-w-0 items-center gap-3 bg-panel px-4 py-3 @3xl:col-span-1">
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                <Server size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <dt className="sr-only">Nom d'hôte</dt>
                <dd>
                  <InlineEdit
                    label="le nom d'hôte"
                    value={info.hostname}
                    textClass="text-[16px] font-semibold tracking-tight"
                    validate={(v) => (validHostname(v) ? null : "Lettres, chiffres et tirets, 63 caractères au plus")}
                    onSave={save((v) => api.systemSetHostname(serverId, v), "Nom d'hôte modifié")}
                  />
                </dd>
                <dd className="truncate text-xs text-muted" title={`${info.os} · noyau ${info.kernel}`}>
                  {info.os} <span className="text-faint">·</span> <span className="font-mono text-[11.5px]">{info.kernel}</span>
                </dd>
              </div>
            </div>
            <Fact icon={<Clock size={12} />} label="En marche depuis" title={`Démarré le ${booted}`}>
              {formatDuration(info.uptimeSecs)}
            </Fact>
            <Fact icon={<Globe size={12} />} label="Fuseau horaire">
              <InlineEdit label="le fuseau horaire" value={info.timezone} list={zones} validate={tzError} onSave={save((v) => api.systemSetTimezone(serverId, v), "Fuseau horaire modifié")} />
            </Fact>
            <Fact icon={<Cpu size={12} />} label="Processeur" detail={info.cpuModel}>
              {info.cpuCount} cœur{info.cpuCount > 1 ? "s" : ""}
            </Fact>
            <Fact icon={<MemoryStick size={12} />} label="Mémoire">
              {formatBytes(info.memoryTotal)}
            </Fact>
          </dl>
        </Card>

        <Resources serverId={serverId} visible={visible} />

        <AuditFindings {...audit} />
      </div>

      <div className={`flex min-w-0 flex-col gap-4 @5xl:col-start-2 ${callouts ? "@5xl:row-start-2" : "@5xl:row-span-2 @5xl:row-start-1"}`}>
        <section aria-label="Alimentation" className="flex min-w-0 flex-col">
          {waitStart ? (
            <Waiting name={name} start={waitStart} onStop={stopWaiting} />
          ) : (
            <Card padded={false} className="flex flex-col">
              <h2 className="flex items-baseline gap-2 border-b border-border px-4 py-2.5 text-[13px] font-semibold">
                Alimentation <span className="truncate text-xs font-normal text-muted">coupe sessions et services</span>
              </h2>
              <div className="divide-y divide-border">
                <PowerRow icon={<RotateCw size={15} />} title="Redémarrer" text="Zenytt attend le retour puis se reconnecte.">
                  <Button size="sm" onClick={() => setModal("reboot")}>
                    Redémarrer…
                  </Button>
                </PowerRow>
                <PowerRow icon={<CalendarClock size={15} />} title="Programmer" text="Différé, annulable jusqu'à l'heure prévue.">
                  <Button size="sm" onClick={() => setModal("schedule")}>
                    Programmer…
                  </Button>
                </PowerRow>
                <PowerRow icon={<PowerOff size={15} className="text-danger" />} title="Éteindre" text="Rallumage depuis l'hébergeur seulement.">
                  <Button size="sm" variant="danger" onClick={() => setModal("poweroff")}>
                    Éteindre…
                  </Button>
                </PowerRow>
              </div>
            </Card>
          )}
        </section>
        <Tile
          title="Mises à jour"
          hint={info.packageManager ?? undefined}
          action={
            <Button size="sm" disabled={!updates} onClick={onShowUpdates}>
              {updates?.length ? "Voir la liste" : "Ouvrir"}
            </Button>
          }
        >
          {!updates ? (
            updatesError ? (
              <Status tone="danger" title="Liste indisponible" detail={updatesError} />
            ) : (
              <Status tone="muted" title="Vérification…" spin />
            )
          ) : updates.length === 0 ? (
            <Status tone="ok" title="Système à jour" detail="Aucun paquet en attente" />
          ) : (
            <Status
              tone={kernelUpdates ? "warn" : "accent"}
              title={`${updates.length} mise${updates.length > 1 ? "s" : ""} à jour disponible${updates.length > 1 ? "s" : ""}`}
              detail={kernelUpdates ? `Dont ${kernelUpdates} noyau ou démarrage : redémarrage à prévoir` : "Paquets du système"}
            />
          )}
        </Tile>
        {/* Hauteur nulle + grow : la liste comble la colonne sans l'allonger, et défile au besoin. */}
        <AuditChecks {...audit} className="max-h-72 @5xl:h-0 @5xl:max-h-none @5xl:min-h-40 @5xl:grow" />
      </div>

      {modal && <PowerModal mode={modal} name={name} onClose={() => setModal(null)} onConfirm={(k, d) => void doPower(k, d)} />}
    </div>
  );
}

/** Tuile d'état compacte : titre et action sur une ligne, puis l'indicateur. */
function Tile({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card padded={false} className="flex min-w-0 flex-col">
      <div className="flex min-h-11 items-center gap-2 border-b border-border px-4 py-2">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {hint && <span className="truncate text-xs text-faint">{hint}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>
      </div>
      <div className="flex flex-1 items-center gap-3 px-4 py-3">{children}</div>
    </Card>
  );
}

/** Indicateur en ligne : pastille, une ligne forte, une ligne de détail. */
function Status({ tone, title, detail, spin }: { tone: Tone; title: ReactNode; detail?: ReactNode; spin?: boolean }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      {spin ? <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-muted" /> : <StatusDot tone={tone} className="mt-[6px]" />}
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        {detail && (
          <div className="truncate text-xs text-muted" title={typeof detail === "string" ? detail : undefined}>
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ icon, label, detail, title, children }: { icon: ReactNode; label: string; detail?: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-0.5 bg-panel px-4 py-2.5" title={title}>
      <dt className="flex items-center gap-1.5 text-[11.5px] text-muted">
        <span aria-hidden className="text-faint">
          {icon}
        </span>
        {label}
      </dt>
      <dd className="min-w-0 text-[13px] font-medium tabular-nums">{children}</dd>
      {detail && (
        <dd className="truncate text-[11px] text-faint" title={detail}>
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
      <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
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


/**
 * Ressources : CPU, charge, mémoire et volumes suivis (mêmes règles que la supervision : lecture seule
 * et volumes écartés masqués), relus toutes les 5 s tant que l'onglet est affiché.
 * Le premier relevé n'a pas encore de CPU calculé : la jauge attend le deuxième.
 */
function Resources({ serverId, visible }: { serverId: string; visible: boolean }) {
  const [m, setM] = useState<Metrics | null>(null);
  const [samples, setSamples] = useState(0);
  const [error, setError] = useState<string | null>(null);
  usePolling(
    async () => {
      try {
        setM(await api.metrics(serverId));
        setSamples((n) => n + 1);
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    5000,
    [serverId],
    visible,
  );

  const disks = m ? m.disks.filter(diskCounts).sort((a, b) => a.mount.localeCompare(b.mount)) : [];
  const ratio = (used: number, total: number) => (total ? (used / total) * 100 : 0);

  return (
    <Card padded={false} className="@container min-w-0">
      <h2 className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">Ressources</h2>
      {error && !m ? (
        <p className="px-4 py-3 text-[13px] text-muted">Relevé indisponible : {error}</p>
      ) : !m ? (
        <div className="px-4 py-3">
          <Loading rows={2} />
        </div>
      ) : (
        <div className="grid gap-x-10 gap-y-3 px-4 py-3 @3xl:grid-cols-2">
          <div className="flex min-w-0 flex-col">
            <Eyebrow className="mb-1">Processeur et mémoire</Eyebrow>
            <Gauge label="CPU" pct={samples > 1 ? m.cpuPercent : null} value={`${m.cpuCount} cœur${m.cpuCount > 1 ? "s" : ""}`} />
            <Gauge label="Charge" title="Charge sur 1 min rapportée au nombre de cœurs" pct={(m.load[0] / Math.max(m.cpuCount, 1)) * 100} value={`${m.load[0].toFixed(2)} · ${m.load[1].toFixed(2)} · ${m.load[2].toFixed(2)}`} />
            <Gauge label="Mémoire" pct={ratio(m.memUsed, m.memTotal)} value={`${formatBytes(m.memUsed)} / ${formatBytes(m.memTotal)}`} />
            {m.swapTotal > 0 && <Gauge label="Swap" pct={ratio(m.swapUsed, m.swapTotal)} value={`${formatBytes(m.swapUsed)} / ${formatBytes(m.swapTotal)}`} />}
          </div>
          <div className="flex min-w-0 flex-col">
            <Eyebrow className="mb-1">Stockage</Eyebrow>
            {disks.length === 0 ? (
              <p className="py-1 text-[13px] text-muted">Aucun volume à suivre.</p>
            ) : (
              disks.map((d) => (
                <Gauge
                  key={d.mount}
                  mono
                  label={d.mount}
                  title={`${d.mount} (${d.device}) · ${formatBytes(d.total - d.used)} libres`}
                  pct={ratio(d.used, d.total)}
                  value={`${formatBytes(d.used)} / ${formatBytes(d.total)}`}
                />
              ))
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Une ligne de ressource : libellé · jauge bornée · pourcentage · valeur, sans vide entre eux. */
function Gauge({ label, title, pct, value, mono }: { label: string; title?: string; pct: number | null; value: string; mono?: boolean }) {
  const hot = pct == null ? "text-muted" : pct >= CRIT_AT ? "text-danger" : pct >= WARN_AT ? "text-warn" : "";
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_minmax(64px,220px)_3rem_minmax(0,1fr)] items-center gap-3 py-1 text-[13px]" title={title}>
      <span className={`truncate ${mono ? "font-mono text-xs" : ""}`}>{label}</span>
      <Meter value={pct ?? 0} tone={pct == null ? "muted" : undefined} height={6} />
      <span className={`text-right text-xs tabular-nums ${hot}`}>{pct == null ? "…" : `${Math.round(pct)} %`}</span>
      <span className="truncate text-xs text-muted tabular-nums">{value}</span>
    </div>
  );
}
