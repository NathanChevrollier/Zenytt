import { Octokit } from "@octokit/rest";
import type { CreatedIssue, FeedbackKind } from "../types/feedback.js";

export interface RoadmapIssue {
  /** Absent pour un brouillon du projet (carte sans issue). */
  number?: number;
  title: string;
  url?: string;
  assignees: string[];
  state: "open" | "closed";
}

export class GitHubService {
  private readonly client: Octokit;
  /** Lecture du projet : jeton dédié si fourni (un jeton « fine-grained » ne lit pas les projets d'un compte personnel). */
  private readonly projectClient: Octokit;
  private readonly attachments: { repo: string; client: Octokit } | undefined;
  private projectNumber: number | undefined;
  /** Titre du projet lu, pour dire dans le panneau d'où vient la roadmap. */
  private projectTitle: string | undefined;

  public constructor(
    private readonly owner: string,
    private readonly repo: string,
    token: string,
    private readonly labels: Record<FeedbackKind, string>,
    projectToken?: string,
    /** Dépôt et jeton dédiés aux captures ; sans eux, le dépôt et le jeton principaux servent. */
    attachments?: { repo: string; token: string },
  ) {
    this.client = new Octokit({ auth: token, userAgent: "zenytt-discord-bot" });
    this.attachments = attachments && { repo: attachments.repo, client: new Octokit({ auth: attachments.token, userAgent: "zenytt-discord-bot" }) };
    this.projectClient = projectToken ? new Octokit({ auth: projectToken, userAgent: "zenytt-discord-bot" }) : this.client;
  }

