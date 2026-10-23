import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import type { Env } from "../config/env.js";
import { formatIssueBody, formatIssueTitle } from "../services/feedbackService.js";
import { GitHubService } from "../services/githubService.js";
import { RoadmapService } from "../services/roadmapService.js";
import { Cooldown } from "../services/cooldown.js";
import { collectImages, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../services/attachmentService.js";
import type { FeedbackInput, FeedbackKind } from "../types/feedback.js";

/** Un retour par minute et cinq par heure au plus, par personne. */
const feedbackCooldown = new Cooldown();

export function createInteractionHandler(client: Client, env: Env, github: GitHubService, roadmap: RoadmapService) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, client, env, github, roadmap);
        return;
      }
      if (interaction.isButton() && (interaction.customId === "feedback:bug" || interaction.customId === "feedback:suggestion")) {
        await showFeedbackModal(interaction.customId.slice("feedback:".length) as FeedbackKind, interaction, env);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("feedback-modal:")) {
        await handleFeedbackModal(interaction.customId.slice("feedback-modal:".length) as FeedbackKind, interaction, github, env);
      }
    } catch (error) {
      console.error("[interaction] traitement échoué:", error);
      await replyWithError(interaction);
    }
  };
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  env: Env,
  github: GitHubService,
  roadmap: RoadmapService,
): Promise<void> {
  switch (interaction.commandName) {
    case "setup-feedback":
      await setupFeedback(interaction, env);
      break;
    case "bug":
      await showFeedbackModal("bug", interaction, env);
      break;
    case "suggestion":
      await showFeedbackModal("suggestion", interaction, env);
      break;
    case "sync-roadmap":
      await syncRoadmap(interaction, roadmap);
      break;
    case "roadmap":
      await showRoadmap(interaction, roadmap);
      break;
    case "zenytt":
      await showStatus(interaction, client, github);
      break;
  }
}

async function syncRoadmap(interaction: ChatInputCommandInteraction, roadmap: RoadmapService): Promise<void> {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Seuls les membres ayant la permission Gérer le serveur peuvent synchroniser la roadmap.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const snapshot = await roadmap.sync();
  await interaction.editReply(
    `Roadmap synchronisée : ${snapshot.brainstorming.length} brainstorming, ${snapshot.inProgress.length} en cours, ${snapshot.test.length} en test, ${snapshot.done.length} terminée(s).`,
  );
}

async function showRoadmap(interaction: ChatInputCommandInteraction, roadmap: RoadmapService): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const snapshot = await roadmap.getCurrent();
  await interaction.editReply(roadmap.formatText(snapshot));
}

async function setupFeedback(interaction: ChatInputCommandInteraction, env: Env): Promise<void> {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Seuls les membres ayant la permission Gérer le serveur peuvent utiliser cette commande.", ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Cette commande doit être utilisée dans un serveur Discord.", ephemeral: true });
    return;
  }
  const suggestionChannel = findTextChannel(guild.channels.cache.get(env.SUGGESTION_CHANNEL_ID));
  const bugChannel = findTextChannel(guild.channels.cache.get(env.BUG_CHANNEL_ID));
  const missing = [
    suggestionChannel ? undefined : `ID ${env.SUGGESTION_CHANNEL_ID}`,
    bugChannel ? undefined : `ID ${env.BUG_CHANNEL_ID}`,
  ].filter((name): name is string => name !== undefined);

  if (missing.length > 0 || !suggestionChannel || !bugChannel) {
    await interaction.reply({ content: `Salons introuvables: ${missing.join(", ")}. Crée-les ou ajuste le fichier .env.`, ephemeral: true });
    return;
  }

  await Promise.all([
    suggestionChannel.send({ embeds: [buildPanel("suggestion")], components: [buildButtonRow("suggestion")] }),
    bugChannel.send({ embeds: [buildPanel("bug")], components: [buildButtonRow("bug")] }),
  ]);
  await interaction.reply({ content: "Les panneaux de feedback ont été publiés.", ephemeral: true });
  console.info(`[feedback] panneaux publiés par ${interaction.user.tag}`);
}

