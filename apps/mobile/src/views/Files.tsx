import { useRef, useState } from "react";
import { File as FileIcon, Folder, Upload } from "lucide-react";
import { api, errorMessage, type FileEntry, type Server } from "../lib/api";
import { formatBytes } from "../lib/format";
import { usePolled } from "../lib/hooks";
import { Confirm, ProblemCard, Sheet } from "../ui";

const isDir = (e: FileEntry) => e.kind === "dir" || (e.kind === "symlink" && e.targetIsDir);

/** Lit un fichier du téléphone en base64 (le sélecteur HTML marche partout, contrairement aux chemins `content://` d'Android). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("fichier illisible"));
    reader.readAsDataURL(file);
  });
}

export function Files({ server, onEdit }: { server: Server; onEdit: () => void }) {
  const [path, setPath] = useState<string | undefined>(undefined);
  // Pas d'actualisation périodique : un dossier ne bouge pas tout seul, et chaque lecture coûte une requête SFTP.
  const { data, error, refresh } = usePolled(() => api.files(server.id, path), 3_600_000, [server.id, path]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const cwd = data?.path ?? path ?? "";
  const parent = cwd.replace(/\/[^/]*\/?$/, "") || "/";

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setNotice(`Envoi de ${file.name}…`);
    try {
      await api.upload(server.id, cwd, file.name, await readBase64(file));
      setNotice(`${file.name} envoyé.`);
      refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    }
  };

  return (
    <div className="screen">
      {error && <ProblemCard serverId={server.id} error={error} onRetry={refresh} onEdit={onEdit} />}
      {data && (
        <>
          <div className="btn-row" style={{ alignItems: "center", flexWrap: "nowrap" }}>
            <span className="mono muted" style={{ flex: 1, overflowWrap: "anywhere", fontSize: 13 }}>
              {cwd}
            </span>
            <button className="btn icon" aria-label="Envoyer un fichier ici" onClick={() => input.current?.click()}>
              <Upload size={20} />
            </button>
            <input ref={input} type="file" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          {notice && <div className="muted">{notice}</div>}
          {cwd !== "/" && (
            <button className="row" onClick={() => setPath(parent)}>
              <Folder size={20} />
              <span className="grow title">..</span>
            </button>
          )}
          {[...data.entries]
            .sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name))
            .map((e) => (
              <button key={e.path} className="row" onClick={() => (isDir(e) ? setPath(e.path) : setSelected(e))}>
                {isDir(e) ? <Folder size={20} /> : <FileIcon size={20} />}
                <span className="grow">
                  <div className="title">{e.name}</div>
                  {!isDir(e) && <div className="sub">{formatBytes(e.size)}</div>}
                </span>
                {isDir(e) && (
                  <span
                    role="button"
                    aria-label={`Actions sur ${e.name}`}
                    className="muted"
                    style={{ padding: 12 }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setSelected(e);
                    }}
                  >
                    ⋯
                  </span>
                )}
              </button>
            ))}
        </>
      )}
      {selected && (
        <EntrySheet
          server={server}
          entry={selected}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

function EntrySheet({
  server,
  entry,
  onClose,
  onChanged,
  onNotice,
}: {
  server: Server;
  entry: FileEntry;
  onClose: () => void;
  onChanged: () => void;
  onNotice: (m: string) => void;
}) {
  const [mode, setMode] = useState<"menu" | "rename" | "delete">("menu");
  if (mode === "rename") {
    return (
      <Confirm
        title="Renommer"
        initial={entry.name}
        label="Renommer"
        onConfirm={async (name) => {
          if (name.includes("/")) throw new Error("le nom ne peut pas contenir « / »");
          await api.renameFile(server.id, entry.path, entry.path.replace(/[^/]*$/, "") + name);
          onChanged();
        }}
        onClose={onClose}
      />
    );
  }
  if (mode === "delete") {
    return (
      <Confirm
        title={`Supprimer « ${entry.name} » ?`}
        message={isDir(entry) ? "Le dossier et tout son contenu seront supprimés du serveur." : "Le fichier sera supprimé du serveur."}
        label="Supprimer"
        danger
        onConfirm={async () => {
          await api.removeFile(server.id, entry.path);
          onChanged();
        }}
        onClose={onClose}
      />
    );
  }
  return (
    <Sheet title={entry.name} onClose={onClose}>
      <div className="btn-row">
        <button
          className="btn primary"
          onClick={() => {
            onClose();
            onNotice(`Téléchargement de ${entry.name}…`);
            api
              .download(server.id, entry.path)
              .then((p) => onNotice(`Enregistré dans l'app : ${p}`))
              .catch((e) => onNotice(errorMessage(e)));
          }}
        >
          Télécharger
        </button>
        <button className="btn" onClick={() => setMode("rename")}>
          Renommer
        </button>
        <button className="btn danger" onClick={() => setMode("delete")}>
          Supprimer
        </button>
      </div>
    </Sheet>
  );
}
