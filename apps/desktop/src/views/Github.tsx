// GitHub : dépôts du compte, où ils sont déployés sur les serveurs connectés, cloner et mettre à jour.
// Le jeton reste dans le coffre de l'OS : l'interface ne le relit jamais.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, FolderOpen, GitPullRequestArrow, Lock, RefreshCw, Search, SquareTerminal, Unplug } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, formatAgo, hasShell, shellQuote, type GithubClone, type GithubRepo, type GithubStatus } from "../lib/api";
import { filterRepos, repoUrl, validFolder } from "../lib/github";
import { navigate } from "../lib/shell";
import { useApp } from "../lib/store";
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, IconButton, Input, Loading, Modal, Select, type Column } from "../components/ui";
import PageLayout from "../components/PageLayout";

const ago = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? "—" : formatAgo(Date.now() - t);
};
const open = (r: GithubRepo) => {
  const url = repoUrl(r.owner, r.name);
  if (url) void openUrl(url);
};

export default function GithubView() {
  const notify = useApp((s) => s.notify);
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GithubRepo | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const st = await api.githubStatus();
      setStatus(st);
      setRepos(st.configured ? await api.githubRepos() : null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const shown = useMemo(() => filterRepos(repos ?? [], query), [repos, query]);
  const columns: Column<GithubRepo>[] = [
    {
      key: "name",
      header: "Dépôt",
      width: "minmax(0,2.4fr)",
      sortValue: (r) => r.fullName.toLowerCase(),
      render: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{r.fullName}</span>
          {r.private && <Lock size={12} className="shrink-0 text-muted" aria-label="Privé" />}
          {r.fork && <Badge>fork</Badge>}
          {r.archived && <Badge tone="warn">archivé</Badge>}
        </span>
      ),
    },
    { key: "branch", header: "Branche", width: "110px", render: (r) => <span className="font-mono text-xs text-muted">{r.defaultBranch}</span> },
    { key: "push", header: "Dernier push", width: "130px", sortValue: (r) => (r.pushedAt ? Date.parse(r.pushedAt) : 0), render: (r) => <span className="text-muted">{ago(r.pushedAt)}</span> },
    { key: "issues", header: "Tickets + PR", width: "100px", align: "right", sortValue: (r) => r.openIssues, render: (r) => <span className="text-muted">{r.openIssues}</span> },
  ];

  return (
    <PageLayout
      title="GitHub"
      subtitle="Tes dépôts et leurs clones sur tes serveurs."
      actions={
        status?.configured ? (
          <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>
            Actualiser
          </Button>
        ) : undefined
      }
      toolbar={
        status?.configured ? (
          <div className="relative w-72 max-w-full">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <Input className="pl-8" placeholder="Rechercher un dépôt…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un dépôt" />
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 pb-6">
        <Account status={status} onChange={(s) => { setStatus(s); void load(); }} notify={notify} />
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {status?.configured && !error && (repos === null ? <Loading label="Chargement des dépôts…" rows={6} /> : (
          <DataTable
            columns={columns}
            rows={shown}
            rowKey={(r) => r.fullName}
            onRowClick={(r) => setSelected(r)}
            initialSort={null}
            rowActions={(r) => (
              <IconButton title={`Ouvrir ${r.fullName} sur github.com`} onClick={(e) => { e.stopPropagation(); open(r); }}>
                <ExternalLink size={14} />
              </IconButton>
            )}
            empty={<EmptyState title={query ? "Aucun dépôt ne correspond" : "Aucun dépôt"} />}
          />
        ))}
      </div>
      {selected && <RepoDialog repo={selected} onClose={() => setSelected(null)} />}
    </PageLayout>
  );
}

function Account({ status, onChange, notify }: { status: GithubStatus | null; onChange: (s: GithubStatus) => void; notify: (m: string, k?: "success" | "error" | "warn" | "info") => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const save = async (value: string) => {
    setBusy(true);
    try {
      onChange(await api.githubSetToken(value));
      setToken("");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  if (status.configured) {
    return (
      <Card className="flex items-center gap-3 text-[13px]">
        <span className="flex-1">
          Connecté en tant que <strong>{status.login}</strong>. Le jeton est dans le coffre de l'OS, il n'est ni exporté ni synchronisé.
        </span>
        <Button icon={<Unplug size={14} />} loading={busy} onClick={() => void save("")}>
          Déconnecter
        </Button>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-3 text-[13px]">
      <p className="text-muted">
        Colle un jeton d'accès personnel GitHub (fine-grained : « Contents » et « Metadata » en lecture, ou classique avec le droit « repo »). Il sert à lister tes dépôts et à cloner les privés sur tes serveurs.
      </p>
      <Field label="Jeton GitHub">
        <div className="flex gap-2">
          <Input type="password" autoComplete="off" spellCheck={false} placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
          <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={() => void save(token)}>
            Connecter
          </Button>
        </div>
      </Field>
    </Card>
  );
}

interface ServerResult {
  loading: boolean;
  clones: GithubClone[];
  error?: string;
}

function RepoDialog({ repo, onClose }: { repo: GithubRepo; onClose: () => void }) {
  const { servers, notify, ask, openTab, setFilesPath } = useApp.getState();
  const targets = servers.filter((s) => s.connected && hasShell(s));
  const [results, setResults] = useState<Record<string, ServerResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [cloneServer, setCloneServer] = useState(targets[0]?.id ?? "");
  const [folder, setFolder] = useState("/srv");

  const scan = useCallback(
    async (serverId: string) => {
      setResults((r) => ({ ...r, [serverId]: { loading: true, clones: [] } }));
      try {
        const clones = await api.githubClones(serverId, repo.owner, repo.name);
        setResults((r) => ({ ...r, [serverId]: { loading: false, clones } }));
      } catch (e) {
        setResults((r) => ({ ...r, [serverId]: { loading: false, clones: [], error: errorMessage(e) } }));
      }
    },
    [repo],
  );
  useEffect(() => {
    for (const s of targets) void scan(s.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      notify(ok, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const replace = (serverId: string, c: GithubClone) =>
    setResults((r) => ({ ...r, [serverId]: { ...r[serverId], clones: r[serverId].clones.map((x) => (x.path === c.path ? c : x)) } }));

  const pull = async (serverId: string, c: GithubClone) => {
    if (c.dirty > 0 && !(await ask({ title: "Modifications locales", body: `${c.path} contient ${c.dirty} fichier(s) modifié(s). Le pull échouera s'ils gênent la mise à jour. Continuer ?`, confirmLabel: "Mettre à jour" }))) return;
    await act(
      `pull:${serverId}:${c.path}`,
      async () => {
        await api.githubPull(serverId, repo.owner, repo.name, c.path);
        replace(serverId, await api.githubCloneState(serverId, repo.owner, repo.name, c.path, false));
      },
      "Dépôt mis à jour (fast-forward).",
    );
  };
  const clone = async () => {
    if (!cloneServer || !validFolder(folder)) return notify("Choisis un serveur et un dossier absolu (ex. /srv).", "warn");
    await act(
      "clone",
      async () => {
        await api.githubClone(cloneServer, repo.owner, repo.name, folder.trim());
        await scan(cloneServer);
      },
      `Cloné dans ${folder.trim().replace(/\/$/, "")}/${repo.name}.`,
    );
  };

  const rows = targets.flatMap((s) => (results[s.id]?.clones ?? []).map((c) => ({ s, c })));
  return (
    <Modal title={repo.fullName} width="max-w-4xl" description={repo.description ?? undefined} onClose={onClose}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={repo.private ? "warn" : "ok"}>{repo.private ? "privé" : "public"}</Badge>
          <Badge>branche {repo.defaultBranch}</Badge>
          <Badge>{repo.openIssues} ticket(s) / PR ouvert(s)</Badge>
          <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => open(repo)}>
            Ouvrir sur github.com
          </Button>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Déployé sur tes serveurs</h3>
          {targets.length === 0 && <p className="text-[13px] text-muted">Aucun serveur connecté (avec shell) à examiner.</p>}
          {targets.map((s) => {
            const r = results[s.id];
            if (r?.loading) return <p key={s.id} className="text-[13px] text-muted">Recherche sur {s.name}…</p>;
            if (r?.error) return <p key={s.id} className="text-[13px] text-danger">{s.name} : {r.error}</p>;
            return null;
          })}
          {rows.map(({ s, c }) => {
            const key = `${s.id}:${c.path}`;
            const [ahead, behind] = c.aheadBehind ?? [0, 0];
            return (
              <Card key={key} className="flex flex-col gap-2 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{s.name}</strong>
                  <span className="font-mono text-xs text-muted">{c.path}</span>
                  <Badge>{c.branch}</Badge>
                  {c.dirty > 0 ? <Badge tone="warn">{c.dirty} modifié(s)</Badge> : <Badge tone="ok">propre</Badge>}
                  {c.aheadBehind && (ahead || behind) ? (
                    <Badge tone="accent">
                      <ArrowUp size={11} className="inline" />{ahead} <ArrowDown size={11} className="inline" />{behind}
                    </Badge>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted">
                  <span className="font-mono">{c.commit}</span> {c.subject} · {ago(c.commitDate)}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" icon={<RefreshCw size={13} />} loading={busy === `fetch:${key}`} onClick={() => void act(`fetch:${key}`, async () => replace(s.id, await api.githubCloneState(s.id, repo.owner, repo.name, c.path, true)), "Comparaison avec GitHub à jour.")}>
                    Comparer (fetch)
                  </Button>
                  <Button size="sm" icon={<GitPullRequestArrow size={13} />} loading={busy === `pull:${key}`} onClick={() => void pull(s.id, c)}>
                    Pull
                  </Button>
                  <Button size="sm" icon={<SquareTerminal size={13} />} onClick={() => { openTab(s.id, { title: repo.name, command: `cd ${shellQuote(c.path)} && exec "$SHELL" -l` }); onClose(); }}>
                    Terminal ici
                  </Button>
                  <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => { setFilesPath(s.id, c.path); navigate("files", undefined, s.id); onClose(); }}>
                    Fichiers
                  </Button>
                </div>
              </Card>
            );
          })}
          {targets.length > 0 && rows.length === 0 && !Object.values(results).some((r) => r.loading) && (
            <p className="text-[13px] text-muted">Aucun clone trouvé sous /srv, /opt, /var/www ni le dossier personnel (4 niveaux de profondeur).</p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Cloner sur un serveur</h3>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Serveur">
              <Select value={cloneServer} onChange={setCloneServer} options={targets.map((s) => ({ value: s.id, label: s.name }))} />
            </Field>
            <Field label={`Dossier parent (créera ${repo.name}/)`} className="min-w-56 flex-1">
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
            </Field>
            <Button variant="primary" loading={busy === "clone"} disabled={!cloneServer} onClick={() => void clone()}>
              Cloner
            </Button>
          </div>
          <p className="text-xs text-muted">
            Le jeton est transmis au serveur par l'entrée standard de git, pour github.com seulement ; il n'est écrit ni dans l'URL du dépôt, ni dans .git/config, ni dans le journal.
          </p>
        </section>
      </div>
    </Modal>
  );
}
