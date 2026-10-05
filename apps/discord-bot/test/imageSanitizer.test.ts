import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectImageType, exifOrientation, stripMetadata } from "../src/services/imageSanitizer.js";

// Images générées avec Pillow, porteuses de métadonnées sensibles : position GPS, fabricant et
// modèle de l'appareil, auteur, commentaires (toutes marquées « SECRET »).
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const text = (data: Uint8Array) => Buffer.from(data).toString("latin1");

describe("métadonnées des images jointes", () => {
  it("reconnaît le type réel d'après le contenu", () => {
    expect(detectImageType(fixture("photo.jpg"))).toBe("jpeg");
    expect(detectImageType(fixture("capture.png"))).toBe("png");
    expect(detectImageType(fixture("image.webp"))).toBe("webp");
    expect(detectImageType(fixture("anim.gif"))).toBe("gif");
    expect(detectImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });

  it.each(["photo.jpg", "capture.png", "image.webp", "anim.gif"])("retire les métadonnées de %s", (name) => {
    const input = fixture(name);
    expect(text(input)).toContain("SECRET");
    const out = stripMetadata(input, detectImageType(input)!);
    expect(text(out)).not.toContain("SECRET");
    expect(detectImageType(out)).toBe(detectImageType(input));
    expect(out.length).toBeLessThan(input.length);
  });

  it("JPEG : retire le GPS mais garde l'orientation (photo prise en portrait)", () => {
    const input = fixture("photo.jpg");
    // Étiquette EXIF 0x8825 (pointeur vers les données GPS), en petit- ou gros-boutiste.
    const hasGps = (data: Uint8Array) => Buffer.from(data).includes(Buffer.from([0x25, 0x88])) || Buffer.from(data).includes(Buffer.from([0x88, 0x25]));
    expect(hasGps(input)).toBe(true);
    const out = stripMetadata(input, "jpeg");
    expect(hasGps(out)).toBe(false);
    // Un seul segment APP1, réduit à l'orientation.
    const app1 = Buffer.from(out).indexOf(Buffer.from([0xff, 0xe1]));
    expect(app1).toBeGreaterThan(0);
    const length = (out[app1 + 2] << 8) | out[app1 + 3];
    expect(length).toBeLessThan(40);
    expect(exifOrientation(out.subarray(app1 + 4, app1 + 2 + length))).toBe(6);
    // Les données de l'image (à partir du début du balayage) sont intactes.
    const sos = (data: Uint8Array) => Buffer.from(data).subarray(Buffer.from(data).indexOf(Buffer.from([0xff, 0xda])));
    expect(sos(out).equals(sos(input))).toBe(true);
  });

  it("refuse un fichier abîmé plutôt que de publier n'importe quoi", () => {
    const broken = fixture("photo.jpg").slice(0, 40);
    broken[20] = 0x00;
    expect(() => stripMetadata(broken, "jpeg")).toThrow();
  });
});
