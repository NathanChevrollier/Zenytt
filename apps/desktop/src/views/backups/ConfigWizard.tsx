// Configuration des sauvegardes en 4 étapes : Destination → Contenu → Planning et rétention →
// Chiffrement. Chaque étape se valide avant de passer à la suivante ; l'enregistrement installe
// restic si besoin et planifie la tâche quotidienne.
import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, HardDrive, KeyRound, Plus, Save, Trash2 } from "lucide-react";
import { api, errorMessage, type BackupConfig, type BackupOverview } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, Checkbox, CodeBlock, Field, IconButton, Input, Modal, ResultBanner, Segmented } from "../../components/ui";

const STEPS = ["Destination", "Contenu", "Planning et rétention", "Chiffrement"] as const;

export default function ConfigWizard({ serverId, data, onClose, onSaved }: { serverId: string; data: BackupOverview; onClose: () => void; onSaved: () => void }) {
  const notify = useApp((s) => s.notify);
  const existing = data.status.config;
  // Les bases déjà configurées reprennent le projet/service compose détecté : le diagnostic les
  // retrouvera si leur conteneur est recréé sous un autre nom.
  const [c, setC] = useState<BackupConfig>(
    existing
      ? { ...existing, databases: existing.databases.map((d) => data.databases.find((x) => x.container === d.container && x.kind === d.kind) ?? d) }
      : { ...data.defaultConfig, volumes: data.volumes, databases: data.databases },
  );
  const [step, setStep] = useState(0);
  const [s3Secret, setS3Secret] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ log: string; generatedPassword: string | null } | null>(null);
  const [newPath, setNewPath] = useState("");
  const set = <K extends keyof BackupConfig>(k: K, v: BackupConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const s3 = c.destination.kind === "s3" ? c.destination : null;
  const hadS3 = existing?.destination.kind === "s3";
  const allDbs = [...data.databases, ...c.databases.filter((d) => !data.databases.some((x) => x.container === d.container))];
  const allVols = [...new Set([...data.volumes, ...c.volumes])];

  /** Problème bloquant de chaque étape (null = on peut avancer). */
  const problems: (string | null)[] = [
    s3
      ? !/^https?:\/\/[^/]+/.test(s3.endpoint)
        ? "Indique l'endpoint S3 complet (https://…)."
        : !s3.bucket.trim()
          ? "Indique le nom du bucket."
          : !s3.accessKeyId.trim()
            ? "Indique l'access key ID."
            : !hadS3 && !s3Secret
              ? "Indique la secret access key."
              : null
      : c.destination.kind === "local" && !c.destination.path.startsWith("/")
        ? "Le dossier doit être un chemin absolu (/…)."
        : null,
    c.paths.length + c.volumes.length + c.databases.length === 0 ? "Choisis au moins une base, un volume ou un dossier." : null,
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.schedule)
      ? "Heure invalide (HH:MM)."
      : [c.keepDaily, c.keepWeekly, c.keepMonthly].some((n) => !Number.isInteger(n) || n < 0)
        ? "Les durées de rétention doivent être des nombres positifs."
        : c.keepDaily + c.keepWeekly + c.keepMonthly === 0
          ? "Garde au moins une sauvegarde."
          : null,
    password && password.length < 12 ? "12 caractères minimum." : password !== password2 ? "Les deux mots de passe diffèrent." : null,
  ];
  const firstInvalid = problems.findIndex(Boolean);

  const save = async () => {
    if (firstInvalid !== -1) {
      setStep(firstInvalid);
      return;
    }
    setSaving(true);
    try {
      setDone(await api.backupSave(serverId, { ...c, paths: c.paths.map((p) => p.trim()) }, password || undefined, s3Secret || undefined));
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <Modal title="Sauvegardes configurées" width="max-w-2xl" onClose={onSaved} footer={<Button variant="primary" onClick={onSaved}>Terminé</Button>}>
        <div className="flex flex-col gap-3 text-sm">
          {done.generatedPassword && (
            <ResultBanner tone="warn" title="Note ce mot de passe de chiffrement en lieu sûr">
              <p className="text-xs text-muted">Sans lui, les sauvegardes sont illisibles, y compris pour toi. Une copie est gardée dans le coffre-fort de ce PC.</p>
              <CodeBlock className="mt-2" code={done.generatedPassword} />
            </ResultBanner>
          )}
          <pre className="max-h-60 overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{done.log}</pre>
        </div>
      </Modal>
    );
  }

  const last = step === STEPS.length - 1;

  return (
    <Modal
      title={existing ? "Modifier les sauvegardes" : "Configurer les sauvegardes"}
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-danger">{problems[step]}</span>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          {step > 0 && (
            <Button icon={<ChevronLeft size={14} />} onClick={() => setStep(step - 1)}>
              Précédent
            </Button>
          )}
          {last ? (
            <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={firstInvalid !== -1} onClick={() => void save()}>
              Enregistrer et planifier
            </Button>
          ) : (
            <Button variant="primary" disabled={!!problems[step]} onClick={() => setStep(step + 1)}>
              Suivant <ChevronRight size={14} />
            </Button>
          )}
        </>
      }
    >
      <ol className="mb-5 flex items-center gap-2">
        {STEPS.map((label, i) => {
          const state = i < step ? "done" : i === step ? "current" : "todo";
          // En modification, toutes les étapes sont déjà remplies : on peut sauter directement.
          const reachable = !!existing || i <= step || problems.slice(0, i).every((p) => !p);
          return (
            <li key={label} className="flex min-w-0 flex-1 items-center gap-2">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => setStep(i)}
                className="flex min-w-0 items-center gap-2 rounded-md text-left disabled:cursor-not-allowed"
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                    state === "current" ? "border-accent bg-accent text-accent-fg" : state === "done" ? "border-ok/50 bg-ok/12 text-ok" : "border-border text-muted"
                  }`}
                >
                  {state === "done" ? <Check size={12} /> : i + 1}
                </span>
                <span className={`truncate text-xs ${state === "current" ? "font-semibold text-fg" : "text-muted"}`}>{label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="h-px min-w-3 flex-1 bg-border" />}
            </li>
          );
        })}
      </ol>

      <div className="min-h-[300px]">
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <Segmented
              label="Destination"
              value={c.destination.kind}
              onChange={(k) =>
                set(
                  "destination",
                  k === "local"
                    ? { kind: "local", path: existing?.destination.kind === "local" ? existing.destination.path : "/var/backups/zenytt/restic" }
                    : existing?.destination.kind === "s3"
                      ? existing.destination
                      : { kind: "s3", endpoint: "https://", bucket: "", prefix: "", accessKeyId: "" },
                )
              }
              options={[
                { value: "local", label: <><HardDrive size={13} /> Dossier du serveur</> },
                { value: "s3", label: "Stockage S3 (hors du serveur)" },
              ]}
            />
            {c.destination.kind === "local" ? (
              <>
                <Field label="Dossier">
                  <Input className="font-mono text-xs" value={c.destination.path} onChange={(e) => set("destination", { kind: "local", path: e.target.value })} />
                </Field>
                <ResultBanner tone="warn" title="Protège des erreurs, pas de la perte du serveur">
                  <span className="text-xs text-muted">Pour une vraie copie de secours, choisis un stockage S3 (Scaleway, Backblaze B2, OVH, AWS…).</span>
                </ResultBanner>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field className="col-span-2" label="Endpoint S3" hint="Ex. https://s3.fr-par.scw.cloud, https://s3.eu-central-003.backblazeb2.com">
                  <Input className="font-mono text-xs" value={s3!.endpoint} onChange={(e) => set("destination", { ...s3!, endpoint: e.target.value })} />
                </Field>
                <Field label="Bucket">
                  <Input value={s3!.bucket} onChange={(e) => set("destination", { ...s3!, bucket: e.target.value })} />
                </Field>
                <Field label="Préfixe (optionnel)">
                  <Input value={s3!.prefix} onChange={(e) => set("destination", { ...s3!, prefix: e.target.value })} placeholder="vps" />
                </Field>
                <Field label="Access key ID">
                  <Input value={s3!.accessKeyId} onChange={(e) => set("destination", { ...s3!, accessKeyId: e.target.value })} />
                </Field>
                <Field label="Secret access key" hint={hadS3 ? "Laisser vide pour conserver la clé actuelle." : undefined}>
                  <Input type="password" value={s3Secret} onChange={(e) => setS3Secret(e.target.value)} />
                </Field>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="grid grid-cols-2 gap-5">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Bases de données · export cohérent, sans arrêt</span>
              {allDbs.length === 0 && <span className="text-xs text-faint">Aucun conteneur MySQL/MariaDB/PostgreSQL détecté.</span>}
              {allDbs.map((d) => (
                <Checkbox
                  key={d.container}
                  checked={c.databases.some((x) => x.container === d.container)}
                  onChange={(on) => set("databases", on ? [...c.databases, d] : c.databases.filter((x) => x.container !== d.container))}
                  label={
                    <span className="flex items-center gap-2">
                      {d.container} <Badge>{d.kind}</Badge>
                    </span>
                  }
                />
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Volumes Docker</span>
              <div className="flex max-h-44 flex-col gap-1.5 overflow-auto">
                {allVols.length === 0 && <span className="text-xs text-faint">Aucun volume nommé.</span>}
                {allVols.map((v) => (
                  <Checkbox
                    key={v}
                    checked={c.volumes.includes(v)}
                    onChange={(on) => set("volumes", on ? [...c.volumes, v] : c.volumes.filter((x) => x !== v))}
                    label={<span className="font-mono text-xs">{v}</span>}
                  />
                ))}
              </div>
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Dossiers</span>
              {c.paths.map((p) => (
                <div key={p} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1">
                  <span className="flex-1 truncate font-mono text-xs">{p}</span>
                  <IconButton size="sm" title="Retirer" onClick={() => set("paths", c.paths.filter((x) => x !== p))}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newPath.trim().startsWith("/")) return;
                  set("paths", [...new Set([...c.paths, newPath.trim()])]);
                  setNewPath("");
                }}
              >
                <Input className="font-mono text-xs" placeholder="/srv/mon-app/uploads" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
                <Button type="submit" icon={<Plus size={13} />} disabled={!newPath.trim().startsWith("/")}>
                  Ajouter
                </Button>
              </form>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-5">
            <Field label="Heure de la sauvegarde quotidienne" hint="Heure du serveur. Choisis un moment creux.">
              <Input type="time" className="w-40" value={c.schedule} onChange={(e) => set("schedule", e.target.value)} />
            </Field>
            <div>
              <span className="text-xs font-medium text-muted">Combien de sauvegardes garder</span>
              <div className="mt-1.5 grid grid-cols-3 gap-3">
                <Field label="Quotidiennes" hint="une par jour">
                  <Input type="number" min={0} value={c.keepDaily} onChange={(e) => set("keepDaily", Number(e.target.value))} />
                </Field>
                <Field label="Hebdomadaires" hint="une par semaine">
                  <Input type="number" min={0} value={c.keepWeekly} onChange={(e) => set("keepWeekly", Number(e.target.value))} />
                </Field>
                <Field label="Mensuelles" hint="une par mois">
                  <Input type="number" min={0} value={c.keepMonthly} onChange={(e) => set("keepMonthly", Number(e.target.value))} />
                </Field>
              </div>
            </div>
            <p className="text-xs text-muted">
              Tu pourras revenir jusqu'à environ {c.keepMonthly > 0 ? `${c.keepMonthly} mois` : c.keepWeekly > 0 ? `${c.keepWeekly} semaines` : `${c.keepDaily} jours`} en arrière. restic déduplique : garder
              plus de sauvegardes coûte peu de place.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <ResultBanner tone="accent" title="Le mot de passe est la seule clé de tes sauvegardes">
              <span className="text-xs text-muted">
                Tout est chiffré sur le serveur avant d'être écrit. Sans ce mot de passe, personne ne peut relire les sauvegardes, pas même toi. Zenytt en garde une copie dans le coffre-fort
                de ce PC{data.passwordInKeyring ? " (déjà présente)" : ""}.
              </span>
            </ResultBanner>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Mot de passe de chiffrement"
                hint={existing ? "Laisser vide pour conserver le mot de passe actuel." : "Laisser vide pour en générer un solide (affiché une seule fois)."}
              >
                <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field label="Confirmation">
                <Input type="password" autoComplete="new-password" disabled={!password} value={password2} onChange={(e) => setPassword2(e.target.value)} />
              </Field>
            </div>
            <div className="rounded-lg border border-border bg-subtle px-3 py-2.5 text-xs">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <KeyRound size={13} /> Récapitulatif
              </p>
              <ul className="flex flex-col gap-0.5 text-muted">
                <li>Destination : {s3 ? `S3 · ${s3.bucket}${s3.prefix ? `/${s3.prefix}` : ""}` : c.destination.kind === "local" ? c.destination.path : ""}</li>
                <li>
                  Contenu : {c.databases.length} base(s), {c.volumes.length} volume(s), {c.paths.length} dossier(s)
                </li>
                <li>
                  Chaque jour à {c.schedule} · garde {c.keepDaily} j / {c.keepWeekly} sem. / {c.keepMonthly} mois
                </li>
              </ul>
            </div>
            {!data.status.restic && <p className="text-xs text-muted">restic n'est pas installé : il le sera automatiquement (paquet officiel de ta distribution).</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
