import { useEffect, useState } from "react";
import { lazy, Suspense } from "react";
import { CheckCircle2, FileCode2, Rocket } from "lucide-react";
import "../lib/monaco";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/store";
import { projectNameFromPath } from "../lib/compose";
import { useMonacoTheme } from "../lib/theme";
import { Button, Checkbox, ErrorState, Field, Input, Modal, Textarea } from "./ui";

const Editor = lazy(() => import("@monaco-editor/react"));

const validName = (n: string) => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(n);

/** Projet pré-rempli par le catalogue d'applications. */
export interface ComposePreset {
  name: string;
  yaml: string;
  env?: string;
  directory?: string;
  /** Points à savoir avant de lancer, affichés au-dessus du fichier. */
  notes?: string[];
}

/**
 * Nouveau projet Docker Compose : dossier + docker-compose.yml (+ .env), vérifiés par
 * `docker compose config` avant tout démarrage. Avec `preset`, les fichiers arrivent remplis par le
 * catalogue et restent modifiables : c'est le dernier point de relecture avant l'écriture.
 */
export default function NewComposeProject({
  serverId,
  preset,
  onClose,
  onDone,
}: {
  serverId: string;
  preset?: ComposePreset | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const monacoTheme = useMonacoTheme();
  const [name, setName] = useState(preset?.name ?? "");
  const [directory, setDirectory] = useState(preset?.directory ?? "");
  /** Le nom suit le dernier segment du dossier tant qu'il n'a pas été modifié à la main (ni venir du catalogue). */
  const [nameTouched, setNameTouched] = useState(!!preset);
  const [yaml, setYaml] = useState(preset?.yaml ?? "");
  const [env, setEnv] = useState(preset?.env ?? "");
  const [showEnv, setShowEnv] = useState(!!preset?.env?.trim());
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Le modèle suit le nom tant que le fichier n'a pas été modifié à la main. Un projet venu du
      catalogue est considéré comme déjà écrit : son fichier ne doit jamais être écrasé par le modèle. */
  const [touched, setTouched] = useState(!!preset);

  useEffect(() => {
    if (touched) return;
    const app = name || "mon-app";
    void api.dockerComposeTemplate(app, "nginx:alpine", 8100, 80).then(setYaml);
  }, [name, touched]);

  const dir = directory.trim() || `/opt/stacks/${name || "mon-app"}`;

  const create = async () => {
    if (!validName(name)) return notify("Nom de projet : minuscules, chiffres, - et _ seulement.", "error");
    setBusy(true);
    setError(null);
    try {
      const r = await api.dockerComposeCreate(serverId, name, directory.trim() || null, yaml, showEnv ? env : null, start);
      setDone(`${r.file}${r.started ? "\n\n" + r.log : ""}`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <Modal
        title="Projet créé"
        width="max-w-3xl"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Fermer
          </Button>
        }
      >
        <p className="mb-2 flex items-center gap-2 text-sm">
          <CheckCircle2 size={16} className="text-ok" /> {start ? "Projet créé et démarré." : "Projet créé (non démarré)."}
        </p>
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{done}</pre>
      </Modal>
    );
  }

  return (
    <Modal
      title={preset ? `Déployer ${preset.name}` : "Nouveau projet Docker Compose"}
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Checkbox className="mr-auto self-center" checked={start} onChange={setStart} label="Démarrer tout de suite" />
          <Button variant="primary" loading={busy} icon={start ? <Rocket size={14} /> : <FileCode2 size={14} />} disabled={!validName(name)} onClick={() => void create()}>
            {start ? "Créer et démarrer" : "Créer"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {preset?.notes && preset.notes.length > 0 && (
          <ul className="flex list-inside list-disc flex-col gap-1 rounded-lg border border-accent/40 bg-accent/8 p-3 text-xs">
            {preset.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nom du projet" hint="Nom de projet compose ; proposé d'après le dossier, modifiable.">
            <Input value={name} placeholder="mon-app" onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value.toLowerCase());
              }}
              autoFocus />
          </Field>
          <Field label="Dossier sur le serveur" hint="Vide : /opt/stacks/<nom>.">
            <Input className="font-mono text-xs" value={directory} placeholder={dir} onChange={(e) => {
                setDirectory(e.target.value);
                if (!nameTouched) setName(projectNameFromPath(e.target.value));
              }}
            />
          </Field>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <span className="font-mono">{dir}/docker-compose.yml</span>
            <button className="hover:text-fg" onClick={() => setShowEnv((v) => !v)}>
              {showEnv ? "Masquer le fichier .env" : "Ajouter un fichier .env"}
            </button>
          </div>
          <div className="h-72 overflow-hidden rounded-md border border-border">
            <Suspense fallback={null}>
              <Editor
                value={yaml}
                onChange={(v) => {
                  setTouched(true);
                  setYaml(v ?? "");
                }}
                language="yaml"
                theme={monacoTheme}
                options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false }}
              />
            </Suspense>
          </div>
        </div>
        {showEnv && (
          <Field label="Fichier .env (variables et mots de passe)" hint="Enregistré à côté du compose, lisible par root seulement (chmod 600).">
            <Textarea
              className="h-24 resize-none font-mono text-xs"
              placeholder={"MYSQL_PASSWORD=…\nAPP_SECRET=…"}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
          </Field>
        )}
        {error && <ErrorState message={<pre className="font-mono text-xs whitespace-pre-wrap">{error}</pre>} />}
        <p className="text-xs text-muted">
          Zenytt vérifie le fichier avec <span className="font-mono">docker compose config</span> avant de démarrer quoi que ce soit. Pense à ne publier les ports que sur 127.0.0.1 et à passer par un site (nginx ou Apache) pour l'exposer.
        </p>
      </div>
    </Modal>
  );
}
