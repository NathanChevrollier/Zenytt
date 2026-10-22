import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftRight, ArrowUp, ChevronRight, Container, Copy, Download, Eye, File, FileArchive, FileDiff, FilePlus, Filter, Folder, FolderOpen, FolderPlus, HardDrive, History, House, Link2,
  PackageOpen, PanelLeft, Pencil, PenLine, Plus, RefreshCw, Search, Shield, SlidersHorizontal, SquareTerminal, Star, Trash2, Upload, X,
} from "lucide-react";
import { api, ARCHIVE_EXTENSIONS, errorMessage, formatBytes, hasShell, shellQuote, type ArchiveFormat, type FsEntry, type Listing } from "../lib/api";
import { track } from "../lib/transfers";
import { composeFileIn, isComposeFile } from "../lib/compose";
import TransfersBar from "../components/TransfersBar";
import { useAutoRefresh } from "../lib/refresh";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import {
  Button, Checkbox, DataTable, Drawer, ErrorState, Eyebrow, Field, IconButton, Input, Loading, MenuButton, Modal, Select, type Column, type MenuItem,
} from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import { writeClipboard } from "../lib/clipboard";
import { useTheme } from "../lib/theme";

const FileEditor = lazy(() => import("../components/FileEditor"));
const FileSearch = lazy(() => import("../components/FileSearch"));
const DiffView = lazy(() => import("../components/DiffView"));
const ComposeFileDialog = lazy(() => import("../components/ComposeFileDialog"));

const isDir = (e: FsEntry) => e.kind === "dir" || e.targetIsDir;

/** Extensions reconnues par « Extraire ici » (mêmes formats que côté Rust). */
const ARCHIVE_SUFFIXES = [
  ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar.zst", ".tar", ".zip", ".gz", ".bz2", ".xz", ".zst",
];

const isArchive = (e: FsEntry) => !isDir(e) && ARCHIVE_SUFFIXES.some((x) => e.name.toLowerCase().endsWith(x));

/** Taille maximale d'un fichier comparé dans la fenêtre de différences. */
const MAX_DIFF_SIZE = 2 * 1024 * 1024;

type PaneId = "left" | "right";

/** État partagé des deux panneaux : serveur, dossier courant, glisser en cours. */
interface PanesState {
  cwd: Record<PaneId, { serverId: string; path: string }>;
  /** Incrémenté pour demander à un panneau de se rafraîchir. */
  version: Record<PaneId, number>;
  drag: { from: PaneId; serverId: string; paths: string[]; label: string; x: number; y: number } | null;
  setCwd: (pane: PaneId, serverId: string, path: string) => void;
  bump: (pane: PaneId) => void;
  setDrag: (drag: PanesState["drag"]) => void;
}

const usePanes = create<PanesState>((set) => ({
  cwd: { left: { serverId: "", path: "" }, right: { serverId: "", path: "" } },
  version: { left: 0, right: 0 },
  drag: null,
  setCwd: (pane, serverId, path) => set((s) => ({ cwd: { ...s.cwd, [pane]: { serverId, path } } })),
  bump: (pane) => set((s) => ({ version: { ...s.version, [pane]: s.version[pane] + 1 } })),
  setDrag: (drag) => set({ drag }),
}));

/**
 * Copie des éléments vers l'autre panneau (autre serveur ou autre dossier), en flux via le PC.
 * Demande confirmation avant d'écraser un élément existant.
 */
async function copyToOther(from: PaneId, serverId: string, paths: string[]) {
  const to: PaneId = from === "left" ? "right" : "left";
  const target = usePanes.getState().cwd[to];
  if (!target.serverId || !target.path) return;
  const { servers, ask } = useApp.getState();
  const dstName = servers.find((s) => s.id === target.serverId)?.name ?? "";
  const label = `Copie de ${paths.length} élément(s) vers ${dstName}:${target.path}`;
  let overwrite = false;
  for (;;) {
    let exists: string | null = null;
    const ok = await track(label, (id, onProgress) =>
      api.fsCopyBetween(serverId, paths, target.serverId, target.path, overwrite, id, onProgress).catch((e) => {
        const msg = errorMessage(e);
        if (msg.startsWith("EXISTS:")) exists = msg.slice(7);
        throw e;
      }),
    );
    if (ok || !exists || overwrite) break;
    const confirm = await ask({
      title: "Élément déjà présent",
      body: `« ${exists} » existe déjà sur ${dstName}. Le remplacer ?`,
      confirmLabel: "Remplacer",
      danger: true,
    });
    if (!confirm) break;
    overwrite = true;
  }
  usePanes.getState().bump(to);
}

export default function FilesView() {
  return <ServerGate title="Fichiers" guide="files">{(serverId, server) => <Files key={serverId} serverId={serverId} serverName={server.name} />}</ServerGate>;
}

function Files({ serverId, serverName }: { serverId: string; serverName: string }) {
  const servers = useApp((s) => s.servers);
  const server = servers.find((s) => s.id === serverId);
  const [dual, setDual] = useState(false);
  const [rightServer, setRightServer] = useState<string | null>(null);
  const drag = usePanes((s) => s.drag);
  const right = rightServer && servers.some((s) => s.id === rightServer) ? rightServer : serverId;

  return (
    <PageLayout
      context={server ? <ServerContext server={server} /> : serverName}
      title="Fichiers"
      subtitle={dual ? "Glisse des éléments d'un panneau à l'autre pour les copier, même entre deux serveurs" : "Explorateur SFTP : glisse des fichiers de ton PC pour les envoyer"}
      guide="files"
      scroll={false}
    >
      <div className="flex min-h-0 w-full flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <Explorer key={`l-${serverId}`} serverId={serverId} pane="left" dual={dual} onToggleDual={() => setDual((v) => !v)} />
          </div>
          {dual && (
            <div className="min-w-0 flex-1 border-l border-border">
              <Explorer key={`r-${right}`} serverId={right} pane="right" dual onToggleDual={() => setDual(false)} onServerChange={setRightServer} />
            </div>
          )}
        </div>
        <TransfersBar />
        {drag && (
          <div className="pointer-events-none fixed z-50 rounded-lg border border-accent bg-raised px-2 py-1 text-xs shadow-xl" style={{ left: drag.x + 12, top: drag.y + 12 }}>
            {drag.label}
          </div>
        )}
      </div>
    </PageLayout>
  );
}

