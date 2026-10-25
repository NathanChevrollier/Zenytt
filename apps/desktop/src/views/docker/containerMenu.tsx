import { FileSearch, FolderInput, FolderPlus, Pause, Play, RotateCw, ScrollText, Square, SquareTerminal, Trash2 } from "lucide-react";
import type { Container } from "../../lib/api";
import { askFolderName } from "../../components/Folders";
import type { MenuItem } from "../../components/ui";
import type { useContainerFolders } from "./shared";

/** Menu ⋯ complet d'un conteneur (tableau et services des cartes de projets). */
export function containerMenu(
  c: Container,
  o: { act: (c: Container, action: string) => void; shell: (c: Container) => void; logs: (c: Container) => void; details: (c: Container) => void; folders: ReturnType<typeof useContainerFolders> },
): MenuItem[] {
  const { act, folders } = o;
  const running = c.state === "running";
  return [
    ...(running
      ? [
          { label: "Redémarrer", icon: <RotateCw size={14} />, onClick: () => act(c, "restart") },
          { label: "Arrêter", icon: <Square size={13} />, onClick: () => act(c, "stop") },
          { label: "Mettre en pause", icon: <Pause size={14} />, onClick: () => act(c, "pause") },
          { label: "Shell", icon: <SquareTerminal size={14} />, onClick: () => o.shell(c) },
        ]
      : [{ label: c.state === "paused" ? "Reprendre" : "Démarrer", icon: <Play size={14} />, onClick: () => act(c, c.state === "paused" ? "unpause" : "start") }]),
    { label: "Logs en direct", icon: <ScrollText size={14} />, onClick: () => o.logs(c) },
    { label: "Détails et inspect", icon: <FileSearch size={14} />, onClick: () => o.details(c) },
    "separator",
    { heading: "Ranger dans un dossier (local)" },
    ...folders.names.filter((f) => f !== folders.folderOf(c.name)).map((f) => ({ label: f, icon: <FolderInput size={14} />, onClick: () => folders.move([c.name], f) })),
    ...(folders.folderOf(c.name) ? [{ label: "Sortir du dossier", onClick: () => folders.move([c.name], null) }] : []),
    {
      label: "Nouveau dossier…",
      icon: <FolderPlus size={14} />,
      onClick: async () => {
        const name = await askFolderName("Nouveau dossier de conteneurs");
        if (name) folders.move([c.name], name);
      },
    },
    ...(!running ? (["separator", { label: "Supprimer…", icon: <Trash2 size={14} />, danger: true, onClick: () => act(c, "remove") }] as MenuItem[]) : []),
  ];
}
