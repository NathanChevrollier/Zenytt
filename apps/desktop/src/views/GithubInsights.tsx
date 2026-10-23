// Page GitHub : sections « Intégration continue », « Pull requests », « Tickets », « Sécurité » et « Déploiements GitHub ».
// Chaque section se charge et échoue seule : une permission manquante au jeton donne une note discrète, jamais une page cassée.
import { useState, type ReactNode } from "react";
import { ChevronRight, CircleDot, ExternalLink, GitBranch, GitPullRequest, KeyRound, RefreshCw, Rocket, ShieldAlert, Workflow } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type GithubAlert, type GithubCiRun, type GithubGhDeployment, type GithubIssue, type GithubPull, type GithubRelease, type GithubRepo } from "../lib/api";
import {
  agoOf, alertCounts, ciState, deployStateLabel, deployStateTone, insightError, labelColor, repoPageUrl, runDuration, severityLabel, severityTone, type InsightKind,
} from "../lib/github";
import { Badge, Button, Card, FOCUS_RING, Skeleton, StatusDot } from "../components/ui";

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

const SHOWN = 10;
const open = (url: string | null) => {
  if (url) void openUrl(url);
};

/** Bloc repliable : titre, compteur, actions à droite, contenu. */
export function Fold({ title, count, description, actions, defaultOpen = true, children }: { title: ReactNode; count?: ReactNode; description?: ReactNode; actions?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [on, setOn] = useState(defaultOpen);
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-7 items-center gap-2">
        <button type="button" aria-expanded={on} onClick={() => setOn(!on)} className={`-ml-1 flex min-w-0 items-center gap-1.5 rounded px-1 text-sm font-semibold ${FOCUS_RING}`}>
          <ChevronRight size={14} className={`shrink-0 text-muted transition-transform ${on ? "rotate-90" : ""}`} aria-hidden />
          <span>{title}</span>
          {count != null && <span className="font-normal text-faint">· {count}</span>}
        </button>
        {description && <span className="truncate text-xs text-muted">{description}</span>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {on && children}
    </section>
  );
}

export function ReloadButton({ slot, onReload }: { slot?: Slot<unknown>; onReload: () => void }) {
  return (
    <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={slot?.loading ? "animate-spin" : ""} />} disabled={slot?.loading} onClick={onReload}>
      Actualiser
    </Button>
  );
}

