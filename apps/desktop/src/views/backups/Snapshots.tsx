// Explorateur des sauvegardes : liste à gauche, contenu à droite, restauration par élément.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUp, Database, Download, File, Folder, RotateCcw, Undo2 } from "lucide-react";
import { api, errorMessage, formatBytes, type DbSource, type Snapshot, type SnapshotNode } from "../../lib/api";
import { track } from "../../lib/transfers";
import { useApp } from "../../lib/store";
import { Button, Card, DataTable, ErrorState, IconButton, Loading, Modal, Section } from "../../components/ui";

type Notify = (m: string, k?: "info" | "error" | "success") => void;

export default function SnapshotsBrowser({
  serverId,
  snaps,
  error,
  onRetry,
  selected,
  onSelect,
  databases,
  notify,
}: {
  serverId: string;
  snaps: Snapshot[] | null;
  error: string | null;
  onRetry: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
  databases: DbSource[];
  notify: Notify;
}) {
  const [path, setPath] = useState("/");
  const [nodes, setNodes] = useState<SnapshotNode[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ node: SnapshotNode; at: string } | null>(null);
  /** Élément en cours de restauration : seul son bouton tourne. */
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const ordered = snaps ? [...snaps].sort((a, b) => b.time.localeCompare(a.time)) : null;
  const current = ordered?.find((s) => s.short_id === selected) ?? null;

  useEffect(() => setPath("/"), [selected]);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    setNodes(null);
    setListError(null);
    api.backupList(serverId, current.short_id, path).then(
      (n) => alive && setNodes(n),
      (e) => alive && setListError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [serverId, current?.short_id, path, retry]);

  const restore = async (node: SnapshotNode) => {
    if (!current) return;
    setBusyPath(node.path);
    try {
      const at = await api.backupRestore(serverId, current.short_id, node.path);
      setRestored({ node, at });
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusyPath(null);
    }
  };

  const crumbs = path.split("/").filter(Boolean);

  return (
    <Section title="Sauvegardes disponibles" count={snaps?.length}>
      {error && <ErrorState message={error} onRetry={onRetry} />}
      {ordered?.length === 0 ? (
        // Pas encore de sauvegarde : une ligne, pas deux panneaux vides côte à côte.
        <Card className="py-3 text-xs text-muted">Aucune sauvegarde pour l'instant. La première sera faite à l'heure prévue, ou maintenant via « Sauvegarder maintenant ».</Card>
      ) : (
        <div className="grid min-h-[360px] grid-cols-[240px_minmax(0,1fr)] gap-3 2xl:grid-cols-[300px_minmax(0,1fr)]">
          <Card padded={false} className="flex max-h-[520px] flex-col overflow-hidden">
            {ordered === null ? (
              <div className="p-3">
                <Loading rows={5} />
              </div>
            ) : (
              <div className="overflow-auto p-1.5">
                {ordered.map((s) => {
                  const on = s.short_id === selected;
                  const d = new Date(s.time);
                  return (
                    <button
                      key={s.short_id}
                      type="button"
                      onClick={() => onSelect(s.short_id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${on ? "bg-accent/12 text-fg" : "hover:bg-hover"}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium">{d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</span>
                        <span className="block text-[11px] text-muted">
                          {d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · <span className="font-mono">{s.short_id}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
          )}
        </Card>

        <Card padded={false} className="flex max-h-[520px] min-w-0 flex-col overflow-hidden">
          {!current ? (
            <p className="p-4 text-xs text-muted">Choisis une sauvegarde pour parcourir son contenu et restaurer un fichier, un dossier ou un export de base. Rien n'est remplacé sans ton accord.</p>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
                <IconButton size="sm" title="Dossier parent" disabled={path === "/"} onClick={() => setPath(path.replace(/\/[^/]+\/?$/, "") || "/")}>
                  <ArrowUp size={14} />
                </IconButton>
                <nav className="flex min-w-0 items-center gap-0.5 overflow-hidden font-mono text-xs">
                  <button type="button" className="rounded px-1 hover:bg-hover" onClick={() => setPath("/")}>
                    /
                  </button>
                  {crumbs.map((c, i) => (
                    <span key={i} className="flex min-w-0 items-center gap-0.5">
                      {i > 0 && <span className="text-faint">/</span>}
                      <button type="button" className="truncate rounded px-1 hover:bg-hover" onClick={() => setPath("/" + crumbs.slice(0, i + 1).join("/"))}>
                        {c}
                      </button>
                    </span>
                  ))}
                </nav>
                <span className="ml-auto shrink-0 text-[11px] text-muted">{new Date(current.time).toLocaleString("fr-FR")}</span>
              </div>
              {listError ? (
                <div className="p-4">
                  <ErrorState message={listError} onRetry={() => setRetry((n) => n + 1)} />
                </div>
              ) : nodes === null ? (
                <div className="p-3">
                  <Loading rows={6} />
                </div>
              ) : (
                <DataTable
                  className="min-h-0 flex-1"
                  rows={nodes}
                  rowKey={(n) => n.path}
                  rowHeight={36}
                  initialSort={{ key: "name", dir: "asc" }}
                  onRowDoubleClick={(n) => n.kind === "dir" && setPath(n.path)}
                  columns={[
                    {
                      key: "name",
                      header: "Nom",
                      sortValue: (n) => `${n.kind === "dir" ? 0 : 1}${n.name.toLowerCase()}`,
                      render: (n) =>
                        n.kind === "dir" ? (
                          <button type="button" className="flex min-w-0 items-center gap-2 hover:underline" onClick={() => setPath(n.path)}>
                            <Folder size={14} className="shrink-0 text-accent" />
                            <span className="truncate">{n.name}</span>
                          </button>
                        ) : (
                          <span className="flex min-w-0 items-center gap-2">
                            {n.name.endsWith(".sql") ? <Database size={14} className="shrink-0 text-muted" /> : <File size={14} className="shrink-0 text-muted" />}
                            <span className="truncate">{n.name}</span>
                          </span>
                        ),
                    },
                    { key: "size", header: "Taille", width: "90px", align: "right", sortValue: (n) => n.size, render: (n) => <span className="text-xs text-muted tabular-nums">{n.kind === "dir" ? "" : formatBytes(n.size)}</span> },
                  ]}
                  actionsWidth={110}
                  rowActions={(n) => (
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} loading={busyPath === n.path} disabled={busyPath !== null && busyPath !== n.path} onClick={() => void restore(n)}>
                      Restaurer
                    </Button>
                  )}
                  empty="Dossier vide."
                />
              )}
            </>
          )}
        </Card>
      </div>
      )}

      {restored && <RestoredDialog serverId={serverId} restored={restored} databases={databases} notify={notify} onClose={() => setRestored(null)} />}
    </Section>
  );
}

/** Après restauration dans un dossier temporaire : télécharger, remettre en place ou réimporter. */
function RestoredDialog({
  serverId,
  restored,
  databases,
  notify,
  onClose,
}: {
  serverId: string;
  restored: { node: SnapshotNode; at: string };
  databases: DbSource[];
  notify: Notify;
  onClose: () => void;
}) {
  const ask = useApp((s) => s.ask);
  const [busy, setBusy] = useState<string | null>(null);
  const db = databases.find((d) => restored.node.name === `${d.container}.sql`);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const download = () =>
    act("download", async () => {
      const dir = await open({ directory: true, title: "Dossier de destination" });
      if (typeof dir !== "string") return;
      const staged = await api.backupStageDownload(serverId, restored.at);
      await track(`Téléchargement de ${restored.node.name}`, (id, p) => api.fsDownload(serverId, [staged], dir, id, p));
      notify(`Téléchargé dans ${dir}`, "success");
    });

  const putBack = () =>
    act("putback", async () => {
      const ok = await ask({
        title: `Remettre en place ${restored.node.path} ?`,
        body: "La version actuelle sera d'abord renommée (…zenytt-avant-restauration-<date>), puis la version sauvegardée copiée à sa place. Un service qui utilise ce fichier devra peut-être être redémarré.",
        confirmLabel: "Remettre en place",
        danger: true,
      });
      if (!ok) return;
      const aside = await api.backupPutBack(serverId, restored.at, restored.node.path);
      notify(`Remis en place. Ancienne version : ${aside}`, "success");
      onClose();
    });

  const reimport = () =>
    act("import", async () => {
      if (!db) return;
      const ok = await ask({
        title: `Réimporter dans ${db.container} ?`,
        body: "Le dump va être rejoué dans la base : les tables présentes dans la sauvegarde seront remplacées par leur contenu sauvegardé. Fais d'abord une sauvegarde de l'état actuel si besoin.",
        confirmLabel: "Réimporter",
        danger: true,
      });
      if (!ok) return;
      await api.backupImportDump(serverId, restored.at, db);
      notify(`Base ${db.container} réimportée`, "success");
      onClose();
    });

  return (
    <Modal
      title={`« ${restored.node.name} » restauré`}
      description="Rien n'a encore été remplacé sur le serveur."
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">
          Copie restaurée dans : <span className="font-mono text-xs text-fg select-text">{restored.at}</span>
        </p>
        <div className="grid gap-2">
          <Choice icon={<Download size={16} />} title="Télécharger sur mon PC" body="Récupère la copie sans toucher au serveur." action={<Button loading={busy === "download"} onClick={() => void download()}>Télécharger</Button>} />
          <Choice
            icon={<Undo2 size={16} />}
            title="Remettre en place"
            body={`Remplace ${restored.node.path} ; la version actuelle est gardée à côté.`}
            action={
              <Button variant="danger" loading={busy === "putback"} onClick={() => void putBack()}>
                Remettre en place
              </Button>
            }
          />
          {db && (
            <Choice
              icon={<Database size={16} />}
              title={`Réimporter dans ${db.container}`}
              body="Rejoue l'export dans la base de données."
              action={
                <Button variant="danger" loading={busy === "import"} onClick={() => void reimport()}>
                  Réimporter
                </Button>
              }
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function Choice({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <span className="text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted">{body}</span>
      </span>
      {action}
    </div>
  );
}
