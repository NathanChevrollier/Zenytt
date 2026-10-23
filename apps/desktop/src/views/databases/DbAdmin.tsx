// Administration d'une instance de base : sauvegardes (et restauration, import depuis le PC),
// comptes et droits, requêtes en cours.
import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Activity, DatabaseBackup, Download, KeyRound, Plus, RefreshCw, RotateCcw, Square, Trash2, Upload, UserPlus, Users } from "lucide-react";
import { api, errorMessage, formatBytes, type DbBackupFile, type DbInstance, type DbNamed, type DbQueryResult } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { track } from "../../lib/transfers";
import { usePolling } from "../../lib/poll";
import { Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Loading, Modal, Segmented, Select } from "../../components/ui";

type Section = "backups" | "users" | "activity";

/** Horodatage de nom de fichier : 2026-09-30_1402. */
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");

export default function DbAdmin({ serverId, instances, instanceId, onInstance, databases }: { serverId: string; instances: DbInstance[]; instanceId: string | null; onInstance: (id: string) => void; databases: DbNamed[] | null }) {
  const [section, setSection] = useState<Section>("backups");
  const instance = instances.find((i) => i.id === instanceId) ?? instances[0];
  if (!instance) return <EmptyState icon={<DatabaseBackup />} title="Aucune instance" />;
  const sqlite = instance.engine === "sqlite";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-7 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <Select className="w-72" value={instance.id} onChange={onInstance} options={instances.map((i) => ({ value: i.id, label: i.label }))} aria-label="Instance" />
        <Segmented
          label="Rubrique"
          value={sqlite ? "backups" : section}
          onChange={setSection}
          options={[
            { value: "backups", label: "Sauvegardes" },
            { value: "users", label: "Utilisateurs", disabled: sqlite, title: sqlite ? "SQLite n'a pas de comptes" : undefined },
            { value: "activity", label: "Requêtes en cours", disabled: sqlite },
          ]}
        />
      </div>
      {(sqlite || section === "backups") && <Backups key={instance.id} serverId={serverId} instance={instance} databases={databases} />}
      {!sqlite && section === "users" && <UsersPanel key={instance.id} serverId={serverId} instance={instance} databases={databases} />}
      {!sqlite && section === "activity" && <ActivityPanel key={instance.id} serverId={serverId} instance={instance} />}
    </div>
  );
}

const SYSTEM = ["information_schema", "mysql", "performance_schema", "sys", "postgres", "template0", "template1"];

