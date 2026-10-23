import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Columns3, Database, Download, Eraser, FileSearch, History, KeyRound, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Rows3, Search, Table2, Trash2, TriangleAlert, X } from "lucide-react";
import {
  api,
  errorMessage,
  formatBytes,
  type DbColumn,
  type DbFilter,
  type DbInstance,
  type DbKeyPart,
  type DbNamed,
  type DbQueryResult,
} from "../lib/api";
import { useApp, useAppPick } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { useMonacoTheme } from "../lib/theme";
import { Badge, Button, Drawer, EmptyState, ErrorState, Eyebrow, Field, FOCUS_RING, IconButton, Input, Loading, MenuButton, Modal, Select, ToolbarSep, useContextMenu, type MenuItem } from "../components/ui";
import { isReadOnly } from "../lib/sql";
import { isAuthError } from "./databases/auth";
import { CreateTableDialog, StructureDrawer, useSchemaApply } from "./databases/Schema";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import DataGrid, { type Sort } from "../components/DataGrid";

// Monaco reste hors du morceau de code de cet onglet : il ne retarde plus son ouverture.
const SqlEditor = lazy(() => import("../components/SqlEditor"));
// La console Redis n'est chargée que si l'onglet Redis est ouvert.
const RedisPanel = lazy(() => import("../components/RedisPanel"));
const DbAdmin = lazy(() => import("./databases/DbAdmin"));
const DbLoginDialog = lazy(() => import("./databases/DbLoginDialog"));

const LIMITS = [100, 500, 1000, 5000];

export default function DatabasesView() {
  return <ServerGate title="Bases de données" guide="databases">{(serverId) => <Databases key={serverId} serverId={serverId} />}</ServerGate>;
}

