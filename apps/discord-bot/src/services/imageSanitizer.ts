/**
 * Retire les métadonnées d'une image avant sa publication sur GitHub (dépôt public) : une photo
 * prise au téléphone porte souvent la position GPS, le modèle de l'appareil, la date, parfois le
 * nom de l'auteur. Seuls les octets de l'image sont gardés, sans la réencoder (aucune perte).
 *
 * - JPEG : segments APP1 (EXIF, XMP), APP13 (IPTC) et commentaires retirés ; l'orientation EXIF
 *   est réécrite seule, pour qu'une photo prise en portrait ne s'affiche pas couchée.
 * - PNG : blocs de texte (tEXt, zTXt, iTXt), eXIf et tIME retirés.
 * - WebP : blocs EXIF et XMP retirés (et leurs indicateurs dans l'en-tête VP8X).
 * - GIF : extensions de commentaire retirées.
 */

export type ImageType = "png" | "jpeg" | "gif" | "webp";

/** Type réel d'après les premiers octets (le type annoncé par Discord vient du nom de fichier). */
export function detectImageType(data: Uint8Array): ImageType | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "webp";
  return null;
}

export function stripMetadata(data: Uint8Array, type: ImageType): Uint8Array {
  switch (type) {
    case "jpeg":
      return stripJpeg(data);
    case "png":
      return stripPng(data);
    case "webp":
      return stripWebp(data);
    case "gif":
      return stripGif(data);
  }
}

/** Octet `i` ; une image tronquée est refusée plutôt que publiée à moitié. */
function byte(data: Uint8Array, i: number): number {
  const v = data[i];
  if (v === undefined) throw new Error("image tronquée");
  return v;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- JPEG ----------

/** Orientation EXIF (1 à 8) lue dans un segment APP1 « Exif », ou null. */
export function exifOrientation(app1: Uint8Array): number | null {
  // « Exif\0\0 » puis un en-tête TIFF.
  if (app1.length < 14 || String.fromCharCode(...app1.subarray(0, 4)) !== "Exif") return null;
  const tiff = app1.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  try {
    const ifd = view.getUint32(4, little);
    const count = view.getUint16(ifd, little);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (view.getUint16(entry, little) === 0x0112) {
        const value = view.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  } catch {
    return null; // EXIF tronqué
  }
  return null;
}

/** Segment APP1 minimal : seule l'orientation (TIFF petit-boutiste, une entrée). */
function orientationSegment(orientation: number): Uint8Array {
  const body = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // « Exif\0\0 »
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // en-tête TIFF, IFD0 à l'octet 8
    0x01, 0x00, // une entrée
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation, SHORT, 1
    0x00, 0x00, 0x00, 0x00, // pas d'IFD suivante
  ];
  const length = body.length + 2;
  return Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...body]);
}

function stripJpeg(data: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [data.subarray(0, 2)];
  let orientation: number | null = null;
  let at = 2;
  while (at + 4 <= data.length) {
    if (byte(data, at) !== 0xff) throw new Error("JPEG invalide");
    const marker = byte(data, at + 1);
    // Début des données compressées : tout le reste est l'image elle-même.
    if (marker === 0xda) {
      kept.push(data.subarray(at));
      break;
    }
    // Marqueurs sans longueur (remplissage, RSTn).
    if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = (byte(data, at + 2) << 8) | byte(data, at + 3);
    if (length < 2 || at + 2 + length > data.length) throw new Error("JPEG invalide");
    const segment = data.subarray(at, at + 2 + length);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    // Gardés : APP0 (JFIF), APP2 (profil de couleur ICC), APP14 (Adobe, utile au décodage CMJN).
    const drop = marker === 0xfe || (isApp && marker !== 0xe0 && marker !== 0xe2 && marker !== 0xee);
    if (marker === 0xe1) orientation ??= exifOrientation(segment.subarray(4));
    if (!drop) kept.push(segment);
    at += 2 + length;
  }
  // Après l'en-tête JFIF (APP0) s'il y en a un : c'est là que les lecteurs l'attendent.
  if (orientation && orientation !== 1) kept.splice(kept[1]?.[1] === 0xe0 ? 2 : 1, 0, orientationSegment(orientation));
  return concat(kept);
}

// ---------- PNG ----------

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function stripPng(data: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [data.subarray(0, 8)];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8;
  while (at + 12 <= data.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (end > data.length) throw new Error("PNG invalide");
    if (!PNG_DROP.has(type)) kept.push(data.subarray(at, end));
    at = end;
    if (type === "IEND") break;
  }
  return concat(kept);
}

// ---------- WebP ----------

function stripWebp(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kept: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= data.length) {
    const type = String.fromCharCode(...data.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size & 1);
    if (at + 8 + size > data.length) throw new Error("WebP invalide");
    if (type === "VP8X") {
      const chunk = data.slice(at, Math.min(end, data.length));
      chunk[8] = byte(chunk, 8) & ~(0x08 | 0x04); // indicateurs EXIF et XMP
      kept.push(chunk);
    } else if (type !== "EXIF" && type !== "XMP ") {
      kept.push(data.subarray(at, Math.min(end, data.length)));
    }
    at = end;
  }
  const body = concat(kept);
  const header = data.slice(0, 12);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}

// ---------- GIF ----------

function stripGif(data: Uint8Array): Uint8Array {
  // En-tête (6) + descripteur d'écran (7) + palette globale éventuelle.
  const flags = byte(data, 10);
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  const kept: Uint8Array[] = [data.subarray(0, at)];
  const skipBlocks = (from: number) => {
    let i = from;
    while (byte(data, i) !== 0) i += byte(data, i) + 1;
    return i + 1;
  };
  while (at < data.length) {
    const start = at;
    const kind = byte(data, at);
    if (kind === 0x3b) {
      kept.push(data.subarray(at, at + 1));
      break;
    }
    if (kind === 0x21) {
      const label = byte(data, at + 1);
      at = skipBlocks(at + 2);
      if (label !== 0xfe) kept.push(data.subarray(start, at)); // 0xFE : commentaire
    } else if (kind === 0x2c) {
      const local = byte(data, at + 9);
      at += 10 + (local & 0x80 ? 3 * 2 ** ((local & 0x07) + 1) : 0);
      at = skipBlocks(at + 1); // taille minimale LZW, puis les données
      kept.push(data.subarray(start, at));
    } else {
      throw new Error("GIF invalide");
    }
  }
  return concat(kept);
}
