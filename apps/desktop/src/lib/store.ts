import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage, hasShell, type ServerView } from "./api";
import type { SectionId } from "../sections";
import type { GuideId } from "./guides";
import type { ThemeSetting } from "./theme";

export interface DialogRequest {
  title: string;
  body?: string;
  /** Texte affiché en police mono (empreinte, commande…). */
  code?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Si défini, le dialogue demande une saisie (mot de passe si `secret`). */
  input?: { label: string; secret?: boolean; initial?: string };
  resolve: (value: string | boolean | null) => void;
}

export interface Toast {
  id: number;
  kind: "info" | "warn" | "error" | "success";
  message: string;
}

export interface NotificationEntry extends Toast {
  /** Horodatage (ms). */
  at: number;
  /** Serveur actif au moment de la notification, pour le contexte. */
  serverId: string | null;
}

const MAX_NOTIFICATIONS = 60;

export interface TermTab {
  /** Identifiant stable (survit au redémarrage de l'app). */
  key: string;
  serverId: string;
  title: string;
  /** Commande interactive à lancer à la place du shell (ex. `docker exec -it`). */
  command?: string;
  /** Session tmux du panneau principal (sessions persistantes). */
  tmux?: string;
  /** Écran divisé : session tmux du second panneau, ou "" pour un shell simple. */
  split?: string | null;
  /** Orientation de la division : côte à côte (« cols », par défaut) ou l'un au-dessus de l'autre. */
  splitDir?: "cols" | "rows";
  /** Serveur du second panneau, s'il diffère de celui de l'onglet (deux hôtes côte à côte). */
  splitServerId?: string;
  /** Onglet multi-serveurs : une grille de panneaux, un par serveur, pour diffuser la saisie. */
  grid?: GridPane[];
  /** Onglet invité : invitation à un terminal partagé par quelqu'un d'autre. */
  join?: string;
}

export interface GridPane {
  serverId: string;
  /** Session tmux du panneau (sessions persistantes), absente pour un shell simple. */
  tmux?: string;
}

/** Raccourci vers un dossier du serveur, dans l'explorateur de fichiers. */
export interface Bookmark {
  path: string;
  name: string;
}

export interface Settings {
  /** Ouvrir les terminaux dans des sessions tmux persistantes. */
  persistentSessions: boolean;
  /** Serveurs pour lesquels l'installation de tmux a été refusée. */
  tmuxDeclined: Record<string, boolean>;
  /** Verrouillage automatique après N minutes d'inactivité (0 : jamais). */
  lockMinutes: number;
  /** Taille de police des terminaux (Ctrl+= / Ctrl+- / Ctrl+0). */
  terminalFontSize: number;
  /** Notifications Windows pour les nouvelles alertes, tant que Zenytt est ouvert. */
  alertNotifications: boolean;
  /** Thème de l'interface. */
  theme: ThemeSetting;
  /** Raccourcis personnalisés (les autres gardent leur valeur par défaut). */
  shortcuts?: Record<string, string>;
  /** Clic droit dans le terminal : menu contextuel, ou copier/coller direct comme PuTTY. */
  terminalRightClick: "menu" | "paste";
  /** Petit monitoring (CPU, RAM, disque, réseau) sous le terminal. */
  terminalStatusBar: boolean;
  /** Actualisation automatique des pages (Docker, sites, fichiers…), en secondes (0 : manuelle). */
  autoRefreshSecs: number;
  /** Afficher les fichiers et dossiers dont le nom commence par un point. */
  showHiddenFiles: boolean;
  /** Fermeture de la fenêtre : demander, réduire dans la zone de notification, ou quitter. */
  closeAction: CloseAction;
  /** Avant de quitter, avertir s'il reste des tunnels, transferts ou terminaux ouverts. */
  confirmQuit: boolean;
  /** Onglets masqués dans la barre latérale (toujours joignables par la palette). */
  hiddenSections?: SectionId[];
  /** Copie sur ce PC du dépôt de sauvegarde de chaque serveur (par identifiant de serveur). */
  backupMirrors?: Record<string, BackupMirror>;
  /** Écran d'une VM ouvert depuis le tiroir Machines : dans Zenytt, ou dans le client du système. */
  vmScreen?: "internal" | "external";
}

/** Copie locale d'un dépôt restic : dossier, et résultat de la dernière mise à jour. */
export interface BackupMirror {
  dir: string;
  lastAt?: number;
  files?: number;
  totalBytes?: number;
}