/** Dernières requêtes exécutées, par serveur (conservées sur ce PC). */
function readHistory(serverId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(`zenytt.sqlHistory.${serverId}`) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushHistory(serverId: string, q: string): string[] {
  const list = [q.trim(), ...readHistory(serverId).filter((x) => x !== q.trim())].slice(0, 25);
  try {
    localStorage.setItem(`zenytt.sqlHistory.${serverId}`, JSON.stringify(list));
  } catch {
    /* historique non retenu */
  }
  return list;
}

/** Hauteur de l'éditeur SQL, réglable à la souris et retenue. */
function useEditorHeight(): [number, (e: React.PointerEvent<HTMLDivElement>) => void] {
  const [h, setH] = useState(() => {
    const v = Number(localStorage.getItem("zenytt.sqlEditorHeight"));
    return v >= 90 && v <= 700 ? v : 190;
  });
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = h;
    let last = h0;
    const move = (ev: PointerEvent) => {
      last = Math.max(90, Math.min(700, h0 + ev.clientY - y0));
      setH(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      try {
        localStorage.setItem("zenytt.sqlEditorHeight", String(last));
      } catch {
        /* non retenu */
      }
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return [h, start];
}

/** Valeur d'une cellule pour un fichier CSV (RFC 4180). */
function csvCell(v: string | null): string {
  if (v === null) return "";
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Table ouverte depuis la liste : son schéma, son tri et ses filtres. */
interface TableView {
  table: string;
  columns: DbColumn[];
  sort: Sort | null;
  filters: DbFilter[];
}

function Databases({ serverId }: { serverId: string }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [tab, setTab] = useTabIntent<"sql" | "admin" | "redis">("databases", "sql");
  const [history, setHistory] = useState(() => readHistory(serverId));
  const [editorHeight, startEditorResize] = useEditorHeight();
  const monacoTheme = useMonacoTheme();
  const [instances, setInstances] = useCachedState<DbInstance[] | null>(`db:${serverId}`, null);
  const [instanceId, setInstanceId] = useCachedState<string | null>(`dbInstance:${serverId}`, null);
  const [databases, setDatabases] = useState<DbNamed[] | null>(null);
  const [database, setDatabase] = useCachedState<string | null>(`dbName:${serverId}`, null);
  const [tables, setTables] = useState<DbNamed[] | null>(null);
  const [filter, setFilter] = useState("");
  const [sql, setSql] = useCachedState(`dbSql:${serverId}`, "SELECT 1;");
  const [limit, setLimitState] = useState(() => {
    const v = Number(localStorage.getItem("zenytt.sqlLimit"));
    return LIMITS.includes(v) ? v : 500;
  });
  const setLimit = (v: number) => {
    setLimitState(v);
    try {
      localStorage.setItem("zenytt.sqlLimit", String(v));
    } catch {
      /* non retenu */
    }
  };
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Table ouverte depuis la liste, ou null pour une requête libre (tableau en lecture seule). */
  const [view, setView] = useState<TableView | null>(null);
  /** Formulaire d'insertion d'une ligne. */
  const [inserting, setInserting] = useState<Record<string, string | null> | null>(null);
  const [searchingSqlite, setSearchingSqlite] = useState(false);

  const instance = instances?.find((i) => i.id === instanceId) ?? null;

  // Version de l'instance affichée : demandée après coup, elle ne retarde ni la liste ni les tables.
  // Elle est gardée à part et jamais réécrite dans `instances` : y toucher changeait l'identité de
  // l'objet, ce qui relançait cet effet en boucle et faisait clignoter la page.
  const [versions, setVersions] = useState<Record<string, string>>({});
  const instanceKey = instance?.id ?? null;
  /** Ligne ouverte en lecture complète. */
  const [rowDetail, setRowDetail] = useState<{ columns: string[]; values: (string | null)[] } | null>(null);
  /** Incrémenté pour relire bases et tables après une création. */
  const [refreshKey, setRefreshKey] = useState(0);
  /** La lecture des bases de l'instance a échoué (identifiants refusés, client absent…). */
  const [dbsFailed, setDbsFailed] = useState(false);
  const [loginFor, setLoginFor] = useState<DbInstance | null>(null);
  useEffect(() => {
    if (!instanceKey || !instance || versions[instanceKey] !== undefined) return;
    let cancelled = false;
    void api.dbVersion(serverId, instance).then(
      (v) => !cancelled && setVersions((x) => ({ ...x, [instanceKey]: v || instance.version || "" })),
      () => !cancelled && setVersions((x) => ({ ...x, [instanceKey]: "" })),
    );
    return () => {
      cancelled = true;
    };
    // `instance` ne figure pas dans les dépendances : seul son identifiant compte ici.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceKey, versions]);

  const loadInstances = useCallback(
    async (auto = false) => {
      setLoading(true);
      try {
        const list = await api.dbInstances(serverId);
        // Les fichiers SQLite déjà ouverts sont conservés : la découverte ne les renvoie pas.
        setInstances((old) => [...list, ...(old ?? []).filter((i) => i.engine === "sqlite")]);
        setInstanceId((id) => (list.some((i) => i.id === id) ? id : (list[0]?.id ?? null)));
      } catch (e) {
        if (!auto) setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [serverId, setInstances, setInstanceId],
  );

  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);
  useAutoRefresh((auto) => loadInstances(auto), { serverId, enabled: tab === "sql" });

  // Bases de l'instance choisie. Les effets suivants dépendent de l'IDENTIFIANT de l'instance, pas
  // de l'objet : l'actualisation automatique recrée la liste, et dépendre de l'objet relançait tout
  // (avec un passage par « null ») toutes les quelques secondes — d'où le clignotement.
  const instanceRef = useRef(instance);
  instanceRef.current = instance;

  useEffect(() => {
    if (!instanceKey) return;
    let cancelled = false;
    setDatabases(null);
    setTables(null);
    api.dbDatabases(serverId, instanceRef.current!).then(
      (list) => {
        if (cancelled) return;
        setDatabases(list);
        setDatabase((d) => (list.some((x) => x.name === d) ? d : (list.find((x) => !SYSTEM_DBS.includes(x.name))?.name ?? list[0]?.name ?? null)));
      },
      (e) => {
        if (cancelled) return;
        // Liste vide plutôt que « Lecture des bases… » sans fin ; l'explication s'affiche à droite.
        setDatabases([]);
        setDbsFailed(true);
        setError(errorMessage(e));
      },
    );
    setDbsFailed(false);
    return () => {
      cancelled = true;
    };
  }, [serverId, instanceKey, refreshKey, setDatabase]);

  // Tables de la base choisie.
  useEffect(() => {
    setTables(null);
    if (!instanceKey || !database) return;
    let cancelled = false;
    api.dbTables(serverId, instanceRef.current!, database).then(
      (list) => !cancelled && setTables(list),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, instanceKey, database, refreshKey]);

  // Changer d'instance ou de base rend la table ouverte caduque.
  useEffect(() => setView(null), [instanceKey, database]);

  /** Crée une base vide dans l'instance affichée, puis la sélectionne. */
  const createDatabase = async () => {
    if (!instance) return;
    const name = await ask({
      title: "Nouvelle base de données",
      body: `Sur ${instance.label}. Lettres, chiffres, « _ » et « - » uniquement. L'encodage est UTF-8.`,
      input: { label: "Nom de la base" },
      confirmLabel: "Créer",
    });
    if (typeof name !== "string" || !name.trim()) return;
    try {
      await api.dbCreate(serverId, instance, name.trim());
      notify(`Base « ${name.trim()} » créée.`, "success");
      setDatabase(name.trim());
      setRefreshKey((k) => k + 1);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Cherche les fichiers SQLite du serveur et les ajoute à la liste des instances. */
  const findSqlite = async () => {
    setSearchingSqlite(true);
    try {
      const found = await api.dbSqliteFiles(serverId);
      if (found.length === 0) {
        notify("Aucun fichier SQLite trouvé dans /opt, /srv, /var/lib, /var/www, /home, /root ou /data.", "info");
        return;
      }
      setInstances((old) => {
        const known = new Set((old ?? []).map((i) => i.id));
        return [...(old ?? []), ...found.filter((f) => !known.has(f.id))];
      });
      notify(`${found.length} fichier(s) SQLite trouvé(s).`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSearchingSqlite(false);
    }
  };

  const run = async (text = sql, fromTable = false) => {
    if (!instance || running || !text.trim()) return;
    // Une requête tapée à la main ne correspond plus forcément à la table ouverte : le tableau
    // repasse en lecture seule plutôt que d'éditer la mauvaise table.
    if (!fromTable) setView(null);
    // Une requête qui modifie les données demande confirmation : elle n'est pas annulable.
    if (!isReadOnly(text)) {
      const ok = await ask({
        title: "Cette requête modifie la base",
        body: `Elle sera exécutée sur ${database ?? instance.label}. Il n'y a pas d'annulation : vérifie la requête (et la sauvegarde) avant de continuer.`,
        code: text.trim().slice(0, 2000),
        confirmLabel: "Exécuter",
        danger: true,
      });
      if (!ok) return;
    }
    setRunning(true);
    setError(null);
    if (!fromTable) setHistory(pushHistory(serverId, text));
    try {
      setResult(await api.dbQuery(serverId, instance, database, text, limit));
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  /** Relit la table ouverte avec son tri et ses filtres, et met l'éditeur SQL en accord. */
  const runTable = useCallback(
    async (v: TableView) => {
      if (!instance) return;
      try {
        const q = await api.dbTableQuery(instance.engine, v.table, v.filters, v.sort?.column ?? null, v.sort?.desc ?? false, Math.min(limit, 5000));
        setSql(q);
        setView(v);
        setRunning(true);
        setError(null);
        setResult(await api.dbQuery(serverId, instance, database, q, limit));
      } catch (e) {
        // Pas de lignes de la table précédente sous l'erreur : elles prêteraient à confusion.
        setResult(null);
        setError(errorMessage(e));
      } finally {
        setRunning(false);
      }
    },
    [instance, serverId, database, limit, setSql],
  );

  const openTable = async (name: string) => {
    if (!instance) return;
    try {
      // Le schéma sert à deux choses : l'autocomplétion, et savoir si l'édition est possible.
      const columns = await api.dbColumns(serverId, instance, database, name).catch(() => [] as DbColumn[]);
      await runTable({ table: name, columns, sort: null, filters: [] });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Clé primaire de la table ouverte, entièrement présente dans le résultat affiché. */
  const primary = useMemo(() => {
    if (!view || !result) return null;
    const names = view.columns.filter((c) => c.primary).map((c) => c.name);
    if (names.length === 0 || !names.every((n) => result.columns.includes(n))) return null;
    return names;
  }, [view, result]);

  const keyOf = (rowIndex: number): DbKeyPart[] =>
    (primary ?? []).map((name) => ({ column: name, value: result!.rows[rowIndex][result!.columns.indexOf(name)] ?? null }));

  /** Applique une requête d'écriture après validation, puis relit la table. */
  const applyWrite = async (title: string, body: string, sqlText: string) => {
    if (!instance || !view) return;
    const ok = await ask({ title, body, code: sqlText, confirmLabel: "Appliquer", danger: true });
    if (!ok) return;
    try {
      await api.dbQuery(serverId, instance, database, sqlText, 1);
      notify("Modification appliquée.", "success");
      await runTable(view);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const editCell = async (column: string, rowIndex: number, value: string | null) => {
    if (!instance || !view || !primary || !result) return;
    const before = result.rows[rowIndex][result.columns.indexOf(column)];
    try {
      const sqlText = await api.dbUpdateCellSql(instance.engine, view.table, column, value, keyOf(rowIndex));
      await applyWrite(
        `Modifier ${view.table}.${column}`,
        `Avant : ${before === null ? "NULL" : `« ${before} »`}\nAprès : ${value === null ? "NULL" : `« ${value} »`}`,
        sqlText,
      );
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const deleteRow = async (rowIndex: number) => {
    if (!instance || !view || !primary) return;
    try {
      const sqlText = await api.dbDeleteRowSql(instance.engine, view.table, keyOf(rowIndex));
      await applyWrite("Supprimer cette ligne", "La suppression est définitive : il n'y a pas d'annulation.", sqlText);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const insertRow = async () => {
    if (!instance || !view || !inserting) return;
    const values = Object.entries(inserting).filter(([, v]) => v !== null && v !== "") as [string, string][];
    setInserting(null);
    if (values.length === 0) return notify("Aucune valeur saisie.", "info");
    try {
      const sqlText = await api.dbInsertRowSql(instance.engine, view.table, values);
      await applyWrite(`Ajouter une ligne dans ${view.table}`, "Les colonnes laissées vides prennent leur valeur par défaut.", sqlText);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const exportCsv = async () => {
    if (!result) return;
    const path = await saveDialog({ defaultPath: `${database ?? "resultat"}-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    const text = [result.columns.map(csvCell).join(","), ...result.rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
    try {
      await api.saveTextFile(path, text);
      notify(`Exporté : ${path}`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  // Structure sans SQL : nouvelle table, structure d'une table, actions sur tables et bases.
  const [creatingTable, setCreatingTable] = useState(false);
  const [structureOf, setStructureOf] = useState<string | null>(null);
  const afterSchema = useCallback(() => setRefreshKey((k) => k + 1), []);
  const applySchema = useSchemaApply(serverId, instance ?? undefined, database, afterSchema);
  const schemaMenu = useContextMenu();
  const tableItems = (t: string): MenuItem[] => [
    { label: "Ouvrir", icon: <Table2 size={14} />, onClick: () => void openTable(t) },
    { label: "Structure (colonnes)…", icon: <Columns3 size={14} />, onClick: () => setStructureOf(t) },
    "separator",
    {
      label: "Renommer…",
      icon: <Pencil size={14} />,
      onClick: async () => {
        const to = await ask({ title: `Renommer la table « ${t} »`, input: { label: "Nouveau nom", initial: t }, confirmLabel: "Continuer" });
        if (typeof to !== "string" || !to.trim() || to.trim() === t) return;
        if (await applySchema({ op: "renameTable", table: t, to: to.trim() }, `Renommer « ${t} » en « ${to.trim()} » ?`, "Les applications qui utilisent l'ancien nom devront être adaptées.") && view?.table === t) setView(null);
      },
    },
    {
      label: "Vider (supprimer toutes les lignes)…",
      icon: <Eraser size={14} />,
      danger: true,
      onClick: async () => {
        if (await applySchema({ op: "truncateTable", table: t }, `Vider la table « ${t} » ?`, "Toutes ses lignes sont supprimées définitivement ; la structure est conservée.") && view?.table === t) await runTable(view);
      },
    },
    {
      label: "Supprimer la table…",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: async () => {
        if (await applySchema({ op: "dropTable", table: t }, `Supprimer la table « ${t} » ?`, "La table et toutes ses données sont supprimées définitivement. Pense à faire une sauvegarde (onglet Administration) avant.") && view?.table === t) {
          setView(null);
          setResult(null);
        }
      },
    },
  ];
  const databaseItems = (d: string): MenuItem[] => [
    ...(instance?.engine === "sqlite" ? [] : [{ label: "Nouvelle table…", icon: <Plus size={14} />, onClick: () => { setDatabase(d); setCreatingTable(true); } }]),
    ...(instance?.engine === "sqlite" || SYSTEM_DBS.includes(d)
      ? []
      : [
          "separator" as const,
          {
            label: "Supprimer la base…",
            icon: <Trash2 size={14} />,
            danger: true,
            onClick: async () => {
              const typed = await ask({ title: `Supprimer la base « ${d} » ?`, body: "Toutes ses tables et données sont supprimées définitivement. Pour confirmer, tape son nom.", input: { label: "Nom de la base" }, confirmLabel: "Continuer", danger: true });
              if (typed !== d) return;
              if (await applySchema({ op: "dropDatabase", database: d }, `Dernière confirmation : supprimer « ${d} » ?`, "Il n'y a pas d'annulation.") && database === d) setDatabase(null);
            },
          },
        ]),
  ];

  const shownTables = useMemo(() => (tables ?? []).filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase())), [tables, filter]);

  const layout = (children: React.ReactNode) => (
    <PageLayout
      title="Bases de données"
      context={server && <ServerContext server={server} />}
      subtitle="Requêtes via le client du serveur (mysql, psql, sqlite3, redis-cli) : aucun port de base à ouvrir"
      guide="databases"
      scroll={false}
      tabs={[
        { id: "sql", label: "SQL", count: instances?.filter((i) => i.engine !== "sqlite").length || undefined },
        { id: "admin", label: "Administration" },
        { id: "redis", label: "Redis / Valkey" },
      ]}
      activeTab={tab}
      onTab={setTab}
      actions={
        tab === "sql" ? (
          <MenuButton
            label="Historique"
            icon={<History size={14} />}
            title="Dernières requêtes exécutées sur ce serveur"
            disabled={history.length === 0}
            items={() => [
              { heading: "Dernières requêtes" },
              ...history.slice(0, 15).map((q) => ({ label: q.replace(/\s+/g, " ").slice(0, 70) + (q.length > 70 ? "…" : ""), onClick: () => setSql(q) })),
              "separator" as const,
              {
                label: "Effacer l'historique",
                icon: <X size={14} />,
                onClick: () => {
                  try {
                    localStorage.removeItem(`zenytt.sqlHistory.${serverId}`);
                  } catch {
                    /* rien */
                  }
                  setHistory([]);
                },
              },
            ]}
          />
        ) : undefined
      }
    >
      {children}
    </PageLayout>
  );

  if (tab === "redis") {
    return layout(
      <Suspense fallback={<Loading />}>
        <RedisPanel serverId={serverId} />
      </Suspense>,
    );
  }

  if (tab === "admin" && !instances) return layout(<Loading rows={4} />);
  if (tab === "admin" && instances && instances.length > 0) {
    return layout(
      <Suspense fallback={<Loading />}>
        <DbAdmin serverId={serverId} instances={instances} instanceId={instanceId} onInstance={setInstanceId} databases={databases} />
      </Suspense>,
    );
  }

  if (instances && instances.length === 0) {
    return layout(
      <EmptyState
        icon={<Database />}
        title="Aucune base de données trouvée"
        action={
          <>
            <Button icon={<RefreshCw size={13} />} onClick={() => void loadInstances()}>
              Rechercher à nouveau
            </Button>
            <Button icon={<FileSearch size={13} />} loading={searchingSqlite} onClick={() => void findSqlite()}>
              Chercher des fichiers SQLite
            </Button>
            <Button variant="ghost" onClick={() => setTab("redis")}>
              Explorer Redis
            </Button>
          </>
        }
      >
        Zenytt cherche les conteneurs MySQL, MariaDB et PostgreSQL en cours, ainsi que les services installés sur le serveur.
      </EmptyState>,
    );
  }

  const engineColor = (e: string) => (e === "postgres" ? "text-accent" : e === "sqlite" ? "text-muted" : "text-warn");

  return layout(
    <>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[270px] max-w-[34%] shrink-0 flex-col border-r border-border bg-subtle" aria-label="Explorateur">
          <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
            <Eyebrow>Instances</Eyebrow>
            <IconButton size="sm" title="Rechercher à nouveau" onClick={() => void loadInstances()}>
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </IconButton>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {instances === null && <Loading rows={3} />}
            {(instances ?? []).map((i) => {
              const current = i.id === instanceId;
              const v = versions[i.id] || i.version;
              return (
                <div key={i.id} className="mb-0.5">
                  <button
                    type="button"
                    onClick={() => setInstanceId(i.id)}
                    aria-expanded={current}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${FOCUS_RING} ${current ? "bg-raised" : "hover:bg-hover"}`}
                  >
                    <ChevronDown size={13} className={`shrink-0 text-faint transition-transform ${current ? "" : "-rotate-90"}`} />
                    <Database size={14} className={`shrink-0 ${engineColor(i.engine)}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{i.label}</span>
                      {v && <span className="block truncate text-[10.5px] text-faint">{v}</span>}
                    </span>
                    {current && i.engine !== "sqlite" && (
                      <span
                        role="button"
                        tabIndex={0}
                        title="Identifiants de connexion à cette instance"
                        className="shrink-0 rounded p-1 text-faint hover:bg-hover-strong hover:text-fg"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLoginFor(i);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            setLoginFor(i);
                          }
                        }}
                      >
                        <KeyRound size={12} />
                      </span>
                    )}
                  </button>
                  {current && (
                    <div className="mt-0.5 ml-4 border-l border-border pl-1.5">
                      {databases === null && <p className="px-2 py-1 text-xs text-faint">Lecture des bases…</p>}
                      {dbsFailed && (
                        <button type="button" className="flex items-center gap-1.5 px-2 py-1 text-left text-xs text-danger hover:underline" onClick={() => setLoginFor(i)}>
                          <KeyRound size={12} /> Lecture impossible : identifiants…
                        </button>
                      )}
                      {(databases ?? []).map((d) => {
                        const on = d.name === database;
                        return (
                          <div key={d.name}>
                            <button
                              type="button"
                              onClick={() => setDatabase(d.name)}
                              onContextMenu={(e) => databaseItems(d.name).length > 0 && schemaMenu.open(e, databaseItems(d.name))}
                              className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] ${FOCUS_RING} ${on ? "font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg"} ${SYSTEM_DBS.includes(d.name) ? "opacity-70" : ""}`}
                            >
                              <ChevronDown size={12} className={`shrink-0 text-faint transition-transform ${on ? "" : "-rotate-90"}`} />
                              <span className="min-w-0 flex-1 truncate">{d.name}</span>
                              {d.size ? <span className="text-[10.5px] text-faint">{formatBytes(d.size)}</span> : null}
                            </button>
                            {on && (
                              <div className="mb-1 ml-3.5">
                                <label className="relative my-1 block">
                                  <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
                                  <Input size_="sm" className="pl-6" placeholder="Filtrer les tables" value={filter} onChange={(e) => setFilter(e.target.value)} />
                                </label>
                                {instance?.engine !== "sqlite" && (
                                  <button type="button" className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-left text-[12px] text-accent hover:bg-hover ${FOCUS_RING}`} onClick={() => setCreatingTable(true)}>
                                    <Plus size={12} /> Nouvelle table
                                  </button>
                                )}
                                {tables === null ? (
                                  <p className="px-2 py-1 text-xs text-faint">Lecture des tables…</p>
                                ) : shownTables.length === 0 ? (
                                  <p className="px-2 py-1 text-xs text-faint">Aucune table.</p>
                                ) : (
                                  shownTables.map((t) => (
                                    <button
                                      key={t.name}
                                      type="button"
                                      className={`group/t flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-left text-[12.5px] ${FOCUS_RING} ${
                                        view?.table === t.name ? "bg-accent/12 text-fg" : "text-fg/85 hover:bg-hover"
                                      }`}
                                      title={`${t.count.toLocaleString("fr-FR")} lignes (estimation) · ${formatBytes(t.size)}`}
                                      onClick={() => void openTable(t.name)}
                                      onContextMenu={(e) => schemaMenu.open(e, tableItems(t.name))}
                                    >
                                      <Table2 size={12} className="shrink-0 text-faint" />
                                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                                      <span className="text-[10.5px] text-faint tabular-nums group-hover/t:hidden">{t.count > 0 ? t.count.toLocaleString("fr-FR") : ""}</span>
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        title="Structure, renommer, vider, supprimer"
                                        className="hidden shrink-0 rounded px-0.5 text-faint group-hover/t:block hover:text-fg"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          schemaMenu.open(e, tableItems(t.name));
                                        }}
                                      >
                                        <MoreHorizontal size={13} />
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex gap-1.5 border-t border-border p-2">
            <Button size="sm" className="flex-1" icon={<Plus size={13} />} disabled={!instance || instance.engine === "sqlite"} onClick={() => void createDatabase()}>
              Nouvelle base
            </Button>
            <Button size="sm" icon={<FileSearch size={13} />} loading={searchingSqlite} onClick={() => void findSqlite()} title="Chercher les fichiers .db / .sqlite du serveur">
              SQLite
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <Button size="sm" variant="primary" loading={running} icon={<Play size={13} />} disabled={!instance} onClick={() => void run()}>
              Exécuter
            </Button>
            <span className="font-mono text-[11px] text-faint">Ctrl+Entrée</span>
            <ToolbarSep />
            <Select size="sm" className="w-36" value={limit} onChange={setLimit} aria-label="Nombre de lignes" options={LIMITS.map((n) => ({ value: n, label: `${n} lignes max` }))} />
            {sql.trim().length > 0 && !isReadOnly(sql) && (
              <Badge tone="warn">
                <TriangleAlert size={11} /> requête qui modifie
              </Badge>
            )}
            {view && (
              <Badge tone={primary ? "accent" : "muted"}>
                {view.table}
                {primary ? " · éditable" : " · lecture seule (pas de clé primaire)"}
              </Badge>
            )}
            {view && view.filters.length > 0 && (
              <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => void runTable({ ...view, filters: [] })}>
                Retirer les filtres ({view.filters.length})
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {view && primary && (
                <Button size="sm" icon={<Rows3 size={13} />} onClick={() => setInserting(Object.fromEntries(view.columns.map((c) => [c.name, ""])))}>
                  Ajouter une ligne
                </Button>
              )}
              <Button size="sm" icon={<Download size={13} />} disabled={!result || result.rows.length === 0} onClick={() => void exportCsv()}>
                Exporter CSV
              </Button>
            </div>
          </div>
          <div className="shrink-0 bg-term" style={{ height: editorHeight }}>
            <Suspense fallback={<Loading label="Chargement de l'éditeur…" />}>
              <SqlEditor
                value={sql}
                onChange={setSql}
                theme={monacoTheme}
                tables={(tables ?? []).map((t) => t.name)}
                columns={view?.columns.map((c) => ({ name: c.name, table: view.table, dataType: c.dataType })) ?? []}
                onMount={(editor, monaco) => {
                  // Ctrl+Entrée exécute, comme dans les clients SQL habituels.
                  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run(editor.getValue()));
                }}
              />
            </Suspense>
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Glisser pour agrandir l'éditeur ou les résultats"
            onPointerDown={startEditorResize}
            className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-y border-border bg-subtle hover:bg-accent/20"
          >
            <span className="h-0.5 w-9 rounded bg-border-strong group-hover:bg-accent" />
          </div>
          {/* Le tableau garde ses colonnes à leur largeur naturelle et défile horizontalement. */}
          <div className="min-h-0 flex-1 overflow-auto">
            {error && (
              <div className="m-4">
                <ErrorState message={<pre className="font-mono text-xs whitespace-pre-wrap">{error}</pre>}>
                  {instance && instance.engine !== "sqlite" && isAuthError(error) && (
                    <Button size="sm" variant="outline" className="shrink-0" icon={<KeyRound size={13} />} onClick={() => setLoginFor(instance)}>
                      Renseigner les identifiants
                    </Button>
                  )}
                </ErrorState>
              </div>
            )}
            {!result && !error && !running && (
              <EmptyState icon={<Table2 />} title="Choisis une table ou écris une requête">
                Un clic sur une table l'ouvre ici : tri et filtres depuis l'en-tête des colonnes, double-clic pour modifier une cellule (si la table a une clé primaire). Chaque modification montre sa requête avant d'être appliquée.
              </EmptyState>
            )}
            {result && result.columns.length > 0 && (
              <DataGrid
                result={result}
                columns={view?.columns ?? null}
                editable={!!primary}
                sort={view?.sort ?? null}
                onSort={(s) => view && void runTable({ ...view, sort: s })}
                filters={view?.filters ?? []}
                onFilters={(f) => view && void runTable({ ...view, filters: f })}
                onEditCell={(c, i, v) => void editCell(c, i, v)}
                onDeleteRow={(i) => void deleteRow(i)}
                onOpenRow={(values) => setRowDetail({ columns: result.columns, values })}
              />
            )}
            {result && result.columns.length === 0 && !error && <p className="p-4 text-[13px] text-muted">Requête exécutée (aucun résultat à afficher).</p>}
          </div>
          <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-rail px-4 text-[11.5px] text-muted">
            {result ? (
              <span>
                {result.rows.length.toLocaleString("fr-FR")} ligne{result.rows.length > 1 ? "s" : ""} · {result.durationMs} ms{result.truncated && " · tronqué à la limite"}
              </span>
            ) : (
              <span>{instance ? `${instance.label}${database ? ` · ${database}` : ""}` : "Aucune instance choisie"}</span>
            )}
            <span className="truncate text-faint">Clic sur ⤢ : fiche de la ligne · double-clic : modifier la cellule · menu de colonne : tri et filtres</span>
          </footer>
        </div>
      </div>

      {schemaMenu.menu}
      {creatingTable && instance && database && <CreateTableDialog instance={instance} database={database} apply={applySchema} onClose={() => setCreatingTable(false)} />}
      {structureOf && instance && (
        <StructureDrawer
          serverId={serverId}
          instance={instance}
          database={database}
          table={structureOf}
          apply={applySchema}
          onClose={() => {
            setStructureOf(null);
            if (view?.table === structureOf) void openTable(structureOf);
          }}
        />
      )}
      {loginFor && (
        <Suspense fallback={null}>
          <DbLoginDialog
            serverId={serverId}
            instance={loginFor}
            onClose={() => setLoginFor(null)}
            onSaved={() => {
              setError(null);
              setRefreshKey((k) => k + 1);
            }}
          />
        </Suspense>
      )}
      {rowDetail && (
        <Drawer title="Fiche de la ligne" subtitle={view ? `Table ${view.table}` : "Résultat de requête"} width={560} modal={false} onClose={() => setRowDetail(null)}>
          <dl className="flex flex-col divide-y divide-line rounded-xl border border-border">
            {rowDetail.columns.map((c, i) => (
              <div key={i} className="grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)] gap-4 px-3 py-2">
                <dt className="truncate font-mono text-xs text-muted" title={c}>
                  {c}
                </dt>
                <dd className="font-mono text-xs break-all whitespace-pre-wrap select-text">
                  {rowDetail.values[i] === null ? <span className="text-faint italic">NULL</span> : rowDetail.values[i]}
                </dd>
              </div>
            ))}
          </dl>
        </Drawer>
      )}

      {inserting && view && (
        <Modal
          title={`Ajouter une ligne dans ${view.table}`}
          description="Les colonnes laissées vides prennent leur valeur par défaut (auto-incrément, date du jour…)."
          width="max-w-2xl"
          onClose={() => setInserting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setInserting(null)}>
                Annuler
              </Button>
              <Button variant="primary" onClick={() => void insertRow()}>
                Vérifier la requête
              </Button>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {view.columns.map((c) => (
              <Field key={c.name} label={`${c.name}${c.nullable ? "" : " *"}`} hint={`${c.dataType}${c.primary ? " · clé primaire" : ""}`}>
                <Input className="font-mono text-xs" value={inserting[c.name] ?? ""} placeholder={c.primary ? "auto" : ""} onChange={(e) => setInserting({ ...inserting, [c.name]: e.target.value })} />
              </Field>
            ))}
          </div>
        </Modal>
      )}
    </>,
  );
}

const SYSTEM_DBS = ["information_schema", "performance_schema", "mysql", "sys", "postgres", "template0", "template1"];

