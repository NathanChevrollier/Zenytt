import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const { hashPassword, verifyPassword, useLock } = await import("./lock");
const { invoke } = await import("@tauri-apps/api/core");

describe("mot de passe de verrouillage", () => {
  it("vérifie le bon mot de passe et refuse les autres", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored.startsWith("pbkdf2$200000$")).toBe(true);
    expect(stored).not.toContain("correct horse");
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("Correct horse", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("sel aléatoire : deux empreintes du même mot de passe diffèrent", async () => {
    expect(await hashPassword("x".repeat(8))).not.toBe(await hashPassword("x".repeat(8)));
  });

  it("refuse une empreinte malformée", async () => {
    expect(await verifyPassword("a", "n'importe quoi")).toBe(false);
  });
});

describe("démarrage verrouillé", () => {
  it("relancé verrouillé, l'interface affiche l'écran de verrouillage", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "app_lock_get" ? "configured" : cmd === "app_is_locked" ? true : null));
    expect(useLock.getState().checked).toBe(false);
    await useLock.getState().refresh();
    expect(useLock.getState()).toMatchObject({ configured: true, locked: true, checked: true });
  });
});
