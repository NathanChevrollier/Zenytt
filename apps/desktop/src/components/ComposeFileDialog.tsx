// Dialogue ouvert depuis l'explorateur sur un fichier docker compose : il montre ce que Docker fait
// déjà du projet (rien, lancé depuis ce fichier, ou lancé depuis un autre dossier) et propose les
// actions qui ont du sens dans cette situation.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Hammer, Layers, Play, Replace, RotateCw, ScrollText, Square, Trash2, UploadCloud } from "lucide-react";
import { api, errorMessage, type ComposeFileInfo, type ComposeProject } from "../lib/api";
import { composeChoices, type ComposeChoice } from "../lib/compose";
import { composeLockKey, confirmDestructive, useLocks } from "../lib/folders";
import { useApp, useAppPick } from "../lib/store";
import { Badge, Button, CodeBlock, Loading, Modal } from "./ui";

interface ChoiceSpec {
  label: string;
  icon: ReactNode;
  variant?: "primary" | "danger";
  /** Confirmation demandée avant d'agir. */
  confirm?: string;
}

const CHOICES: Record<ComposeChoice, ChoiceSpec> = {
  launch: { label: "Lancer", icon: <Play size={14} />, variant: "primary" },
  launchBuild: { label: "Lancer en reconstruisant", icon: <Hammer size={14} /> },
  start: { label: "Démarrer", icon: <Play size={14} />, variant: "primary" },
  restart: { label: "Redémarrer", icon: <RotateCw size={14} />, variant: "primary" },
  update: { label: "Mettre à jour", icon: <UploadCloud size={14} /> },
  rebuild: {
    label: "Reconstruire",
    icon: <Hammer size={14} />,
    confirm: "Le projet sera arrêté, les images récupérées, les services reconstruits puis redémarrés. Les volumes nommés sont conservés, mais le service sera indisponible pendant l'opération.",
  },
  logs: { label: "Journaux", icon: <ScrollText size={14} /> },
  stop: { label: "Arrêter", icon: <Square size={14} /> },
  down: { label: "Supprimer les conteneurs", icon: <Trash2 size={14} />, variant: "danger", confirm: "Les conteneurs du projet seront supprimés (les volumes nommés sont conservés)." },
  replace: {
    label: "Remplacer par celui-ci",
    icon: <Replace size={14} />,
    variant: "primary",
    confirm: "Les conteneurs de l'ancien projet seront supprimés puis recréés depuis ce fichier. Les volumes nommés sont conservés (même nom de projet), mais le service sera coupé quelques secondes.",
  },
  launchAs: { label: "Lancer sous un autre nom…", icon: <Layers size={14} /> },
};

