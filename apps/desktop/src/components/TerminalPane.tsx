import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ClipboardPaste, Circle, Copy, Eraser, EyeOff, FolderOpen, History, ScrollText, Search, Share2, Sparkles, Square, TextSelect, Upload, Users, X } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon, type ClipboardSelectionType } from "@xterm/addon-clipboard";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type ShareMode, type TermEvent } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { broadcastInput, isBroadcasting, useBroadcast } from "../lib/broadcast";
import { useTheme } from "../lib/theme";
import { display, isAppShortcut, matches, shortcutOf } from "../lib/shortcuts";
import { focusedTerminal } from "../lib/focus";
import { paneCwd, uploadToPane, usePanes } from "../lib/panes";
import { cwdFromPrompt } from "../lib/prompt-cwd";
import { registerPaneActions, usePaneStatus } from "../lib/paneActions";
import { ask as askAssistant, explain } from "../lib/assistant";
import { diagnosePrompt, findLastFailure, type Failure } from "../lib/terminal-errors";
import { readClipboard, writeClipboard } from "../lib/clipboard";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Button, Modal } from "./ui";

// Chargée à la demande : l'historique n'est lu que lorsqu'on l'ouvre.
const HistoryPalette = lazy(() => import("./HistoryPalette"));


const THEME = {
  background: "#0b0c0e",
  foreground: "#d7dae0",
  cursor: "#8ab4ff",
  selectionBackground: "#8ab4ff44",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  selectionBackground: "#0969da33",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

// Décodage natif quand le moteur le propose (bien plus rapide que la boucle ci-dessous).
const nativeFromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64?.bind(Uint8Array);

function decode(b64: string): Uint8Array {
  if (nativeFromBase64) return nativeFromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Présence de tmux par serveur : vrai, faux, ou null si la vérification a échoué (rien n'est alors mis en cache). */
const tmuxPresent = new Map<string, Promise<boolean>>();

function tmuxAvailable(serverId: string): Promise<boolean | null> {
  let p = tmuxPresent.get(serverId);
  if (!p) {
    p = api.tmuxCheck(serverId).then((v) => !!v);
    tmuxPresent.set(serverId, p);
  }
  return p.catch(() => {
    tmuxPresent.delete(serverId);
    return null;
  });
}

/** Serveurs pour lesquels l'installation de tmux a déjà été proposée pendant cette session de l'app. */
const tmuxOffered = new Set<string>();

/** Propose tmux une fois le terminal ouvert, sans bloquer son ouverture. */
async function offerTmux(serverId: string) {
  const { settings, setSettings, ask, notify } = useApp.getState();
  if (settings.tmuxDeclined[serverId] || tmuxOffered.has(serverId)) return;
  tmuxOffered.add(serverId);
  const ok = await ask({
    title: "Sessions persistantes",
    body: "tmux n'est pas installé sur ce serveur. Il permet de retrouver tes terminaux intacts après une coupure réseau ou la fermeture de l'app. L'installer maintenant (paquet officiel de ta distribution) ? Les prochains terminaux ouverts en profiteront.",
    confirmLabel: "Installer tmux",
  });
  if (!ok) {
    setSettings({ tmuxDeclined: { ...useApp.getState().settings.tmuxDeclined, [serverId]: true } });
    return;
  }
  try {
    await api.tmuxInstall(serverId);
    tmuxPresent.set(serverId, Promise.resolve(true));
    notify("tmux installé : les prochains terminaux seront persistants", "success");
  } catch (e) {
    const msg = errorMessage(e);
    // Aucun gestionnaire de paquets utilisable (Unraid…) : on explique quoi faire, une seule fois,
    // et on n'en reparle plus pour ce serveur (réactivable dans les réglages).
    if (msg.startsWith("UNSUPPORTED:")) {
      setSettings({ tmuxDeclined: { ...useApp.getState().settings.tmuxDeclined, [serverId]: true } });
      await ask({ title: "tmux non installable automatiquement", body: msg.slice("UNSUPPORTED:".length).trim(), confirmLabel: "Compris" });
      return;
    }
    notify(`Installation de tmux impossible : ${msg}`, "error");
  }
}

/**
 * Presse-papiers pour les séquences OSC 52 (sélection à la souris dans tmux, vim…) : écriture seule,
 * et seulement quand ce terminal a le focus (on est en train de s'en servir). Un programme en
 * arrière-plan ne remplace pas en silence ce que tu viens de copier ailleurs.
 */
function writeOnlyClipboard(focused: () => boolean) {
  return {
    readText: (_s: ClipboardSelectionType) => "",
    writeText: async (_s: ClipboardSelectionType, text: string) => {
      if (!focused()) return;
      await writeClipboard(text);
      useApp.getState().notify("Le serveur a copié du texte dans le presse-papiers");
    },
  };
}

export default function TerminalPane({
  serverId,
  command,
  tmux,
  join,
  paneId,
  label,
  visible,
  onTitle,
}: {
  serverId: string;
  command?: string;
  /** Session tmux à créer ou rattacher (sessions persistantes). */
  tmux?: string;
  /** Invitation : ce panneau affiche le terminal partagé par quelqu'un d'autre. */
  join?: string;
  /** Identifiant du panneau, pour la diffusion de la saisie. */
  paneId: string;
  label: string;
  visible: boolean;
  onTitle?: (title: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<number | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const started = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const broadcasting = useBroadcast((s) => s.active && s.targets.includes(paneId));
  const broadcastCount = useBroadcast((s) => s.targets.length);
  const fontSize = useApp((s) => s.settings.terminalFontSize);
  const theme = useTheme((s) => s.theme);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const openSearchRef = useRef<() => void>(() => {});
  const joinModeRef = useRef<ShareMode | null>(null);
  const safePasteRef = useRef<(text: string) => Promise<void>>(async () => {});
  /** Relance la recherche d'un échec dans le tampon ; posé plus bas dans le composant. */
  const scanFailureRef = useRef<() => void>(() => {});
  /** Ouvre l'historique du serveur ; posé plus bas, appelé depuis le gestionnaire de touches. */
  const openHistoryRef = useRef<() => void>(() => {});
  const [historyOpen, setHistoryOpen] = useState(false);
  openSearchRef.current = () => {
    setSearching(true);
    // Déjà ouverte : on resélectionne le texte ; sinon autoFocus prend le relais au montage.
    searchInput.current?.select();
  };
  /** Enregistrement asciicast v2 : [secondes depuis le début, "o", texte]. */
  const recording = useRef<{ start: number; cols: number; rows: number; events: [number, "o", string][]; decoder: TextDecoder } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  /** Fichiers du PC glissés au-dessus du panneau : dossier de destination (null : en cours de lecture). */
  const [dropTarget, setDropTarget] = useState<string | null | false>(false);
  /** Partage en cours de ce terminal (celui qui partage), avec son invitation. */
  const [share, setShare] = useState<{ invite: string; mode: ShareMode } | null>(null);
  const [sharePicker, setSharePicker] = useState(false);
  /** Terminal rejoint : mode du partage (lecture seule ou contrôle). */
  const [joinMode, setJoinMode] = useState<ShareMode | null>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: useTheme.getState().theme === "light" ? LIGHT_THEME : THEME,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: useApp.getState().settings.terminalFontSize,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    // Seuls les liens web s'ouvrent : une sortie de commande ne doit pas pouvoir lancer autre chose.
    term.loadAddon(new WebLinksAddon((_e, url) => /^https?:\/\//i.test(url) && void openUrl(url)));
    // Copie demandée par le serveur (OSC 52) ; la lecture du presse-papiers lui reste interdite.
    // Terminal rejoint : c'est l'hôte du partage qui écrirait chez nous, jamais accepté.
    if (!join) {
      const focused = () => document.hasFocus() && document.activeElement === term.textarea;
      term.loadAddon(new ClipboardAddon(undefined, writeOnlyClipboard(focused)));
    }
    // PID du shell simple (séquence privée envoyée au démarrage) et dossier courant annoncé par le
    // shell (OSC 7) : servent au panneau Fichiers et au dépôt de fichiers dans le terminal.
    term.parser.registerOscHandler(7770, (data) => {
      const pid = Number(data);
      if (Number.isInteger(pid) && pid > 0) usePanes.getState().set(paneId, { pid });
      return true;
    });
    // Secours quand /proc est illisible (shell root) : l'invite affichée dit où l'on est.
    usePanes.getState().set(paneId, {
      promptCwd: () => {
        const buf = term.buffer.active;
        const end = buf.baseY + buf.cursorY;
        const lines: string[] = [];
        for (let i = Math.max(0, end - 200); i <= end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        return cwdFromPrompt(lines);
      },
    });
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol === "file:") usePanes.getState().set(paneId, { cwd: decodeURIComponent(url.pathname) });
      } catch {
        /* URL invalide : ignorée */
      }
      return true;
    });
    // Liens OSC 8 envoyés par le serveur lui-même : mêmes règles (web uniquement, sur clic).
    term.options.linkHandler = { activate: (_e, url) => void (/^https?:\/\//i.test(url) && openUrl(url)), allowNonHttpProtocols: false };
    term.open(host.current!);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL indisponible : rendu DOM par défaut */
    }
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    useBroadcast.getState().register(paneId, { termId: null, label });
    usePanes.getState().set(paneId, { serverId, termId: null });
    // En développement, les terminaux sont joignables depuis la console : le rendu WebGL n'est pas
    // lisible dans le DOM, et les tests d'interface ont besoin de leur contenu.
    if (import.meta.env.DEV) {
      const bag = (window as unknown as { __zenyttTerms?: Record<string, Terminal> }).__zenyttTerms ?? {};
      bag[paneId] = term;
      (window as unknown as { __zenyttTerms?: Record<string, Terminal> }).__zenyttTerms = bag;
    }

    let disposed = false;
    let waitingReconnect = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const setTerm = (id: number | null) => {
      idRef.current = id;
      useBroadcast.getState().register(paneId, { termId: id, label });
      usePanes.getState().set(paneId, { termId: id });
    };

    // Reconnexion automatique : 1 s, 2 s, 4 s… jusqu'à 30 s entre deux tentatives.
    const scheduleRetry = () => {
      const delay = Math.min(30, 2 ** retry);
      retry++;
      term.write(`\x1b[2mNouvelle tentative dans ${delay} s… (Entrée pour réessayer tout de suite)\x1b[0m\r\n`);
      waitingReconnect = true;
      retryTimer = setTimeout(() => {
        if (disposed || !waitingReconnect) return;
        waitingReconnect = false;
        void start(false);
      }, delay * 1000);
    };

    const start = async (interactive = true): Promise<void> => {
      term.write("\x1b[2mConnexion…\x1b[0m\r\n");
      // Terminal partagé par quelqu'un d'autre : aucun SSH, tout passe par le relais.
      if (join) {
        try {
          const info = await api.termJoin(join, (e: TermEvent) => {
            if (e.type === "data") {
              term.write(decode(e.data));
              return;
            }
            setTerm(null);
            if (disposed) return;
            term.write("\r\n\x1b[33m[La personne a arrêté le partage]\x1b[0m\r\n");
          });
          if (disposed) {
            void api.termJoinClose(info.id);
            return;
          }
          setTerm(info.id);
          setJoinMode(info.mode);
          onTitle?.(info.label || "Terminal partagé");
          if (visibleRef.current) term.focus();
          term.write(
            info.mode === "control"
              ? "\x1b[2mConnecté : tu peux taper dans ce terminal.\x1b[0m\r\n"
              : "\x1b[2mConnecté en lecture seule.\x1b[0m\r\n",
          );
        } catch (e) {
          term.write(`\x1b[31m${errorMessage(e)}\x1b[0m\r\n`);
        }
        return;
      }
      if (!(await ensureConnected(serverId, { interactive, force: interactive }))) {
        if (!interactive && tmux) return scheduleRetry();
        term.write("\x1b[31mConnexion annulée ou impossible.\x1b[0m Appuie sur Entrée pour réessayer.\r\n");
        waitingReconnect = true;
        return;
      }
      const hasTmux = !command && tmux ? await tmuxAvailable(serverId) : null;
      const useTmux = hasTmux === true;
      // Console série d'une VM (virsh console) : l'invite de connexion n'apparaît qu'après une
      // touche. On envoie donc un retour à la ligne une fois connecté, puis, si la VM reste muette,
      // on explique pourquoi (aucune session ouverte sur son port série) au lieu d'un écran figé.
      const serial = !!command && /\bvirsh\b.*\bconsole\b/.test(command);
      let serialSeen = "";
      let serialStage: "attente" | "relance" | "fini" = serial ? "attente" : "fini";
      let serialBytesAfter = 0;
      const serialNudge = () => {
        serialStage = "relance";
        serialBytesAfter = 0;
        window.setTimeout(() => idRef.current != null && void api.termWrite(idRef.current, "\r"), 500);
        window.setTimeout(() => {
          if (disposed || serialStage !== "relance") return;
          serialStage = "fini";
          // Seul l'écho du retour à la ligne est revenu : rien n'écoute sur ttyS0 dans la VM.
          if (serialBytesAfter <= 4) {
            term.write(
              "\r\n\x1b[33m[Zenytt] La VM ne répond pas sur sa console série. Son système n'y ouvre sans doute pas de session :\r\n" +
                "  dans la VM, lance « sudo systemctl enable --now serial-getty@ttyS0 » (ou ajoute console=ttyS0 au noyau).\r\n" +
                "  Ctrl+] pour quitter la console ; l'écran (VNC) reste disponible depuis la liste des VM.\x1b[0m\r\n",
            );
          }
        }, 5000);
      };
      // Nouveau shell : son PID et son dossier seront annoncés à nouveau.
      usePanes.getState().set(paneId, { tmux: useTmux ? tmux : undefined, pid: undefined, cwd: undefined });
      try {
        const id = await api.termOpen(
          serverId,
          term.cols,
          term.rows,
          (e: TermEvent) => {
            if (e.type === "data") {
              const bytes = decode(e.data);
              term.write(bytes);
              if (serialStage === "relance") serialBytesAfter += bytes.length;
              else if (serialStage === "attente") {
                serialSeen = (serialSeen + new TextDecoder().decode(bytes)).slice(-2000);
                if (serialSeen.includes("Escape character is")) serialNudge();
              }
              const rec = recording.current;
              if (rec) rec.events.push([(performance.now() - rec.start) / 1000, "o", rec.decoder.decode(bytes, { stream: true })]);
              scanFailureRef.current();
              return;
            }
            setTerm(null);
            if (disposed) return;
            if (e.code == null && useTmux) {
              // Coupure réseau : la session tmux tourne toujours, on s'y rattache tout seul.
              term.write("\r\n\x1b[33m[Connexion perdue, la session continue sur le serveur]\x1b[0m\r\n");
              scheduleRetry();
              return;
            }
            term.write(`\r\n\x1b[2m[Session terminée${e.code != null ? ` (code ${e.code})` : ""}] Appuie sur Entrée pour relancer.\x1b[0m\r\n`);
            waitingReconnect = true;
          },
          { command, tmuxSession: useTmux ? tmux : undefined },
        );
        if (disposed) {
          void api.termClose(id);
          return;
        }
        retry = 0;
        setTerm(id);
        focusedTerminal.id = id;
        if (visibleRef.current) term.focus();
        if (hasTmux === false) void offerTmux(serverId);
      } catch (e) {
        if (!interactive && tmux) return scheduleRetry();
        term.write(`\x1b[31m${errorMessage(e)}\x1b[0m\r\nAppuie sur Entrée pour réessayer.\r\n`);
        waitingReconnect = true;
      }
    };

    startRef.current = () => {
      if (started.current) return;
      started.current = true;
      void start();
    };

    term.onData((data) => {
      if (waitingReconnect) {
        if (data === "\r") {
          clearTimeout(retryTimer);
          waitingReconnect = false;
          term.clear();
          void start();
        }
        return;
      }
      if (isBroadcasting(paneId)) {
        void broadcastInput(data);
        return;
      }
      if (idRef.current == null) return;
      if (join) {
        // Lecture seule : les frappes ne partent pas (l'hôte les refuserait de toute façon).
        if (joinModeRef.current === "control") void api.termJoinWrite(idRef.current, data);
        return;
      }
      void api.termWrite(idRef.current, data);
      if (data.includes("\r")) usePanes.getState().set(paneId, { inputTick: Date.now() });
    });
    term.onResize(({ cols, rows }) => {
      if (idRef.current != null) void api.termResize(idRef.current, cols, rows);
    });
    term.onTitleChange((t) => onTitle?.(t));
    term.textarea?.addEventListener("focus", () => {
      focusedTerminal.id = idRef.current;
      focusedTerminal.focus = () => term.focus();
      usePanes.getState().setActive(paneId);
    });

    // Collage : un bloc de plusieurs lignes s'exécuterait ligne par ligne dès le collage ; on
    // demande confirmation (sauf si le shell gère le « bracketed paste »), et toujours quand la
    // saisie est diffusée à plusieurs serveurs.
    const safePaste = async (text: string) => {
      if (!text) return;
      const multiline = /[\r\n]/.test(text.replace(/\r?\n$/, ""));
      const broadcast = isBroadcasting(paneId);
      if ((multiline && !term.modes.bracketedPasteMode) || broadcast) {
        const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
        const ok = await useApp.getState().ask({
          title: broadcast ? `Coller dans ${useBroadcast.getState().targets.length} terminaux ?` : `Coller ${lines} lignes ?`,
          body: broadcast
            ? "La saisie est diffusée : ce texte sera envoyé à tous les terminaux sélectionnés."
            : "Chaque ligne sera exécutée dès le collage. Vérifie le contenu avant de continuer.",
          code: text.length > 3000 ? `${text.slice(0, 3000)}\n…` : text,
          confirmLabel: "Coller",
          danger: broadcast,
        });
        if (!ok) return;
      }
      term.paste(text);
      term.focus();
    };
    // Ctrl+V et collage natif : interceptés avant xterm (phase de capture sur le conteneur).
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void safePaste(e.clipboardData?.getData("text/plain") ?? "");
    };
    const hostEl = host.current!;
    hostEl.addEventListener("paste", onPaste, true);

    // Taille de police : Ctrl+= / Ctrl+- / Ctrl+0 et Ctrl+molette, partagée par tous les terminaux.
    const zoom = (delta: number | null) => {
      const { settings, setSettings } = useApp.getState();
      const size = delta === null ? 14 : Math.min(28, Math.max(9, settings.terminalFontSize + delta));
      setSettings({ terminalFontSize: size });
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    };
    hostEl.addEventListener("wheel", onWheel, { passive: false });

    // Molette dans une session tmux : l'écran alterné prive ce terminal de son propre historique,
    // et xterm traduit alors la molette en flèches — ce qui rappelait les dernières commandes au
    // lieu de remonter le texte. On demande donc à tmux de faire défiler son historique à lui.
    if (tmux) {
      let cumul = 0;
      let envoiPrevu: ReturnType<typeof setTimeout> | null = null;
      term.attachCustomWheelEventHandler((e: WheelEvent) => {
        // Le tampon normal (hors programme plein écran) défile normalement dans xterm.
        if (term.buffer.active.type !== "alternate") return true;
        cumul += e.deltaY;
        if (!envoiPrevu) {
          envoiPrevu = setTimeout(() => {
            envoiPrevu = null;
            const lignes = Math.min(200, Math.max(1, Math.round(Math.abs(cumul) / 40) * 3));
            const up = cumul < 0;
            cumul = 0;
            void api.tmuxScroll(serverId, tmux, up, lignes).catch(() => {});
          }, 40);
        }
        return false;
      });
    }

    // Ctrl+Shift+C / Ctrl+Shift+V, comme dans les terminaux Linux ; Ctrl+C reste SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (matches(e, "termSearch")) {
        openSearchRef.current();
        return false;
      }
      if (matches(e, "termHistory")) {
        openHistoryRef.current();
        return false;
      }
      // Raccourcis de l'app (palette, onglets, verrouillage…) : pour Zenytt, pas pour le shell.
      if (isAppShortcut(e)) return false;
      if (!e.ctrlKey) return true;
      if (!e.shiftKey && !e.altKey) {
        if (e.code === "Equal" || e.code === "NumpadAdd") return (zoom(1), false);
        if (e.code === "Minus" || e.code === "NumpadSubtract") return (zoom(-1), false);
        if (e.code === "Digit0" || e.code === "Numpad0") return (zoom(null), false);
        return true;
      }
      if (!e.shiftKey) return true;
      if (e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void writeClipboard(sel);
        return false;
      }
      if (e.code === "KeyV") {
        void readClipboard().then(safePaste);
        return false;
      }
      return true;
    });
    // Clic droit : menu contextuel, ou copier/coller direct comme PuTTY (réglage). Il n'est jamais
    // transmis au serveur : avec la souris activée, tmux ouvrait son propre menu, aussitôt refermé.
    const swallowRight = (e: MouseEvent) => {
      if (e.button === 2) e.stopPropagation();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const sel = term.getSelection();
      if (useApp.getState().settings.terminalRightClick === "menu") {
        setMenu({ x: e.clientX, y: e.clientY, selection: sel });
        return;
      }
      if (sel) {
        void writeClipboard(sel);
        term.clearSelection();
      } else {
        void readClipboard().then(safePaste);
      }
    };
    safePasteRef.current = safePaste;
    hostEl.addEventListener("mousedown", swallowRight, true);
    hostEl.addEventListener("mouseup", swallowRight, true);
    hostEl.addEventListener("contextmenu", onContext, true);

    // Fichiers glissés depuis l'explorateur Windows : envoyés dans le dossier courant du shell.
    let unlistenDrop: (() => void) | undefined;
    let dropCwd: Promise<string | null> | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "leave") {
          dropCwd = null;
          return setDropTarget(false);
        }
        const { x, y } = p.position;
        const el = document.elementFromPoint(x / window.devicePixelRatio, y / window.devicePixelRatio);
        const inside = visibleRef.current && useApp.getState().section === "terminal" && !!el && hostEl.contains(el);
        if (!inside) {
          dropCwd = null;
          return setDropTarget(false);
        }
        if (p.type === "drop") {
          dropCwd = null;
          setDropTarget(false);
          if (idRef.current == null) return useApp.getState().notify("Terminal non connecté : impossible d'y déposer des fichiers.", "info");
          void uploadToPane(paneId, p.paths);
          return;
        }
        if (!dropCwd) {
          const pending = paneCwd(paneId);
          dropCwd = pending;
          setDropTarget(null);
          void pending.then((cwd) => dropCwd === pending && setDropTarget(cwd ?? ""));
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlistenDrop = fn;
      });

    const observer = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) fit.fit();
    });
    observer.observe(host.current!);

    if (visibleRef.current) startRef.current();

    return () => {
      disposed = true;
      // Le panneau peut être reconstruit (changement de serveur, rechargement à chaud) : sans
      // cette remise à zéro, le terminal suivant resterait vide, faute de démarrer.
      started.current = false;
      if (import.meta.env.DEV) delete (window as unknown as { __zenyttTerms?: Record<string, Terminal> }).__zenyttTerms?.[paneId];
      clearTimeout(retryTimer);
      observer.disconnect();
      hostEl.removeEventListener("paste", onPaste, true);
      hostEl.removeEventListener("wheel", onWheel);
      hostEl.removeEventListener("mousedown", swallowRight, true);
      hostEl.removeEventListener("mouseup", swallowRight, true);
      hostEl.removeEventListener("contextmenu", onContext, true);
      unlistenDrop?.();
      usePanes.getState().remove(paneId);
      useBroadcast.getState().unregister(paneId);
      // Fermer le canal détache simplement la session tmux : elle continue sur le serveur.
      if (idRef.current != null) void (join ? api.termJoinClose(idRef.current) : api.termClose(idRef.current));
      term.dispose();
    };
    // La session est liée au serveur, à la commande et à la session tmux initiales uniquement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, command, tmux, join, paneId]);

  // Connexion différée : un onglet restauré ne se connecte qu'à son premier affichage.
  useEffect(() => {
    if (visible) {
      startRef.current?.();
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  joinModeRef.current = joinMode;

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme === "light" ? LIGHT_THEME : THEME;
  }, [theme]);

  // Changement de taille de police (depuis n'importe quel terminal) : appliqué à celui-ci.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  /** Dernières lignes affichées, de la plus ancienne à la plus récente. */
  const lastLines = (count: number): string[] => {
    const term = termRef.current;
    if (!term) return [];
    const buffer = term.buffer.active;
    const lines: string[] = [];
    const first = Math.max(0, buffer.length - count);
    for (let i = first; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true).trimEnd() ?? "");
    return lines;
  };

  /**
   * Échec repéré dans ce qui s'affiche. Zenytt n'installe rien sur le serveur pour cela : le code de
   * retour n'est donc pas lisible, et la détection se fait sur le texte (voir lib/terminal-errors).
   * Le tampon n'est relu qu'au repos, une demi-seconde après la dernière sortie : le relire à chaque
   * octet reçu coûterait cher pendant un « tail -f ».
   */
  const [failure, setFailure] = useState<Failure | null>(null);
  const failureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  scanFailureRef.current = () => {
    if (failureTimer.current) clearTimeout(failureTimer.current);
    failureTimer.current = setTimeout(() => {
      // L'écran d'une application plein écran (vim, htop, tmux) n'est pas une sortie de commande.
      if (termRef.current?.buffer.active.type === "alternate") return setFailure(null);
      setFailure(findLastFailure(lastLines(60)));
    }, 500);
  };
  useEffect(() => () => void (failureTimer.current && clearTimeout(failureTimer.current)), []);

  openHistoryRef.current = () => setHistoryOpen(true);

  /** Demande à l'assistant pourquoi la dernière commande a échoué, sa sortie en contexte. */
  const diagnose = (f: Failure) => {
    const contexte = `Serveur : ${label}

Sortie du terminal :
${f.output}`;
    setFailure(null);
    void askAssistant(diagnosePrompt(f), contexte);
  };

  /** Écran courant en texte, envoyé à un invité qui vient d'arriver. */
  const screenText = (): string => {
    const term = termRef.current;
    if (!term) return "";
    const lines = lastLines(term.rows);
    return `\x1b[2J\x1b[H${lines.join("\r\n")}\r\n`;
  };

  const startShare = async (mode: ShareMode) => {
    const id = idRef.current;
    const { notify } = useApp.getState();
    if (id == null) return notify("Le terminal n'est pas connecté.", "info");
    try {
      const info = await api.termShareStart(id, label, mode, (e) => {
        if (e.type === "guestJoined") void api.termShareSend(id, screenText()).catch(() => {});
        else {
          setShare(null);
          useApp.getState().notify(`Partage terminé : ${e.reason}`, "info");
        }
      });
      setShare({ invite: info.invite, mode: info.mode });
      usePaneStatus.getState().setShared(paneId, info.mode);
      await writeClipboard(info.invite).catch(() => {});
      notify("Invitation copiée : envoie-la à la personne. Elle la colle dans Terminal → Rejoindre.", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const stopShare = async () => {
    if (idRef.current != null) await api.termShareStop(idRef.current).catch(() => {});
    setShare(null);
    usePaneStatus.getState().setShared(paneId, null);
  };


  const find = (backwards = false) => {
    if (!query) return;
    const opts = { caseSensitive: false, decorations: { matchOverviewRuler: "#d29922", activeMatchColorOverviewRuler: "#3b82f6", matchBackground: "#d2992255", activeMatchBackground: "#3b82f6aa" } };
    if (backwards) searchRef.current?.findPrevious(query, opts);
    else searchRef.current?.findNext(query, opts);
  };
  const closeSearch = () => {
    setSearching(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  const toggleRecording = async () => {
    const term = termRef.current;
    if (!term) return;
    if (!recording.current) {
      recording.current = { start: performance.now(), cols: term.cols, rows: term.rows, events: [], decoder: new TextDecoder() };
      setIsRecording(true);
      usePaneStatus.getState().setRecording(paneId, { since: Date.now(), label });
      return;
    }
    const rec = recording.current;
    recording.current = null;
    setIsRecording(false);
    usePaneStatus.getState().setRecording(paneId, null);
    const { notify } = useApp.getState();
    if (rec.events.length === 0) return notify("Rien à enregistrer : aucune sortie pendant l'enregistrement.", "info");
    const path = await save({
      title: "Enregistrer la session",
      defaultPath: `session-${label.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.cast`,
      filters: [{ name: "Enregistrement asciicast", extensions: ["cast"] }],
    });
    if (!path) return;
    const header = { version: 2, width: rec.cols, height: rec.rows, timestamp: Math.floor(Date.now() / 1000 - (performance.now() - rec.start) / 1000), title: label };
    const content = [JSON.stringify(header), ...rec.events.map((e) => JSON.stringify([Number(e[0].toFixed(4)), e[1], e[2]]))].join("\n") + "\n";
    try {
      await api.saveTextFile(path, content);
      notify(`Session enregistrée : ${path} (lecture avec asciinema play)`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  // Actions exposées à la barre d'outils et au dock du terminal (via des références : elles
  // lisent toujours l'état courant du panneau).
  const actionsRef = useRef({ toggleRecording, share: () => (share ? void stopShare() : setSharePicker(true)) });
  actionsRef.current = { toggleRecording, share: () => (share ? void stopShare() : setSharePicker(true)) };
  useEffect(
    () =>
      registerPaneActions(paneId, {
        search: () => openSearchRef.current(),
        history: () => openHistoryRef.current(),
        toggleRecording: () => actionsRef.current.toggleRecording(),
        share: () => actionsRef.current.share(),
      }),
    [paneId],
  );

  /**
   * Enregistre la sélection comme fragment réutilisable. La commande est nettoyée de l'invite
   * (« $ », « # ») et des retours à la ligne inutiles : on sélectionne souvent la ligne entière.
   */
  const saveSnippet = async (selection: string) => {
    const commande = selection
      .split("\n")
      .map((l) => l.replace(/^\s*[^\s@]*@[^\s:]*:[^$#]*[$#]\s?/, "").trimEnd())
      .filter((l) => l.trim().length > 0)
      .join("\n")
      .trim();
    if (!commande) return;
    const nom = await useApp.getState().ask({
      title: "Nouveau fragment",
      body: commande.length > 300 ? `${commande.slice(0, 300)}…` : commande,
      input: { label: "Nom du fragment", initial: commande.split("\n")[0].slice(0, 40) },
      confirmLabel: "Enregistrer",
    });
    if (typeof nom !== "string" || !nom.trim()) return;
    try {
      await api.saveSnippet({ id: "", name: nom.trim(), command: commande });
      useApp.getState().notify(`Fragment « ${nom.trim()} » enregistré.`, "success");
    } catch (e) {
      useApp.getState().notify(errorMessage(e), "error");
    }
  };

  const menuItems = (selection: string): MenuItem[] => {
    const term = termRef.current;
    const connected = idRef.current != null;
    return [
      { label: "Copier", icon: <Copy size={14} />, hint: "Ctrl+Maj+C", disabled: !selection, onClick: () => void writeClipboard(selection) },
      { label: "Coller", icon: <ClipboardPaste size={14} />, hint: "Ctrl+Maj+V", disabled: !connected, onClick: () => void readClipboard().then((t) => safePasteRef.current(t)) },
      { label: "Tout sélectionner", icon: <TextSelect size={14} />, onClick: () => term?.selectAll() },
      { label: "Rechercher…", icon: <Search size={14} />, hint: display(shortcutOf("termSearch")), onClick: () => openSearchRef.current() },
      {
        label: "Historique du serveur…",
        icon: <History size={14} />,
        hint: display(shortcutOf("termHistory")),
        disabled: !connected,
        onClick: () => setHistoryOpen(true),
      },
      { label: "Effacer l'écran", icon: <Eraser size={14} />, onClick: () => term?.clear() },
      {
        label: selection ? "Expliquer la sélection" : "Expliquer ce qui s'affiche",
        icon: <Sparkles size={14} />,
        onClick: () => explain(selection ? "cette sortie de terminal" : "ce qui s'affiche dans mon terminal", selection || screenText()),
      },
      {
        label: "Diagnostiquer la dernière erreur",
        icon: <Sparkles size={14} />,
        disabled: !failure,
        onClick: () => failure && diagnose(failure),
      },
      {
        label: "Enregistrer comme fragment…",
        icon: <ScrollText size={14} />,
        disabled: !selection.trim(),
        onClick: () => void saveSnippet(selection),
      },
      "separator",
      {
        label: "Envoyer des fichiers ici…",
        icon: <Upload size={14} />,
        disabled: !connected,
        onClick: async () => {
          const files = await open({ multiple: true, title: "Fichiers à envoyer dans le dossier courant du terminal" });
          if (files && files.length) void uploadToPane(paneId, Array.isArray(files) ? files : [files]);
        },
      },
      {
        label: "Ouvrir le dossier courant dans Fichiers",
        icon: <FolderOpen size={14} />,
        disabled: !connected,
        onClick: async () => {
          const cwd = await paneCwd(paneId);
          const { setFilesPath, setSection, setActiveServer, notify } = useApp.getState();
          if (!cwd) return notify("Dossier courant introuvable pour ce terminal.", "info");
          setActiveServer(serverId);
          setFilesPath(serverId, cwd);
          setSection("files");
        },
      },
      "separator",
      { label: isRecording ? "Arrêter l'enregistrement" : "Enregistrer la session", icon: <Circle size={14} />, onClick: () => void toggleRecording() },
    ];
  };

  return (
    <div className="group/term flex h-full w-full flex-col">
      {share && (
        <div className="flex shrink-0 items-center justify-center gap-2 bg-accent/85 px-3 py-0.5 text-[11px] font-medium text-accent-fg">
          <Users size={12} />
          Partagé ({share.mode === "control" ? "avec le contrôle" : "lecture seule"})
          <button className="underline" onClick={() => void writeClipboard(share.invite)}>
            copier l'invitation
          </button>
          <button className="underline" onClick={() => void stopShare()}>
            arrêter
          </button>
        </div>
      )}
      {join && joinMode === "view" && (
        <div className="pointer-events-none flex shrink-0 items-center justify-center gap-2 bg-panel/90 px-3 py-0.5 text-[11px] text-muted">
          <EyeOff size={12} /> Lecture seule : la personne qui partage garde le contrôle
        </div>
      )}
      {broadcasting && (
        <div className="pointer-events-none shrink-0 bg-danger/85 px-3 py-0.5 text-center text-[11px] font-medium text-white">
          Saisie diffusée à {broadcastCount} terminaux
        </div>
      )}
      <div className="relative min-h-0 w-full flex-1">
        <div ref={host} className="h-full w-full overflow-hidden bg-bg" />
        {failure && (
          <button
            className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-warn/50 bg-panel/95 px-2.5 py-1 text-[11px] text-warn shadow-lg transition-colors hover:bg-warn/10 hover:text-fg"
            title={`Dernière erreur : ${failure.reason}`}
            onClick={() => diagnose(failure)}
          >
            <Sparkles size={12} />
            Pourquoi cette commande a échoué ?
            <span className="rounded p-0.5 text-muted hover:text-fg" role="presentation" title="Masquer" onClick={(e) => {
              e.stopPropagation();
              setFailure(null);
            }}>
              <X size={11} />
            </span>
          </button>
        )}
        <div className={`absolute top-1 right-3 z-10 flex items-center gap-1 ${searching || isRecording ? "" : "opacity-0 group-hover/term:opacity-100"}`}>
          {isRecording && (
            <span className="flex items-center gap-1 rounded bg-danger/85 px-1.5 py-0.5 text-[10px] font-medium text-white">
              <Circle size={8} fill="currentColor" /> REC
            </span>
          )}
          {searching ? (
            <span className="flex items-center gap-1 rounded-md border border-border bg-panel px-1.5 py-1 shadow-lg">
              <input
                ref={searchInput}
                autoFocus
                className="w-48 bg-transparent text-xs outline-none placeholder:text-muted/60"
                placeholder="Rechercher (Entrée, Maj+Entrée)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") find(e.shiftKey);
                  if (e.key === "Escape") closeSearch();
                }}
              />
              <button className="text-muted hover:text-fg" title="Fermer (Échap)" onClick={closeSearch}>
                <X size={12} />
              </button>
            </span>
          ) : (
            <button className="rounded bg-panel/90 p-1 text-muted hover:text-fg" title={`Rechercher dans le terminal (${display(shortcutOf("termSearch"))})`} onClick={() => openSearchRef.current()}>
              <Search size={13} />
            </button>
          )}
          {!join && (
            <button
              className={`rounded bg-panel/90 p-1 hover:text-fg ${share ? "text-accent" : "text-muted"}`}
              title={share ? "Terminal partagé : cliquer pour arrêter" : "Partager ce terminal avec quelqu'un"}
              onClick={() => (share ? void stopShare() : setSharePicker(true))}
            >
              <Share2 size={13} />
            </button>
          )}
          <button
            className={`rounded bg-panel/90 p-1 hover:text-fg ${isRecording ? "text-danger" : "text-muted"}`}
            title={isRecording ? "Arrêter et enregistrer la session" : "Enregistrer la session (asciicast)"}
            onClick={() => void toggleRecording()}
          >
            {isRecording ? <Square size={13} fill="currentColor" /> : <Circle size={13} />}
          </button>
        </div>
        {dropTarget !== false && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
            <span className="flex items-center gap-2 rounded-md bg-panel px-3 py-2 text-sm shadow-lg">
              <Upload size={15} className="text-accent" />
              {dropTarget === null ? "Lecture du dossier courant…" : dropTarget ? <>Déposer pour envoyer dans <span className="font-mono">{dropTarget}</span></> : "Déposer pour envoyer sur le serveur"}
            </span>
          </div>
        )}
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.selection)} onClose={() => {
          setMenu(null);
          termRef.current?.focus();
        }} />}
        {historyOpen && (
          <Suspense fallback={null}>
            <HistoryPalette
              serverId={serverId}
              onClose={() => {
                setHistoryOpen(false);
                termRef.current?.focus();
              }}
              onPick={(command, run) => {
                setHistoryOpen(false);
                const id = idRef.current;
                if (id == null) return useApp.getState().notify("Le terminal n'est pas connecté.", "info");
                // Sans « run », la commande est seulement écrite : elle se relit et se corrige
                // avant d'être lancée, comme la recherche inversée du shell.
                void api.termWrite(id, run ? command + "\r" : command);
                termRef.current?.focus();
              }}
            />
          </Suspense>
        )}
        {sharePicker && (
          <SharePicker
            onClose={() => setSharePicker(false)}
            onPick={(mode) => {
              setSharePicker(false);
              void startShare(mode);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Choix du mode de partage d'un terminal. */
function SharePicker({ onClose, onPick }: { onClose: () => void; onPick: (mode: ShareMode) => void }) {
  return (
    <Modal
      title="Partager ce terminal"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button icon={<EyeOff size={14} />} onClick={() => onPick("view")}>
            Lecture seule
          </Button>
          <Button variant="primary" icon={<Users size={14} />} onClick={() => onPick("control")}>
            Avec le contrôle
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        Zenytt crée une session sur ton serveur de synchronisation, qui ne fait que relayer : ce qui s'affiche et ce qui est tapé sont chiffrés
        de bout en bout, avec une clé présente uniquement dans l'invitation. Elle est copiée dans ton presse-papiers ; transmets-la à la
        personne, qui la colle dans Terminal → Rejoindre.
      </p>
      <p className="mt-3 text-sm text-muted">
        <span className="font-medium text-fg">Avec le contrôle</span>, la personne tape dans <span className="font-medium text-fg">ton</span>{" "}
        terminal, avec tes droits sur le serveur : à réserver à quelqu'un de confiance. Le partage s'arrête dès que tu le décides, ou à la
        fermeture de l'onglet.
      </p>
    </Modal>
  );
}
