// Copie du dépôt de sauvegarde sur ce PC : une seconde copie, hors du serveur, quand les
// sauvegardes sont gardées sur le serveur lui-même. Seuls les fichiers nouveaux sont téléchargés ;
// la copie reste chiffrée (restic l'ouvre avec le mot de passe des sauvegardes).
import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, HardDriveDownload, Laptop, X } from "lucide-react";
import { api, errorMessage, formatBytes, shellQuote, type MirrorProgress } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Button, Card, CodeBlock, Meter, MenuButton } from "../../components/ui";

let transferSeq = 900_000;

export default function LocalCopy({ serverId }: { serverId: string }) {
  const notify = useApp((s) => s.notify);
  const mirror = useApp((s) => s.settings.backupMirrors?.[serverId]);
  const [progress, setProgress] = useState<MirrorProgress | null>(null);
  const [running, setRunning] = useState(false);
  const transfer = useRef<number | null>(null);

  const remember = (patch: { dir: string; lastAt?: number; files?: number; totalBytes?: number }) => {
    const all = useApp.getState().settings.backupMirrors ?? {};
    useApp.getState().setSettings({ backupMirrors: { ...all, [serverId]: { ...all[serverId], ...patch } } });
  };

  const pickDir = async (): Promise<string | null> => {
    const dir = await open({ directory: true, title: "Dossier de ce PC où garder la copie des sauvegardes" });
    return typeof dir === "string" ? dir : null;
  };

  const run = async (dir: string) => {
    const id = ++transferSeq;
    transfer.current = id;
    setRunning(true);
    setProgress(null);
    try {
      const r = await api.backupMirror(serverId, dir, id, setProgress);
      remember({ dir: r.dir, lastAt: Date.now(), files: r.files, totalBytes: r.totalBytes });
      notify(
        r.downloaded || r.deleted
          ? `Copie à jour : ${r.downloaded} fichier(s) téléchargé(s) (${formatBytes(r.bytes)})${r.deleted ? `, ${r.deleted} retiré(s)` : ""}`
          : "La copie sur ce PC était déjà à jour",
        "success",
      );
    } catch (e) {
      const msg = errorMessage(e);
      notify(msg.includes("CANCELLED") ? "Copie interrompue : elle reprendra où elle s'est arrêtée." : msg, msg.includes("CANCELLED") ? "info" : "error");
    } finally {
      transfer.current = null;
      setRunning(false);
      setProgress(null);
    }
  };

  const start = async (change = false) => {
    const dir = !change && mirror?.dir ? mirror.dir : await pickDir();
    if (dir) await run(dir);
  };

  const pct = progress && progress.bytesTotal > 0 ? (progress.bytesDone / progress.bytesTotal) * 100 : progress ? 100 : 0;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Laptop size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Copie sur ce PC</h3>
          <p className="text-xs text-muted">
            Une seconde copie hors du serveur, à jour en un clic : seuls les nouveaux fichiers sont téléchargés. Elle reste chiffrée et s'ouvre avec restic et le mot de passe des sauvegardes.
          </p>
        </div>
        {!running && (
          <span className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="primary" icon={<HardDriveDownload size={13} />} onClick={() => void start()}>
              {mirror ? "Mettre à jour la copie" : "Copier sur ce PC…"}
            </Button>
            {mirror && (
              <MenuButton
                size="sm"
                items={[
                  { label: "Afficher dans l'explorateur", icon: <FolderOpen size={14} />, onClick: () => void revealItemInDir(mirror.dir).catch((e) => notify(errorMessage(e), "error")) },
                  { label: "Changer de dossier…", icon: <HardDriveDownload size={14} />, onClick: () => void start(true) },
                ]}
              />
            )}
          </span>
        )}
      </div>

      {running && (
        <div className="flex flex-col gap-1.5">
          <Meter value={pct} />
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="flex-1">
              {progress
                ? progress.filesTotal === 0
                  ? "Déjà à jour, vérification terminée…"
                  : `${progress.filesDone} / ${progress.filesTotal} fichier(s) · ${formatBytes(progress.bytesDone)} sur ${formatBytes(progress.bytesTotal)}`
                : "Comparaison avec le dépôt du serveur…"}
            </span>
            <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => transfer.current !== null && void api.fsCancel(transfer.current)}>
              Interrompre
            </Button>
          </div>
        </div>
      )}

      {mirror && !running && (
        <div className="flex flex-col gap-2 text-xs">
          <p className="text-muted">
            <span className="font-mono break-all select-text">{mirror.dir}</span>
            {mirror.lastAt && (
              <>
                {" "}· mise à jour le {new Date(mirror.lastAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
                {mirror.totalBytes !== undefined && ` · ${formatBytes(mirror.totalBytes)}`}
              </>
            )}
          </p>
          <details>
            <summary className="cursor-pointer text-faint hover:text-fg">Restaurer depuis cette copie</summary>
            <p className="mt-1.5 mb-1 text-muted">Avec restic installé sur ce PC (restic.net) ; le mot de passe est celui des sauvegardes, gardé dans le coffre-fort de Zenytt.</p>
            <CodeBlock code={`restic -r ${shellQuote(mirror.dir)} snapshots\nrestic -r ${shellQuote(mirror.dir)} restore latest --target ./restauration`} />
          </details>
        </div>
      )}
    </Card>
  );
}
