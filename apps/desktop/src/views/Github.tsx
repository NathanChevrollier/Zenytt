// GitHub : dépôts du compte, où ils sont déployés sur les serveurs connectés, cloner et mettre à jour.
// Liste à gauche, détail du dépôt choisi à droite (l'un au-dessus de l'autre dans une fenêtre étroite).
// Le jeton reste dans le coffre de l'OS : l'interface ne le relit jamais.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Container, ExternalLink, Eye, EyeOff, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequestArrow, KeyRound, Loader2, Lock, LogOut, RefreshCw, Rocket, Search, Server, SquareTerminal, UserRound,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, hasShell, shellQuote, type GithubClone, type GithubDeployment, type GithubRepo, type GithubStatus, type ServerView } from "../lib/api";
import {
  agoOf, browseRepos, certainDeployments, clonePath, cloneSync, containerTone, githubError, otherDeployments, repoUrl, validFolder, validToken, type RepoFilter, type RepoSort,
} from "../lib/github";
import { navigate } from "../lib/shell";
import { useApp, useAppPick } from "../lib/store";
import { useCachedState } from "../lib/cache";
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, FOCUS_RING, IconButton, Input, Loading, MenuButton, Modal, ResultBanner, Section, Segmented, Select, Skeleton, StatTile,
} from "../components/ui";
import PageLayout from "../components/PageLayout";

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const FOLDERS = ["/srv", "/opt", "/var/www"];

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [sort, setSort] = useState<RepoSort>("pushed");
  const [selected, setSelected] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [cloneFor, setCloneFor] = useState<GithubRepo | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const st = await api.githubStatus();
      setStatus(st);
      setRepos(st.configured ? await api.githubRepos() : null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [setStatus, setRepos]);
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
      const list = (repos ?? []).map((r) => ({ owner: r.owner, name: r.name }));
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

  const saveToken = async (token: string) => {
    const st = await api.githubSetToken(token);
    setStatus(st);
    setTokenOpen(false);
    setError(null);
    if (st.configured) {
      notify(`Connecté en tant que ${st.login}.`, "success");
      void load();
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
            <IconButton title="Actualiser la liste des dépôts" onClick={() => void load()} disabled={loading}>
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
            <strong className="font-medium text-fg">Metadata : lecture</strong> (ajoutée d'office) et <strong className="font-medium text-fg">Contents : lecture</strong> (pour cloner et mettre à jour les dépôts privés).
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
    <aside className="flex w-[340px] shrink-0 flex-col border-r border-border bg-panel max-[1100px]:max-h-[42%] max-[1100px]:w-full max-[1100px]:border-r-0 max-[1100px]:border-b">
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
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted">
          <span aria-live="polite">{scanning ? "Recherche sur les serveurs…" : "Clones et images trouvés sur tes serveurs."}</span>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} className={scanning ? "animate-spin" : ""} />} disabled={scanning} onClick={onScanAll}>
            Rechercher sur les serveurs
          </Button>
        </div>
      )}
      <div ref={listRef} role="listbox" aria-label="Dépôts" className="scroll-thin min-h-0 flex-1 overflow-auto p-1.5" onKeyDown={onKey}>
        {repos.length === 0 ? (
          <p className="px-3 py-8 text-center text-[13px] text-muted">{query || filter !== "all" ? "Aucun dépôt ne correspond." : "Ce compte n'a encore aucun dépôt."}</p>
        ) : (
          repos.map((r) => {
            const on = r.fullName === current?.fullName;
            const n = deployedCount(r.fullName);
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
                  {n > 0 && (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-medium text-ok" title={`Déployé : ${n} déploiement${n > 1 ? "s" : ""}`}>
                      <Server size={11} aria-hidden />
                      {n}
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
                  <span className="truncate">{r.owner}</span>
                  <span className="text-faint">·</span>
                  <span className="shrink-0 font-mono text-[11px]">{r.defaultBranch}</span>
                  <span className="ml-auto shrink-0 text-faint">{agoOf(r.pushedAt)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

// ---- Détail ---------------------------------------------------------------------------------------

function RepoDetail({
  repo,
  targets,
  scans,
  deps,
  onScan,
  onReplace,
  onClone,
}: {
  repo: GithubRepo;
  targets: ServerView[];
  scans: Record<string, ServerScan>;
  deps: Deps;
  onScan: (serverId: string) => void;
  onReplace: (serverId: string, c: GithubClone) => void;
  onClone: () => void;
}) {
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
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-7 py-6">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">{repo.owner}</div>
          <h2 id="github-repo-title" tabIndex={-1} className="truncate rounded text-lg font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {repo.name}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={repo.private ? "warn" : "muted"}>
              {repo.private && <Lock size={10} />}
              {repo.private ? "privé" : "public"}
            </Badge>
            {repo.fork && <Badge>fork</Badge>}
            {repo.archived && <Badge tone="warn">archivé</Badge>}
          </div>
          <p className={`mt-2.5 max-w-prose text-[13px] leading-relaxed ${repo.description ? "text-muted" : "text-faint"}`}>{repo.description ?? "Pas de description."}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button icon={<ExternalLink size={14} />} onClick={() => openRepo(repo)}>
            Ouvrir sur GitHub
          </Button>
          <Button variant="primary" icon={<Rocket size={14} />} disabled={targets.length === 0} title={targets.length ? undefined : "Connecte d'abord un serveur SSH"} onClick={onClone}>
            Cloner sur un serveur
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <StatTile label="Dernier push" value={agoOf(repo.pushedAt)} />
        <StatTile label="Branche par défaut" value={<span className="font-mono text-lg">{repo.defaultBranch}</span>} />
        <StatTile label="Tickets et PR ouverts" value={repo.openIssues} />
        <StatTile label="Déploiements" value={pending && found.length === 0 ? "…" : found.length} tone={found.length ? "ok" : undefined} hint={targets.length ? `sur ${targets.length} serveur${targets.length > 1 ? "s" : ""} examiné${targets.length > 1 ? "s" : ""}` : "aucun serveur connecté"} />
      </div>

      <Section
        title="Déploiements"
        count={found.length || undefined}
        description="Clones sous /srv, /opt, /var/www et le dossier personnel, images GHCR et projets compose."
        actions={
          targets.length > 0 && (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={pending ? "animate-spin" : ""} />} disabled={pending} onClick={() => targets.forEach((s) => onScan(s.id))}>
              Rechercher à nouveau
            </Button>
          )
        }
      >
        {targets.length === 0 ? (
          <Card className="border-dashed">
            <EmptyState icon={<Server />} title="Aucun serveur connecté" action={<Button onClick={() => navigate("servers")}>Voir les serveurs</Button>}>
              Connecte un serveur SSH pour voir où ce dépôt est déployé et le mettre à jour.
            </EmptyState>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {results.map(({ s, r }) =>
              !r || r.loading ? (
                <Card key={s.id} className="flex items-center gap-3 text-[13px]">
                  <Avatar name={s.name} color={s.color} size={28} />
                  <span className="font-medium">{s.name}</span>
                  <span className="flex items-center gap-1.5 text-muted">
                    <Loader2 size={13} className="animate-spin" /> Recherche des clones…
                  </span>
                </Card>
              ) : r.error ? (
                <ErrorState key={s.id} message={<><strong className="font-semibold">{s.name} injoignable.</strong> {r.error}</>} onRetry={() => onScan(s.id)} />
              ) : null,
            )}
            {clones.map(({ s, c }) => (
              <CloneCard key={`${s.id}:${c.path}`} repo={repo} server={s} clone={c} onReplace={(nc) => onReplace(s.id, nc)} />
            ))}
            {images.map(({ s, d }) => (
              <ImageCard key={`${s.id}:${d.kind}:${d.project ?? d.containers[0]?.name ?? d.path}`} server={s} dep={d} />
            ))}
            {!pending && found.length === 0 && (
              <Card className="border-dashed">
                <EmptyState icon={<Rocket />} title="Pas encore déployé" action={<Button variant="primary" onClick={onClone}>Cloner sur un serveur</Button>}>
                  Aucun clone de {repo.name} sur {empty.join(", ") || "tes serveurs"}.
                </EmptyState>
              </Card>
            )}
            {found.length > 0 && empty.length > 0 && <p className="text-xs text-faint">Rien trouvé sur {empty.join(", ")}.</p>}
          </div>
        )}
      </Section>
    </div>
  );
}

function CloneCard({ repo, server, clone: c, onReplace }: { repo: GithubRepo; server: ServerView; clone: GithubClone; onReplace: (c: GithubClone) => void }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const [busy, setBusy] = useState<"pull" | "fetch" | null>(null);
  const behind = c.aheadBehind?.[1] ?? 0;
  const run = async (kind: "pull" | "fetch", ok: string) => {
    setBusy(kind);
    try {
      if (kind === "pull") await api.githubPull(server.id, repo.owner, repo.name, c.path);
      onReplace(await api.githubCloneState(server.id, repo.owner, repo.name, c.path, kind === "fetch"));
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
  return (
    <Card padded={false}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <Avatar name={server.name} color={server.color} size={30} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{server.name}</div>
          <div className="truncate font-mono text-xs text-muted select-text" title={c.path}>
            {c.path}
          </div>
        </div>
        <Badge title="Branche du clone">
          <GitBranch size={10} />
          {c.branch}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 pt-3" title="Avance et retard datent du dernier fetch : « Comparer » interroge GitHub.">
        {cloneSync(c).map((x) => (
          <Badge key={x.label} tone={x.tone}>
            {x.label}
          </Badge>
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 px-4 pt-2 pb-3 text-xs text-muted">
        <GitCommitHorizontal size={13} className="shrink-0 text-faint" />
        <span className="shrink-0 font-mono text-fg/80">{c.commit || "—"}</span>
        <span className="truncate select-text">{c.subject}</span>
        <span className="ml-auto shrink-0 pl-2 text-faint">{agoOf(c.commitDate)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <Button size="sm" variant={behind ? "primary" : "outline"} icon={<GitPullRequestArrow size={13} />} loading={busy === "pull"} disabled={!!busy} onClick={() => void pull()}>
          Pull
        </Button>
        <Button size="sm" icon={<RefreshCw size={13} />} loading={busy === "fetch"} disabled={!!busy} title="git fetch, puis recalcule l'avance et le retard" onClick={() => void run("fetch", "Comparaison avec GitHub à jour.")}>
          Comparer
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<SquareTerminal size={13} />} onClick={() => openTerminal(server.id, repo.name, c.path)}>
          Terminal ici
        </Button>
        <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => openFiles(server.id, c.path)}>
          Fichiers
        </Button>
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
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <Avatar name={server.name} color={server.color} size={30} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            {server.name} <span className="font-normal text-muted">· {probable ? "projet compose" : "images Docker"} {title}</span>
          </div>
          {dep.path && (
            <div className="truncate font-mono text-xs text-muted select-text" title={dep.path}>
              {dep.path}
            </div>
          )}
        </div>
        <Badge tone={probable ? "warn" : "ok"} title={probable ? "Déduit du nom du dossier, sans preuve" : "L'image ou son label désigne ce dépôt"}>
          {probable ? "probable" : "certain"}
        </Badge>
      </div>
      {probable && <p className="px-4 pt-2 text-xs text-muted">Dossier compose au même nom que le dépôt : à vérifier.</p>}
      <ul className="flex flex-col gap-1.5 px-4 py-3">
        {dep.containers.map((c) => (
          <li key={c.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Badge tone={containerTone(c.state)}>{c.state}</Badge>
            <span className="font-medium text-fg">{c.name}</span>
            <span className="min-w-0 truncate font-mono text-muted select-text" title={c.image}>
              {c.image.replace(/^ghcr\.io\//i, "")}
            </span>
            {c.sha && <Badge title={`Étiquette = SHA de commit ${c.sha}`}>commit {c.sha}</Badge>}
            <span className="ml-auto shrink-0 text-faint" title="Création du conteneur">
              {agoOf(c.created)}
            </span>
          </li>
        ))}
        {dep.containers.length === 0 && <li className="text-xs text-faint">Aucun conteneur.</li>}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <Button size="sm" icon={<Container size={13} />} onClick={() => navigate("docker", dep.project ? "compose" : "containers", server.id)}>
          Voir dans Docker
        </Button>
        <span className="flex-1" />
        {dep.path && (
          <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => openFiles(server.id, dep.path!)}>
            Fichiers
          </Button>
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
