import { Suspense, lazy, useEffect, useState } from "react";
import { Copy, KeyRound, Lock, RotateCw, ShieldAlert, Trash2 } from "lucide-react";
import { api, errorMessage, shellQuote, type ComposeProject, type Container, type DeployKey, type SudoRisk } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { useApp, useAppPick } from "../lib/store";
import { Button, CodeBlock, Field, IconButton, Input, Modal } from "./ui";
import { useMonacoTheme } from "../lib/theme";

const DiffView = lazy(() => import("./DiffView"));

/** Crée et démarre un tunnel vers un port publié (ou un port de conteneur) du serveur. */
export async function tunnelTo(serverId: string, c: Container, remotePort: number) {
  const { notify } = useApp.getState();
  try {
    const localPort = await api.tunnelFreePort(remotePort < 1024 ? remotePort + 10000 : remotePort);
    const id = await api.tunnelSave({ id: "", serverId, name: `${c.name}:${remotePort}`, localPort, remoteHost: "127.0.0.1", remotePort, autoStart: false });
    await api.tunnelStart(id);
    void writeClipboard(`127.0.0.1:${localPort}`);
    notify(`${c.name} accessible sur 127.0.0.1:${localPort} (adresse copiée). Gère-le dans Réseau › Tunnels SSH.`, "success");
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Restreint un port publié sur toutes les interfaces à 127.0.0.1, après aperçu du changement. */
export function RestrictPortDialog({
  serverId,
  project,
  port,
  onClose,
  onDone,
}: {
  serverId: string;
  project: ComposeProject;
  port: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const monacoTheme = useMonacoTheme();
  const [preview, setPreview] = useState<{ file: string; before: string; after: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api.restrictPreview(serverId, project, port).then(setPreview, (e) => setError(errorMessage(e)));
  }, [serverId, project, port]);

  const apply = async () => {
    setApplying(true);
    try {
      notify(await api.restrictApply(serverId, project, port), "success");
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      title={`Restreindre le port ${port} à ce serveur`}
      width="max-w-5xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Lock size={14} />} loading={applying} disabled={!preview} onClick={() => void apply()}>
            Appliquer et redémarrer le projet
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Le port {port} ne sera plus joignable depuis Internet, seulement depuis le serveur (nginx, tunnels). Le fichier est sauvegardé, le résultat validé par docker compose, et l'ancienne version revient automatiquement si le projet ne redémarre pas.
        </p>
        {error && <pre className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs whitespace-pre-wrap text-danger">{error}</pre>}
        {preview && (
          <>
            <div className="font-mono text-xs text-muted">{preview.file}</div>
            <div className="h-[50vh]">
              <Suspense fallback={<p className="p-3 text-xs text-muted">Chargement de la comparaison…</p>}>
                <DiffView original={preview.before} modified={preview.after} language="yaml" theme={monacoTheme} />
              </Suspense>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Lance le déploiement d'un projet dans un terminal (sortie en direct). */
export async function deployProject(serverId: string, project: ComposeProject) {
  const { ask, notify, openTab } = useApp.getState();
  const host = await api.deploySuggestHost(serverId, project.name).catch(() => null);
  const ok = await ask({
    title: `Déployer ${project.name} ?`,
    body: `Télécharge les nouvelles images, redémarre le projet puis vérifie que les conteneurs tournent${host ? ` et que ${host} répond` : ""}. En cas d'échec, retour automatique à la version précédente.`,
    confirmLabel: "Déployer",
  });
  if (!ok) return;
  try {
    const cmd = await api.deployPrepare(serverId, project, host);
    openTab(serverId, { title: `Déploiement ${project.name}`, command: `${cmd}; echo; echo 'Tu peux fermer cet onglet.'; exec "$SHELL" -l` });
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Clé de déploiement restreinte pour GitHub Actions. */
export function GithubDeployDialog({ serverId, project, onClose }: { serverId: string; project: ComposeProject; onClose: () => void }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const [host, setHost] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [created, setCreated] = useState<DeployKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [risk, setRisk] = useState<SudoRisk | null>(null);
  const checkRisk = () => void api.deploySudoRisk(serverId, project).then(setRisk, () => setRisk(null));

  useEffect(() => {
    void api.deploySuggestHost(serverId, project.name).then((h) => setHost(h ?? ""), () => {});
    void api.deployKeys(serverId).then(setKeys, () => {});
    checkRisk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, project.name]);

  // La règle sudo ne crée un chemin vers root que si le compte n'y a pas déjà accès (root, groupe
  // docker) et peut modifier les fichiers du projet.
  const escalates = !!risk && !risk.root && !risk.dockerGroup && risk.writable.length > 0;

  const copy = (t: string, what: string) => {
    void writeClipboard(t);
    notify(`${what} copié`, "success");
  };

  const create = async () => {
    if (
      escalates &&
      !(await ask({
        title: "Créer la clé malgré le risque ?",
        body: "Quiconque prend le contrôle de ce compte SSH pourra devenir root sur le serveur sans mot de passe, en modifiant les fichiers du projet listés.",
        confirmLabel: "Créer quand même",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      setCreated(await api.deployKeyCreate(serverId, project, host || null));
      setKeys(await api.deployKeys(serverId));
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const active = keys.includes(project.name);

  return (
    <Modal title={`Déploiement automatique de ${project.name} depuis GitHub`} width="max-w-3xl" onClose={onClose}>
      {!created ? (
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted">
            Zenytt crée une clé SSH dédiée qui ne peut faire <strong className="text-fg">qu'une seule chose</strong> : lancer le déploiement de ce projet (pull, redémarrage, vérification, retour arrière). Pas de shell, pas de redirection, pas de port supplémentaire ouvert.
          </p>
          <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            À savoir : le déploiement tourne en root et démarre les images que ton dépôt désigne. Quiconque peut modifier le dépôt (ou ses secrets GitHub) peut donc faire tourner du code sur ce serveur. Protège la branche déployée, limite les collaborateurs, et régénère la clé si un accès est compromis.
          </p>
          {escalates && risk && (
            <div className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs">
              <p className="flex items-start gap-2 text-danger">
                <ShieldAlert size={15} className="mt-px shrink-0" />
                <span>
                  <strong>Cette clé donnerait root au compte SSH.</strong> Pour que GitHub puisse déployer, Zenytt autorise ce compte à lancer le déploiement en root
                  sans mot de passe. Or il peut modifier les fichiers du projet : il suffirait d'y ajouter un volume <span className="font-mono">/:/host</span> pour
                  prendre la main sur tout le serveur. Quiconque obtient ce compte (mot de passe volé, clé SSH copiée) deviendrait donc root.
                </span>
              </p>
              <ul className="ml-6 list-disc font-mono text-[11px] text-fg/80">
                {risk.writable.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p className="text-muted">Pour supprimer ce risque, rends ces éléments modifiables par root seulement (les données du projet ne sont pas touchées), puis revérifie :</p>
              <CodeBlock code={`sudo chown root:root ${risk.writable.map(shellQuote).join(" ")} && sudo chmod go-w ${risk.writable.map(shellQuote).join(" ")}`} />
              <div>
                <Button size="sm" icon={<RotateCw size={12} />} onClick={checkRisk}>
                  Revérifier
                </Button>
              </div>
            </div>
          )}
          <Field label="Domaine à vérifier après déploiement (optionnel)" hint="Le déploiement est annulé si ce site ne répond pas en 2xx/3xx.">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.mondomaine.fr" />
          </Field>
          {active && (
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
              <KeyRound size={14} className="text-ok" />
              <span className="flex-1">Une clé de déploiement est active pour ce projet.</span>
              <IconButton
                title="Révoquer"
                onClick={async () => {
                  if (!(await ask({ title: "Révoquer la clé de déploiement ?", body: "GitHub ne pourra plus déployer ce projet.", confirmLabel: "Révoquer", danger: true }))) return;
                  await api.deployKeyRevoke(serverId, project.name).catch((e) => notify(errorMessage(e), "error"));
                  setKeys(await api.deployKeys(serverId));
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="primary" icon={<KeyRound size={14} />} loading={busy} onClick={() => void create()}>
              {active ? "Régénérer la clé" : "Créer la clé de déploiement"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted">
            <li>Dans ton dépôt GitHub : Settings → Secrets and variables → Actions → New repository secret.</li>
            <li>
              Nom : <span className="font-mono text-fg">ZENYTT_DEPLOY_KEY</span>, valeur : la clé privée ci-dessous.
            </li>
            <li>
              Ajoute le workflow ci-dessous dans <span className="font-mono text-fg">.github/workflows/deploy.yml</span>.
            </li>
          </ol>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-muted">
              Clé privée (affichée une seule fois, Zenytt ne la conserve pas)
              <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(created.privateKey, "Clé")}>
                Copier
              </Button>
            </div>
            <pre className="max-h-32 overflow-auto rounded-md border border-warn/40 bg-bg p-2 font-mono text-[11px] select-all">{created.privateKey}</pre>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-muted">
              Workflow GitHub Actions
              <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(created.workflow, "Workflow")}>
                Copier
              </Button>
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11px] select-text">{created.workflow}</pre>
          </div>
          <p className="text-xs text-muted">
            L'empreinte du serveur est incluse dans le workflow : GitHub refusera de se connecter si la clé du serveur change. La clé se révoque depuis ce même écran.
          </p>
        </div>
      )}
    </Modal>
  );
}