function Backups({ serverId, instance, databases }: { serverId: string; instance: DbInstance; databases: DbNamed[] | null }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [files, setFiles] = useState<DbBackupFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const userDbs = instance.engine === "sqlite" ? ["main"] : (databases ?? []).map((d) => d.name).filter((d) => !SYSTEM.includes(d));
  const [database, setDatabase] = useState(userDbs[0] ?? "");
  useEffect(() => {
    if (!database && userDbs[0]) setDatabase(userDbs[0]);
  }, [database, userDbs]);

  const load = useCallback(() => {
    api.dbBackups(serverId).then(
      (f) => {
        setFiles(f);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [serverId]);
  useEffect(load, [load]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const backup = () =>
    act("backup", async () => {
      const f = await api.dbBackup(serverId, instance, database, stamp());
      notify(`Sauvegarde créée : ${f.name} (${formatBytes(f.size)})`, "success");
      load();
    });

  const restore = (f: DbBackupFile) =>
    act(`restore:${f.name}`, async () => {
      const ok = await ask({
        title: `Restaurer ${f.name} dans « ${database} » ?`,
        body: "Le contenu actuel des tables présentes dans la sauvegarde sera remplacé (les sauvegardes Zenytt suppriment puis recréent chaque table). Pense à faire d'abord une sauvegarde de l'état actuel.",
        confirmLabel: "Restaurer",
        danger: true,
      });
      if (!ok) return;
      const warnings = await api.dbRestore(serverId, instance, database, f.name);
      notify(warnings ? `Restauration terminée, avec des avertissements : ${warnings.slice(0, 300)}` : `« ${database} » restaurée depuis ${f.name}.`, warnings ? "warn" : "success");
    });

  const download = (f: DbBackupFile) =>
    act(`dl:${f.name}`, async () => {
      const dir = await openDialog({ directory: true, title: "Dossier de destination" });
      if (typeof dir !== "string") return;
      await track(`Téléchargement de ${f.name}`, (id, p) => api.fsDownload(serverId, [f.path], dir, id, p));
      notify(`Téléchargé dans ${dir}`, "success");
    });

  const importFile = () =>
    act("import", async () => {
      const picked = await openDialog({ multiple: false, title: "Fichier SQL à importer", filters: [{ name: "SQL", extensions: ["sql", "gz"] }] });
      if (typeof picked !== "string") return;
      const name = picked.split(/[\\/]/).pop() ?? "";
      if (!/^[A-Za-z0-9._-]+\.sql(\.gz)?$/.test(name) || name.startsWith(".")) {
        notify("Nom de fichier accepté : lettres, chiffres, « . », « _ », « - », terminé par .sql ou .sql.gz. Renomme le fichier puis réessaie.", "error");
        return;
      }
      const dir = await api.dbImportDir(serverId);
      await track(`Envoi de ${name}`, (id, p) => api.fsUpload(serverId, [picked], dir, id, p));
      load();
      notify(`${name} est sur le serveur : clique sur « Restaurer » pour le rejouer dans une base.`, "success");
    });

  const remove = (f: DbBackupFile) =>
    act(`rm:${f.name}`, async () => {
      if (!(await ask({ title: `Supprimer ${f.name} ?`, body: "Le fichier est effacé du serveur.", confirmLabel: "Supprimer", danger: true }))) return;
      await api.dbBackupDelete(serverId, f.name);
      load();
    });

  return (
    <>
      <Card className="flex flex-wrap items-end gap-3">
        <Field label={instance.engine === "sqlite" ? "Fichier" : "Base"} className="w-64">
          {instance.engine === "sqlite" ? (
            <Input value={instance.path ?? ""} readOnly className="font-mono text-xs" />
          ) : (
            <Select value={database} onChange={setDatabase} options={userDbs.map((d) => ({ value: d, label: d }))} />
          )}
        </Field>
        <Button variant="primary" icon={<DatabaseBackup size={14} />} loading={busy === "backup"} disabled={!database} onClick={() => void backup()}>
          Sauvegarder maintenant
        </Button>
        <Button icon={<Upload size={14} />} loading={busy === "import"} onClick={() => void importFile()}>
          Importer un fichier .sql…
        </Button>
        <p className="w-full text-xs leading-relaxed text-muted">
          Sauvegarde complète (structure et données, compressée) dans <span className="font-mono">~/zenytt-sauvegardes-bdd</span> sur le serveur, à télécharger ou à restaurer. Pour des sauvegardes planifiées et chiffrées hors du serveur, utilise la section Sauvegardes.
        </p>
      </Card>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Fichiers sur le serveur</h2>
          <IconButton size="sm" title="Actualiser" onClick={load}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
        {error && <ErrorState message={error} onRetry={load} />}
        {!files && !error && <Loading rows={3} />}
        {files && files.length === 0 && <p className="text-[13px] text-muted">Aucune sauvegarde pour l'instant.</p>}
        {files && files.length > 0 && (
          <Card padded={false} className="divide-y divide-border">
            {files.map((f) => (
              <div key={f.name} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                  {f.name}
                </span>
                <span className="w-20 text-right text-xs text-muted tabular-nums">{formatBytes(f.size)}</span>
                <span className="w-36 text-right text-xs text-muted">{new Date(f.modified * 1000).toLocaleString("fr-FR")}</span>
                <Button size="sm" icon={<RotateCcw size={12} />} loading={busy === `restore:${f.name}`} disabled={!database} onClick={() => void restore(f)} title={`Rejouer dans « ${database} »`}>
                  Restaurer
                </Button>
                <IconButton size="sm" title="Télécharger sur le PC" onClick={() => void download(f)}>
                  <Download size={14} />
                </IconButton>
                <IconButton size="sm" title="Supprimer" onClick={() => void remove(f)}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))}
          </Card>
        )}
      </section>
    </>
  );
}

/** Tableau simple d'un résultat, avec une colonne d'actions. */
function ResultTable({ result, actions }: { result: DbQueryResult; actions?: (row: (string | null)[]) => React.ReactNode }) {
  return (
    <div className="overflow-auto rounded-xl border border-border">
      <table className="w-full text-[12.5px]">
        <thead className="bg-subtle text-left text-[11px] text-muted">
          <tr>
            {result.columns.map((c) => (
              <th key={c} className="px-3 py-1.5 font-medium">
                {c}
              </th>
            ))}
            {actions && <th />}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {result.rows.map((r, i) => (
            <tr key={i} className="hover:bg-hover-soft">
              {r.map((v, j) => (
                <td key={j} className="max-w-md truncate px-3 py-1.5 font-mono text-xs" title={v ?? "NULL"}>
                  {v ?? <span className="text-faint">NULL</span>}
                </td>
              ))}
              {actions && <td className="px-2 py-1 text-right whitespace-nowrap">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsersPanel({ serverId, instance, databases }: { serverId: string; instance: DbInstance; databases: DbNamed[] | null }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const mysql = instance.engine === "mysql";

  const load = useCallback(() => {
    setResult(null);
    api.dbUsers(serverId, instance).then(
      (r) => {
        setResult(r);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [serverId, instance]);
  useEffect(load, [load]);

  const hostOf = (r: (string | null)[]) => (mysql ? (r[1] ?? "%") : "");

  const changePassword = async (user: string, host: string) => {
    const pw = await ask({ title: `Nouveau mot de passe pour ${user}${host ? `@${host}` : ""}`, input: { label: "Mot de passe (8 caractères au moins)", secret: true }, confirmLabel: "Changer" });
    if (typeof pw !== "string" || !pw) return;
    try {
      await api.dbUserPassword(serverId, instance, user, host, pw);
      notify(`Mot de passe de ${user} changé. Pense à le mettre à jour dans les applications qui l'utilisent.`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const drop = async (user: string, host: string) => {
    if (!(await ask({ title: `Supprimer le compte ${user}${host ? `@${host}` : ""} ?`, body: "Les applications qui s'y connectent ne pourront plus accéder à la base.", confirmLabel: "Supprimer", danger: true }))) return;
    try {
      await api.dbUserDrop(serverId, instance, user, host);
      notify(`Compte ${user} supprimé.`, "success");
      load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Users size={15} className="text-muted" />
        <h2 className="text-sm font-semibold">Comptes</h2>
        <Button size="sm" variant="primary" className="ml-auto" icon={<UserPlus size={13} />} onClick={() => setCreating(true)}>
          Nouveau compte
        </Button>
        <IconButton size="sm" title="Actualiser" onClick={load}>
          <RefreshCw size={13} />
        </IconButton>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}
      {!result && !error && <Loading rows={4} />}
      {result && (
        <ResultTable
          result={result}
          actions={(r) => (
            <span className="inline-flex gap-0.5">
              <IconButton size="sm" title="Changer le mot de passe" onClick={() => void changePassword(r[0] ?? "", hostOf(r))}>
                <KeyRound size={13} />
              </IconButton>
              <IconButton size="sm" title="Supprimer le compte" onClick={() => void drop(r[0] ?? "", hostOf(r))}>
                <Trash2 size={13} />
              </IconButton>
            </span>
          )}
        />
      )}
      {creating && <CreateUserDialog serverId={serverId} instance={instance} databases={databases} onClose={() => setCreating(false)} onDone={load} />}
    </section>
  );
}

function CreateUserDialog({ serverId, instance, databases, onClose, onDone }: { serverId: string; instance: DbInstance; databases: DbNamed[] | null; onClose: () => void; onDone: () => void }) {
  const { notify } = useAppPick("notify");
  const mysql = instance.engine === "mysql";
  const userDbs = (databases ?? []).map((d) => d.name).filter((d) => !SYSTEM.includes(d));
  const [user, setUser] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 22);
  });
  const [database, setDatabase] = useState<string>(userDbs[0] ?? "");
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z0-9_.-]{1,63}$/.test(user) && password.length >= 8;

  const submit = async () => {
    setBusy(true);
    try {
      await api.dbUserCreate(serverId, instance, user, host, password, database || null);
      notify(`Compte ${user} créé${database ? ` avec tous les droits sur « ${database} »` : ""}. Note son mot de passe : il n'est pas conservé par Zenytt.`, "success");
      onDone();
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nouveau compte"
      width="max-w-lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Plus size={13} />} loading={busy} disabled={!valid} onClick={() => void submit()}>
            Créer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nom d'utilisateur">
            <Input value={user} onChange={(e) => setUser(e.target.value)} className="font-mono" autoFocus />
          </Field>
          {mysql && (
            <Field label="Depuis" hint="% : toute origine (conteneurs compris) ; localhost : le serveur seul">
              <Input value={host} onChange={(e) => setHost(e.target.value)} className="font-mono" />
            </Field>
          )}
        </div>
        <Field label="Mot de passe" hint="Généré au hasard : copie-le avant de valider, Zenytt ne le garde pas.">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Tous les droits sur la base">
          <Select value={database} onChange={setDatabase} options={[{ value: "", label: "Aucune (compte sans droit)" }, ...userDbs.map((d) => ({ value: d, label: d }))]} />
        </Field>
      </div>
    </Modal>
  );
}

function ActivityPanel({ serverId, instance }: { serverId: string; instance: DbInstance }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.dbActivity(serverId, instance).then(
      (r) => {
        setResult(r);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [serverId, instance]);
  usePolling(load, 5000, [load]);

  const kill = async (id: number, whole: boolean) => {
    if (!(await ask({ title: whole ? `Couper la connexion ${id} ?` : `Arrêter la requête ${id} ?`, body: whole ? "La requête est arrêtée et l'application perd sa connexion (elle devra se reconnecter)." : "La requête est annulée ; la connexion reste ouverte.", confirmLabel: whole ? "Couper" : "Arrêter", danger: true })))
      return;
    try {
      await api.dbKill(serverId, instance, id, whole);
      notify("Fait.", "success");
      load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Activity size={15} className="text-muted" />
        <h2 className="text-sm font-semibold">Requêtes en cours</h2>
        <Badge tone="muted">actualisé toutes les 5 s</Badge>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}
      {!result && !error && <Loading rows={3} />}
      {result && result.rows.length === 0 && <p className="text-[13px] text-muted">Aucune requête en cours : la base est au repos.</p>}
      {result && result.rows.length > 0 && (
        <ResultTable
          result={result}
          actions={(r) => {
            const id = Number(r[0]);
            return (
              <span className="inline-flex gap-1">
                <Button size="sm" icon={<Square size={11} />} onClick={() => void kill(id, false)}>
                  Arrêter
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void kill(id, true)}>
                  Couper
                </Button>
              </span>
            );
          }}
        />
      )}
    </section>
  );
}