async function showFeedbackModal(kind: FeedbackKind, interaction: ButtonInteraction | ChatInputCommandInteraction, env: Env): Promise<void> {
  const isBug = kind === "bug";
  const modal = new ModalBuilder().setCustomId(`feedback-modal:${kind}`).setTitle(isBug ? "Signaler un bug" : "Proposer une amélioration");
  const title = new TextInputBuilder()
    .setCustomId("title")
    .setPlaceholder(isBug ? "Ex: Le terminal se ferme au démarrage" : "Ex: Ajouter le support de ...")
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(120)
    .setRequired(true);
  const description = new TextInputBuilder()
    .setCustomId("description")
    .setPlaceholder(isBug ? "Étapes, résultat attendu, résultat obtenu..." : "Explique le besoin et le résultat attendu...")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(10)
    .setMaxLength(4000)
    .setRequired(true);
  const context = new TextInputBuilder()
    .setCustomId("context")
    .setPlaceholder("Version Zenytt, OS, priorité, logs utiles...")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(false);

  modal.addLabelComponents(
    new LabelBuilder().setLabel("Titre court").setTextInputComponent(title),
    new LabelBuilder().setLabel(isBug ? "Description et étapes pour reproduire" : "Description de l'amélioration").setTextInputComponent(description),
    new LabelBuilder().setLabel("Contexte optionnel").setTextInputComponent(context),
  );
  // Captures : seulement si une branche d'archivage est configurée (sinon elles seraient perdues).
  if (env.GITHUB_ATTACHMENTS_BRANCH) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel(isBug ? "Captures d'écran (optionnel)" : "Images (optionnel)")
        .setDescription(`${MAX_ATTACHMENTS} images max (PNG, JPEG, GIF, WebP). Publiées dans l'issue GitHub publique : masque mots de passe, IP et e-mails.`)
        .setFileUploadComponent(new FileUploadBuilder().setCustomId("images").setMinValues(0).setMaxValues(MAX_ATTACHMENTS).setRequired(false)),
    );
  }
  await interaction.showModal(modal);
}

async function handleFeedbackModal(kind: FeedbackKind, interaction: ModalSubmitInteraction, github: GitHubService, env: Env): Promise<void> {
  const title = interaction.fields.getTextInputValue("title").trim();
  const description = interaction.fields.getTextInputValue("description").trim();
  const context = interaction.fields.getTextInputValue("context").trim();
  const uploaded = env.GITHUB_ATTACHMENTS_BRANCH ? [...(interaction.fields.getUploadedFiles("images")?.values() ?? [])] : [];

  if (title.length < 3 || description.length < 10) {
    await interaction.reply({ content: "Le titre doit contenir au moins 3 caractères et la description au moins 10 caractères.", ephemeral: true });
    return;
  }
  const wait = feedbackCooldown.waitSeconds(interaction.user.id);
  if (wait > 0) {
    const delay = wait >= 120 ? `${Math.ceil(wait / 60)} minutes` : `${wait} secondes`;
    await interaction.reply({ content: `Merci ! Pour éviter les doublons, attends encore ${delay} avant d'envoyer un autre retour.`, ephemeral: true });
    return;
  }
  // Réservé avant le premier await : deux envois simultanés ne passent pas tous les deux le délai.
  feedbackCooldown.record(interaction.user.id);
  try {
    await submitFeedback(kind, interaction, github, env, { title, description, context }, uploaded);
  } catch (error) {
    feedbackCooldown.forget(interaction.user.id);
    throw error;
  }
}