export type CloseAction = "ask" | "tray" | "quit";

/** Partie de l'état sauvegardée dans zenytt.json et restaurée au démarrage. */
interface Persisted {
  v: 1;
  section: SectionId;
  tabs: TermTab[];
  activeTab: string | null;
  filesPaths: Record<string, string>;
  settings: Settings;
  recent: string[];
  bookmarks?: Record<string, Bookmark[]>;
  folders?: Folders;
}

/** Dossiers de classement (serveurs, conteneurs Docker, clients des sites et projets compose), propres à ce PC. */
export interface Folders {
  /** Dossiers de serveurs créés, même vides (le dossier d'un serveur est son champ `group`). */
  servers: string[];
  /** Par serveur : nom du conteneur → dossier. */
  containers: Record<string, Record<string, string>>;
  /** Par serveur : dossiers de conteneurs créés, même vides. */
  containerFolders: Record<string, string[]>;
  /** Par serveur : UUID de la machine virtuelle → dossier. */
  vms?: Record<string, Record<string, string>>;
  /** Par serveur : dossiers de machines virtuelles créés, même vides. */
  vmFolders?: Record<string, string[]>;
  /** Par serveur : domaine d'un site → client. */
  sites?: Record<string, Record<string, string>>;
  /** Par serveur : clients de sites créés, même vides. */
  siteFolders?: Record<string, string[]>;
  /** Par serveur : dossier d'un projet compose → client. */
  compose?: Record<string, Record<string, string>>;
  /** Par serveur : clients de projets compose créés, même vides. */
  composeFolders?: Record<string, string[]>;
  /** Par serveur : sites (`site:<domaine>`) et projets compose (`compose:<dossier>`) verrouillés. */
  locks?: Record<string, string[]>;
  /** Dossiers repliés (`servers:<nom>`, `docker:<serveur>:<nom>`, `vms:<serveur>:<nom>`, `sites:<serveur>:<nom>` ou `compose:<serveur>:<nom>`). */
  collapsed: string[];
}

const NO_FOLDERS: Folders = { servers: [], containers: {}, containerFolders: {}, collapsed: [] };

interface State {
  hydrated: boolean;
  /** `saved` : lecture de l'état déjà lancée (en parallèle de la liste des serveurs, au démarrage). */
  hydrate: (saved?: Promise<unknown>) => Promise<void>;

  section: SectionId;
  setSection: (s: SectionId) => void;

  /** Fiche d'aide courante : en fenêtre depuis le « ? » d'une page, ou dépliée dans la section Aide. */
  guide: GuideId | null;
  guideInPage: boolean;
  /** « ? » d'une page : montre uniquement la fiche de cette page, sans quitter l'écran. */
  openGuide: (id: GuideId | null) => void;
  /** Palette ou section Aide : ouvre la fiche dans la page Aide. */
  openHelpPage: (id: GuideId) => void;

  servers: ServerView[];
  refreshServers: () => Promise<void>;
  activeServerId: string | null;
  setActiveServer: (id: string | null) => void;

  dialog: DialogRequest | null;
  ask: (req: Omit<DialogRequest, "resolve">) => Promise<string | boolean | null>;
  closeDialog: (value: string | boolean | null) => void;

  toasts: Toast[];
  notify: (message: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
  /** Historique des notifications de la session (centre de notifications), les plus récentes d'abord. */
  notifications: NotificationEntry[];
  unreadNotifications: number;
  markNotificationsRead: () => void;
  clearNotifications: () => void;

  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;

  tabs: TermTab[];
  activeTab: string | null;
  openTab: (serverId: string, opts?: { title?: string; command?: string; tmux?: string }) => void;
  /** Ouvre un onglet avec un terminal par serveur, en grille ; renvoie sa clé. */
  openGridTab: (serverIds: string[]) => string;
  /** Ouvre l'onglet d'un terminal partagé par quelqu'un d'autre (invitation). */
  openJoinTab: (code: string, title: string) => void;
  closeTab: (key: string) => void;
  setActiveTab: (key: string) => void;
  updateTab: (key: string, patch: Partial<TermTab>) => void;

  /** Dernier dossier ouvert dans l'explorateur, par serveur. */
  filesPaths: Record<string, string>;
  setFilesPath: (serverId: string, path: string) => void;

  /** Raccourcis de dossiers, par serveur. */
  bookmarks: Record<string, Bookmark[]>;
  addBookmark: (serverId: string, path: string, name?: string) => void;
  removeBookmark: (serverId: string, path: string) => void;
  renameBookmark: (serverId: string, path: string, name: string) => void;

  /** Identifiants des dernières actions de la palette (les plus récentes d'abord). */
  recent: string[];
  pushRecent: (id: string) => void;

  folders: Folders;
  setFolders: (update: (f: Folders) => Folders) => void;
}

const ACTIVE_SERVER_KEY = "zenytt.activeServer";
let toastSeq = 0;

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function newTmuxName(): string {
  return `zenytt-${newId()}`;
}

function readActiveServer(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SERVER_KEY);
  } catch {
    return null;
  }
}

