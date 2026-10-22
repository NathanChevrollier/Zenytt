import {
  Activity,
  Cable,
  CircleHelp,
  Container,
  Database,
  DatabaseBackup,
  FolderTree,
  Globe,
  LayoutDashboard,
  Monitor,
  Network,
  Power,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

export type SectionId =
  | "home"
  | "servers"
  | "terminal"
  | "files"
  | "monitoring"
  | "docker"
  | "vms"
  | "databases"
  | "sites"
  | "logs"
  | "tunnels"
  | "mesh"
  | "backups"
  | "security"
  | "system"
  | "help"
  | "settings";

/**
 * Groupes de la barre latérale : « Poste » (ce qui vit sur ton PC ou couvre tous les serveurs),
 * « Serveur » (ce qui agit sur le serveur choisi en haut de la colonne), et le pied de colonne.
 */
export type SectionGroup = "poste" | "serveur" | "pied";

export interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  description: string;
  group: SectionGroup;
  /** Section qui dépend du serveur sélectionné. */
  perServer?: boolean;
}

/** Sections qui exécutent des commandes sur le serveur : absentes pour un compte SFTP seul ou FTP. */
export const needsShell = (id: SectionId) => !!SECTIONS.find((s) => s.id === id)?.perServer && id !== "files";

/** Toujours dans la barre latérale : on ne peut pas se retrouver sans accueil ni réglages. */
export const ALWAYS_VISIBLE: SectionId[] = ["home", "help", "settings"];

export const SECTIONS: Section[] = [
  { id: "home", group: "poste", label: "Accueil", icon: LayoutDashboard, description: "Santé de tous tes serveurs d'un coup d'œil." },
  { id: "terminal", group: "poste", label: "Terminal", icon: SquareTerminal, description: "Sessions SSH persistantes en onglets et panneaux, snippets, diffusion." },
  { id: "tunnels", group: "poste", label: "Tunnels", icon: Cable, description: "Accès local à des services du serveur, sans les exposer sur Internet." },
  { id: "mesh", group: "poste", label: "Réseau privé", icon: Network, description: "Relie tes serveurs de différents hébergeurs dans un réseau privé chiffré (WireGuard)." },
  { id: "servers", group: "poste", label: "Serveurs", icon: Server, description: "Profils de connexion, clés SSH et secrets stockés dans le keyring de l'OS." },
  { id: "monitoring", group: "serveur", label: "Supervision", icon: Activity, perServer: true, description: "CPU, RAM, disque, réseau, processus, services systemd et alertes." },
  { id: "files", group: "serveur", label: "Fichiers", icon: FolderTree, perServer: true, description: "Explorateur SFTP, recherche et grep distants, archives, comparaison, transferts entre serveurs, édition distante." },
  { id: "docker", group: "serveur", label: "Docker", icon: Container, perServer: true, description: "Conteneurs, logs en direct, exec, stats, compose, catalogue d'applications 1-clic, registres privés et nettoyage de disque." },
  { id: "vms", group: "serveur", label: "Machines virtuelles", icon: Monitor, perServer: true, description: "VM KVM/QEMU (libvirt) : démarrage, arrêt, écran et console série, sans rien exposer sur Internet." },
  { id: "databases", group: "serveur", label: "Bases de données", icon: Database, perServer: true, description: "Bases MySQL/MariaDB, PostgreSQL et SQLite : tables, requêtes SQL, édition en place, export CSV, et explorateur Redis." },
  { id: "sites", group: "serveur", label: "Sites", icon: Globe, perServer: true, description: "Sous-domaines nginx, certificats SSL, sauvegardes de configuration." },
  { id: "logs", group: "serveur", label: "Journaux", icon: ScrollText, perServer: true, description: "Logs Docker, systemd et nginx en direct, fusionnés et filtrables." },
  { id: "backups", group: "serveur", label: "Sauvegardes", icon: DatabaseBackup, perServer: true, description: "Sauvegardes planifiées et chiffrées (restic), restauration." },
  { id: "security", group: "serveur", label: "Sécurité", icon: ShieldCheck, perServer: true, description: "Audit du serveur et corrections guidées." },
  { id: "system", group: "serveur", label: "Système", icon: Power, perServer: true, description: "Redémarrage, extinction, nom d'hôte, fuseau, mises à jour, et alimentation via l'API de l'hébergeur." },
  { id: "help", group: "pied", label: "Aide", icon: CircleHelp, description: "Comment marche chaque fonctionnalité et ce qu'elle demande sur le serveur." },
  { id: "settings", group: "pied", label: "Réglages", icon: Settings, description: "Préférences, raccourcis, assistant IA, synchronisation et journal d'actions." },
];