/** Attente, erreur (note de permission discrète) ou contenu d'une section. */
function Body<T>({ kind, slot, onReload, empty, children }: { kind: InsightKind; slot?: Slot<T>; onReload: () => void; empty: string; children: (data: T) => ReactNode }) {
  if (!slot || (slot.loading && slot.data === undefined)) return <Skeleton rows={2} height="h-9" />;
  if (slot.error) {
    const e = insightError(kind, slot.error);
    return (
      <p className="flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs leading-relaxed text-muted" role="note">
        <KeyRound size={13} className={`mt-0.5 shrink-0 ${e.permission ? "text-faint" : "text-warn"}`} aria-hidden />
        <span className="min-w-0 flex-1 select-text">{e.text}</span>
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
  return none ? <p className="text-xs text-faint">{empty}</p> : <>{children(data)}</>;
}

/** Ligne cliquable (ouvre github.com) : contenu à gauche, âge à droite. */
function Row({ url, ago, children }: { url: string | null; ago?: string | null; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        disabled={!url}
        onClick={() => open(url)}
        title={url ? "Ouvrir sur github.com" : undefined}
        className={`group flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] enabled:hover:bg-hover ${FOCUS_RING}`}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{children}</span>
        {ago !== undefined && <span className="shrink-0 text-xs text-faint">{agoOf(ago)}</span>}
        {url && <ExternalLink size={12} className="shrink-0 text-faint opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />}
      </button>
    </li>
  );
}

function List({ children }: { children: ReactNode }) {
  return <Card padded={false}><ul className="flex flex-col p-1">{children}</ul></Card>;
}

function More({ total, owner, name, page, label }: { total: number; owner: string; name: string; page: Parameters<typeof repoPageUrl>[2]; label: string }) {
  return (
    <div>
      <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => open(repoPageUrl(owner, name, page))}>
        {total > SHOWN ? `Voir les ${total} ${label} sur GitHub` : "Voir sur GitHub"}
      </Button>
    </div>
  );
}

// ---- Sections --------------------------------------------------------------------------------------

type P<T> = { repo: GithubRepo; slot?: Slot<T>; onReload: () => void };

export function CiSection({ repo, slot, onReload }: P<GithubCiRun[]>) {
  return (
    <Fold title="Intégration continue" count={slot?.data?.length || undefined} description="Derniers runs GitHub Actions." actions={<ReloadButton slot={slot} onReload={onReload} />}>
      <Body kind="ci" slot={slot} onReload={onReload} empty="Aucune exécution de workflow.">
        {(runs) => (
          <>
            <List>
              {runs.slice(0, SHOWN).map((r, i) => {
                const st = ciState(r);
                return (
                  <Row key={`${r.url ?? i}`} url={r.url} ago={r.startedAt}>
                    <Badge tone={st.tone}>{st.running && <StatusDot tone="accent" pulse className="bg-current" />}{st.label}</Badge>
                    <span className="min-w-0 truncate font-medium">{r.name || "Workflow"}</span>
                    <Badge title="Branche">
                      <GitBranch size={10} />
                      {r.branch || "—"}
                    </Badge>
                    <span className="text-xs text-muted">{r.event}</span>
                    <span className="text-xs text-faint">{runDuration(r)}</span>
                  </Row>
                );
              })}
            </List>
            <More total={runs.length} owner={repo.owner} name={repo.name} page="actions" label="runs" />
          </>
        )}
      </Body>
    </Fold>
  );
}

export function PullsSection({ repo, slot, onReload }: P<GithubPull[]>) {
  return (
    <Fold title="Pull requests ouvertes" count={slot?.data ? slot.data.length : undefined} actions={<ReloadButton slot={slot} onReload={onReload} />}>
      <Body kind="pulls" slot={slot} onReload={onReload} empty="Aucune pull request ouverte.">
        {(list) => (
          <>
            <List>
              {list.slice(0, SHOWN).map((p) => (
                <Row key={p.number} url={p.url} ago={p.createdAt}>
                  <GitPullRequest size={13} className={`shrink-0 ${p.draft ? "text-faint" : "text-ok"}`} aria-hidden />
                  <span className="min-w-0 truncate font-medium">{p.title}</span>
                  <span className="text-xs text-muted">#{p.number}</span>
                  {p.draft && <Badge>brouillon</Badge>}
                  {p.author && <span className="text-xs text-faint">par {p.author}</span>}
                </Row>
              ))}
            </List>
            <More total={list.length} owner={repo.owner} name={repo.name} page="pulls" label="pull requests" />
          </>
        )}
      </Body>
    </Fold>
  );
}

export function IssuesSection({ repo, slot, onReload }: P<GithubIssue[]>) {
  return (
    <Fold title="Tickets ouverts" count={slot?.data ? slot.data.length : undefined} actions={<ReloadButton slot={slot} onReload={onReload} />}>
      <Body kind="issues" slot={slot} onReload={onReload} empty="Aucun ticket ouvert.">
        {(list) => (
          <>
            <List>
              {list.slice(0, SHOWN).map((t) => (
                <Row key={t.number} url={t.url} ago={t.createdAt}>
                  <CircleDot size={13} className="shrink-0 text-ok" aria-hidden />
                  <span className="min-w-0 truncate font-medium">{t.title}</span>
                  <span className="text-xs text-muted">#{t.number}</span>
                  {t.labels.map((l) => {
                    const c = labelColor(l.color);
                    return (
                      <span key={l.name} className="inline-flex h-[18px] items-center gap-1 rounded-full bg-hover-strong px-2 text-[11px] text-muted">
                        {c && <span className="size-2 rounded-full" style={{ background: c }} aria-hidden />}
                        {l.name}
                      </span>
                    );
                  })}
                </Row>
              ))}
            </List>
            <More total={list.length} owner={repo.owner} name={repo.name} page="issues" label="tickets" />
          </>
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
    <Fold title="Sécurité des dépendances" count={slot?.data ? slot.data.length : undefined} description="Alertes Dependabot ouvertes." actions={<ReloadButton slot={slot} onReload={onReload} />}>
      <Body kind="alerts" slot={slot} onReload={onReload} empty="Aucune alerte ouverte.">
        {(list) => (
          <>
            <List>
              {list.slice(0, SHOWN).map((a, i) => (
                <Row key={`${a.url ?? i}`} url={a.url} ago={a.createdAt}>
                  <Badge tone={severityTone(a.severity)}>{severityLabel(a.severity)}</Badge>
                  <span className="font-medium">{a.package}</span>
                  <Badge title="Écosystème">{a.ecosystem}</Badge>
                  <span className="min-w-0 truncate text-xs text-muted">{a.summary}</span>
                  {a.manifest && <span className="font-mono text-[11px] text-faint">{a.manifest}</span>}
                </Row>
              ))}
            </List>
            <More total={list.length} owner={repo.owner} name={repo.name} page="security/dependabot" label="alertes" />
          </>
        )}
      </Body>
    </Fold>
  );
}

/** Sous-section « Déploiements GitHub » (Deployments API), affichée sous les déploiements des serveurs. */
export function GhDeploymentsBlock({ repo, slot, onReload }: P<GithubGhDeployment[]>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Rocket size={13} className="text-muted" aria-hidden />
          Déploiements GitHub
          {slot?.data ? <span className="font-normal text-faint">· {slot.data.length}</span> : null}
        </h3>
        <span className="truncate text-xs text-muted">Par environnement, tels que publiés sur GitHub.</span>
        <div className="ml-auto">
          <ReloadButton slot={slot} onReload={onReload} />
        </div>
      </div>
      <Body kind="deployments" slot={slot} onReload={onReload} empty="Aucun déploiement publié sur GitHub.">
        {(list) => (
          <>
            <List>
              {latestPerEnvironment(list).map((d) => (
                <Row key={d.id} url={repoPageUrl(repo.owner, repo.name, "deployments")} ago={d.createdAt}>
                  <Badge tone={deployStateTone(d.state)}>{deployStateLabel(d.state)}</Badge>
                  <span className="font-medium">{d.environment || "—"}</span>
                  <Badge title="Référence déployée">
                    <Workflow size={10} />
                    {d.reference || d.sha}
                  </Badge>
                  {d.sha && <span className="font-mono text-[11px] text-muted">{d.sha}</span>}
                  {d.creator && <span className="text-xs text-faint">par {d.creator}</span>}
                </Row>
              ))}
            </List>
          </>
        )}
      </Body>
    </div>
  );
}

/** Le déploiement le plus récent de chaque environnement (la liste de GitHub va du plus récent au plus ancien). */
export function latestPerEnvironment(list: GithubGhDeployment[]): GithubGhDeployment[] {
  const seen = new Set<string>();
  return list.filter((d) => !seen.has(d.environment) && !!seen.add(d.environment));
}