export const useApp = create<State>((set, get) => ({
  hydrated: false,
  hydrate: async (saved) => {
    try {
      const raw = (await (saved ?? api.uiStateGet())) as Partial<Persisted> | null;
      if (raw && raw.v === 1) {
        // L'ancienne section « Sécurité » vit désormais dans Système (onglet Sécurité).
        const legacySecurity = (raw.section as string) === "security";
        if (legacySecurity) void import("./shell").then(({ useShell }) => useShell.setState({ intent: { section: "system", tab: "security" } }));
        set({
          section: legacySecurity ? "system" : (raw.section ?? "servers"),
          // Les sessions partagées ne survivent pas à la fermeture de l'app.
          tabs: (raw.tabs ?? []).filter((t) => !t.join),
          activeTab: raw.activeTab ?? null,
          filesPaths: raw.filesPaths ?? {},
          settings: { ...get().settings, ...raw.settings },
          recent: raw.recent ?? [],
          bookmarks: raw.bookmarks ?? {},
          folders: { ...NO_FOLDERS, ...raw.folders },
        });
      }
    } catch {
      /* état illisible : on repart d'un espace de travail vide */
    }
    set({ hydrated: true });
  },

  section: "home",
  setSection: (section) => set({ section }),

  guide: null,
  guideInPage: false,
  openGuide: (guide) => set({ guide, guideInPage: false }),
  openHelpPage: (guide) => set({ guide, guideInPage: true, section: "help" }),

  servers: [],
  refreshServers: async () => {
    const servers = await api.servers();
    const active = get().activeServerId;
    set((s) => ({
      servers,
      activeServerId: active && servers.some((x) => x.id === active) ? active : (servers[0]?.id ?? null),
      // Les onglets et raccourcis d'un serveur supprimé disparaissent.
      tabs: s.tabs
        // Les onglets invités ne dépendent d'aucun serveur local.
        .filter((t) => !!t.join || servers.some((x) => x.id === t.serverId))
        .map((t) => {
          const known = (id: string) => servers.some((x) => x.id === id);
          if (t.splitServerId && !known(t.splitServerId)) return { ...t, split: null, splitServerId: undefined };
          if (t.grid && !t.grid.every((g) => known(g.serverId))) return { ...t, grid: t.grid.filter((g) => known(g.serverId)) };
          return t;
        }),
      bookmarks: Object.fromEntries(Object.entries(s.bookmarks).filter(([id]) => servers.some((x) => x.id === id))),
    }));
  },
  activeServerId: readActiveServer(),
  setActiveServer: (id) => {
    try {
      if (id) localStorage.setItem(ACTIVE_SERVER_KEY, id);
    } catch {
      /* stockage indisponible : on garde juste l'état en mémoire */
    }
    set({ activeServerId: id });
  },

  dialog: null,
  ask: (req) => new Promise((resolve) => set({ dialog: { ...req, resolve } })),
  closeDialog: (value) => {
    get().dialog?.resolve(value);
    set({ dialog: null });
  },

  toasts: [],
  notifications: [],
  unreadNotifications: 0,
  markNotificationsRead: () => set({ unreadNotifications: 0 }),
  clearNotifications: () => set({ notifications: [], unreadNotifications: 0 }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  notify: (message, kind = "info") => {
    const id = ++toastSeq;
    set((s) => ({
      // Au plus 4 notifications à l'écran : une rafale d'erreurs ne doit pas couvrir la fenêtre.
      toasts: [...s.toasts, { id, kind, message }].slice(-4),
      notifications: [{ id, kind, message, at: Date.now(), serverId: s.activeServerId }, ...s.notifications].slice(0, MAX_NOTIFICATIONS),
      unreadNotifications: s.unreadNotifications + 1,
    }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" || kind === "warn" ? 8000 : 4000);
  },

  settings: { persistentSessions: true, tmuxDeclined: {}, lockMinutes: 0, terminalFontSize: 14, alertNotifications: true, theme: "dark", terminalRightClick: "menu", terminalStatusBar: true, autoRefreshSecs: 15, showHiddenFiles: false, closeAction: "ask", confirmQuit: true },
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  tabs: [],
  activeTab: null,
  openTab: (serverId, opts = {}) => {
    if (!hasShell(get().servers.find((s) => s.id === serverId))) {
      get().notify("Ce serveur n'a pas de shell : il n'offre que les fichiers.", "warn");
      return;
    }
    const { servers, settings } = get();
    const server = servers.find((s) => s.id === serverId);
    const key = newId();
    const title = opts.title ?? server?.name ?? "Terminal";
    // Un shell simple devient persistant ; une commande (logs, exec…) reste éphémère.
    const tmux = opts.tmux ?? (!opts.command && settings.persistentSessions && !settings.tmuxDeclined[serverId] ? newTmuxName() : undefined);
    set((s) => ({ tabs: [...s.tabs, { key, serverId, title, command: opts.command, tmux }], activeTab: key, section: "terminal" }));
  },
  openGridTab: (serverIds) => {
    const { servers, settings } = get();
    const key = newId();
    const grid = serverIds.map((serverId) => ({
      serverId,
      tmux: settings.persistentSessions && !settings.tmuxDeclined[serverId] ? newTmuxName() : undefined,
    }));
    const names = serverIds.map((id) => servers.find((s) => s.id === id)?.name ?? "?");
    const title = names.length > 2 ? `${names.slice(0, 2).join(" + ")} +${names.length - 2}` : names.join(" + ");
    set((s) => ({ tabs: [...s.tabs, { key, serverId: serverIds[0], title, grid }], activeTab: key, section: "terminal" }));
    return key;
  },
  openJoinTab: (code, title) => {
    const key = newId();
    set((s) => ({ tabs: [...s.tabs, { key, serverId: "", title, join: code }], activeTab: key, section: "terminal" }));
  },
  closeTab: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeTab = s.activeTab === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeTab;
      return { tabs, activeTab };
    }),
  setActiveTab: (activeTab) => set({ activeTab }),
  updateTab: (key, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) })),

  filesPaths: {},
  setFilesPath: (serverId, path) => set((s) => ({ filesPaths: { ...s.filesPaths, [serverId]: path } })),

  bookmarks: {},
  addBookmark: (serverId, path, name) =>
    set((s) => {
      const list = s.bookmarks[serverId] ?? [];
      if (list.some((b) => b.path === path)) return {};
      const label = name ?? (path.split("/").filter(Boolean).pop() || "/");
      return { bookmarks: { ...s.bookmarks, [serverId]: [...list, { path, name: label }] } };
    }),
  removeBookmark: (serverId, path) =>
    set((s) => ({ bookmarks: { ...s.bookmarks, [serverId]: (s.bookmarks[serverId] ?? []).filter((b) => b.path !== path) } })),
  renameBookmark: (serverId, path, name) =>
    set((s) => ({ bookmarks: { ...s.bookmarks, [serverId]: (s.bookmarks[serverId] ?? []).map((b) => (b.path === path ? { ...b, name } : b)) } })),

  recent: [],
  pushRecent: (id) => set((s) => ({ recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, 30) })),

  folders: NO_FOLDERS,
  setFolders: (update) => set((s) => ({ folders: update(s.folders) })),
}));

