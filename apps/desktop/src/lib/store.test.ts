import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const openDoctor = vi.fn();
vi.mock("../components/ConnectionDoctor", () => ({
  isNetworkFailure: (m: string) => /délai dépassé/.test(m),
  useDoctor: { getState: () => ({ open: openDoctor }) },
}));
const connect = vi.fn();
const trustHost = vi.fn(async () => {});
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: { connect, trustHost, servers: vi.fn(async () => []), uiStateSet: vi.fn(async () => {}) },
}));

const { ensureConnected, useApp } = await import("./store");

const ask = vi.fn();
const notify = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ ask, notify, servers: [{ id: "s1", name: "VPS", host: "h", port: 22, username: "u", authKind: "key", connected: false }] as never });
});

describe("ensureConnected", () => {
  it("en arrière-plan, n'ouvre jamais de dialogue", async () => {
    connect.mockRejectedValueOnce("UNKNOWN_HOST_KEY:SHA256:abc");
    expect(await ensureConnected("s1", { interactive: false })).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("transmet l'action explicite (levée de la suspension après échec d'authentification)", async () => {
    connect.mockResolvedValueOnce({});
    await ensureConnected("s1", { force: true });
    expect(connect).toHaveBeenCalledWith("s1", true);
    connect.mockResolvedValueOnce({});
    await ensureConnected("s1");
    expect(connect).toHaveBeenLastCalledWith("s1", false);
  });

  it("clé d'hôte inconnue : approuvée par l'utilisateur puis connexion", async () => {
    connect.mockRejectedValueOnce("UNKNOWN_HOST_KEY:SHA256:abc").mockResolvedValueOnce({});
    ask.mockResolvedValueOnce(true);
    expect(await ensureConnected("s1")).toBe(true);
    expect(trustHost).toHaveBeenCalledWith("s1", "SHA256:abc");
  });

  it("clé d'hôte refusée : pas de connexion", async () => {
    connect.mockRejectedValueOnce("HOST_KEY_MISMATCH:SHA256:old|SHA256:new");
    ask.mockResolvedValueOnce(false);
    expect(await ensureConnected("s1")).toBe(false);
    expect(trustHost).not.toHaveBeenCalled();
  });

  it("serveur injoignable : propose le diagnostic", async () => {
    connect.mockRejectedValueOnce("Connexion impossible : délai dépassé en se connectant à h:22");
    ask.mockResolvedValueOnce(true);
    expect(await ensureConnected("s1")).toBe(false);
    expect(openDoctor).toHaveBeenCalledWith("s1");
  });

  it("identifiants refusés : message d'erreur, sans diagnostic réseau", async () => {
    connect.mockRejectedValueOnce("Authentification échouée : identifiants refusés par le serveur");
    expect(await ensureConnected("s1")).toBe(false);
    expect(notify).toHaveBeenCalled();
    expect(openDoctor).not.toHaveBeenCalled();
  });
});

describe("état enregistré d'une ancienne version", () => {
  it("Système et Sécurité mènent à Supervision, et ne restent pas dans les onglets masqués", async () => {
    await useApp.getState().hydrate(Promise.resolve({ v: 1, section: "system", settings: { hiddenSections: ["system", "docker", "security"] } }));
    expect(useApp.getState().section).toBe("monitoring");
    expect(useApp.getState().settings.hiddenSections).toEqual(["docker"]);
    await useApp.getState().hydrate(Promise.resolve({ v: 1, section: "security" }));
    expect(useApp.getState().section).toBe("monitoring");
  });
});
