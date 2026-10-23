// Barre de touches du terminal : séquences envoyées au shell pour les touches que le clavier
// d'un téléphone n'a pas (Échap, Tab, flèches, Ctrl, Alt).

export type Mods = { ctrl: boolean; alt: boolean };
export type BarKey = "esc" | "tab" | "up" | "down" | "left" | "right" | "|" | "~" | "/";

const ARROW: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };

/** Séquence d'une touche de la barre, avec les modificateurs actifs. `appCursor` : mode « curseur applicatif » du terminal. */
export function barSequence(key: BarKey, mods: Mods, appCursor = false): string {
  const letter = ARROW[key];
  if (letter) {
    const code = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
    if (code > 1) return `\x1b[1;${code}${letter}`;
    return appCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
  }
  const base = key === "esc" ? "\x1b" : key === "tab" ? "\t" : key;
  return mods.alt ? `\x1b${base}` : base;
}

/** Ctrl + caractère tapé au clavier : `c` → ^C (0x03), `[` → Échap… Inchangé s'il n'a pas d'équivalent. */
export function ctrlChar(ch: string): string {
  if (ch.length !== 1) return ch;
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40); // @ A-Z [ \ ] ^ _
  if (ch === " ") return "\x00";
  if (ch === "?") return "\x7f";
  return ch;
}

/** Applique Ctrl / Alt à ce que le clavier vient d'envoyer au terminal (un caractère à la fois ; le collage passe tel quel). */
export function withMods(data: string, mods: Mods): string {
  if (data.length !== 1 || (!mods.ctrl && !mods.alt)) return data;
  const out = mods.ctrl ? ctrlChar(data) : data;
  return mods.alt ? `\x1b${out}` : out;
}
