// Page GitHub : sections « Intégration continue », « Pull requests », « Tickets », « Sécurité » et « Déploiements GitHub ».
// Chaque section se charge et échoue seule : une permission manquante au jeton donne une note d'une ligne, jamais une page cassée.
// Listes denses (une ligne par élément), actions en icônes dans l'en-tête de section.
import { useState, type ReactNode } from "react";
import { ChevronRight, CircleDot, ExternalLink, GitBranch, GitPullRequest, KeyRound, RefreshCw, Rocket, ShieldAlert, Workflow } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type GithubAlert, type GithubCiRun, type GithubGhDeployment, type GithubIssue, type GithubPull, type GithubRelease, type GithubRepo } from "../lib/api";
import {
  agoOf, alertCounts, ciState, deployStateLabel, deployStateTone, insightError, labelColor, repoPageUrl, runDuration, severityLabel, severityTone, type InsightKind,
} from "../lib/github";
import { Badge, Button, Card, FOCUS_RING, IconButton, Skeleton, StatusDot } from "../components/ui";

/** Une donnée en cours de chargement, chargée ou en erreur. */
export interface Slot<T> {
  loading: boolean;
  data?: T;
  error?: string;
}
export interface Insights {
  ci?: Slot<GithubCiRun[]>;
  pulls?: Slot<GithubPull[]>;
  issues?: Slot<GithubIssue[]>;
  alerts?: Slot<GithubAlert[]>;
  deployments?: Slot<GithubGhDeployment[]>;
  release?: Slot<GithubRelease | null>;
}
export const INSIGHT_KINDS: InsightKind[] = ["ci", "pulls", "issues", "alerts", "deployments", "release"];

export function fetchInsight(kind: InsightKind, r: Pick<GithubRepo, "owner" | "name">): Promise<unknown> {
  switch (kind) {
    case "ci":
      return api.githubCi(r.owner, r.name, undefined, 8);
    case "pulls":
      return api.githubPulls(r.owner, r.name);
    case "issues":
      return api.githubIssues(r.owner, r.name);
    case "alerts":
      return api.githubAlerts(r.owner, r.name);
    case "deployments":
      return api.githubGhDeployments(r.owner, r.name);
    case "release":
      return api.githubRelease(r.owner, r.name);
  }
}

const SHOWN = 8;
const open = (url: string | null) => {
  if (url) void openUrl(url);
};
type Page = Parameters<typeof repoPageUrl>[2];

/** Bloc repliable : titre, compteur, actions à droite, contenu. `hint` : précision en infobulle du titre. */
export function Fold({ title, count, hint, actions, defaultOpen = true, children }: { title: ReactNode; count?: ReactNode; hint?: string; actions?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [on, setOn] = useState(defaultOpen);
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex h-7 items-center gap-2">
        <button type="button" aria-expanded={on} title={hint} onClick={() => setOn(!on)} className={`-ml-1 flex min-w-0 items-center gap-1.5 rounded px-1 text-[13px] font-semibold ${FOCUS_RING}`}>
          <ChevronRight size={13} className={`shrink-0 text-muted transition-transform ${on ? "rotate-90" : ""}`} aria-hidden />
          <span className="truncate">{title}</span>
          {count != null && <span className="font-normal text-faint">{count}</span>}
        </button>
        {actions && <div className="ml-auto flex shrink-0 items-center">{actions}</div>}
      </div>
      {on && children}
    </section>
  );
}

export function ReloadButton({ slot, onReload, title = "Actualiser" }: { slot?: { loading?: boolean }; onReload: () => void; title?: string }) {
  return (
    <IconButton size="sm" title={title} disabled={slot?.loading} onClick={onReload}>
      <RefreshCw size={13} className={slot?.loading ? "animate-spin" : ""} />
    </IconButton>
  );
}

function OpenButton({ repo, page }: { repo: GithubRepo; page: Page }) {
  return (
    <IconButton size="sm" title="Ouvrir sur github.com" onClick={() => open(repoPageUrl(repo.owner, repo.name, page))}>
      <ExternalLink size={13} />
    </IconButton>
  );
}

const actionsOf = (repo: GithubRepo, page: Page, slot: Slot<unknown> | undefined, onReload: () => void) => (
  <>
    <ReloadButton slot={slot} onReload={onReload} />
    <OpenButton repo={repo} page={page} />
  </>
);