/** Derniers dossiers ouverts par serveur (session courante). */
const recentDirs = new Map<string, string[]>();
function pushRecentDir(serverId: string, path: string) {
  const list = [path, ...(recentDirs.get(serverId) ?? []).filter((p) => p !== path)].slice(0, 6);
  recentDirs.set(serverId, list);
}

function Explorer({
  serverId,
  pane,
  dual,
  onToggleDual,
  onServerChange,
}: {
  serverId: string;
  pane: PaneId;
  dual: boolean;
  onToggleDual: () => void;
  onServerChange?: (id: string) => void;
}) {
  const { notify, ask, openTab, servers, filesPaths, setFilesPath, addBookmark, removeBookmark, renameBookmark, settings, setSettings } = useAppPick("notify", "ask", "openTab", "servers", "filesPaths", "setFilesPath", "addBookmark", "removeBookmark", "renameBookmark", "settings", "setSettings");
  const bookmarks = useApp((s) => s.bookmarks[serverId]) ?? [];
  const shell = hasShell(servers.find((s) => s.id === serverId));
  const root = useRef<HTMLDivElement>(null);
  const version = usePanes((s) => s.version[pane]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const showHidden = settings.showHiddenFiles;
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [chmodOf, setChmodOf] = useState<FsEntry | null>(null);
  /** Fichier docker compose ouvert dans le dialogue « Docker Compose ». */
  const [composeFile, setComposeFile] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [miniTerminalOpen, setMiniTerminalOpen] = useState(false);
  const [miniCommand, setMiniCommand] = useState("");
  const [miniOutput, setMiniOutput] = useState<string[]>([]);
  const [miniHistory, setMiniHistory] = useState<string[]>([]);
  const [miniHistoryIndex, setMiniHistoryIndex] = useState(-1);
  const [miniRunning, setMiniRunning] = useState(false);
  const miniInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [preview, setPreview] = useState<FsEntry | null>(null);
  const theme = useTheme((s) => s.theme);
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    try {
      return localStorage.getItem("zenytt.files.sidebar") !== "closed";
    } catch {
      return true;
    }
  });
  const setSidebarOpen = (v: boolean) => {
    setSidebarOpenState(v);
    try {
      localStorage.setItem("zenytt.files.sidebar", v ? "open" : "closed");
    } catch {
      /* préférence non retenue */
    }
  };
  /** Ligne a montrer a l'ouverture de l'editeur, venue d'un resultat de recherche. */
  const [editingLine, setEditingLine] = useState<number | undefined>(undefined);
  /** Compression en cours de préparation : les éléments choisis. */
  const [archiving, setArchiving] = useState<string[] | null>(null);
  /** Comparaison de deux fichiers : leurs chemins et leur contenu. */
  const [diff, setDiff] = useState<{ left: string; right: string; original: string; modified: string } | null>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        if (!(await ensureConnected(serverId))) {
          setError("Non connecté.");
          return;
        }
        const target = path || (await api.fsHome(serverId));
        const l = await api.fsList(serverId, target);
        setListing(l);
        setPathInput(l.path);
        setSelected(new Set());
        usePanes.getState().setCwd(pane, serverId, l.path);
        pushRecentDir(serverId, l.path);
        if (pane === "left") setFilesPath(serverId, l.path);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [serverId, pane, setFilesPath],
  );

  // Reprend le dernier dossier ouvert sur ce serveur (panneau principal).
  useEffect(() => {
    void load(pane === "left" ? (filesPaths[serverId] ?? "") : "");
    // Chargement initial uniquement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Rafraîchissement demandé par l'autre panneau (après une copie vers celui-ci).
  const cwdRef = useRef("");

  const cwd = listing?.path ?? "";
  cwdRef.current = cwd;
  const refresh = () => void load(cwd);
  const runMiniCommand = async () => {
    const command = miniCommand.trim();
    if (!command || !cwd || miniRunning) return;
    setMiniRunning(true);
    setMiniHistory((history) => [command, ...history.filter((item) => item !== command)].slice(0, 50));
    setMiniHistoryIndex(-1);
    setMiniOutput((output) => [...output, `$ ${command}`]);
    setMiniCommand("");
    try {
      const result = await api.fsExec(serverId, cwd, command);
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
      setMiniOutput((lines) => [...lines, output || `(code ${result.exitCode})`].slice(-100));
    } catch (e) {
      setMiniOutput((lines) => [...lines, errorMessage(e)].slice(-100));
    } finally {
      setMiniRunning(false);
      miniInputRef.current?.focus();
    }
  };
  useEffect(() => {
    if (version > 0) void load(cwdRef.current);
  }, [version, load]);
  useAutoRefresh(
    async (auto) => {
      if (!cwdRef.current) return;
      if (!auto) return load(cwdRef.current);
      const dir = cwdRef.current;
      const l = await api.fsList(serverId, dir).catch(() => null);
      if (!l || cwdRef.current !== dir) return;
      setListing(l);
      setSelected((sel) => new Set([...sel].filter((p) => l.entries.some((e) => e.path === p))));
    },
    { serverId },
  );

  // Dossier demandé depuis ailleurs (palette Ctrl+K, raccourci) alors que l'explorateur est déjà ouvert.
  const requested = pane === "left" ? filesPaths[serverId] : undefined;
  useEffect(() => {
    if (requested && cwdRef.current && requested !== cwdRef.current) void load(requested);
  }, [requested, load]);
  const join = (name: string) => (cwd.endsWith("/") ? cwd + name : `${cwd}/${name}`);
  const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

  const entries = useMemo(() => {
    const list = listing?.entries ?? [];
    const f = filter.toLowerCase();
    return list.filter((e) => (showHidden || !e.name.startsWith(".")) && (!f || e.name.toLowerCase().includes(f)));
  }, [listing, showHidden, filter]);

  const selectedEntries = entries.filter((e) => selected.has(e.path));
  /** Fichier compose du dossier affiché, pour le lancer sans avoir à le sélectionner. */
  const composeInCwd = composeFileIn((listing?.entries ?? []).filter((e) => !isDir(e)).map((e) => e.name));

  const upload = async (paths: string[]) => {
    if (!paths.length || !cwd) return;
    const dir = cwd;
    await track(`Envoi de ${paths.length} élément(s) vers ${dir}`, (id, p) => api.fsUpload(serverId, paths, dir, id, p));
    if (dir === cwd) refresh();
  };

  const download = async (items: FsEntry[]) => {
    if (!items.length) return;
    const dir = await open({ directory: true, title: "Dossier de destination" });
    if (typeof dir !== "string") return;
    await track(`Téléchargement de ${items.length} élément(s)`, async (id, p) => {
      const where = await api.fsDownload(serverId, items.map((i) => i.path), dir, id, p);
      notify(`Téléchargé dans ${where}`, "success");
    });
  };

  // Glisser-déposer depuis l'explorateur Windows.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (useApp.getState().section !== "files") return;
        if (event.payload.type === "over" || event.payload.type === "enter" || event.payload.type === "drop") {
          const { x, y } = event.payload.position;
          const el = document.elementFromPoint(x / window.devicePixelRatio, y / window.devicePixelRatio);
          const mine = !!el && root.current?.contains(el);
          if (!mine) {
            setDragOver(false);
            return;
          }
        }
        if (event.payload.type === "over" || event.payload.type === "enter") setDragOver(true);
        else if (event.payload.type === "leave") setDragOver(false);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          void upload(event.payload.paths);
        }
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
    // `upload` dépend du dossier courant : on se réabonne quand il change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const activate = (e: FsEntry) => {
    if (isDir(e)) return void load(e.path);
    setEditingLine(undefined);
    setEditing(e.path);
  };

  const onRowMouseDown = (ev: React.MouseEvent, e: FsEntry) => {
    if (!dual || ev.button !== 0) return;
    const start = { x: ev.clientX, y: ev.clientY };
    const paths = selected.has(e.path) ? [...selected] : [e.path];
    const { setDrag } = usePanes.getState();
    let dragging = false;
    const move = (m: MouseEvent) => {
      if (!dragging && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
      dragging = true;
      setDrag({ from: pane, serverId, paths, label: paths.length > 1 ? `${paths.length} éléments` : e.name, x: m.clientX, y: m.clientY });
    };
    const up = (m: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      if (!dragging) return;
      const target = document.elementFromPoint(m.clientX, m.clientY)?.closest("[data-pane]")?.getAttribute("data-pane");
      if (target && target !== pane) void copyToOther(pane, serverId, paths);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onRowClick = (ev: React.MouseEvent, e: FsEntry) => {
    const next = new Set(ev.ctrlKey || ev.metaKey ? selected : []);
    if (ev.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.path === anchor);
      const b = entries.findIndex((x) => x.path === e.path);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(entries[i].path);
    } else if (next.has(e.path) && (ev.ctrlKey || ev.metaKey)) {
      next.delete(e.path);
    } else {
      next.add(e.path);
      setAnchor(e.path);
    }
    setSelected(next);
  };

  /** Lance une action puis relit le dossier ; `false` si elle a échoué (l'erreur est affichée). */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      refresh();
      return true;
    } catch (e) {
      notify(errorMessage(e), "error");
      return false;
    }
  };

  const newItem = async (kind: "dir" | "file") => {
    const name = await ask({
      title: kind === "dir" ? "Nouveau dossier" : "Nouveau fichier",
      input: { label: "Nom" },
      confirmLabel: "Créer",
    });
    if (typeof name !== "string" || !name.trim()) return;
    await act(() => (kind === "dir" ? api.fsMkdir(serverId, join(name.trim())) : api.fsCreate(serverId, join(name.trim()))));
  };

  const rename = async (e: FsEntry) => {
    const name = await ask({ title: `Renommer ${e.name}`, input: { label: "Nouveau nom", initial: e.name }, confirmLabel: "Renommer" });
    if (typeof name !== "string" || !name.trim() || name === e.name) return;
    const to = join(name.trim());
    // Docker retrouve un projet compose par le chemin de son fichier : renommer le dossier sans
    // précaution le rend introuvable. Zenytt arrête, renomme puis relance.
    const projects = isDir(e) ? await api.dockerProjectsUnder(serverId, e.path).catch(() => []) : [];
    if (projects.length > 0) {
      const ok = await ask({
        title: `« ${e.name} » contient des projets Docker`,
        body: "Docker retrouve ces projets grâce au chemin de leur fichier compose : renommé tel quel, le dossier les rendrait introuvables. Zenytt va les arrêter, renommer le dossier, puis relancer ceux qui tournaient depuis le nouvel emplacement (volumes conservés, coupure de quelques secondes).",
        code: projects.map((p) => `${p.name} — ${p.status}`).join("\n"),
        confirmLabel: "Arrêter, renommer et relancer",
      });
      if (!ok) return;
      if (await act(() => api.dockerMoveFolder(serverId, e.path, to))) notify(`« ${e.name} » renommé, projets Docker relancés depuis le nouvel emplacement.`, "success");
      return;
    }
    await act(() => api.fsRename(serverId, e.path, to));
  };

  const remove = async (items: FsEntry[]) => {
    if (!items.length) return;
    const projects = (await Promise.all(items.filter(isDir).map((d) => api.dockerProjectsUnder(serverId, d.path).catch(() => [])))).flat();
    const dockerWarning = projects.length
      ? ` Attention : ${projects.length > 1 ? "les projets Docker" : "le projet Docker"} ${projects.map((p) => `« ${p.name} »`).join(", ")} ${projects.length > 1 ? "ont leur fichier" : "a son fichier"} ici. Leurs conteneurs continueront de tourner, mais plus personne ne pourra les reconstruire : arrête-les d'abord depuis la section Docker si tu n'en as plus besoin.`
      : "";
    const ok = await ask({
      title: `Supprimer ${items.length > 1 ? `${items.length} éléments` : `« ${items[0].name} »`} ?`,
      body: `Suppression définitive sur le serveur. Les dossiers sont supprimés avec tout leur contenu.${dockerWarning}`,
      code: items.map((i) => i.path).join("\n"),
      confirmLabel: "Supprimer définitivement",
      danger: true,
    });
    if (ok) await act(() => api.fsRemove(serverId, items.map((i) => i.path)));
  };

  /** Compresse la sélection sur le serveur, sans qu'un octet transite par le PC. */
  const archive = async (paths: string[], name: string, format: ArchiveFormat) => {
    setArchiving(null);
    const dest = join(name);
    try {
      const size = await api.fsArchive(serverId, paths, dest, format);
      notify(`Archive créée : ${name} (${formatBytes(size)})`, "success");
      refresh();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Extrait une archive dans le dossier courant, après avoir montré ce qu'elle contient. */
  const extract = async (e: FsEntry) => {
    const inside = await api.fsArchiveList(serverId, e.path).catch(() => [] as string[]);
    const ok = await ask({
      title: `Extraire ${e.name} ici`,
      body:
        inside.length > 0
          ? `${inside.length} élément(s) seront déposés dans ${cwd}. Les fichiers de même nom seront remplacés.`
          : `Le contenu sera déposé dans ${cwd}. Les fichiers de même nom seront remplacés.`,
      code: inside.slice(0, 40).join("\n") || undefined,
      confirmLabel: "Extraire",
    });
    if (!ok) return;
    await act(() => api.fsExtract(serverId, e.path, cwd));
  };

  /** Compare deux fichiers du serveur côte à côte dans Monaco. */
  const compare = async (a: FsEntry, b: FsEntry) => {
    const tooBig = [a, b].find((x) => x.size > MAX_DIFF_SIZE);
    if (tooBig) return notify(`« ${tooBig.name} » est trop gros pour être comparé (plus de ${formatBytes(MAX_DIFF_SIZE)}).`, "error");
    try {
      const [original, modified] = await Promise.all([api.fsRead(serverId, a.path), api.fsRead(serverId, b.path)]);
      setDiff({ left: a.path, right: b.path, original, modified });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const crumbs = cwd.split("/").filter(Boolean);
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;
  /** Exactement deux fichiers sélectionnés : la comparaison a un sens. */
  const pair = selectedEntries.length === 2 && selectedEntries.every((e) => !isDir(e)) ? selectedEntries : null;
  const bookmarked = bookmarks.some((b) => b.path === cwd);
  const hiddenCount = (listing?.entries ?? []).filter((e) => e.name.startsWith(".")).length;
  const recents = (recentDirs.get(serverId) ?? []).filter((p) => p !== cwd && !bookmarks.some((b) => b.path === p));
  const showSidebar = !dual && sidebarOpen;
  const terminalHere = (dir: string) => openTab(serverId, { title: dir, command: `cd ${shellQuote(dir)} && exec "$SHELL" -l` });
  const copyPath = (path: string) => void writeClipboard(path).then(() => notify("Chemin copié", "success"));

  const rowMenu = (e: FsEntry): MenuItem[] => {
    const sel = selected.has(e.path) ? selectedEntries : [e];
    const many = sel.length > 1;
    return [
      ...(many
        ? []
        : ([
            isDir(e)
              ? { label: "Ouvrir", icon: <FolderOpen size={14} />, onClick: () => void load(e.path) }
              : { label: "Éditer", icon: <Pencil size={14} />, onClick: () => activate(e) },
            ...(!isDir(e) ? [{ label: "Aperçu", icon: <Eye size={14} />, onClick: () => setPreview(e) }] : []),
          ] as MenuItem[])),
      { label: many ? `Télécharger ${sel.length} éléments` : "Télécharger", icon: <Download size={14} />, onClick: () => void download(sel) },
      ...(dual ? [{ label: "Copier vers l'autre panneau", icon: <ArrowLeftRight size={14} />, onClick: () => void copyToOther(pane, serverId, sel.map((x) => x.path)) }] : []),
      "separator",
      ...(many
        ? []
        : ([
            { label: "Renommer", hint: "F2", icon: <PenLine size={14} />, onClick: () => void rename(e) },
            { label: "Permissions…", icon: <Shield size={14} />, onClick: () => setChmodOf(e) },
            { label: "Copier le chemin", icon: <Copy size={14} />, onClick: () => copyPath(e.path) },
          ] as MenuItem[])),
      ...(shell ? [{ label: "Compresser…", icon: <FileArchive size={14} />, onClick: () => setArchiving(sel.map((x) => x.path)) }] : []),
      ...(shell && !many && isArchive(e) ? [{ label: "Extraire ici", icon: <PackageOpen size={14} />, onClick: () => void extract(e) }] : []),
      ...(shell && !many && !isDir(e) && isComposeFile(e.name) ? [{ label: "Docker Compose…", icon: <Container size={14} />, onClick: () => setComposeFile(e.path) }] : []),
      ...(pair && selected.has(e.path) ? [{ label: "Comparer les deux fichiers", icon: <FileDiff size={14} />, onClick: () => void compare(pair[0], pair[1]) }] : []),
      ...(!many && isDir(e)
        ? ([
            ...(shell ? [{ label: "Terminal dans ce dossier", icon: <SquareTerminal size={14} />, onClick: () => terminalHere(e.path) }] : []),
            ...(!bookmarks.some((b) => b.path === e.path) ? [{ label: "Ajouter aux raccourcis", icon: <Star size={14} />, onClick: () => addBookmark(serverId, e.path) }] : []),
          ] as MenuItem[])
        : []),
      "separator",
      { label: many ? `Supprimer ${sel.length} éléments…` : "Supprimer…", hint: "Suppr", icon: <Trash2 size={14} />, danger: true, onClick: () => void remove(sel) },
    ];
  };

  const columns: Column<FsEntry>[] = [
    {
      key: "name",
      header: "Nom",
      width: "minmax(0,1fr)",
      sortValue: (e) => `${isDir(e) ? 0 : 1}${e.name.toLowerCase()}`,
      render: (e) => (
        <span className="flex min-w-0 items-center gap-2.5">
          {e.kind === "symlink" ? (
            <Link2 size={15} className={`shrink-0 ${e.targetIsDir ? "text-accent" : "text-[#c792ea]"}`} />
          ) : isDir(e) ? (
            <Folder size={15} className="shrink-0 text-accent" />
          ) : (
            <File size={15} className="shrink-0 text-muted" />
          )}
          <span className={`truncate ${isDir(e) ? "font-medium" : ""}`}>{e.name}</span>
        </span>
      ),
    },
    { key: "size", header: "Taille", width: "96px", align: "right", sortValue: (e) => (isDir(e) ? -1 : e.size), render: (e) => <span className="text-xs text-muted tabular-nums">{isDir(e) || e.kind === "symlink" ? "—" : formatBytes(e.size)}</span> },
    {
      key: "modified",
      header: "Modifié",
      width: "150px",
      sortValue: (e) => e.modified ?? 0,
      render: (e) => <span className="text-xs text-muted tabular-nums">{e.modified ? new Date(e.modified * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : ""}</span>,
    },
    ...(dual ? [] : [{ key: "perms", header: "Droits", width: "110px", sortValue: (e: FsEntry) => e.permissions, render: (e: FsEntry) => <span className="font-mono text-xs text-muted">{e.permissions}</span> }]),
    ...(dual
      ? []
      : [
          {
            key: "owner",
            header: "Propriétaire",
            width: "130px",
            sortValue: (e: FsEntry) => e.owner ?? "",
            render: (e: FsEntry) => (
              <span className="text-xs text-muted">
                {e.owner}
                {e.group && e.group !== e.owner ? `:${e.group}` : ""}
              </span>
            ),
          },
        ]),
  ];

  return (
    <div
      ref={root}
      data-pane={pane}
      className="relative flex h-full flex-col outline-none"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "Delete") void remove(selectedEntries);
        if (e.key === "F2" && single) void rename(single);
        if (e.key === "Backspace") void load(parentOf(cwd));
        if (e.key === "F5") refresh();
        if (e.key === "Escape" && selected.size) setSelected(new Set());
        // Ctrl+P : chercher un fichier ou du texte dans toute l'arborescence.
        if (shell && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
          e.preventDefault();
          setSearchOpen(true);
        }
      }}
      tabIndex={-1}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2.5">
        {onServerChange && (
          <Select className="w-36" value={serverId} onChange={onServerChange} aria-label="Serveur du panneau" options={servers.map((s) => ({ value: s.id, label: s.name }))} />
        )}
        {!dual && (
          <IconButton title={sidebarOpen ? "Masquer les emplacements" : "Afficher les emplacements"} active={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>
            <PanelLeft size={15} />
          </IconButton>
        )}
        <IconButton title="Dossier parent (Retour arrière)" onClick={() => void load(parentOf(cwd))} disabled={cwd === "/"}>
          <ArrowUp size={15} />
        </IconButton>
        {editingPath ? (
          <form
            className="flex min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setEditingPath(false);
              void load(pathInput.trim() || "/");
            }}
          >
            <Input
              autoFocus
              className="font-mono text-xs"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditingPath(false))}
              aria-label="Chemin"
            />
          </form>
        ) : (
          <nav
            aria-label="Chemin"
            onClick={(e) => e.target === e.currentTarget && setEditingPath(true)}
            title="Cliquer dans le vide pour saisir un chemin"
            className="flex h-8 min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-hidden rounded-lg border border-border bg-subtle px-1.5 font-mono text-xs"
          >
            <button type="button" className="rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg" onClick={() => void load("/")}>
              /
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex min-w-0 items-center gap-0.5">
                {i > 0 && <ChevronRight size={12} className="shrink-0 text-faint" />}
                <button
                  type="button"
                  className={`truncate rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg ${i === crumbs.length - 1 ? "bg-raised text-fg" : "text-muted"}`}
                  onClick={() => void load("/" + crumbs.slice(0, i + 1).join("/"))}
                >
                  {c}
                </button>
              </span>
            ))}
            <span className="min-w-6 flex-1 self-stretch" onClick={() => setEditingPath(true)} />
            <IconButton
              size="sm"
              title={bookmarked ? "Retirer ce dossier des raccourcis" : "Ajouter ce dossier aux raccourcis"}
              className={bookmarked ? "text-warn" : ""}
              disabled={!cwd}
              onClick={() => (bookmarked ? removeBookmark(serverId, cwd) : addBookmark(serverId, cwd))}
            >
              <Star size={14} fill={bookmarked ? "currentColor" : "none"} />
            </IconButton>
          </nav>
        )}
        <label className="relative w-40 shrink-0">
          <Filter size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input className="pl-7" placeholder="Filtrer" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <MenuButton
          label={dual ? undefined : "Nouveau"}
          icon={<Plus size={14} />}
          title="Nouveau dossier ou fichier"
          items={[
            { label: "Dossier…", icon: <FolderPlus size={14} />, onClick: () => void newItem("dir") },
            { label: "Fichier vide…", icon: <FilePlus size={14} />, onClick: () => void newItem("file") },
          ]}
        />
        <Button
          icon={<Upload size={14} />}
          title="Envoyer des fichiers de ton PC dans ce dossier"
          onClick={async () => {
            const files = await open({ multiple: true, title: "Fichiers à envoyer" });
            if (files) void upload(Array.isArray(files) ? files : [files]);
          }}
        >
          {dual ? null : "Envoyer"}
        </Button>
        {shell && (
          <IconButton title="Chercher un fichier ou du texte dans l'arborescence (Ctrl+P)" onClick={() => setSearchOpen(true)}>
            <Search size={15} />
          </IconButton>
        )}
        <IconButton title="Actualiser (F5)" onClick={refresh}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
        <MenuButton
          icon={<SlidersHorizontal size={15} />}
          title="Affichage et outils"
          items={[
            { label: "Fichiers cachés", checked: showHidden, onClick: () => setSettings({ showHiddenFiles: !showHidden }) },
            { label: "Double panneau (copie entre serveurs)", checked: dual, onClick: onToggleDual },
            ...(shell
              ? ([
                  {
                    label: "Mini terminal dans ce dossier",
                    checked: miniTerminalOpen,
                    onClick: () => {
                      setMiniTerminalOpen((v) => !v);
                      setTimeout(() => miniInputRef.current?.focus(), 0);
                    },
                  },
                  "separator",
                  { label: "Ouvrir un terminal ici", icon: <SquareTerminal size={14} />, disabled: !cwd, onClick: () => terminalHere(cwd) },
                ] as MenuItem[])
              : []),
            { label: "Copier le chemin du dossier", icon: <Copy size={14} />, disabled: !cwd, onClick: () => copyPath(cwd) },
            ...(shell && composeInCwd ? [{ label: `Docker Compose (${composeInCwd})…`, icon: <Container size={14} />, onClick: () => setComposeFile(join(composeInCwd)) }] : []),
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {showSidebar && (
          <aside className="scroll-thin flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-subtle px-2 py-3" aria-label="Emplacements">
            <Eyebrow className="px-2 pb-1">Emplacements</Eyebrow>
            <PlaceButton icon={<House size={14} />} label="Dossier personnel" onClick={() => void load("")} />
            <PlaceButton icon={<HardDrive size={14} />} label="Racine /" active={cwd === "/"} onClick={() => void load("/")} />
            <Eyebrow className="px-2 pt-3 pb-1">Raccourcis</Eyebrow>
            {bookmarks.length === 0 && <p className="px-2 text-[11.5px] text-faint">L'étoile du chemin ajoute le dossier courant ici.</p>}
            {bookmarks.map((b) => (
              <PlaceButton
                key={b.path}
                icon={<Star size={14} className="text-warn" fill="currentColor" />}
                label={b.name}
                title={b.path}
                active={b.path === cwd}
                onClick={() => void load(b.path)}
                menu={[
                  {
                    label: "Renommer…",
                    icon: <PenLine size={14} />,
                    onClick: async () => {
                      const name = await ask({ title: "Renommer le raccourci", body: b.path, input: { label: "Nom", initial: b.name }, confirmLabel: "Renommer" });
                      if (typeof name === "string" && name.trim()) renameBookmark(serverId, b.path, name.trim());
                    },
                  },
                  { label: "Retirer des raccourcis", icon: <X size={14} />, onClick: () => removeBookmark(serverId, b.path) },
                ]}
              />
            ))}
            {recents.length > 0 && (
              <>
                <Eyebrow className="px-2 pt-3 pb-1">Récents</Eyebrow>
                {recents.map((p) => (
                  <PlaceButton key={p} icon={<History size={14} />} label={p} mono title={p} onClick={() => void load(p)} />
                ))}
              </>
            )}
          </aside>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col">
          {error ? (
            <div className="p-5">
              <ErrorState message={error} onRetry={refresh}>
                <Button size="sm" variant="ghost" onClick={() => void load("")}>
                  Dossier personnel
                </Button>
              </ErrorState>
            </div>
          ) : !listing ? (
            <div className="p-5">
              <Loading rows={8} />
            </div>
          ) : (
            <DataTable
              className="min-h-0 flex-1 select-none"
              rows={entries}
              rowKey={(e) => e.path}
              columns={columns}
              rowHeight={36}
              initialSort={{ key: "name", dir: "asc" }}
              isSelected={(e) => selected.has(e.path)}
              onRowClick={(e, ev) => onRowClick(ev, e)}
              onRowDoubleClick={activate}
              onRowMouseDown={(e, ev) => onRowMouseDown(ev, e)}
              rowMenu={rowMenu}
              onBackgroundClick={() => setSelected(new Set())}
              empty={filter ? `Aucun élément ne contient « ${filter} ».` : "Dossier vide. Glisse des fichiers ici pour les envoyer."}
            />
          )}

          {selectedEntries.length > 0 && (
            <div className="animate-pop-in pointer-events-auto absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border border-border-strong bg-raised py-1 pr-1 pl-3.5 shadow-2xl">
              <span className="mr-2 shrink-0 text-[12.5px] font-semibold whitespace-nowrap">
                {selectedEntries.length} sélectionné{selectedEntries.length > 1 ? "s" : ""}
              </span>
              {dual && (
                <Button size="sm" variant="ghost" icon={<ArrowLeftRight size={13} />} onClick={() => void copyToOther(pane, serverId, selectedEntries.map((e) => e.path))}>
                  Vers l'autre panneau
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void download(selectedEntries)}>
                Télécharger
              </Button>
              {single && !isDir(single) && (
                <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => activate(single)}>
                  Éditer
                </Button>
              )}
              {shell && (
                <Button size="sm" variant="ghost" icon={<FileArchive size={13} />} onClick={() => setArchiving(selectedEntries.map((e) => e.path))}>
                  Compresser
                </Button>
              )}
              {shell && single && isArchive(single) && (
                <Button size="sm" variant="ghost" icon={<PackageOpen size={13} />} onClick={() => void extract(single)}>
                  Extraire
                </Button>
              )}
              {pair && (
                <Button size="sm" variant="ghost" icon={<FileDiff size={13} />} onClick={() => void compare(pair[0], pair[1])}>
                  Comparer
                </Button>
              )}
              {single && (
                <Button size="sm" variant="ghost" icon={<Shield size={13} />} onClick={() => setChmodOf(single)}>
                  Droits
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-danger hover:text-danger" icon={<Trash2 size={13} />} onClick={() => void remove(selectedEntries)}>
                Supprimer
              </Button>
              <span className="mx-1 h-5 w-px shrink-0 bg-border-strong" />
              <IconButton size="sm" title="Désélectionner (Échap)" onClick={() => setSelected(new Set())}>
                <X size={14} />
              </IconButton>
            </div>
          )}

          {miniTerminalOpen && (
            <div className="shrink-0 border-t border-border bg-term px-4 py-2.5">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-faint">
                <span>Mini terminal · une commande à la fois, dans le dossier affiché</span>
                <IconButton size="sm" title="Fermer le mini terminal" onClick={() => setMiniTerminalOpen(false)}>
                  <X size={13} />
                </IconButton>
              </div>
              {miniOutput.length > 0 && (
                <pre className="mb-2 max-h-36 overflow-auto rounded-lg border border-border bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap text-muted select-text">{miniOutput.join("\n")}</pre>
              )}
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runMiniCommand();
                }}
              >
                <span className="max-w-60 shrink-0 truncate font-mono text-xs text-accent" title={cwd}>
                  {cwd || "…"} $
                </span>
                <Input
                  ref={miniInputRef}
                  className="flex-1 font-mono text-xs"
                  value={miniCommand}
                  disabled={!cwd || miniRunning}
                  placeholder={cwd ? "Commande… (↑ ↓ : historique)" : "Chargement du dossier…"}
                  onChange={(event) => setMiniCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    const next = event.key === "ArrowUp" ? Math.min(miniHistoryIndex + 1, miniHistory.length - 1) : Math.max(miniHistoryIndex - 1, -1);
                    setMiniHistoryIndex(next);
                    setMiniCommand(next < 0 ? "" : (miniHistory[next] ?? ""));
                  }}
                  aria-label={`Commande dans ${cwd}`}
                />
                <Button size="sm" type="submit" variant="primary" loading={miniRunning} disabled={!cwd || !miniCommand.trim()}>
                  Exécuter
                </Button>
              </form>
            </div>
          )}

          <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-rail px-4 text-[11.5px] text-muted">
            <span>
              {entries.length} élément{entries.length > 1 ? "s" : ""}
              {!showHidden && hiddenCount > 0 && ` · ${hiddenCount} caché${hiddenCount > 1 ? "s" : ""}`}
            </span>
            <span className="truncate text-faint">Maj+clic : plage · Ctrl+clic : ajouter · F2 renommer · Suppr · clic droit : actions</span>
          </footer>
        </div>
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <div className="rounded-xl bg-raised px-4 py-3 text-[13px] shadow-xl">
            Déposer pour envoyer dans <span className="font-mono">{cwd}</span>
          </div>
        </div>
      )}

      {editing && (
        <Suspense fallback={null}>
          <FileEditor
            serverId={serverId}
            path={editing}
            line={editingLine}
            onClose={() => {
              setEditing(null);
              setEditingLine(undefined);
            }}
          />
        </Suspense>
      )}
      {preview && (
        <PreviewDrawer
          serverId={serverId}
          entry={preview}
          onClose={() => setPreview(null)}
          onEdit={() => {
            setPreview(null);
            activate(preview);
          }}
          onDownload={() => void download([preview])}
        />
      )}
      {composeFile && (
        <Suspense fallback={null}>
          <ComposeFileDialog serverId={serverId} file={composeFile} onClose={() => setComposeFile(null)} />
        </Suspense>
      )}
      {chmodOf && <ChmodDialog entry={chmodOf} onClose={() => setChmodOf(null)} onApply={(mode) => act(() => api.fsChmod(serverId, chmodOf.path, mode))} />}
      {searchOpen && (
        <Suspense fallback={null}>
          <FileSearch
            serverId={serverId}
            root={cwd}
            onClose={() => setSearchOpen(false)}
            onOpenFolder={(path) => void load(path)}
            onOpenFile={(path, line) => {
              // Le dossier du fichier est ouvert derrière l'éditeur : refermer laisse au bon endroit.
              void load(parentOf(path)).then(() => {
                setEditingLine(line);
                setEditing(path);
              });
            }}
          />
        </Suspense>
      )}
      {archiving && <ArchiveDialog paths={archiving} onClose={() => setArchiving(null)} onCreate={archive} />}
      {diff && (
        <Modal title={`${diff.left.split("/").pop()} ↔ ${diff.right.split("/").pop()}`} description={`${diff.left} ↔ ${diff.right}`} width="max-w-[95vw]" onClose={() => setDiff(null)}>
          <div className="h-[70vh]">
            <Suspense fallback={<Loading label="Chargement du comparateur…" />}>
              <DiffView original={diff.original} modified={diff.modified} language="plaintext" theme={theme === "light" ? "vs" : "vs-dark"} />
            </Suspense>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Entrée de la colonne « Emplacements » (avec un menu « ⋯ » pour les raccourcis). */
function PlaceButton({ icon, label, onClick, active, title, mono, menu }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; title?: string; mono?: boolean; menu?: MenuItem[] }) {
  return (
    <div className={`group flex items-center rounded-lg ${active ? "bg-raised text-fg" : "text-fg/85 hover:bg-hover"}`}>
      <button type="button" onClick={onClick} title={title} className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left ${mono ? "font-mono text-[11px] text-muted" : "text-[12.5px]"}`}>
        <span className="shrink-0 text-muted">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {menu && (
        <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <MenuButton size="sm" items={menu} title={`Raccourci ${label}`} />
        </span>
      )}
    </div>
  );
}

/** Aperçu rapide d'un fichier texte (les 64 premiers Ko), sans ouvrir l'éditeur. */
function PreviewDrawer({ serverId, entry, onClose, onEdit, onDownload }: { serverId: string; entry: FsEntry; onClose: () => void; onEdit: () => void; onDownload: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.fsReadRange(serverId, entry.path, 0, 64 * 1024).then(
      (w) => !cancelled && setText(w.text + (w.size > w.len ? `\n\n… (${formatBytes(w.size - w.len)} de plus : ouvre l'éditeur pour la suite)` : "")),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, entry.path]);
  return (
    <Drawer
      modal={false}
      width={560}
      title={entry.name}
      subtitle={`${entry.path} · ${formatBytes(entry.size)} · ${entry.permissions}`}
      onClose={onClose}
      actions={
        <>
          <Button size="sm" variant="primary" icon={<Pencil size={13} />} onClick={onEdit}>
            Éditer
          </Button>
          <Button size="sm" icon={<Download size={13} />} onClick={onDownload}>
            Télécharger
          </Button>
        </>
      }
    >
      {error ? <ErrorState message={error} /> : text === null ? <Loading rows={10} /> : <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap select-text">{text}</pre>}
    </Drawer>
  );
}

/** Choix du nom et du format avant de compresser une sélection côté serveur. */
function ArchiveDialog({
  paths,
  onClose,
  onCreate,
}: {
  paths: string[];
  onClose: () => void;
  onCreate: (paths: string[], name: string, format: ArchiveFormat) => Promise<void>;
}) {
  const [format, setFormat] = useState<ArchiveFormat>("targz");
  const [name, setName] = useState("");
  // Le nom proposé vient du serveur : même règle que celle appliquée à la compression.
  useEffect(() => {
    let cancelled = false;
    void api.fsArchiveName(paths, format).then((n) => !cancelled && setName(n));
    return () => {
      cancelled = true;
    };
  }, [paths, format]);

  const FORMATS: { id: ArchiveFormat; label: string; hint: string }[] = [
    { id: "targz", label: "tar.gz", hint: "attendu partout sous Linux, conserve droits et liens" },
    { id: "zip", label: "zip", hint: "s'ouvre sans rien installer sous Windows" },
    { id: "tarzst", label: "tar.zst", hint: "plus rapide et plus compact, demande zstd sur le serveur" },
  ];

  return (
    <Modal
      title={`Compresser ${paths.length > 1 ? `${paths.length} éléments` : paths[0].split("/").pop()}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void onCreate(paths, name.trim(), format)}>
            Compresser
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted">
        La compression a lieu sur le serveur : aucun octet ne transite par ton PC. L'archive est déposée dans le dossier affiché.
      </p>
      <div className="mb-4 grid gap-2" role="radiogroup" aria-label="Format">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={format === f.id}
            onClick={() => setFormat(f.id)}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-[13px] ${format === f.id ? "border-accent bg-accent/10" : "border-border hover:border-border-strong"}`}
          >
            <span className={`size-3.5 shrink-0 rounded-full border-2 ${format === f.id ? "border-accent bg-accent" : "border-border-strong"}`} />
            <span className="w-16 font-mono">{f.label}</span>
            <span className="text-xs text-muted">{f.hint}</span>
          </button>
        ))}
      </div>
      <Field label="Nom de l'archive" hint={`Extension attendue : .${ARCHIVE_EXTENSIONS[format]}`}>
        <Input className="font-mono text-sm" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ChmodDialog({ entry, onClose, onApply }: { entry: FsEntry; onClose: () => void; onApply: (mode: number) => Promise<boolean> }) {
  const [mode, setMode] = useState(entry.mode & 0o777);
  const who = [
    ["Propriétaire", 6],
    ["Groupe", 3],
    ["Autres", 0],
  ] as const;
  const perms = [
    ["Lecture", 4],
    ["Écriture", 2],
    ["Exécution", 1],
  ] as const;
  return (
    <Modal
      title={`Permissions de ${entry.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              // La fenêtre reste ouverte si le serveur refuse : on voit ce qui n'a pas été appliqué.
              if (await onApply(mode | (entry.mode & 0o7000))) onClose();
            }}
          >
            Appliquer
          </Button>
        </>
      }
    >
      <table className="mb-4 w-full text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th />
            {perms.map(([label]) => <th key={label} className="pb-2 font-medium">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {who.map(([label, shift]) => (
            <tr key={label}>
              <td className="py-1.5 text-muted">{label}</td>
              {perms.map(([p, bit]) => (
                <td key={p} className="text-center">
                  <span className="inline-flex" aria-label={`${label} ${p}`}>
                    <Checkbox checked={(mode & (bit << shift)) !== 0} onChange={(v) => setMode((m) => (v ? m | (bit << shift) : m & ~(bit << shift)))} />
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Field label="Mode octal">
        <Input
          className="font-mono"
          value={mode.toString(8).padStart(3, "0")}
          onChange={(e) => /^[0-7]{0,3}$/.test(e.target.value) && setMode(parseInt(e.target.value || "0", 8))}
        />
      </Field>
    </Modal>
  );
}