// Sauvegarde de l'espace de travail, regroupée pour ne pas écrire à chaque frappe.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastSaved = "";
let lastRefs: unknown[] = [];
useApp.subscribe((s) => {
  if (!s.hydrated) return;
  // Le store change sans cesse (notifications, état des serveurs, transferts…) : on ne sérialise
  // que si l'une des parties sauvegardées a changé de référence.
  const refs = [s.section, s.tabs, s.activeTab, s.filesPaths, s.settings, s.recent, s.bookmarks, s.folders];
  if (refs.length === lastRefs.length && refs.every((r, i) => r === lastRefs[i])) return;
  lastRefs = refs;
  const snapshot: Persisted = {
    v: 1,
    section: s.section,
    tabs: s.tabs,
    activeTab: s.activeTab,
    filesPaths: s.filesPaths,
    settings: s.settings,
    recent: s.recent,
    bookmarks: s.bookmarks,
    folders: s.folders,
  };
  const json = JSON.stringify(snapshot);
  if (json === lastSaved) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    lastSaved = json;
    void api.uiStateSet(snapshot).catch(() => {});
  }, 500);
});

/**
 * Connecte le serveur en gérant les cas qui demandent l'avis de l'utilisateur :
 * clé d'hôte inconnue ou modifiée, mot de passe absent.
 */
