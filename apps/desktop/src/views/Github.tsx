// GitHub : dépôts du compte, où ils sont déployés sur les serveurs connectés, cloner et mettre à jour.
// Liste à gauche, détail du dépôt choisi à droite (l'un au-dessus de l'autre dans une fenêtre étroite).
// Le jeton reste dans le coffre de l'OS : l'interface ne le relit jamais.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  Container, ExternalLink, Eye, EyeOff, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequestArrow, KeyRound, Loader2, Lock, LogOut, RefreshCw, Rocket, Search, Server, ShieldAlert, SquareTerminal, TriangleAlert, UserRound,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, hasShell, shellQuote, type GithubCiRun, type GithubClone, type GithubDeployment, type GithubRepo, type GithubStatus, type ServerView } from "../lib/api";
import {
  agoOf, browseRepos, certainDeployments, ciState, clonePath, cloneSync, containerTone, githubError, oldRemoteName, otherDeployments, repoUrl, urgentAlerts, validFolder, validToken, type InsightKind, type RepoFilter, type RepoSort,
} from "../lib/github";
import {
  AlertBadges, AlertsSection, CiSection, Fold, fetchInsight, GhDeploymentsSection, INSIGHT_KINDS, IssuesSection, PullsSection, ReloadButton, type Insights, type Slot,
} from "./GithubInsights";
import { navigate } from "../lib/shell";
import { useApp, useAppPick } from "../lib/store";
import { useCachedState } from "../lib/cache";
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, FOCUS_RING, IconButton, Input, Loading, MenuButton, Modal, ResizeHandle, ResultBanner, Segmented, Select, Skeleton, StatusDot, useResizable,
} from "../components/ui";
import PageLayout from "../components/PageLayout";

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const FOLDERS = ["/srv", "/opt", "/var/www"];
/** Pastilles de CI de la liste : seulement les premiers dépôts affichés, 3 requêtes à la fois, pour ménager la limite de GitHub. */
const DOT_LIMIT = 15;
const DOT_PARALLEL = 3;
/** Dernier run de la branche par défaut d'un dépôt (null : aucun workflow). */
type Dots = Record<string, Slot<GithubCiRun | null>>;
type InsightsByRepo = Record<string, Insights>;

interface ServerScan {
  loading: boolean;
  clones: GithubClone[];
  error?: string;
}
/** Clones connus, par dépôt puis par serveur. */
type Scans = Record<string, Record<string, ServerScan>>;
interface ServerDeps {
  loading: boolean;
  items: GithubDeployment[];
  error?: string;
}
/** Déploiements de tous les dépôts, par serveur (une seule commande par serveur). */
type Deps = Record<string, ServerDeps>;

const openRepo = (r: GithubRepo) => {
  const url = repoUrl(r.owner, r.name);
  if (url) void openUrl(url);
};
const openTerminal = (serverId: string, title: string, path: string) =>
  useApp.getState().openTab(serverId, { title, command: `cd ${shellQuote(path)} && exec "$SHELL" -l` });
const openFiles = (serverId: string, path: string) => {
  useApp.getState().setFilesPath(serverId, path);
  navigate("files", undefined, serverId);
};