async function submitFeedback(
  kind: FeedbackKind,
  interaction: ModalSubmitInteraction,
  github: GitHubService,
  env: Env,
  { title, description, context }: { title: string; description: string; context: string },
  uploaded: Attachment[],
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  // Captures : téléchargées, vérifiées, nettoyées de leurs métadonnées puis archivées dans le dépôt.
  // Un échec ne bloque pas le retour : il est signalé, et l'issue le mentionne.
  const { images, rejected } = await collectImages(
    uploaded.map((a) => ({ name: a.name, url: a.url, size: a.size, contentType: a.contentType })),
  );
  let urls: string[] = [];
  let archiveFailed = false;
  if (images.length) {
    try {
      urls = await github.storeAttachments(env.GITHUB_ATTACHMENTS_BRANCH, images, formatIssueTitle({ kind, title }));
    } catch (error) {
      archiveFailed = true;
      console.error("[feedback] archivage des captures échoué:", error);
    }
  }
  const input: FeedbackInput = {
    kind,
    title,
    description,
    ...(context ? { context } : {}),
    ...(urls.length ? { images: urls } : {}),
    ...(uploaded.length - urls.length > 0 ? { missingImages: uploaded.length - urls.length } : {}),
  };

  const issue = await github.createIssue(
    formatIssueTitle(input),
    formatIssueBody(input, {
      id: interaction.user.id,
      username: interaction.user.tag,
      avatarUrl: interaction.user.displayAvatarURL({ extension: "png", size: 128 }),
    }),
    kind,
  );
  const notes = [
    urls.length ? `${urls.length} capture(s) jointe(s), sans leurs métadonnées (position GPS, appareil…).` : "",
    ...rejected.map((r) => `Image « ${r.name} » non jointe : ${r.reason}.`),
    archiveFailed ? "Les captures n'ont pas pu être archivées : ajoute-les en commentaire de l'issue si besoin." : "",
  ].filter(Boolean);
  await interaction.editReply([`Merci pour ton retour. L'issue GitHub **#${issue.number}** a été créée : ${issue.url}`, ...notes].join("\n"));
  console.info(`[feedback] issue #${issue.number} créée par ${interaction.user.tag} (${kind}, ${urls.length} capture(s))`);
}

async function showStatus(interaction: ChatInputCommandInteraction, client: Client, github: GitHubService): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const release = await github.getLatestRelease();
  const releaseText = release ? `[${release.tagName}](${release.url})` : "Aucune release publiée";
  await interaction.editReply(`**Zenytt Community Bot**\nÉtat : en ligne\nPing Discord : ${client.ws.ping} ms\nUptime : ${formatDuration(client.uptime ?? 0)}\nDernière release Zenytt : ${releaseText}`);
}

function buildPanel(kind: FeedbackKind): EmbedBuilder {
  const isBug = kind === "bug";
  return new EmbedBuilder()
    .setColor(isBug ? 0xd73a4a : 0x2ea043)
    .setTitle(isBug ? "Signaler un bug" : "Proposer une amélioration")
    .setDescription(
      isBug
        ? "Tu as rencontré un problème dans Zenytt ? Décris-le avec les étapes pour le reproduire afin que l'équipe puisse l'analyser."
        : "Une idée pour rendre Zenytt plus utile ? Partage-la avec la communauté et l'équipe de développement.",
    )
    .setFooter({ text: `Un formulaire Discord ouvrira les champs nécessaires (captures d'écran jusqu'à ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo acceptées).` });
}

function buildButtonRow(kind: FeedbackKind): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(`feedback:${kind}`)
    .setLabel(kind === "bug" ? "Signaler un bug" : "Proposer une amélioration")
    .setEmoji(kind === "bug" ? "🐛" : "💡")
    .setStyle(kind === "bug" ? ButtonStyle.Danger : ButtonStyle.Success);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function findTextChannel(channel: unknown): TextChannel | undefined {
  return isTextChannel(channel) ? channel : undefined;
}

function isTextChannel(channel: unknown): channel is TextChannel {
  return typeof channel === "object" && channel !== null && "type" in channel && channel.type === ChannelType.GuildText && "send" in channel;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

async function replyWithError(interaction: Interaction): Promise<void> {
  const payload = { content: "Une erreur est survenue. Réessaie dans quelques instants ou contacte un administrateur.", ephemeral: true };
  try {
    if (interaction.isRepliable()) {
      if (interaction.replied) await interaction.followUp(payload);
      else if (interaction.deferred) await interaction.editReply(payload.content);
      else await interaction.reply(payload);
    }
  } catch (replyError) {
    console.error("[interaction] impossible d'envoyer l'erreur à Discord:", replyError);
  }
}