/**
 * `force` : action explicite de l'utilisateur (clic sur Connecter…) ; seule elle relance une
 * connexion suspendue après un échec d'authentification.
 */
export async function ensureConnected(serverId: string, opts: { interactive?: boolean; force?: boolean } = {}): Promise<boolean> {
  const interactive = opts.interactive ?? true;
  const { ask, notify, refreshServers } = useApp.getState();
  const server = () => useApp.getState().servers.find((s) => s.id === serverId);

  // Serveur de rebond : on le connecte d'abord, avec ses propres dialogues (clé d'hôte, mot de
  // passe), pour qu'une approbation porte toujours sur le bon serveur.
  const jump = server()?.jumpId;
  if (jump && jump !== serverId && !(await ensureConnected(jump, opts))) return false;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // Une tentative interactive (clic de l'utilisateur) lève la suspension après un échec d'authentification.
      await api.connect(serverId, opts.force ?? false);
      void refreshServers();
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      // En arrière-plan (reconnexion, vue d'ensemble), on n'ouvre jamais de dialogue.
      if (!interactive) return false;
      if (msg.startsWith("UNKNOWN_HOST_KEY:")) {
        const fp = msg.slice("UNKNOWN_HOST_KEY:".length);
        const ok = await ask({
          title: "Nouveau serveur",
          body: `C'est la première connexion à ${server()?.host}. Vérifie que l'empreinte de sa clé correspond bien à celle de ton VPS avant de l'approuver.`,
          code: fp,
          confirmLabel: "Approuver et se connecter",
        });
        if (!ok) return false;
        await api.trustHost(serverId, fp);
        continue;
      }
      if (msg.startsWith("HOST_KEY_MISMATCH:")) {
        const [expected, got] = msg.slice("HOST_KEY_MISMATCH:".length).split("|");
        const ok = await ask({
          title: "⚠ La clé du serveur a changé",
          body: "La clé présentée ne correspond pas à celle enregistrée. C'est normal après une réinstallation du VPS, mais cela peut aussi signaler une attaque. N'accepte que si tu sais pourquoi elle a changé.",
          code: `Attendue : ${expected}\nReçue :   ${got}`,
          confirmLabel: "Accepter la nouvelle clé",
          danger: true,
        });
        if (!ok) return false;
        await api.trustHost(serverId, got);
        continue;
      }
      if (msg.startsWith("NEED_PASSWORD")) {
        const s = server();
        if (!s) return false;
        // Serveur lié à la banque : le mot de passe est celui de l'identifiant, partagé.
        const identity = s.identityId ? (await api.identities()).find((i) => i.id === s.identityId) : undefined;
        const pw = await ask({
          title: `Mot de passe pour ${s.username}@${s.host}`,
          body: identity
            ? `Il sera enregistré dans l'identifiant « ${identity.name} » (coffre-fort du système) et servira à tous les serveurs qui l'utilisent.`
            : "Il sera enregistré dans le coffre-fort de ton système (Gestionnaire d'identification Windows / Trousseau).",
          input: { label: "Mot de passe", secret: true },
          confirmLabel: "Se connecter",
        });
        if (typeof pw !== "string" || !pw) return false;
        if (identity) await api.identitySave(identity, { password: pw });
        else await api.saveServer(s, { password: pw });
        continue;
      }
      // Serveur injoignable : on propose le diagnostic réseau (IP bannie, sshd arrêté, serveur éteint…).
      const { isNetworkFailure, useDoctor } = await import("../components/ConnectionDoctor");
      if (isNetworkFailure(msg)) {
        const ok = await ask({ title: `${server()?.name ?? "Serveur"} injoignable`, body: msg, confirmLabel: "Diagnostiquer" });
        if (ok) useDoctor.getState().open(serverId);
      } else {
        notify(msg, "error");
      }
      return false;
    }
  }
  return false;
}

/**
 * Abonne le composant aux seuls champs demandés : il ne se redessine que si l'un d'eux change,
 * pas à chaque notification, onglet ou changement d'état d'un serveur.
 */
export function useAppPick<K extends keyof State>(...keys: K[]): Pick<State, K> {
  return useApp(
    useShallow((s) => {
      const out = {} as Pick<State, K>;
      for (const k of keys) out[k] = s[k];
      return out;
    }),
  );
}