  public async createIssue(title: string, body: string, kind: FeedbackKind): Promise<CreatedIssue> {
    const label = this.labels[kind];
    await this.ensureLabel(label, kind === "bug" ? "d73a4a" : "a2eeef");

    try {
      const response = await this.client.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        labels: [label],
      });
      return { number: response.data.number, url: response.data.html_url };
    } catch (error) {
      throw new Error(`GitHub n'a pas pu créer l'issue: ${describeGitHubError(error)}`);
    }
  }

  /**
   * Archive des images dans une branche dédiée du dépôt (créée au premier usage, sans lien avec le
   * code) et renvoie leurs adresses, affichables dans une issue. Les liens de Discord expirent au
   * bout de quelques heures : une issue doit garder ses captures.
   */
  public async storeAttachments(branch: string, files: { path: string; content: Uint8Array }[], label: string): Promise<string[]> {
    const git = (this.attachments?.client ?? this.client).rest.git;
    const repoName = this.attachments?.repo ?? this.repo;
    const repo = { owner: this.owner, repo: repoName };
    // Deux envois simultanés : le second échoue à avancer la branche (non fast-forward) et réessaie.
    for (let attempt = 0; ; attempt++) {
      try {
        let parent: string | undefined;
        let baseTree: string | undefined;
        try {
          parent = (await git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
          baseTree = (await git.getCommit({ ...repo, commit_sha: parent })).data.tree.sha;
        } catch (error) {
          if (getStatus(error) !== 404) throw error;
        }
        const blobs = await Promise.all(files.map((f) => git.createBlob({ ...repo, content: Buffer.from(f.content).toString("base64"), encoding: "base64" })));
        const tree = await git.createTree({
          ...repo,
          ...(baseTree ? { base_tree: baseTree } : {}),
          tree: files.map((f, i) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, sha: blobs[i]!.data.sha })),
        });
        const commit = await git.createCommit({ ...repo, message: `chore(feedback): ${files.length} capture(s) — ${label}`, tree: tree.data.sha, parents: parent ? [parent] : [] });
        if (parent) await git.updateRef({ ...repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
        else await git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: commit.data.sha });
        return files.map((f) => `https://raw.githubusercontent.com/${this.owner}/${repoName}/${encodeURIComponent(branch)}/${f.path}`);
      } catch (error) {
        if (attempt < 2 && getStatus(error) === 422) continue;
        throw new Error(`GitHub n'a pas pu archiver les captures: ${describeGitHubError(error)}`);
      }
    }
  }

  public async getLatestRelease(): Promise<{ tagName: string; url: string } | null> {
    try {
      const response = await this.client.rest.repos.getLatestRelease({ owner: this.owner, repo: this.repo });
      return { tagName: response.data.tag_name, url: response.data.html_url };
    } catch (error) {
      if (getStatus(error) === 404) return null;
      throw new Error(`GitHub n'a pas pu lire la dernière release: ${describeGitHubError(error)}`);
    }
  }

  public async getRoadmapIssues(labels: { brainstorming: string; inProgress: string; test: string; done: string }): Promise<{
    brainstorming: RoadmapIssue[];
    inProgress: RoadmapIssue[];
    test: RoadmapIssue[];
    done: RoadmapIssue[];
  }> {
    const [brainstorming, inProgress, test, done] = await Promise.all([
      this.getIssuesByLabel(labels.brainstorming),
      this.getIssuesByLabel(labels.inProgress),
      this.getIssuesByLabel(labels.test),
      this.getIssuesByLabel(labels.done),
    ]);
    const seen = new Set<string>();
    const unique = (issues: RoadmapIssue[]) => issues.filter((issue) => !seen.has(issue.url ?? issue.title) && seen.add(issue.url ?? issue.title));
    return {
      brainstorming: unique(brainstorming),
      inProgress: unique(inProgress),
      test: unique(test),
      done: unique(done),
    };
  }

  /**
   * Cartes du GitHub Project v2 (brouillons compris), rangées par colonne selon leur statut.
   * Sans numéro, le projet est retrouvé seul : celui dont le titre contient le nom du dépôt, ou
   * l'unique projet ouvert du propriétaire.
   */
  public async getProjectRoadmapIssues(projectNumber?: number): Promise<Record<RoadmapColumn, RoadmapIssue[]>> {
    try {
      const number = projectNumber ?? (await this.findProjectNumber());
      const columns: Record<RoadmapColumn, RoadmapIssue[]> = { brainstorming: [], inProgress: [], test: [], done: [] };
      let cursor: string | null = null;
      do {
        const response: ProjectItemsResponse = await this.projectClient.graphql<ProjectItemsResponse>(PROJECT_ITEMS_QUERY, {
          owner: this.owner,
          number,
          cursor,
        });
        const project = response.repositoryOwner?.projectV2;
        if (!project) throw new Error(`Projet GitHub #${number} introuvable`);
        for (const item of project.items.nodes) {
          const card = toRoadmapIssue(item);
          if (!card) continue;
          const status = item.fieldValues.nodes.find((field) => isStatusField(field?.field?.name))?.name ?? undefined;
          columns[roadmapColumn(status)].push(card);
        }
        cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
      } while (cursor);
      return columns;
    } catch (error) {
      throw new Error(`GitHub n'a pas pu lire le projet de la roadmap: ${describeGitHubError(error)}`);
    }
  }

  /** Projet lu par la dernière synchronisation : « titre » (#numéro). */
  public projectLabel(): string {
    const number = this.projectNumber ? ` (#${this.projectNumber})` : "";
    return this.projectTitle ? `« ${this.projectTitle} »${number}` : number.trim();
  }

  private async findProjectNumber(): Promise<number> {
    if (this.projectNumber) return this.projectNumber;
    const response = await this.projectClient.graphql<{
      repositoryOwner: { projectsV2?: { nodes: Array<{ number: number; title: string; closed: boolean }> } } | null;
    }>(PROJECTS_QUERY, { owner: this.owner });
    const open = (response.repositoryOwner?.projectsV2?.nodes ?? []).filter((project) => !project.closed);
    const repo = this.repo.toLowerCase();
    const found = open.find((project) => project.title.toLowerCase().includes(repo)) ?? (open.length === 1 ? open[0] : undefined);
    if (!found) {
      throw new Error(`aucun projet dont le titre contient « ${this.repo} » : renseigne GITHUB_PROJECT_NUMBER`);
    }
    console.info(`[roadmap] projet GitHub utilisé : #${found.number} « ${found.title} »`);
    this.projectNumber = found.number;
    this.projectTitle = found.title;
    return found.number;
  }

  private async getIssuesByLabel(label: string): Promise<RoadmapIssue[]> {
    try {
      const response = await this.client.paginate(this.client.rest.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        state: "all",
        labels: label,
        per_page: 100,
        sort: "updated",
        direction: "desc",
      });
      return response
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
          state: issue.state === "closed" ? "closed" : "open",
        }));
    } catch (error) {
      throw new Error(`GitHub n'a pas pu lire les issues « ${label} »: ${describeGitHubError(error)}`);
    }
  }

  private async ensureLabel(name: string, color: string): Promise<void> {
    try {
      await this.client.rest.issues.getLabel({ owner: this.owner, repo: this.repo, name });
    } catch (error) {
      if (getStatus(error) !== 404) {
        throw new Error(`GitHub n'a pas pu vérifier le label « ${name} »: ${describeGitHubError(error)}`);
      }
      try {
        await this.client.rest.issues.createLabel({ owner: this.owner, repo: this.repo, name, color });
      } catch (createError) {
        // Deux instances démarrées ensemble peuvent créer le même label: relire dans ce cas.
        if (getStatus(createError) !== 422) {
          throw new Error(`GitHub n'a pas pu créer le label « ${name} »: ${describeGitHubError(createError)}`);
        }
      }
    }
  }
}

function getStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

function describeGitHubError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "erreur inconnue";
}

export type RoadmapColumn = "brainstorming" | "inProgress" | "test" | "done";

const CARD_FIELDS = `number title url state assignees(first: 10) { nodes { login } }`;

const PROJECTS_QUERY = `query Projects($owner: String!) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner { projectsV2(first: 50) { nodes { number title closed } } }
  }
}`;

const PROJECT_ITEMS_QUERY = `query Roadmap($owner: String!, $number: Int!, $cursor: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isArchived
            content {
              ... on DraftIssue { title assignees(first: 10) { nodes { login } } }
              ... on Issue { ${CARD_FIELDS} }
              ... on PullRequest { ${CARD_FIELDS} }
            }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface ProjectItem {
  isArchived?: boolean;
  content: {
    number?: number;
    title?: string;
    url?: string;
    state?: string;
    assignees?: { nodes: Array<{ login: string }> };
  } | null;
  fieldValues: { nodes: Array<{ name?: string | null; field?: { name?: string | null } | null } | null> };
}

interface ProjectItemsResponse {
  repositoryOwner: {
    projectV2?: {
      items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ProjectItem[] };
    } | null;
  } | null;
}

function toRoadmapIssue(item: ProjectItem): RoadmapIssue | undefined {
  const content = item.content;
  if (item.isArchived || !content?.title) return undefined;
  return {
    ...(content.number !== undefined && { number: content.number }),
    ...(content.url !== undefined && { url: content.url }),
    title: content.title,
    assignees: (content.assignees?.nodes ?? []).map((assignee) => assignee.login),
    state: content.state === "CLOSED" || content.state === "MERGED" ? "closed" : "open",
  };
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function isStatusField(name: string | null | undefined): boolean {
  const field = normalize(name ?? "");
  return field === "status" || field === "statut" || field === "etat";
}

/**
 * Colonne de la roadmap d'après le statut de la carte, en français ou en anglais. Une carte sans
 * statut (ou au statut inconnu) est une idée : elle va dans Brainstorming.
 */
export function roadmapColumn(status: string | undefined): RoadmapColumn {
  const s = normalize(status ?? "");
  if (/(done|termine|fini|livre|complete|ferme|closed|shipped)/.test(s)) return "done";
  if (/(test|review|revue|qa|recette|verif|valid)/.test(s)) return "test";
  if (/(progress|cours|doing|dev|wip)/.test(s)) return "inProgress";
  return "brainstorming";
}
