export type FeedbackKind = "bug" | "suggestion";

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  description: string;
  context?: string;
  /** Adresses des captures archivées (générées par le bot, jamais saisies). */
  images?: string[];
  /** Captures envoyées mais refusées ou non archivées. */
  missingImages?: number;
}

export interface DiscordAuthor {
  id: string;
  username: string;
  avatarUrl: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
}
