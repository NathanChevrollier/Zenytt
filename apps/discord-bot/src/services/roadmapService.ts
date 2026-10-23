import { ChannelType, Client, EmbedBuilder, type Message, type TextChannel } from "discord.js";
import type { Env } from "../config/env.js";
import { GitHubService, type RoadmapIssue } from "./githubService.js";

const ROADMAP_TITLE = "🗺️ Zenytt — Tâches en cours & Roadmap";
/** Fin du titre, commune à toutes les versions du panneau : retrouve aussi un panneau publié sous un ancien nom. */
const ROADMAP_TITLE_SUFFIX = "Tâches en cours & Roadmap";
const MAX_FIELD_LENGTH = 1024;
const MAX_REPLY_LENGTH = 1900;
const MAX_ISSUES_PER_SECTION = 18;

export interface RoadmapSnapshot {
  brainstorming: RoadmapIssue[];
  inProgress: RoadmapIssue[];
  test: RoadmapIssue[];
  done: RoadmapIssue[];
  updatedAt: Date;
  /** D'où viennent les chantiers (projet GitHub ou étiquettes) : affiché dans le panneau. */
  source: string;
}

export class RoadmapService {
  private timer: NodeJS.Timeout | undefined;
  private syncPromise: Promise<RoadmapSnapshot> | undefined;

  public constructor(
    private readonly client: Client,
    private readonly env: Env,
    private readonly github: GitHubService,
  ) {}

  /** Le projet GitHub est lu dès qu'un numéro ou un jeton de lecture des projets est fourni. */
  private get useProject(): boolean {
    return Boolean(this.env.GITHUB_PROJECT_NUMBER || this.env.GITHUB_PROJECT_TOKEN);
  }

