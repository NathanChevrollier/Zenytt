import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, FileCode2, Pencil, Play, Plus, Timer, Trash2 } from "lucide-react";
import { api, errorMessage, type CronJob, type CronSource, type Schedule } from "../../lib/api";
import { useApp, useAppPick } from "../../lib/store";
import { Badge, Button, Card, ErrorState, Field, IconButton, Input, Loading, MenuButton, Modal, Segmented, Select, Textarea } from "../../components/ui";
import { describeCron } from "../../lib/cron";
import { CRON_PRESETS, humanSchedule, isValidSchedule, replaceJob, WEEKDAYS } from "../../lib/crontab";
import { useCachedState } from "../../lib/cache";
import { useAutoRefresh } from "../../lib/refresh";

export default function ScheduleView({ serverId, onCount }: { serverId: string; onCount?: (n: number) => void }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [data, setData] = useCachedState<Schedule | null>(`schedule:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CronSource | null>(null);
  const [jobForm, setJobForm] = useState<{ source: CronSource; job: CronJob | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.scheduleList(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh((auto) => (auto ? api.scheduleList(serverId).then(setData, () => {}) : load()), { serverId });
  const count = (data?.crontabs.reduce((n, c) => n + c.jobs.length, 0) ?? 0) + (data?.timers.length ?? 0);
  useEffect(() => onCount?.(count), [count, onCount]);

  /** Crontab de l'utilisateur de connexion (ou la première modifiable) : cible de « Nouvelle tâche ». */
  const mine = data?.crontabs.find((c) => c.editable);

  const removeJob = async (source: CronSource, job: CronJob) => {
    if (!(await ask({ title: "Supprimer cette tâche ?", body: `Crontab de ${source.id.replace(/^user:/, "")}.`, code: `${job.schedule} ${job.command}`, confirmLabel: "Supprimer", danger: true }))) return;
    try {
      await api.crontabSave(serverId, source.id.replace(/^user:/, ""), replaceJob(source.raw, job, null));
      notify("Tâche supprimée", "success");
      void load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const header = (
    <div className="flex min-h-7 items-center gap-2">
      <h2 className="text-[13px] font-semibold" title="Crontabs des utilisateurs, fichiers système (/etc/crontab, /etc/cron.d) et timers systemd">
        Tâches planifiées {data && <span className="font-normal text-faint">· {count}</span>}
      </h2>
      {mine && (
        <Button size="sm" className="ml-auto" variant="primary" icon={<Plus size={13} />} onClick={() => setJobForm({ source: mine, job: null })}>
          Nouvelle tâche
        </Button>
      )}
    </div>
  );

  if (error)
    return (
      <div className="@container flex flex-col gap-3">
        {header}
        <ErrorState message={error} onRetry={() => void load()} />
      </div>
    );
  if (!data)
    return (
      <div className="@container flex flex-col gap-3">
        {header}
        <Loading rows={6} />
      </div>
    );

  return (
    <div className="@container flex flex-col gap-3">
      {header}

      {data.crontabs.length === 0 && <p className="text-[13px] text-muted">Aucune crontab.</p>}
      {data.crontabs.map((c) => (
        <Card key={c.id} padded={false} className="overflow-hidden">
          <header className="flex items-center gap-2 border-b border-border bg-subtle px-4 py-2.5">
            <CalendarClock size={14} className="text-muted" />
            <span className="font-mono text-[13px]">{c.label}</span>
            {!c.editable && <Badge>système · lecture seule</Badge>}
            {c.editable && (
              <span className="ml-auto flex items-center gap-1.5">
                <Button size="sm" icon={<Plus size={13} />} onClick={() => setJobForm({ source: c, job: null })}>
                  Ajouter
                </Button>
                <Button size="sm" variant="ghost" icon={<FileCode2 size={13} />} onClick={() => setEditing(c)}>
                  Éditer le texte
                </Button>
              </span>
            )}
          </header>
          {c.jobs.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted">Aucune tâche active.</p>
          ) : (
            <ul>
              {c.jobs.map((j, i) => {
                const role = describeCron(j.command);
                return (
                  <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-line px-4 py-2 first:border-t-0 @xl:grid-cols-[200px_minmax(0,1fr)_auto]">
                    <div>
                      <div className="font-mono text-xs">{j.schedule}</div>
                      <div className="text-xs text-muted">{j.human ?? humanSchedule(j.schedule) ?? ""}</div>
                      {j.user !== null && <div className="text-[11px] text-faint">en tant que {j.user}</div>}
                    </div>
                    <div className="col-start-1 min-w-0 @xl:col-start-2 @xl:row-start-1">
                      <div className="font-mono text-xs break-all select-text">{j.command}</div>
                      {/* Ce que la commande fait réellement : une crontab ne se relit pas toute seule. */}
                      {role && <div className="mt-1 text-xs leading-relaxed text-muted">{role}</div>}
                    </div>
                    {c.editable && (
                      <span className="col-start-2 row-start-1 flex @xl:col-start-3">
                        <IconButton size="sm" title="Modifier la tâche" onClick={() => setJobForm({ source: c, job: j })}>
                          <Pencil size={13} />
                        </IconButton>
                        <MenuButton size="sm" items={[{ label: "Supprimer…", icon: <Trash2 size={14} />, danger: true, onClick: () => void removeJob(c, j) }]} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ))}

      {data.systemd && (
        <Card padded={false} className="overflow-hidden">
          <header className="flex items-center gap-2 border-b border-border bg-subtle px-4 py-2.5">
            <Timer size={14} className="text-muted" />
            <span className="text-[13px] font-medium">Timers systemd</span>
            <span className="text-xs text-faint">· {data.timers.length}</span>
          </header>
          <ul>
            {data.timers.map((t) => (
              <li key={t.unit} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-3 border-t border-line px-4 py-2 first:border-t-0 @xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs">{t.unit}</div>
                  <div className="truncate text-[11px] text-faint">{t.activates}</div>
                </div>
                <div className="flex min-w-0 flex-col @xl:contents">
                  <div className="truncate text-xs" title={t.next}>
                    <span className="text-faint">prochaine </span>
                    {t.next}
                  </div>
                  <div className="truncate text-xs text-muted" title={t.last}>
                    <span className="text-faint">dernière </span>
                    {t.last}
                  </div>
                </div>
                {t.activates.endsWith(".service") ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Play size={13} />}
                    onClick={async () => {
                      if (!(await ask({ title: `Lancer ${t.activates} maintenant ?`, body: "La tâche s'exécute tout de suite, en plus de son planning habituel.", confirmLabel: "Lancer" }))) return;
                      try {
                        await api.timerRun(serverId, t.activates);
                        notify(`${t.activates} lancé`, "success");
                      } catch (e) {
                        notify(errorMessage(e), "error");
                      }
                    }}
                  >
                    Lancer
                  </Button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {editing && (
        <CrontabEditor
          serverId={serverId}
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {jobForm && (
        <JobForm
          serverId={serverId}
          source={jobForm.source}
          job={jobForm.job}
          onClose={() => setJobForm(null)}
          onSaved={() => {
            setJobForm(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Ajout ou modification d'une tâche, avec un planning choisi en clair plutôt qu'en syntaxe cron. */
function JobForm({ serverId, source, job, onClose, onSaved }: { serverId: string; source: CronSource; job: CronJob | null; onClose: () => void; onSaved: () => void }) {
  const notify = useApp((s) => s.notify);
  const user = source.id.replace(/^user:/, "");
  const [preset, setPreset] = useState(job ? "custom" : "daily");
  const [time, setTime] = useState("03:00");
  const [dow, setDow] = useState(1);
  const [dom, setDom] = useState(1);
  const [custom, setCustom] = useState(job?.schedule ?? "0 3 * * *");
  const [command, setCommand] = useState(job?.command ?? "");
  const [saving, setSaving] = useState(false);

  const p = CRON_PRESETS.find((x) => x.id === preset)!;
  const [h, m] = time.split(":").map((x) => Number(x) || 0);
  const schedule = preset === "custom" ? custom.trim() : p.expr(h, m, dow, dom);
  const valid = isValidSchedule(schedule) && command.trim().length > 0 && !command.includes("\n");
  const human = useMemo(() => humanSchedule(schedule), [schedule]);
  const role = describeCron(command);

  const save = async () => {
    setSaving(true);
    try {
      await api.crontabSave(serverId, user, replaceJob(source.raw, job, `${schedule} ${command.trim()}`));
      notify(job ? "Tâche modifiée" : "Tâche ajoutée", "success");
      onSaved();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={job ? "Modifier la tâche" : "Nouvelle tâche planifiée"}
      description={`Crontab de ${user} · crontab vérifie la syntaxe avant d'enregistrer`}
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} disabled={!valid} onClick={() => void save()}>
            {job ? "Enregistrer" : "Ajouter"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Commande" hint="Chemins absolus conseillés : cron a un PATH réduit.">
          <Input className="font-mono" autoFocus value={command} placeholder="/opt/scripts/backup.sh >> /var/log/backup.log 2>&1" onChange={(e) => setCommand(e.target.value)} />
        </Field>
        {role && <p className="-mt-2 text-xs text-muted">{role}</p>}
        <Field label="Quand">
          <Select value={preset} onChange={setPreset} options={CRON_PRESETS.map((x) => ({ value: x.id, label: x.label }))} />
        </Field>
        {(p.needs.length > 0 || preset === "custom") && (
          <div className="flex flex-wrap items-end gap-3">
            {p.needs.includes("dow") && (
              <Field label="Jour">
                <Select value={dow} onChange={setDow} options={WEEKDAYS.map((d, i) => ({ value: i, label: d }))} />
              </Field>
            )}
            {p.needs.includes("dom") && (
              <Field label="Jour du mois">
                <Select value={dom} onChange={setDom} options={Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
              </Field>
            )}
            {p.needs.includes("time") && (
              <Field label="Heure">
                <Input type="time" className="w-32" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
            )}
            {preset === "custom" && (
              <Field label="Expression (minute heure jour mois jour-semaine)" className="flex-1" error={isValidSchedule(schedule) ? undefined : "5 champs, ou @reboot, @daily…"}>
                <Input className="font-mono" value={custom} onChange={(e) => setCustom(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        <div className="rounded-lg border border-border bg-subtle px-3 py-2.5 text-[13px]">
          <div className="text-xs text-faint">Ligne ajoutée à la crontab</div>
          <div className="mt-1 font-mono text-xs break-all select-text">
            {schedule} {command.trim() || "…"}
          </div>
          {human && <div className="mt-1 text-xs text-muted">S'exécute {human}.</div>}
        </div>
      </div>
    </Modal>
  );
}

function CrontabEditor({ serverId, source, onClose, onSaved }: { serverId: string; source: CronSource; onClose: () => void; onSaved: () => void }) {
  const notify = useApp((s) => s.notify);
  const [text, setText] = useState(source.raw);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"text" | "help">("text");
  const user = source.id.replace(/^user:/, "");

  const save = async () => {
    setSaving(true);
    try {
      await api.crontabSave(serverId, user, text);
      notify(`Crontab de ${user} enregistrée`, "success");
      onSaved();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Crontab de ${user}`}
      description="minute heure jour-du-mois mois jour-de-la-semaine commande"
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <Segmented
            size="sm"
            className="mr-auto"
            value={view}
            onChange={setView}
            options={[
              { value: "text", label: "Texte" },
              { value: "help", label: "Aide-mémoire" },
            ]}
          />
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} disabled={text === source.raw} onClick={() => void save()}>
            Enregistrer
          </Button>
        </>
      }
    >
      {view === "text" ? (
        <Textarea className="h-[55vh] resize-none font-mono text-xs" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="grid gap-2 font-mono text-xs">
          {[
            ["*/5 * * * *", "toutes les 5 minutes"],
            ["0 * * * *", "toutes les heures"],
            ["0 3 * * *", "chaque jour à 03:00"],
            ["30 2 * * 1", "chaque lundi à 02:30"],
            ["0 4 1 * *", "le 1er du mois à 04:00"],
            ["0 9 * * 1-5", "du lundi au vendredi à 09:00"],
            ["@reboot", "au démarrage du serveur"],
          ].map(([e, d]) => (
            <div key={e} className="flex gap-4 rounded-lg border border-border bg-subtle px-3 py-2">
              <span className="w-32">{e}</span>
              <span className="font-sans text-muted">{d}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
