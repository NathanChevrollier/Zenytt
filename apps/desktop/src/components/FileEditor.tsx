import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Eye, FileDiff, Save, ShieldAlert } from "lucide-react";
import "../lib/monaco";
import { languageFor } from "../lib/monaco";
import { api, errorMessage, formatBytes, hasShell, type FileStamp, type TextWindow } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, Modal } from "./ui";
import { useMonacoTheme } from "../lib/theme";

/** Portion affichée d'un fichier trop gros pour l'éditeur (ou dans un autre encodage que l'UTF-8). */
const WINDOW = 8 * 1024 * 1024;

/** Les journaux s'ouvrent sur leur fin, le reste sur le début. */
const isLog = (path: string) => /\.log(\.\d+)?$|\/log\//.test(path);

/** Éditeur de fichier distant en fenêtre modale, avec aperçu des modifications avant enregistrement. */
export default function FileEditor({ serverId, path, line, onClose }: { serverId: string; path: string; /** Ligne a montrer a l'ouverture (resultat de recherche). */ line?: number; onClose: () => void }) {
  const notify = useApp((s) => s.notify);
  const monacoTheme = useMonacoTheme();
  const ask = useApp((s) => s.ask);
  const [original, setOriginal] = useState<string | null>(null);
  /** Texte en cours, copié seulement pour l'aperçu des modifications. */
  const [diffText, setDiffText] = useState("");
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  /** Version Monaco du texte tel qu'il est enregistré sur le serveur. */
  const savedVersion = useRef(0);
  const [sudo, setSudo] = useState(false);
  // Sans shell (SFTP seul, FTP) : pas de sudo possible.
  const shell = useApp((s) => hasShell(s.servers.find((x) => x.id === serverId)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const saveRef = useRef<() => void>(() => {});
  /** État du fichier à l'ouverture (ou au dernier enregistrement) : sert à détecter une modification concurrente. */
  const stampRef = useRef<FileStamp | null>(null);
  /** Lecture seule par portions : fichier de plus de 50 Mo, ou pas en UTF-8. */
  const [view, setView] = useState<{ win: TextWindow; reason: "big" | "encoding" } | null>(null);
  const [moving, setMoving] = useState(false);

  const showWindow = useCallback(
    async (offset: number, withSudo: boolean, reason: "big" | "encoding", size?: number) => {
      setMoving(true);
      try {
        // Fin du fichier : la dernière portion complète.
        const start = offset < 0 ? Math.max(0, (size ?? 0) - WINDOW) : offset;
        const win = await api.fsReadRange(serverId, path, start, WINDOW, withSudo);
        setView({ win, reason });
        setSudo(withSudo);
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setMoving(false);
      }
    },
    [serverId, path],
  );

  const load = useCallback(
    async (withSudo: boolean) => {
      setError(null);
      try {
        const text = await api.fsRead(serverId, path, withSudo);
        stampRef.current = await api.fsStat(serverId, path, withSudo).catch(() => null);
        setOriginal(text);
        setSudo(withSudo);
      } catch (e) {
        const msg = errorMessage(e);
        const big = /^TOO_BIG:(\d+)/.exec(msg);
        if (big) {
          const size = Number(big[1]);
          await showWindow(isLog(path) ? -1 : 0, withSudo, "big", size);
        } else if (msg === "NOT_UTF8") {
          await showWindow(0, withSudo, "encoding");
        } else {
          setError(msg);
        }
      }
    },
    [serverId, path, showWindow],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  /** Enregistre `text` ; le texte affiché devient la référence « non modifiée ». */
  const write = async (text: string, version: number, withSudo: boolean, force = false) => {
    stampRef.current = await api.fsWrite(serverId, path, text, withSudo, force ? null : stampRef.current);
    savedVersion.current = version;
    setDirty((editorRef.current?.getModel()?.getAlternativeVersionId() ?? version) !== version);
    setOriginal(text);
  };

  const save = async () => {
    const model = editorRef.current?.getModel();
    if (!dirty || !model) return;
    const text = model.getValue();
    const version = model.getAlternativeVersionId();
    setSaving(true);
    try {
      await write(text, version, sudo);
      setShowDiff(false);
      notify(`${path} enregistré`, "success");
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.startsWith("CONFLICT")) {
        const ok = await ask({
          title: "Le fichier a changé sur le serveur",
          body: "Quelqu'un ou quelque chose (déploiement, autre session, certbot…) l'a modifié depuis que tu l'as ouvert. L'écraser fera disparaître ces changements. Pour les récupérer, annule, copie tes modifications, puis rouvre le fichier.",
          confirmLabel: "Écraser la version du serveur",
          danger: true,
        });
        if (ok) {
          try {
            await write(text, version, sudo, true);
            setShowDiff(false);
            notify(`${path} enregistré`, "success");
          } catch (e2) {
            notify(errorMessage(e2), "error");
          }
        }
      } else if (shell && !sudo && /permission|denied|refus/i.test(msg)) {
        const ok = await ask({
          title: "Permission refusée",
          body: "Ce fichier appartient à un autre utilisateur. Enregistrer en root avec sudo ?",
          confirmLabel: "Enregistrer avec sudo",
        });
        if (ok) {
          try {
            await write(text, version, true);
            setSudo(true);
            notify(`${path} enregistré (sudo)`, "success");
          } catch (e2) {
            notify(errorMessage(e2), "error");
          }
        }
      } else {
        notify(msg, "error");
      }
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  const onViewMount: OnMount = (editor) => {
    // Dernière portion d'un fichier : on se place tout en bas, comme `tail`.
    if (view && view.win.offset + view.win.len >= view.win.size && view.win.offset > 0) editor.revealLine(editor.getModel()?.getLineCount() ?? 1);
  };

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    const model = editor.getModel();
    savedVersion.current = model?.getAlternativeVersionId() ?? 0;
    // « Modifié » d'après le numéro de version de Monaco : annuler jusqu'à l'état enregistré le remet à faux.
    // Lu au tour suivant : pendant un « annuler », Monaco ne met la version à jour qu'après l'événement.
    editor.onDidChangeModelContent(() =>
      setTimeout(() => setDirty((model?.getAlternativeVersionId() ?? 0) !== savedVersion.current)),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    // Ouvert depuis un resultat de recherche : la ligne trouvee est centree et le curseur pose dessus.
    if (line && line > 0) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
    editor.focus();
  };

  const close = async () => {
    if (dirty) {
      const ok = await ask({ title: "Modifications non enregistrées", body: "Fermer sans enregistrer ?", confirmLabel: "Fermer", danger: true });
      if (!ok) return;
    }
    onClose();
  };

  return (
    <Modal
      width="max-w-6xl"
      title={
        <span className="flex items-center gap-2 font-mono text-xs">
          {path}
          {dirty && <Badge tone="warn">modifié</Badge>}
          {sudo && <Badge tone="danger">root</Badge>}
        </span>
      }
      onClose={() => void close()}
      footer={
        <>
          {view ? (
            <span className="mr-auto self-center text-xs text-muted">Lecture seule</span>
          ) : (
            <>
              <span className="mr-auto self-center text-xs text-muted">Ctrl+S pour enregistrer</span>
              <Button
                icon={<FileDiff size={14} />}
                disabled={!dirty}
                onClick={() => {
                  if (!showDiff) setDiffText(editorRef.current?.getValue() ?? "");
                  setShowDiff((v) => !v);
                }}
              >
                {showDiff ? "Éditer" : "Voir les modifications"}
              </Button>
              <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={() => void save()}>
                Enregistrer
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="h-[70vh]">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <ShieldAlert size={32} className="text-warn" />
            <p className="max-w-md text-sm text-muted">{error}</p>
            {shell && /permission|denied/i.test(error) && (
              <Button variant="primary" onClick={() => void load(true)}>
                Ouvrir en root (sudo)
              </Button>
            )}
          </div>
        ) : view ? (
          <div className="flex h-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Eye size={14} className="text-warn" />
              <span>
                {view.reason === "big"
                  ? `Fichier de ${formatBytes(view.win.size)} : lecture seule, par portions de ${formatBytes(WINDOW)}.`
                  : "Fichier dans un autre encodage que l'UTF-8 : lecture seule (les caractères non reconnus s'affichent « � »)."}
              </span>
              <span className="ml-auto font-mono">
                {formatBytes(view.win.offset)} – {formatBytes(view.win.offset + view.win.len)} sur {formatBytes(view.win.size)}
              </span>
              {view.win.len < view.win.size && (
                <span className="flex gap-1">
                  <Button title="Début du fichier" icon={<ChevronFirst size={14} />} disabled={moving || view.win.offset === 0} onClick={() => void showWindow(0, sudo, view.reason)} />
                  <Button
                    title="Portion précédente"
                    icon={<ChevronLeft size={14} />}
                    disabled={moving || view.win.offset === 0}
                    onClick={() => void showWindow(Math.max(0, view.win.offset - WINDOW), sudo, view.reason)}
                  />
                  <Button
                    title="Portion suivante"
                    icon={<ChevronRight size={14} />}
                    disabled={moving || view.win.offset + view.win.len >= view.win.size}
                    onClick={() => void showWindow(view.win.offset + view.win.len, sudo, view.reason)}
                  />
                  <Button
                    title="Fin du fichier"
                    icon={<ChevronLast size={14} />}
                    disabled={moving || view.win.offset + view.win.len >= view.win.size}
                    onClick={() => void showWindow(-1, sudo, view.reason, view.win.size)}
                  />
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                key={view.win.offset}
                value={view.win.text}
                language={languageFor(path)}
                theme={monacoTheme}
                onMount={onViewMount}
                options={{ automaticLayout: true, readOnly: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
              />
            </div>
          </div>
        ) : original === null ? (
          <p className="text-sm text-muted">Chargement…</p>
        ) : (
          <>
            {showDiff && (
              <DiffEditor
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                original={original}
                modified={diffText}
                language={languageFor(path)}
                theme={monacoTheme}
                options={{ automaticLayout: true, readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13 }}
              />
            )}
            {/* Éditeur non contrôlé et gardé monté pendant l'aperçu : le texte n'est copié qu'à
                l'enregistrement, pas à chaque frappe (sinon un fichier de 50 Mo rame). */}
            <div className={showDiff ? "hidden" : "h-full"}>
              <Editor
                defaultValue={original}
                language={languageFor(path)}
                theme={monacoTheme}
                onMount={onMount}
                options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
