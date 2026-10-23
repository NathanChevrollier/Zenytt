import "dotenv/config";
import { z } from "zod";

const optionalDiscordId = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().regex(/^\d{17,20}$/, "doit être un identifiant Discord valide").optional(),
);
const optionalProjectNumber = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  CLIENT_ID: z.string().regex(/^\d{17,20}$/, "CLIENT_ID doit être un identifiant Discord valide"),
  GUILD_ID: z.string().regex(/^\d{17,20}$/, "GUILD_ID doit être un identifiant Discord valide"),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  GITHUB_REPO: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  GITHUB_PROJECT_NUMBER: optionalProjectNumber,
  // Jeton « classic » limité à read:project : un jeton fine-grained ne lit pas les projets d'un compte personnel.
  GITHUB_PROJECT_TOKEN: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  SUGGESTION_CHANNEL_ID: z.string().regex(/^\d{17,20}$/, "SUGGESTION_CHANNEL_ID doit être un identifiant Discord valide"),
  BUG_CHANNEL_ID: z.string().regex(/^\d{17,20}$/, "BUG_CHANNEL_ID doit être un identifiant Discord valide"),
  ROADMAP_CHANNEL_ID: optionalDiscordId,
  ROADMAP_MESSAGE_ID: optionalDiscordId,
  ROADMAP_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  // Branche du dépôt où sont archivées les captures jointes aux retours (vide : captures désactivées).
  GITHUB_ATTACHMENTS_BRANCH: z
    .string()
    .regex(/^$|^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/, "GITHUB_ATTACHMENTS_BRANCH doit être un nom de branche valide")
    .refine((v) => !v.includes("..") && !v.endsWith(".lock") && !v.endsWith("/"), "GITHUB_ATTACHMENTS_BRANCH doit être un nom de branche valide")
    .default("feedback-attachments"),
  // Captures dans un dépôt SÉPARÉ, avec son propre jeton (Contents: write sur ce seul dépôt) : le
  // jeton du dépôt Zenytt reste limité aux issues et ne peut pas pousser de tag ni de code.
  GITHUB_ATTACHMENTS_REPO: z.preprocess((value) => (value === "" ? undefined : value), z.string().regex(/^[A-Za-z0-9_.-]+$/).optional()),
  GITHUB_ATTACHMENTS_TOKEN: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  GITHUB_BUG_LABEL: z.string().min(1).max(50).default("bug"),
  GITHUB_SUGGESTION_LABEL: z.string().min(1).max(50).default("enhancement"),
  GITHUB_BRAINSTORMING_LABEL: z.string().min(1).max(50).default("brainstorming"),
  GITHUB_IN_PROGRESS_LABEL: z.string().min(1).max(50).default("in-progress"),
  GITHUB_TEST_LABEL: z.string().min(1).max(50).default("test"),
  GITHUB_DONE_LABEL: z.string().min(1).max(50).default("done"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Configuration d'environnement invalide: ${details}`);
  }
  return result.data;
}