  public start(): void {
    if (!this.env.ROADMAP_CHANNEL_ID) {
      console.info("[roadmap] synchronisation désactivée: ROADMAP_CHANNEL_ID absent");
      return;
    }
    console.info(
      this.useProject
        ? "[roadmap] source : projet GitHub"
        : "[roadmap] source : étiquettes GitHub (GITHUB_PROJECT_TOKEN absent : le projet GitHub n'est pas lu)",
    );
    void this.sync().catch((error: unknown) => console.error("[roadmap] première synchronisation échouée:", error));
    this.timer = setInterval(() => {
      void this.sync().catch((error: unknown) => console.error("[roadmap] synchronisation échouée:", error));
    }, this.env.ROADMAP_SYNC_INTERVAL_MINUTES * 60_000);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async sync(): Promise<RoadmapSnapshot> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  public async getCurrent(): Promise<RoadmapSnapshot> {
    const issues = this.useProject
      ? this.github.getProjectRoadmapIssues(this.env.GITHUB_PROJECT_NUMBER)
      : this.github.getRoadmapIssues({
          brainstorming: this.env.GITHUB_BRAINSTORMING_LABEL,
          inProgress: this.env.GITHUB_IN_PROGRESS_LABEL,
          test: this.env.GITHUB_TEST_LABEL,
          done: this.env.GITHUB_DONE_LABEL,
        });
    const columns = await issues;
    const source = this.useProject
      ? `projet GitHub ${this.github.projectLabel()}`.trim()
      : "étiquettes GitHub (ajoute GITHUB_PROJECT_TOKEN pour lire le projet)";
    return { ...columns, updatedAt: new Date(), source };
  }

  public formatText(snapshot: RoadmapSnapshot): string {
    return [
      "**💡 Brainstorming**",
      formatIssueTable(snapshot.brainstorming),
      "",
      "**🔵 En cours de développement**",
      formatIssueTable(snapshot.inProgress),
      "",
      "**🧪 En test**",
      formatIssueTable(snapshot.test),
      "",
      "**✅ Terminé**",
      formatIssueTable(snapshot.done),
    ].join("\n").slice(0, MAX_REPLY_LENGTH);
  }

  private async performSync(): Promise<RoadmapSnapshot> {
    const channel = await this.getRoadmapChannel();
    const message = await this.findExistingMessage(channel);
    let snapshot: RoadmapSnapshot;
    try {
      snapshot = await this.getCurrent();
    } catch (error) {
      // Visible dans Discord : sinon le panneau garde l'ancien contenu sans dire pourquoi.
      const failed = buildRoadmapErrorEmbed(error instanceof Error ? error.message : String(error));
      if (message) await message.edit({ embeds: [failed] });
      else await channel.send({ embeds: [failed] });
      throw error;
    }
    const embed = buildRoadmapEmbed(snapshot);

    if (message) {
      await message.edit({ embeds: [embed] });
      console.info(`[roadmap] message ${message.id} mis à jour`);
    } else {
      const created = await channel.send({ embeds: [embed] });
      console.info(`[roadmap] message créé: ${created.id}; ajoute ROADMAP_MESSAGE_ID=${created.id} pour un accès direct`);
    }
    return snapshot;
  }

  private async getRoadmapChannel(): Promise<TextChannel> {
    if (!this.env.ROADMAP_CHANNEL_ID) throw new Error("ROADMAP_CHANNEL_ID n'est pas configuré");
    const channel = await this.client.channels.fetch(this.env.ROADMAP_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Le salon roadmap ${this.env.ROADMAP_CHANNEL_ID} est introuvable ou n'est pas un salon textuel`);
    }
    return channel;
  }

  private async findExistingMessage(channel: TextChannel): Promise<Message | undefined> {
    if (this.env.ROADMAP_MESSAGE_ID) {
      try {
        return await channel.messages.fetch(this.env.ROADMAP_MESSAGE_ID);
      } catch (error) {
        if (!isUnknownMessage(error)) throw error;
        console.warn(`[roadmap] message ${this.env.ROADMAP_MESSAGE_ID} introuvable; recherche dans l'historique`);
      }
    }

    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find((message) => message.author.id === this.client.user?.id && message.embeds.some((embed) => embed.title?.endsWith(ROADMAP_TITLE_SUFFIX)));
  }
}

function buildRoadmapEmbed(snapshot: RoadmapSnapshot): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2ea043)
    .setTitle(ROADMAP_TITLE)
    .setDescription("Consulte ces chantiers avant de soumettre une nouvelle suggestion.")
    .addFields(
      { name: "💡 Brainstorming", value: formatIssueTable(snapshot.brainstorming), inline: false },
      { name: "🔵 En cours de développement", value: formatIssueTable(snapshot.inProgress), inline: false },
      { name: "🧪 En test", value: formatIssueTable(snapshot.test), inline: false },
      { name: "✅ Terminé", value: formatIssueTable(snapshot.done), inline: false },
    )
    .setFooter({ text: `Source : ${snapshot.source} · Dernière synchronisation : ${snapshot.updatedAt.toLocaleString("fr-FR")}` });
}

/** Panneau affiché quand la roadmap ne peut pas être lue : la raison, telle quelle. */
function buildRoadmapErrorEmbed(reason: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xd29922)
    .setTitle(ROADMAP_TITLE)
    .setDescription(`⚠️ La roadmap n'a pas pu être lue.\n\n${truncate(reason, 1500)}`)
    .setFooter({ text: `Dernière tentative : ${new Date().toLocaleString("fr-FR")} · nouvel essai automatique` });
}

/** Une ligne par chantier (Discord n'affiche pas les tableaux Markdown dans un embed). */
export function formatIssueTable(issues: RoadmapIssue[]): string {
  if (issues.length === 0) return "Aucun chantier dans cette catégorie.";
  const lines = issues.slice(0, MAX_ISSUES_PER_SECTION).map((issue) => {
    const title = escapeText(issue.title);
    const label = issue.number !== undefined && issue.url ? `[#${issue.number}](${issue.url}) ${title}` : title;
    const assignees = issue.assignees.length > 0 ? ` — ${issue.assignees.map((assignee) => `@${assignee}`).join(", ")}` : "";
    return `• ${label}${assignees}`;
  });
  if (issues.length > MAX_ISSUES_PER_SECTION) lines.push(`• … et ${issues.length - MAX_ISSUES_PER_SECTION} autre(s)`);
  return truncate(lines.join("\n"), MAX_FIELD_LENGTH);
}

/** Neutralise la mise en forme Markdown de Discord dans un titre. */
function escapeText(value: string): string {
  return value.replace(/[\\*_`~|[\]]/g, "\\$&").replaceAll("\n", " ");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isUnknownMessage(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 10008;
}