export default function ComposeFileDialog({ serverId, file, onClose }: { serverId: string; file: string; onClose: () => void }) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
  const [info, setInfo] = useState<ComposeFileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ComposeChoice | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const locks = useLocks(serverId);

  const load = useCallback(() => {
    setError(null);
    api.composeFileInfo(serverId, file).then(setInfo, (e) => setError(errorMessage(e)));
  }, [serverId, file]);
  useEffect(load, [load]);

  const run = async (choice: ComposeChoice) => {
    if (!info) return;
    const spec = CHOICES[choice];
    const existing: ComposeProject | null = info.state.kind === "same" || info.state.kind === "conflict" ? info.state.project : null;
    // Un projet verrouillé demande de retaper son nom pour toute action qui interrompt le service.
    const locked = !!existing && ["stop", "down", "rebuild", "restart", "replace"].includes(choice) && locks.isLocked(composeLockKey(existing));
    if (locked || spec.confirm) {
      if (!(await confirmDestructive({ title: `${spec.label} « ${info.project} » ?`, body: spec.confirm ?? "Le service sera interrompu.", confirmLabel: spec.label, name: existing?.name ?? info.project, locked, danger: spec.variant === "danger" }))) return;
    }
    if (choice === "logs" && existing) {
      openTab(serverId, { title: `${existing.name} (logs)`, command: await api.composeCommand(existing, "logs -f --tail 200") });
      onClose();
      return;
    }
    let name = info.project;
    if (choice === "launchAs") {
      const input = await ask({ title: "Lancer sous un autre nom", body: "Minuscules, chiffres, - et _. Les conteneurs et volumes de ce projet seront distincts de ceux de l'existant.", input: { label: "Nom du projet", initial: `${info.project}-2` }, confirmLabel: "Lancer" });
      if (typeof input !== "string" || !input.trim()) return;
      name = input.trim();
    }
    setBusy(choice);
    setLog(null);
    try {
      let out: string;
      if (choice === "launch" || choice === "launchBuild" || choice === "launchAs") {
        out = await api.composeLaunch(serverId, file, name, choice === "launchBuild", null);
      } else if (choice === "replace" && existing) {
        out = await api.composeLaunch(serverId, file, info.project, info.hasBuild, existing.name);
      } else if (existing) {
        const action = { start: "up", restart: "restart", update: "update", rebuild: "rebuild", stop: "stop", down: "down" }[choice as "start"] ?? choice;
        out = await api.composeAction(serverId, existing, action);
      } else {
        return;
      }
      setLog(out.trim() || "Terminé.");
      notify(`« ${name} » : ${spec.label.toLowerCase()} — terminé.`, "success");
      load();
    } catch (e) {
      setLog(errorMessage(e));
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const goDocker = () => {
    useApp.getState().setSection("docker");
    onClose();
  };

  return (
    <Modal
      title="Docker Compose"
      description={<span className="font-mono text-xs">{file}</span>}
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={goDocker}>
            Voir dans Docker
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Fermer
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !info ? (
        <Loading label="Analyse du fichier…" />
      ) : (
        <div className="flex flex-col gap-4">
          <StateLine info={info} />
          {info.busyPorts.length > 0 && (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
              Port{info.busyPorts.length > 1 ? "s" : ""} déjà utilisé{info.busyPorts.length > 1 ? "s" : ""} sur le serveur : <strong>{info.busyPorts.join(", ")}</strong>. Le lancement échouera tant qu'un autre service les occupe.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {composeChoices(info).map((c) => (
              <Button key={c} variant={CHOICES[c].variant ?? "outline"} icon={CHOICES[c].icon} loading={busy === c} disabled={busy !== null} onClick={() => void run(c)}>
                {CHOICES[c].label}
              </Button>
            ))}
          </div>
          {log !== null && <CodeBlock code={log} className="max-h-72 overflow-auto" />}
        </div>
      )}
    </Modal>
  );
}

function StateLine({ info }: { info: ComposeFileInfo }) {
  const s = info.state;
  const name = <strong>{info.project}</strong>;
  switch (s.kind) {
    case "invalid":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            <Badge tone="danger">Fichier refusé</Badge> Docker ne peut pas lire ce fichier :
          </p>
          <CodeBlock code={s.message} className="max-h-60 overflow-auto" />
        </div>
      );
    case "notRunning":
      return (
        <p className="text-sm">
          <Badge tone="muted">Pas lancé</Badge> Aucun projet {name} n'existe sur ce serveur.{info.ports.length > 0 && ` Ports publiés : ${info.ports.join(", ")}.`}
        </p>
      );
    case "same":
      return (
        <p className="text-sm">
          <Badge tone={s.running ? "ok" : "muted"}>{s.running ? "En marche" : "Arrêté"}</Badge> Le projet {name} {s.running ? "tourne déjà" : "existe"}, lancé depuis ce fichier ({s.project.status}).
        </p>
      );
    case "conflict":
      return (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            <Badge tone="warn">Déjà lancé ailleurs</Badge> Un projet {name} existe déjà ({s.project.status}), lancé depuis un autre fichier :
          </p>
          <p className="font-mono text-xs text-muted">{s.project.configFiles}</p>
          {s.project.missing && <p className="text-muted">Ce fichier n'existe plus : le dossier a sans doute été renommé ou déplacé. « Remplacer » relance le projet depuis ici.</p>}
        </div>
      );
  }
}