/** Attente, erreur (note de permission d'une ligne) ou contenu d'une section. */
function Body<T>({ kind, slot, onReload, empty, children }: { kind: InsightKind; slot?: Slot<T>; onReload: () => void; empty: string; children: (data: T) => ReactNode }) {
  if (!slot || (slot.loading && slot.data === undefined)) return <Skeleton rows={2} height="h-7" />;
  if (slot.error) {
    const e = insightError(kind, slot.error);
    return (
      <p className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted" role="note">
        <KeyRound size={12} className={`shrink-0 ${e.permission ? "text-faint" : "text-warn"}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate select-text" title={e.text}>
          {e.text}
        </span>
        {!e.permission && (
          <Button size="sm" variant="ghost" onClick={onReload}>
            Réessayer
          </Button>
        )}
      </p>
    );
  }
  const data = slot.data as T;
  const none = Array.isArray(data) ? data.length === 0 : data == null;
  return none ? <p className="px-1 text-xs text-faint">{empty}</p> : <>{children(data)}</>;
}

/** Ligne cliquable (ouvre github.com) : contenu sur une ligne à gauche, âge à droite. */
function Row({ url, ago, children }: { url: string | null; ago?: string | null; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        disabled={!url}
        onClick={() => open(url)}
        title={url ? "Ouvrir sur github.com" : undefined}
        className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-[13px] enabled:hover:bg-hover ${FOCUS_RING}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">{children}</span>
        {ago !== undefined && <span className="shrink-0 text-xs text-faint tabular-nums">{agoOf(ago)}</span>}
      </button>
    </li>
  );
}

/** Liste dense ; au-delà de `SHOWN`, une dernière ligne mène au reste sur github.com. */
function List({ total, repo, page, label, children }: { total: number; repo: GithubRepo; page: Page; label: string; children: ReactNode }) {
  return (
    <Card padded={false}>
      <ul className="flex flex-col p-1">
        {children}
        {total > SHOWN && (
          <li>
            <button
              type="button"
              onClick={() => open(repoPageUrl(repo.owner, repo.name, page))}
              className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2.5 text-xs text-muted hover:bg-hover hover:text-fg ${FOCUS_RING}`}
            >
              <ExternalLink size={12} aria-hidden />
              {total - SHOWN} autres {label} sur GitHub
            </button>
          </li>
        )}
      </ul>
    </Card>
  );
}

// ---- Sections --------------------------------------------------------------------------------------

type P<T> = { repo: GithubRepo; slot?: Slot<T>; onReload: () => void };

export function CiSection({ repo, slot, onReload }: P<GithubCiRun[]>) {
  return (
    <Fold title="Intégration continue" count={slot?.data?.length || undefined} hint="Derniers runs GitHub Actions" actions={actionsOf(repo, "actions", slot, onReload)}>
      <Body kind="ci" slot={slot} onReload={onReload} empty="Aucune exécution de workflow.">
        {(runs) => (
          <List total={runs.length} repo={repo} page="actions" label="runs">
            {runs.slice(0, SHOWN).map((r, i) => {
              const st = ciState(r);
              return (
                <Row key={`${r.url ?? i}`} url={r.url} ago={r.startedAt}>
                  <Badge tone={st.tone}>
                    {st.running && <StatusDot tone="accent" pulse className="bg-current" />}
                    {st.label}
                  </Badge>
                  <span className="min-w-0 truncate font-medium">{r.name || "Workflow"}</span>
                  <span className="flex min-w-0 shrink items-center gap-1 truncate font-mono text-[11px] text-muted" title={`Branche ${r.branch}`}>
                    <GitBranch size={10} className="shrink-0" aria-hidden />
                    <span className="truncate">{r.branch || "—"}</span>
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-faint">{runDuration(r)}</span>
                </Row>
              );
            })}
          </List>
        )}
      </Body>
    </Fold>
  );
}

export function PullsSection({ repo, slot, onReload }: P<GithubPull[]>) {
  return (
    <Fold title="Pull requests" count={slot?.data ? slot.data.length : undefined} hint="Pull requests ouvertes" actions={actionsOf(repo, "pulls", slot, onReload)}>
      <Body kind="pulls" slot={slot} onReload={onReload} empty="Aucune pull request ouverte.">
        {(list) => (
          <List total={list.length} repo={repo} page="pulls" label="pull requests">
            {list.slice(0, SHOWN).map((p) => (
              <Row key={p.number} url={p.url} ago={p.createdAt}>
                <GitPullRequest size={13} className={`shrink-0 ${p.draft ? "text-faint" : "text-ok"}`} aria-hidden />
                <span className="shrink-0 text-xs text-muted tabular-nums">#{p.number}</span>
                <span className="min-w-0 truncate font-medium" title={p.title}>
                  {p.title}
                </span>
                {p.draft && <Badge>brouillon</Badge>}
                {p.author && <span className="ml-auto shrink-0 text-xs text-faint">{p.author}</span>}
              </Row>
            ))}
          </List>
        )}
      </Body>
    </Fold>
  );
}

