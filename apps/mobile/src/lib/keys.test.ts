import { describe, expect, it } from "vitest";
import { barSequence, ctrlChar, withMods } from "./keys";

const none = { ctrl: false, alt: false };

describe("barre de touches", () => {
  it("touches simples", () => {
    expect(barSequence("esc", none)).toBe("\x1b");
    expect(barSequence("tab", none)).toBe("\t");
    expect(barSequence("|", none)).toBe("|");
    expect(barSequence("/", none)).toBe("/");
  });

  it("flèches, en mode normal et applicatif", () => {
    expect(barSequence("up", none)).toBe("\x1b[A");
    expect(barSequence("left", none)).toBe("\x1b[D");
    expect(barSequence("up", none, true)).toBe("\x1bOA");
  });

  it("flèches avec Ctrl / Alt", () => {
    expect(barSequence("right", { ctrl: true, alt: false })).toBe("\x1b[1;5C");
    expect(barSequence("right", { ctrl: false, alt: true })).toBe("\x1b[1;3C");
    expect(barSequence("down", { ctrl: true, alt: true }, true)).toBe("\x1b[1;7B");
  });

  it("Alt préfixe la touche d'un Échap", () => {
    expect(barSequence("tab", { ctrl: false, alt: true })).toBe("\x1b\t");
    expect(barSequence("/", { ctrl: false, alt: true })).toBe("\x1b/");
  });
});

describe("modificateurs du clavier", () => {
  it("Ctrl + lettre", () => {
    expect(ctrlChar("c")).toBe("\x03");
    expect(ctrlChar("D")).toBe("\x04");
    expect(ctrlChar("[")).toBe("\x1b");
    expect(ctrlChar("1")).toBe("1");
  });

  it("withMods ne touche que la frappe d'un caractère", () => {
    expect(withMods("c", { ctrl: true, alt: false })).toBe("\x03");
    expect(withMods("x", { ctrl: false, alt: true })).toBe("\x1bx");
    expect(withMods("ls -la", { ctrl: true, alt: false })).toBe("ls -la");
    expect(withMods("c", none)).toBe("c");
  });
});
