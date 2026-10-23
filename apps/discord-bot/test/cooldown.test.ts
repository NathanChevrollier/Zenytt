import { describe, expect, it } from "vitest";
import { Cooldown } from "../src/services/cooldown.js";

describe("Cooldown", () => {
  it("impose un délai entre deux envois et un plafond horaire", () => {
    let t = 0;
    const c = new Cooldown(60_000, 3, () => t);
    expect(c.waitSeconds("a")).toBe(0);
    c.record("a");
    t = 10_000;
    expect(c.waitSeconds("a")).toBe(50);
    expect(c.waitSeconds("b")).toBe(0);
    t = 60_000;
    c.record("a");
    t = 120_000;
    c.record("a");
    t = 200_000;
    // Trois envois dans l'heure : il faut attendre que le premier sorte de la fenêtre.
    expect(c.waitSeconds("a")).toBe(3_400);
    t = 3_600_001;
    expect(c.waitSeconds("a")).toBe(0);
  });

  it("libère la réservation d'un envoi échoué", () => {
    const c = new Cooldown(60_000, 3, () => 0);
    c.record("a");
    expect(c.waitSeconds("a")).toBe(60);
    c.forget("a");
    expect(c.waitSeconds("a")).toBe(0);
    c.forget("inconnu"); // sans effet
  });
});