export function IssuesSection({ repo, slot, onReload }: P<GithubIssue[]>) {
  return (
    <Fold title="Tickets" count={slot?.data ? slot.data.length : undefined} hint="Tickets ouverts" actions={actionsOf(repo, "issues", slot, onReload)}>
      <Body kind="issues" slot={slot} onReload={onReload} empty="Aucun ticket ouvert.">
        {(list) => (
          <List total={list.length} repo={repo} page="issues" label="tickets">
            {list.slice(0, SHOWN).map((t) => (
              <Row key={t.number} url={t.url} ago={t.createdAt}>
                <CircleDot size={13} className="shrink-0 text-ok" aria-hidden />
                <span className="shrink-0 text-xs text-muted tabular-nums">#{t.number}</span>
                <span className="min-w-0 truncate font-medium" title={t.title}>
                  {t.title}
                </span>
                {t.labels.slice(0, 2).map((l) => {
                  const c = labelColor(l.color);
                  return (
                    <span key={l.name} className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-hover-strong px-2 text-[11px] text-muted">
                      {c && <span className="size-2 rounded-full" style={{ background: c }} aria-hidden />}
                      {l.name}
                    </span>
                  );
                })}
              </Row>
            ))}
          </List>
        )}
      </Body>
    </Fold>
  );
}

/** Pastilles « 2 critiques · 1 haute » ; vert « aucune alerte » une fois la liste lue. */
export function AlertBadges({ alerts }: { alerts: GithubAlert[] }) {
  const counts = alertCounts(alerts);
  if (!counts.length) return <Badge tone="ok">aucune alerte de sécurité</Badge>;
  return (
    <>
      {counts.map((c) => (
        <Badge key={c.severity} tone={severityTone(c.severity)} title="Alertes Dependabot ouvertes">
          <ShieldAlert size={10} />
          {c.count} {severityLabel(c.severity)}
          {c.count > 1 && c.severity === "critical" ? "s" : ""}
        </Badge>
      ))}
    </>
  );
}

export function AlertsSection({ repo, slot, onReload }: P<GithubAlert[]>) {
  return (
    <Fold title="Sécurité des dépendances" count={slot?.data ? slot.data.length : undefined} hint="Alertes Dependabot ouvertes" actions={actionsOf(repo, "security/dependabot", slot, onReload)}>
      <Body kind="alerts" slot={slot} onReload={onReload} empty="Aucune alerte ouverte.">
        {(list) => (
          <List total={list.length} repo={repo} page="security/dependabot" label="alertes">
            {list.slice(0, SHOWN).map((a, i) => (
              <Row key={`${a.url ?? i}`} url={a.url} ago={a.createdAt}>
                <Badge tone={severityTone(a.severity)}>{severityLabel(a.severity)}</Badge>
                <span className="shrink-0 font-medium">{a.package}</span>
                <span className="shrink-0 text-[11px] text-faint">{a.ecosystem}</span>
                <span className="min-w-0 truncate text-xs text-muted" title={a.manifest ? `${a.summary} (${a.manifest})` : a.summary}>
                  {a.summary}
                </span>
              </Row>
            ))}
          </List>
        )}
      </Body>
    </Fold>
  );
}

/** « Déploiements GitHub » (Deployments API) : le plus récent de chaque environnement. */
export function GhDeploymentsSection({ repo, slot, onReload }: P<GithubGhDeployment[]>) {
  return (
    <Fold
      title={
        <span className="flex items-center gap-1.5">
          <Rocket size={13} className="text-muted" aria-hidden />
          Déploiements GitHub
        </span>
      }
      count={slot?.data ? latestPerEnvironment(slot.data).length : undefined}
      hint="Par environnement, tels que publiés sur GitHub"
      actions={actionsOf(repo, "deployments", slot, onReload)}
    >
      <Body kind="deployments" slot={slot} onReload={onReload} empty="Aucun déploiement publié sur GitHub.">
        {(list) => {
          const latest = latestPerEnvironment(list);
          return (
            <List total={latest.length} repo={repo} page="deployments" label="environnements">
              {latest.slice(0, SHOWN).map((d) => (
                <Row key={d.id} url={repoPageUrl(repo.owner, repo.name, "deployments")} ago={d.createdAt}>
                  <Badge tone={deployStateTone(d.state)}>{deployStateLabel(d.state)}</Badge>
                  <span className="shrink-0 font-medium">{d.environment || "—"}</span>
                  <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-muted" title={`Référence ${d.reference || d.sha}`}>
                    <Workflow size={10} className="shrink-0" aria-hidden />
                    <span className="truncate">{d.reference || d.sha}</span>
                  </span>
                  {d.creator && <span className="ml-auto shrink-0 text-xs text-faint">{d.creator}</span>}
                </Row>
              ))}
            </List>
          );
        }}
      </Body>
    </Fold>
  );
}

/** Le déploiement le plus récent de chaque environnement (la liste de GitHub va du plus récent au plus ancien). */
export function latestPerEnvironment(list: GithubGhDeployment[]): GithubGhDeployment[] {
  const seen = new Set<string>();
  return list.filter((d) => !seen.has(d.environment) && !!seen.add(d.environment));
}