export default function GithubView() {
  const { servers, notify, ask } = useAppPick("servers", "notify", "ask");
  const targets = useMemo(() => servers.filter((s) => s.connected && hasShell(s)), [servers]);
  const [status, setStatus] = useCachedState<GithubStatus | null>("github:status", null);
  const [repos, setRepos] = useCachedState<GithubRepo[] | null>("github:repos", null);
  const [scans, setScans] = useCachedState<Scans>("github:scans", {});
  const [deps, setDeps] = useCachedState<Deps>("github:deps", {});
  const [insights, setInsights] = useCachedState<InsightsByRepo>("github:insights", {});
  const [dots, setDots] = useCachedState<Dots>("github:dots", {});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [sort, setSort] = useState<RepoSort>("pushed");
  const [selected, setSelected] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [cloneFor, setCloneFor] = useState<GithubRepo | null>(null);

  const load = useCallback(async (reset = false) => {
    setError(null);
    setLoading(true);
    try {
      const st = await api.githubStatus();
      setStatus(st);
      setRepos(st.configured ? await api.githubRepos() : null);
      // Actualiser (ou changer de jeton) repart de zéro : CI, PR, tickets, alertes seront relus.
      if (reset) {
        setInsights({});
        setDots({});
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [setStatus, setRepos, setInsights, setDots]);
  useEffect(() => void load(), [load]);

  const scan = useCallback(
    async (repo: GithubRepo, serverId: string) => {
      const put = (v: ServerScan) => setScans((all) => ({ ...all, [repo.fullName]: { ...all[repo.fullName], [serverId]: v } }));
      put({ loading: true, clones: [] });
      try {
        put({ loading: false, clones: await api.githubClones(serverId, repo.owner, repo.name) });
      } catch (e) {
        put({ loading: false, clones: [], error: errorMessage(e) });
      }
    },
    [setScans],
  );
  const replace = (repo: GithubRepo, serverId: string, c: GithubClone) =>
    setScans((all) => {
      const cur = all[repo.fullName]?.[serverId];
      if (!cur) return all;
      return { ...all, [repo.fullName]: { ...all[repo.fullName], [serverId]: { ...cur, clones: cur.clones.map((x) => (x.path === c.path ? c : x)) } } };
    });

  // Une commande par serveur couvre tous les dépôts : à l'ouverture de la page (sauf serveurs déjà examinés), ou à la demande.
  const scanServers = useCallback(
    async (ids: string[]) => {
      const list = (repos ?? []).map((r) => ({ id: r.id, owner: r.owner, name: r.name }));
      if (!list.length) return;
      setDeps((all) => ({ ...all, ...Object.fromEntries(ids.map((id) => [id, { loading: true, items: all[id]?.items ?? [] }])) }));
      await Promise.all(
        ids.map(async (id) => {
          try {
            const items = await api.githubServerDeployments(id, list);
            setDeps((all) => ({ ...all, [id]: { loading: false, items } }));
          } catch (e) {
            setDeps((all) => ({ ...all, [id]: { loading: false, items: [], error: errorMessage(e) } }));
          }
        }),
      );
    },
    [repos, setDeps],
  );
  const targetIds = targets.map((s) => s.id).join(",");
  const depsKnown = repos !== null;
  useEffect(() => {
    if (!depsKnown) return;
    const todo = targets.filter((s) => !deps[s.id]).map((s) => s.id);
    if (todo.length) void scanServers(todo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKnown, targetIds]);
  const depsLoading = targets.some((s) => deps[s.id]?.loading);
  const allDeps = useMemo(() => Object.values(deps).flatMap((d) => d.items), [deps]);

  const deployedCount = useCallback(
    (fullName: string) => {
      const known = certainDeployments(allDeps, fullName).length;
      return known || Object.values(scans[fullName] ?? {}).reduce((n, s) => n + s.clones.length, 0);
    },
    [allDeps, scans],
  );
  const shown = useMemo(() => browseRepos(repos ?? [], query, filter, sort, (n) => deployedCount(n) > 0), [repos, query, filter, sort, deployedCount]);
  const current = shown.find((r) => r.fullName === selected) ?? shown[0] ?? null;

  // Examine les serveurs une fois que la sélection se pose : parcourir la liste au clavier ne lance pas un scan par ligne.
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => {
      for (const s of targets) if (!scans[current.fullName]?.[s.id]) void scan(current, s.id);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.fullName, targetIds]);

  // Chaque donnée (CI, PR, tickets, alertes, déploiements, version) se charge seule, à la sélection, puis reste en cache pour la session.
  const loadInsight = useCallback(
    async (repo: GithubRepo, kind: InsightKind) => {
      const put = (change: (old: Slot<unknown> | undefined) => Slot<unknown>) =>
        setInsights((all) => {
          const cur = all[repo.fullName] as Record<string, Slot<unknown> | undefined> | undefined;
          return { ...all, [repo.fullName]: { ...cur, [kind]: change(cur?.[kind]) } };
        });
      put((old) => ({ loading: true, data: old?.data })); // l'ancien contenu reste affiché pendant l'actualisation
      try {
        const data = await fetchInsight(kind, repo);
        put(() => ({ loading: false, data }));
      } catch (e) {
        put(() => ({ loading: false, error: errorMessage(e) }));
      }
    },
    [setInsights],
  );
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => {
      const known = insights[current.fullName] ?? {};
      for (const k of INSIGHT_KINDS) if (!known[k]) void loadInsight(current, k);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.fullName, !insights[current?.fullName ?? ""]]);

  // Pastille de CI : les premiers dépôts de la liste seulement, 3 requêtes à la fois. La première erreur (permission, limite) arrête le reste.
  const dotsOff = Object.values(dots).some((d) => d.error);
  const dotKey = shown.slice(0, DOT_LIMIT).map((r) => r.fullName).join(",");
  const dotQueue = useRef(new Set<string>());
  useEffect(() => {
    if (dotsOff || !repos) return;
    const todo = shown.slice(0, DOT_LIMIT).filter((r) => !dots[r.fullName] && !dotQueue.current.has(r.fullName));
    if (!todo.length) return;
    let live = true;
    const t = setTimeout(async () => {
      const queue = [...todo];
      const worker = async () => {
        for (let r = queue.shift(); r && live; r = queue.shift()) {
          dotQueue.current.add(r.fullName);
          try {
            const run = (await api.githubCi(r.owner, r.name, r.defaultBranch, 1))[0] ?? null;
            setDots((all) => ({ ...all, [r.fullName]: { loading: false, data: run } }));
          } catch (e) {
            setDots((all) => ({ ...all, [r.fullName]: { loading: false, error: errorMessage(e) } }));
            queue.length = 0;
          } finally {
            dotQueue.current.delete(r.fullName);
          }
        }
      };
      await Promise.all(Array.from({ length: DOT_PARALLEL }, worker));
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dotKey, dotsOff, repos]);

  const saveToken = async (token: string) => {
    const st = await api.githubSetToken(token);
    setStatus(st);
    setTokenOpen(false);
    setError(null);
    if (st.configured) {
      notify(`Connecté en tant que ${st.login}.`, "success");
      void load(true);
    }
  };
  const disconnect = async () => {
    if (!(await ask({ title: "Déconnecter GitHub ?", body: "Le jeton sera retiré du coffre de ce poste. Les clones sur tes serveurs ne changent pas.", confirmLabel: "Déconnecter", danger: true }))) return;
    try {
      setStatus(await api.githubSetToken(""));
      setRepos(null);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const err = error ? githubError(error) : null;
  const needToken = err?.kind === "token" || status?.configured === false;
  const connected = !!status?.configured && !needToken;
  const login = status?.login ?? "";

  return (
    <PageLayout
      title="GitHub"
      subtitle="Tes dépôts, où ils tournent sur tes serveurs, et leur mise à jour."
      scroll={!connected || !repos || !!err}
      actions={
        connected ? (
          <>
            <IconButton title="Actualiser la liste des dépôts" onClick={() => void load(true)} disabled={loading}>
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </IconButton>
            <MenuButton
              variant="subtle"
              title="Compte GitHub"
              label={
                <span className="flex items-center gap-2">
                  <Avatar name={login} size={18} />
                  {login}
                  {repos && <span className="font-normal text-faint">{repos.length} dépôts</span>}
                </span>
              }
              items={[
                { label: "Voir mon profil sur github.com", icon: <UserRound size={14} />, onClick: () => void openUrl(`https://github.com/${encodeURIComponent(login)}`) },
                { label: "Changer de jeton", icon: <KeyRound size={14} />, onClick: () => setTokenOpen(true) },
                "separator",
                { label: "Déconnecter", icon: <LogOut size={14} />, danger: true, onClick: () => void disconnect() },
              ]}
            />
          </>
        ) : undefined
      }
    >
      {!status && !error ? (
        <Loading label="Connexion à GitHub…" />
      ) : needToken ? (
        <Onboarding error={err?.kind === "token" ? err.hint : null} onSave={saveToken} />
      ) : err ? (
        <div className="p-7">
          <ErrorState message={<><strong className="font-semibold">Impossible de lister tes dépôts.</strong> {err.hint}</>} onRetry={() => void load()} />
        </div>
      ) : !repos ? (
        <div className="flex gap-6 p-7">
          <Skeleton rows={8} height="h-12" className="w-[320px] shrink-0" />
          <Skeleton rows={3} height="h-24" className="flex-1" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 max-[1100px]:flex-col">
          <RepoList
            repos={shown}
            total={repos.length}
            current={current}
            onSelect={setSelected}
            deployedCount={deployedCount}
            ciOf={(n) => dots[n]?.data ?? insights[n]?.ci?.data?.[0]}
            urgentOf={(n) => urgentAlerts(insights[n]?.alerts?.data)}
            scanning={depsLoading}
            canScan={targets.length > 0}
            onScanAll={() => void scanServers(targets.map((s) => s.id))}
            {...{ query, setQuery, filter, setFilter, sort, setSort }}
          />
          <main className="min-h-0 min-w-0 flex-1 overflow-auto" aria-label="Détail du dépôt">
            {current ? (
              <RepoDetail
                key={current.fullName}
                repo={current}
                targets={targets}
                scans={scans[current.fullName] ?? {}}
                deps={deps}
                insights={insights[current.fullName] ?? {}}
                onReloadInsight={(k) => void loadInsight(current, k)}
                onScan={(id) => {
                  void scan(current, id);
                  void scanServers([id]);
                }}
                onReplace={(id, c) => replace(current, id, c)}
                onClone={() => setCloneFor(current)}
              />
            ) : (
              <EmptyState icon={<FolderGit2 />} title="Aucun dépôt sélectionné">
                Choisis un dépôt dans la liste pour voir où il est déployé.
              </EmptyState>
            )}
          </main>
        </div>
      )}
      {tokenOpen && (
        <Modal title="Changer de jeton" description="Le nouveau jeton remplace l'ancien dans le coffre de ce poste." onClose={() => setTokenOpen(false)}>
          <TokenForm onSave={saveToken} autoFocus />
        </Modal>
      )}
      {cloneFor && (
        <CloneDialog
          repo={cloneFor}
          targets={targets}
          scans={scans[cloneFor.fullName] ?? {}}
          onCloned={(id) => void scan(cloneFor, id)}
          onClose={() => setCloneFor(null)}
        />
      )}
    </PageLayout>
  );
}

// ---- Premier lancement --------------------------------------------------------------------------

function Onboarding({ error, onSave }: { error: string | null; onSave: (token: string) => Promise<void> }) {
  const points = [
    { icon: <FolderGit2 size={16} />, title: "Tes dépôts", text: "Privés et publics, triés par dernier push." },
    { icon: <Server size={16} />, title: "Où ils tournent", text: "Les clones trouvés sur tes serveurs, et s'ils sont à jour." },
    { icon: <GitPullRequestArrow size={16} />, title: "Cloner et mettre à jour", text: "Un clic pour cloner ou faire un pull, sans copier de clé." },
  ];
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-7 py-10">
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <GitBranch size={24} />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Relie ton compte GitHub</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">Zenytt affiche tes dépôts à côté de tes serveurs : tu vois d'un coup d'œil ce qui est déployé, où, et si c'est en retard.</p>
        </div>
      </div>
      <ul className="grid grid-cols-3 gap-3 max-[1000px]:grid-cols-1">
        {points.map((p) => (
          <li key={p.title} className="flex gap-2.5 rounded-xl border border-border px-3.5 py-3">
            <span className="mt-0.5 text-accent">{p.icon}</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{p.title}</span>
              <span className="block text-xs leading-relaxed text-muted">{p.text}</span>
            </span>
          </li>
        ))}
      </ul>
      {error && <ErrorState message={<><strong className="font-semibold">Jeton refusé par GitHub.</strong> {error}</>} />}
      <Card className="flex flex-col gap-4">
        <TokenForm onSave={onSave} />
        <div className="flex flex-col gap-1.5 border-t border-border pt-3 text-xs leading-relaxed text-muted">
          <p>
            Minimum pour un jeton <strong className="font-medium text-fg">fine-grained</strong> : accès aux dépôts à suivre (ou « All repositories »), permissions de dépôt{" "}
            <strong className="font-medium text-fg">Metadata</strong> + <strong className="font-medium text-fg">Contents</strong> en lecture (pour cloner et mettre à jour les dépôts privés).
            Optionnel pour plus d'infos : <strong className="font-medium text-fg">Actions</strong>, <strong className="font-medium text-fg">Pull requests</strong>, <strong className="font-medium text-fg">Issues</strong>,{" "}
            <strong className="font-medium text-fg">Dependabot alerts</strong>, <strong className="font-medium text-fg">Deployments</strong> (lecture). Une permission absente masque seulement la section concernée.
            Aucune permission de compte n'est utile. Un jeton classique avec le droit <strong className="font-medium text-fg">repo</strong> fonctionne aussi.
          </p>
          <p>
            Un jeton fine-grained ne couvre que les dépôts d'un seul propriétaire : pour ceux d'une organisation, choisis l'organisation comme <strong className="font-medium text-fg">Resource owner</strong> à la création.
          </p>
          <p className="text-faint">Le jeton est rangé dans le coffre de l'OS. Il n'est ni exporté ni synchronisé, et n'est jamais écrit sur tes serveurs.</p>
        </div>
      </Card>
    </div>
  );
}

function TokenForm({ onSave, autoFocus }: { onSave: (token: string) => Promise<void>; autoFocus?: boolean }) {
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = token.trim() !== "" && !validToken(token);
  const submit = async () => {
    if (!validToken(token)) return setError("Un jeton ne contient que des lettres, des chiffres, « _ » et « - ».");
    setBusy(true);
    setError(null);
    try {
      await onSave(token.trim());
      setToken("");
    } catch (e) {
      setError(githubError(errorMessage(e)).hint);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field
        label="Jeton d'accès personnel"
        error={error ?? (invalid ? "Caractère inattendu : vérifie que le jeton est collé en entier, sans espace." : undefined)}
        hint="Commence par github_pat_ (fine-grained) ou ghp_ (classique)."
      >
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              type={visible ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              autoFocus={autoFocus}
              placeholder="github_pat_…"
              className="pr-9 font-mono"
              value={token}
              aria-invalid={!!error || invalid}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
            />
            <IconButton size="sm" title={visible ? "Masquer le jeton" : "Afficher le jeton"} className="absolute top-0.5 right-0.5" onClick={() => setVisible((v) => !v)}>
              {visible ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
          </div>
          <Button type="submit" variant="primary" loading={busy} disabled={!token.trim() || invalid}>
            Connecter
          </Button>
        </div>
      </Field>
      <div>
        <Button size="sm" variant="ghost" className="-ml-2.5" icon={<ExternalLink size={13} />} onClick={() => void openUrl(NEW_TOKEN_URL)}>
          Créer un jeton sur github.com
        </Button>
      </div>
    </form>
  );
}

// ---- Liste ----------------------------------------------------------------------------------------

function RepoList({
  repos,
  total,
  current,
  onSelect,
  deployedCount,
  ciOf,
  urgentOf,
  scanning,
  canScan,
  onScanAll,
  query,
  setQuery,
  filter,
  setFilter,
  sort,
  setSort,
}: {
  repos: GithubRepo[];
  total: number;
  current: GithubRepo | null;
  onSelect: (fullName: string) => void;
  deployedCount: (fullName: string) => number;
  /** Dernier run de la branche par défaut, s'il est déjà connu (undefined : pas encore lu ou illisible). */
  ciOf: (fullName: string) => GithubCiRun | null | undefined;
  /** Alertes critiques ou hautes déjà lues. */
  urgentOf: (fullName: string) => number;
  scanning: boolean;
  canScan: boolean;
  onScanAll: () => void;
  query: string;
  setQuery: (q: string) => void;
  filter: RepoFilter;
  setFilter: (f: RepoFilter) => void;
  sort: RepoSort;
  setSort: (s: RepoSort) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const width = useResizable("github-repos", 320, 260, 560, "right");
  const focusRow = (i: number) => {
    const r = repos[Math.max(0, Math.min(repos.length - 1, i))];
    if (!r) return;
    onSelect(r.fullName);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-repo="${CSS.escape(r.fullName)}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    const i = repos.findIndex((r) => r.fullName === current?.fullName);
    const moves: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: repos.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      focusRow(moves[e.key]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("github-repo-title")?.focus();
    }
  };
  return (
    <>
      <aside
        className="flex w-(--list-w) shrink-0 flex-col border-r border-border bg-panel max-[1100px]:max-h-[42%] max-[1100px]:w-full max-[1100px]:border-r-0 max-[1100px]:border-b"
        style={{ "--list-w": `${width.size}px` } as CSSProperties}
      >
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <Input
              className="pl-8"
              placeholder="Rechercher un dépôt…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown") return;
                e.preventDefault();
                focusRow(0);
              }}
              aria-label="Rechercher un dépôt"
            />
          </div>
          <Segmented
            size="sm"
            label="Filtrer les dépôts"
            value={filter}
            onChange={setFilter}
            className="self-start"
            options={[
              { value: "all", label: "Tous" },
              { value: "private", label: "Privés" },
              { value: "public", label: "Publics" },
              { value: "deployed", label: "Déployés", title: "Dépôts dont un clone ou une image a été trouvé sur un serveur" },
            ]}
          />
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span aria-live="polite">{repos.length === total ? `${total} dépôts` : `${repos.length} sur ${total}`}</span>
            <Select
              size="sm"
              aria-label="Trier les dépôts"
              value={sort}
              onChange={setSort}
              options={[
                { value: "pushed", label: "Récemment poussés" },
                { value: "name", label: "Par nom" },
              ]}
            />
          </div>
        </div>
        {canScan && (
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1 text-xs text-muted">
            <span aria-live="polite" className="truncate">
              {scanning ? "Recherche sur les serveurs…" : "Déploiements sur tes serveurs"}
            </span>
            <ReloadButton title="Rechercher les clones et images sur tous les serveurs" slot={{ loading: scanning }} onReload={onScanAll} />
          </div>
        )}
        <div ref={listRef} role="listbox" aria-label="Dépôts" className="scroll-thin min-h-0 flex-1 overflow-auto p-1.5" onKeyDown={onKey}>
          {repos.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted">{query || filter !== "all" ? "Aucun dépôt ne correspond." : "Ce compte n'a encore aucun dépôt."}</p>
          ) : (
            repos.map((r) => {
              const on = r.fullName === current?.fullName;
              const n = deployedCount(r.fullName);
              const ci = ciOf(r.fullName);
              const urgent = urgentOf(r.fullName);
              const st = ci === undefined ? null : ciState(ci ?? undefined);
              return (
                <button
                  key={r.fullName}
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-repo={r.fullName}
                  tabIndex={on ? 0 : -1}
                  onClick={() => onSelect(r.fullName)}
                  className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors ${FOCUS_RING} ${on ? "bg-accent/12" : "hover:bg-hover"}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`truncate text-[13px] ${on ? "font-semibold" : "font-medium"}`}>{r.name}</span>
                    {r.private && <Lock size={11} className="shrink-0 text-muted" aria-label="privé" />}
                    {r.archived && <Badge tone="warn">archivé</Badge>}
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {urgent > 0 && (
                        <span className="flex items-center gap-0.5 text-[11px] font-medium text-danger" title={`${urgent} alerte${urgent > 1 ? "s" : ""} de sécurité critique${urgent > 1 ? "s" : ""} ou haute${urgent > 1 ? "s" : ""}`}>
                          <ShieldAlert size={11} aria-hidden />
                          {urgent}
                        </span>
                      )}
                      {st && st.label !== "aucune exécution" && (
                        <span title={`Intégration continue (${r.defaultBranch}) : ${st.label}`} className="flex">
                          <StatusDot tone={st.tone} pulse={st.running} className="size-2" />
                        </span>
                      )}
                    </span>
                    {n > 0 && (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ok" title={`Déployé : ${n} déploiement${n > 1 ? "s" : ""}`}>
                        <Server size={11} aria-hidden />
                        {n}
                      </span>
                    )}
                  </span>
                  {/* Le propriétaire reste entier ; c'est la branche qui se raccourcit (valeur complète en infobulle). */}
                  <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
                    <span className="max-w-[65%] shrink-0 truncate" title={r.owner}>
                      {r.owner}
                    </span>
                    <span className="text-faint">·</span>
                    <span className="min-w-0 truncate font-mono text-[11px]" title={`Branche par défaut : ${r.defaultBranch}`}>
                      {r.defaultBranch}
                    </span>
                    <span className="ml-auto shrink-0 pl-1 text-faint">{agoOf(r.pushedAt)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>
      {/* Poignée entre la liste et le détail ; la liste empilée (fenêtre étroite) prend toute la largeur. */}
      <div className="contents max-[1100px]:hidden">
        <ResizeHandle {...width.handle} />
      </div>
    </>
  );
}

// ---- Détail ---------------------------------------------------------------------------------------

/** Paire libellé/valeur du bandeau de chiffres ; `wide` : seulement quand la fenêtre a la place (jamais de tuile orpheline). */
function Stat({ label, value, title, tone, wide }: { label: string; value: ReactNode; title?: string; tone?: "ok"; wide?: boolean }) {
  return (
    <div className={`flex shrink-0 items-baseline gap-1.5 px-3 first:pl-0 ${wide ? "max-[1400px]:hidden" : ""}`} title={title}>
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-[13px] font-medium tabular-nums ${tone === "ok" ? "text-ok" : "text-fg"}`}>{value}</span>
    </div>
  );
}

/** Une ligne d'état (attente, erreur, rien trouvé) dans la section des déploiements. */
function Line({ icon, children, action, tone }: { icon: ReactNode; children: ReactNode; action?: ReactNode; tone?: "danger" }) {
  return (
    <div className={`flex min-h-7 min-w-0 items-center gap-2 px-1 text-xs ${tone === "danger" ? "text-danger" : "text-muted"}`}>
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
      {action}
    </div>
  );
}

function RepoDetail({
  repo,
  targets,
  scans,
  deps,
  insights,
  onReloadInsight,
  onScan,
  onReplace,
  onClone,
}: {
  repo: GithubRepo;
  targets: ServerView[];
  scans: Record<string, ServerScan>;
  deps: Deps;
  insights: Insights;
  onReloadInsight: (kind: InsightKind) => void;
  onScan: (serverId: string) => void;
  onReplace: (serverId: string, c: GithubClone) => void;
  onClone: () => void;
}) {
  // undefined : pas encore lue ; null : aucune version publiée.
  const rel = insights.release?.data;
  const count = (slot: Slot<unknown[]> | undefined, cap?: number) =>
    slot?.error ? "—" : !slot?.data ? "…" : cap && slot.data.length >= cap ? `${cap}+` : slot.data.length;
  const results = targets.map((s) => ({ s, r: scans[s.id] }));
  const depsPending = targets.some((s) => !deps[s.id] || deps[s.id].loading);
  const pending = results.some(({ r }) => !r || r.loading) || depsPending;
  const clones = results.flatMap(({ s, r }) => (r?.clones ?? []).map((c) => ({ s, c })));
  const images = targets.flatMap((s) => otherDeployments(deps[s.id]?.items, repo.fullName).map((d) => ({ s, d })));
  const found = [...clones, ...images.filter(({ d }) => d.certain)];
  const empty = results
    .filter(({ s, r }) => r && !r.loading && !r.error && r.clones.length === 0 && !images.some((i) => i.s.id === s.id))
    .map(({ s }) => s.name);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 id="github-repo-title" tabIndex={-1} className="min-w-0 truncate rounded text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-accent" title={repo.fullName}>
              <span className="font-normal text-muted">{repo.owner} / </span>
              {repo.name}
            </h2>
            <Badge tone={repo.private ? "warn" : "muted"}>
              {repo.private && <Lock size={10} />}
              {repo.private ? "privé" : "public"}
            </Badge>
            {repo.fork && <Badge>fork</Badge>}
            {repo.archived && <Badge tone="warn">archivé</Badge>}
            {insights.alerts?.data && <AlertBadges alerts={insights.alerts.data} />}
          </div>
          {repo.description && (
            <p className="mt-0.5 max-w-[90ch] truncate text-xs text-muted" title={repo.description}>
              {repo.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => openRepo(repo)}>
            Ouvrir sur GitHub
          </Button>
          <Button size="sm" variant="primary" icon={<Rocket size={13} />} disabled={targets.length === 0} title={targets.length ? undefined : "Connecte d'abord un serveur SSH"} onClick={onClone}>
            Cloner sur un serveur
          </Button>
        </div>
      </header>

      <div className="flex min-w-0 flex-nowrap items-center divide-x divide-border overflow-hidden border-y border-border py-2" role="group" aria-label="Chiffres du dépôt">
        <Stat
          label="Déploiements"
          value={pending && found.length === 0 ? "…" : found.length}
          tone={found.length ? "ok" : undefined}
          title={targets.length ? `Sur ${targets.length} serveur${targets.length > 1 ? "s" : ""} examiné${targets.length > 1 ? "s" : ""}` : "Aucun serveur connecté"}
        />
        <Stat label="Push" value={agoOf(repo.pushedAt)} />
        <Stat label="Branche" value={<span className="font-mono text-xs">{repo.defaultBranch}</span>} wide />
        <Stat
          label="Version"
          value={<span className="font-mono text-xs">{insights.release?.error ? "—" : rel === undefined ? "…" : (rel?.tag ?? "aucune")}</span>}
          title={insights.release?.error ? "Non lisible" : rel ? `Publiée ${agoOf(rel.publishedAt)}` : undefined}
        />
        <Stat label="Tickets" value={count(insights.issues)} wide />
        <Stat label="PR" value={count(insights.pulls, 30)} title="Pull requests ouvertes" />
      </div>

      {/* 1 colonne ; 2 dès 1400 px (déploiements | activité) ; à 2200 px l'activité se partage elle-même en 2. */}
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-5 min-[1400px]:grid-cols-2 min-[2200px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Fold
            title="Déploiements serveurs"
            count={found.length || undefined}
            hint="Clones sous /srv, /opt, /var/www et le dossier personnel, images GHCR et projets compose"
            actions={targets.length > 0 && <ReloadButton title="Rechercher à nouveau sur les serveurs" slot={{ loading: pending }} onReload={() => targets.forEach((s) => onScan(s.id))} />}
          >
            {targets.length === 0 ? (
              <Line icon={<Server size={12} />} action={<Button size="sm" variant="ghost" onClick={() => navigate("servers")}>Voir les serveurs</Button>}>
                Aucun serveur SSH connecté.
              </Line>
            ) : (
              <div className="flex flex-col gap-2">
                {results.map(({ s, r }) =>
                  !r || r.loading ? (
                    <Line key={s.id} icon={<Loader2 size={12} className="animate-spin" />}>
                      {s.name} : recherche des clones…
                    </Line>
                  ) : r.error ? (
                    <Line key={s.id} tone="danger" icon={<Server size={12} />} action={<Button size="sm" variant="ghost" onClick={() => onScan(s.id)}>Réessayer</Button>}>
                      <span title={r.error}>
                        {s.name} injoignable : {r.error}
                      </span>
                    </Line>
                  ) : null,
                )}
                {clones.map(({ s, c }) => (
                  <CloneCard key={`${s.id}:${c.path}`} repo={repo} server={s} clone={c} onReplace={(nc) => onReplace(s.id, nc)} />
                ))}
                {images.map(({ s, d }) => (
                  <ImageCard key={`${s.id}:${d.kind}:${d.project ?? d.containers[0]?.name ?? d.path}`} server={s} dep={d} />
                ))}
                {!pending && found.length === 0 && (
                  <Line icon={<Rocket size={12} />} action={<Button size="sm" variant="ghost" onClick={onClone}>Cloner sur un serveur</Button>}>
                    Pas encore déployé{empty.length ? ` sur ${empty.join(", ")}` : ""}.
                  </Line>
                )}
                {found.length > 0 && empty.length > 0 && <p className="px-1 text-xs text-faint">Rien sur {empty.join(", ")}.</p>}
              </div>
            )}
          </Fold>
          <GhDeploymentsSection repo={repo} slot={insights.deployments} onReload={() => onReloadInsight("deployments")} />
        </div>
        <div className="flex min-w-0 flex-col gap-5 min-[2200px]:grid min-[2200px]:grid-cols-2 min-[2200px]:items-start">
          <CiSection repo={repo} slot={insights.ci} onReload={() => onReloadInsight("ci")} />
          <PullsSection repo={repo} slot={insights.pulls} onReload={() => onReloadInsight("pulls")} />
          <IssuesSection repo={repo} slot={insights.issues} onReload={() => onReloadInsight("issues")} />
          <AlertsSection repo={repo} slot={insights.alerts} onReload={() => onReloadInsight("alerts")} />
        </div>
      </div>
    </div>
  );
}

/** En-tête d'une carte de déploiement : serveur, chemin, et un élément à droite. */
function CardHead({ server, label, path, right }: { server: ServerView; label?: ReactNode; path?: string | null; right?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
      <Avatar name={server.name} color={server.color} size={22} />
      <span className="shrink-0 text-[13px] font-medium">{server.name}</span>
      {label && <span className="shrink-0 text-xs text-muted">{label}</span>}
      {path && (
        <span className="min-w-0 truncate font-mono text-xs text-muted select-text" title={path}>
          {path}
        </span>
      )}
      {right && <span className="ml-auto flex min-w-0 shrink-0 items-center">{right}</span>}
    </div>
  );
}

function CloneCard({ repo, server, clone: c, onReplace }: { repo: GithubRepo; server: ServerView; clone: GithubClone; onReplace: (c: GithubClone) => void }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const [busy, setBusy] = useState<"pull" | "fetch" | "remote" | null>(null);
  const behind = c.aheadBehind?.[1] ?? 0;
  const run = async (kind: "pull" | "fetch" | "remote", ok: string) => {
    setBusy(kind);
    try {
      if (kind === "remote") onReplace(await api.githubSetRemote(server.id, repo.owner, repo.name, c.path));
      else {
        if (kind === "pull") await api.githubPull(server.id, repo.owner, repo.name, c.path);
        onReplace(await api.githubCloneState(server.id, repo.owner, repo.name, c.path, kind === "fetch"));
      }
      notify(ok, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const pull = async () => {
    const body =
      `git pull --ff-only dans ${c.path} sur ${server.name}. Rien n'est écrasé : la mise à jour s'arrête si l'historique a divergé.` +
      (c.dirty ? ` Attention, ${c.dirty} fichier(s) modifié(s) sur le serveur peuvent la bloquer.` : "");
    if (await ask({ title: `Mettre à jour ${repo.name} ?`, body, confirmLabel: "Faire le pull" })) await run("pull", `${repo.name} mis à jour sur ${server.name}.`);
  };
  const oldName = c.oldRemote ? oldRemoteName(c.oldRemote) : null;
  const setRemote = async () => {
    const url = `https://github.com/${repo.owner}/${repo.name}.git`;
    const body = `git remote set-url origin ${url} dans ${c.path} sur ${server.name}. Seule l'URL change : ni les fichiers ni l'historique.`;
    if (await ask({ title: "Mettre à jour l'URL du remote ?", body, confirmLabel: "Mettre à jour" })) await run("remote", `Remote de ${c.path} mis à jour sur ${server.name}.`);
  };
  return (
    <Card padded={false}>
      <CardHead
        server={server}
        path={c.path}
        right={
          <span className="flex max-w-40 min-w-0 items-center gap-1 font-mono text-[11px] text-muted" title={`Branche du clone : ${c.branch}`}>
            <GitBranch size={11} className="shrink-0" aria-hidden />
            <span className="truncate">{c.branch}</span>
          </span>
        }
      />
      <div className="flex min-w-0 items-center gap-1.5 px-3 pt-1.5 text-xs text-muted">
        <GitCommitHorizontal size={13} className="shrink-0 text-faint" aria-hidden />
        <span className="shrink-0 font-mono text-fg/80">{c.commit || "—"}</span>
        <span className="truncate select-text" title={c.subject}>
          {c.subject}
        </span>
        <span className="ml-auto shrink-0 pl-2 text-faint">{agoOf(c.commitDate)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pt-2" title="Avance et retard datent du dernier fetch : « Comparer » interroge GitHub.">
        {cloneSync(c).map((x) => (
          <Badge key={x.label} tone={x.tone}>
            {x.label}
          </Badge>
        ))}
      </div>
      {oldName && (
        <div className="mx-3 mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-warn/10 px-2.5 py-1 text-xs text-warn" title={`origin pointe vers ${c.oldRemote} ; GitHub redirige vers ${repo.fullName}`}>
          <TriangleAlert size={12} className="shrink-0" aria-hidden />
          <span className="min-w-0">
            Remote encore sur l'ancien nom <span className="font-mono">{oldName}</span>
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" loading={busy === "remote"} disabled={!!busy} onClick={() => void setRemote()}>
            Mettre à jour l'URL du remote
          </Button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 border-t border-border px-2 py-1.5">
        <Button size="sm" variant={behind ? "primary" : "outline"} icon={<GitPullRequestArrow size={13} />} loading={busy === "pull"} disabled={!!busy} onClick={() => void pull()}>
          Pull
        </Button>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={busy === "fetch"} disabled={!!busy} title="git fetch, puis recalcule l'avance et le retard" onClick={() => void run("fetch", "Comparaison avec GitHub à jour.")}>
          Comparer
        </Button>
        <span className="flex-1" />
        <IconButton size="sm" title="Terminal dans ce dossier" onClick={() => openTerminal(server.id, repo.name, c.path)}>
          <SquareTerminal size={14} />
        </IconButton>
        <IconButton size="sm" title="Ouvrir dans Fichiers" onClick={() => openFiles(server.id, c.path)}>
          <FolderOpen size={14} />
        </IconButton>
      </div>
    </Card>
  );
}

/** Déploiement par images (GHCR) ou dossier compose « probable » : pas de .git, donc pas de pull. */
function ImageCard({ server, dep }: { server: ServerView; dep: GithubDeployment }) {
  const probable = !dep.certain;
  const title = dep.project ?? dep.containers[0]?.name ?? "Conteneur";
  return (
    <Card padded={false} className={probable ? "border-dashed" : undefined}>
      <CardHead
        server={server}
        label={`${probable ? "compose" : "images"} ${title}`}
        path={dep.path}
        right={
          <Badge tone={probable ? "warn" : "ok"} title={probable ? "Dossier compose au même nom que le dépôt, sans preuve : à vérifier" : "L'image ou son label désigne ce dépôt"}>
            {probable ? "probable" : "certain"}
          </Badge>
        }
      />
      <ul className="flex flex-col px-3 py-1.5">
        {dep.containers.map((c) => (
          <li key={c.name} className="flex h-7 min-w-0 items-center gap-2 text-xs">
            <Badge tone={containerTone(c.state)}>{c.state}</Badge>
            <span className="shrink-0 font-medium text-fg">{c.name}</span>
            <span className="min-w-0 truncate font-mono text-muted select-text" title={c.image}>
              {c.image.replace(/^ghcr\.io\//i, "")}
            </span>
            {c.sha && (
              <span className="shrink-0 font-mono text-[11px] text-faint" title={`Étiquette = SHA de commit ${c.sha}`}>
                {c.sha}
              </span>
            )}
            <span className="ml-auto shrink-0 text-faint" title="Création du conteneur">
              {agoOf(c.created)}
            </span>
          </li>
        ))}
        {dep.containers.length === 0 && <li className="flex h-7 items-center text-xs text-faint">Aucun conteneur.</li>}
      </ul>
      <div className="flex items-center gap-1.5 border-t border-border px-2 py-1.5">
        <Button size="sm" variant="ghost" icon={<Container size={13} />} onClick={() => navigate("docker", "apps", server.id)}>
          Voir dans Docker
        </Button>
        <span className="flex-1" />
        {dep.path && (
          <IconButton size="sm" title="Ouvrir dans Fichiers" onClick={() => openFiles(server.id, dep.path!)}>
            <FolderOpen size={14} />
          </IconButton>
        )}
      </div>
    </Card>
  );
}

// ---- Clonage --------------------------------------------------------------------------------------

function CloneDialog({
  repo,
  targets,
  scans,
  onCloned,
  onClose,
}: {
  repo: GithubRepo;
  targets: ServerView[];
  scans: Record<string, ServerScan>;
  onCloned: (serverId: string) => void;
  onClose: () => void;
}) {
  const [serverId, setServerId] = useState(targets[0]?.id ?? "");
  const [folder, setFolder] = useState(FOLDERS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const server = targets.find((s) => s.id === serverId);
  const okFolder = validFolder(folder.trim());
  const target = clonePath(folder, repo.name);
  const exists = scans[serverId]?.clones.some((c) => c.path === target);

  const submit = async () => {
    if (!server || !okFolder) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await api.githubClone(server.id, repo.owner, repo.name, folder.trim()));
      onCloned(server.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done && server) {
    return (
      <Modal title={`${repo.name} est cloné`} onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
        <ResultBanner tone="ok" title={`Cloné sur ${server.name}`}>
          <span className="font-mono text-xs">{done}</span>
        </ResultBanner>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            icon={<FolderOpen size={14} />}
            onClick={() => {
              openFiles(server.id, done);
              onClose();
            }}
          >
            Ouvrir dans Fichiers
          </Button>
          <Button
            icon={<SquareTerminal size={14} />}
            onClick={() => {
              openTerminal(server.id, repo.name, done);
              onClose();
            }}
          >
            Terminal ici
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Cloner ${repo.name}`}
      description={`${repo.fullName}, branche ${repo.defaultBranch}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={busy} disabled={!server || !okFolder || exists} onClick={() => void submit()}>
            {busy ? "Clonage…" : "Cloner"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Serveur">
          <Select value={serverId} onChange={setServerId} disabled={busy} options={targets.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field
          label="Dossier parent"
          error={!okFolder ? "Chemin absolu attendu (ex. /srv), sans « .. »." : exists ? "Ce dépôt est déjà cloné à cet endroit." : undefined}
          hint="Créé s'il n'existe pas."
        >
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} disabled={busy} className="font-mono" aria-invalid={!okFolder || exists} />
        </Field>
        <div className="-mt-2 flex gap-1.5">
          {FOLDERS.map((f) => (
            <Button key={f} size="sm" variant={folder === f ? "subtle" : "ghost"} className="font-mono" disabled={busy} onClick={() => setFolder(f)}>
              {f}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-subtle px-3 py-2.5">
          <span className="text-xs text-muted">Le dépôt sera cloné dans</span>
          <span className="font-mono text-[13px] break-all select-text">{okFolder ? target : "—"}</span>
        </div>
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
            <Loader2 size={13} className="animate-spin" /> Clonage en cours sur {server?.name}. Un gros dépôt peut prendre une minute.
          </p>
        )}
        {error && <ErrorState message={error} />}
        <p className="text-xs text-faint">
          Le jeton passe par l'entrée standard de git, pour github.com seulement : il n'est écrit ni dans l'URL du dépôt, ni dans .git/config, ni dans le journal.
        </p>
      </form>
    </Modal>
  );
}
