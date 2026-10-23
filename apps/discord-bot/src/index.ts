import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadEnv } from "./config/env.js";
import { registerCommands } from "./events/ready.js";
import { createInteractionHandler } from "./events/interactionCreate.js";
import { GitHubService } from "./services/githubService.js";
import { RoadmapService } from "./services/roadmapService.js";

const env = loadEnv();
const github = new GitHubService(
  env.GITHUB_OWNER,
  env.GITHUB_REPO,
  env.GITHUB_TOKEN,
  { bug: env.GITHUB_BUG_LABEL, suggestion: env.GITHUB_SUGGESTION_LABEL },
  env.GITHUB_PROJECT_TOKEN,
  env.GITHUB_ATTACHMENTS_REPO && env.GITHUB_ATTACHMENTS_TOKEN ? { repo: env.GITHUB_ATTACHMENTS_REPO, token: env.GITHUB_ATTACHMENTS_TOKEN } : undefined,
);
if (env.GITHUB_ATTACHMENTS_BRANCH && !(env.GITHUB_ATTACHMENTS_REPO && env.GITHUB_ATTACHMENTS_TOKEN)) {
  console.warn("[config] captures archivées dans le dépôt Zenytt avec son jeton (Contents: write) : définis GITHUB_ATTACHMENTS_REPO et GITHUB_ATTACHMENTS_TOKEN pour un dépôt séparé.");
}
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const roadmap = new RoadmapService(client, env, github);

client.once(Events.ClientReady, (readyClient) => {
  void registerCommands(readyClient, env)
    .then(() => roadmap.start())
    .catch((error: unknown) => {
      console.error("[discord] impossible d'enregistrer les commandes:", error);
      void readyClient.destroy();
      process.exitCode = 1;
    });
});
client.on(Events.InteractionCreate, createInteractionHandler(client, env, github, roadmap));

async function shutdown(signal: string): Promise<void> {
  console.info(`[process] arrêt demandé (${signal})`);
  roadmap.stop();
  client.destroy();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

client.login(env.DISCORD_TOKEN).catch((error: unknown) => {
  console.error("[discord] échec de connexion:", error);
  process.exitCode = 1;
});
