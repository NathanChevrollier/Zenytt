import { randomUUID } from "node:crypto";
import { detectImageType, stripMetadata, type ImageType } from "./imageSanitizer.js";

/** Images acceptées par formulaire : 4 au plus, 8 Mo chacune. */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Seuls les serveurs de fichiers de Discord sont contactés (jamais une adresse fournie ailleurs). */
const DISCORD_CDN = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

const EXTENSION: Record<ImageType, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };

/** Pièce jointe telle que Discord la décrit. */
export interface IncomingAttachment {
  name: string;
  url: string;
  size: number;
  contentType: string | null;
}

/** Image prête à publier : métadonnées retirées, chemin dans la branche des pièces jointes. */
export interface PreparedImage {
  path: string;
  content: Uint8Array;
}

/** Image refusée, avec la raison (affichée à la personne qui l'a envoyée). */
export interface RejectedImage {
  name: string;
  reason: string;
}

/** Refus avant tout téléchargement : trop d'images, trop lourde, pas une image, hors de Discord. */
export function precheck(file: IncomingAttachment): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return `plus de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo`;
  if (file.contentType && !/^image\/(png|jpeg|gif|webp)$/i.test(file.contentType)) return "format non accepté (PNG, JPEG, GIF ou WebP)";
  let host: string;
  try {
    host = new URL(file.url).hostname;
  } catch {
    return "adresse invalide";
  }
  return DISCORD_CDN.has(host) ? null : "adresse hors de Discord";
}

/** Chemin de l'image dans la branche : un dossier par mois, un nom aléatoire (rien de personnel). */
export function attachmentPath(type: ImageType, now = new Date(), id = randomUUID()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `feedback/${month}/${id}.${EXTENSION[type]}`;
}

/** Vérifie le contenu réel (pas seulement le type annoncé) puis retire les métadonnées. */
export function prepare(data: Uint8Array, now = new Date()): PreparedImage {
  const type = detectImageType(data);
  if (!type) throw new Error("ce n'est pas une image PNG, JPEG, GIF ou WebP");
  return { path: attachmentPath(type, now), content: stripMetadata(data, type) };
}

/**
 * Télécharge les images depuis Discord, les vérifie et les nettoie. Les refus n'empêchent pas
 * l'envoi du retour : ils sont signalés à la personne.
 */
export async function collectImages(files: IncomingAttachment[], fetchImpl: typeof fetch = fetch): Promise<{ images: PreparedImage[]; rejected: RejectedImage[] }> {
  const images: PreparedImage[] = [];
  const rejected: RejectedImage[] = [];
  for (const [i, file] of files.entries()) {
    if (i >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: `${MAX_ATTACHMENTS} images au plus` });
      continue;
    }
    const early = precheck(file);
    if (early) {
      rejected.push({ name: file.name, reason: early });
      continue;
    }
    try {
      const response = await fetchImpl(file.url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
      if (!response.ok) throw new Error(`téléchargement refusé (${response.status})`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`plus de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo`);
      images.push(prepare(data));
    } catch (error) {
      rejected.push({ name: file.name, reason: error instanceof Error ? error.message : "image illisible" });
    }
  }
  return { images, rejected };
}
