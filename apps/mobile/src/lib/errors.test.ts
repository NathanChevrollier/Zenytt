import { describe, expect, it } from "vitest";
import { classify } from "./errors";

describe("classify", () => {
  it("reconnaît les erreurs qui demandent une action", () => {
    expect(classify("UNKNOWN_HOST_KEY:SHA256:abc")).toEqual({ kind: "unknownHost", fingerprint: "SHA256:abc" });
    expect(classify("HOST_KEY_MISMATCH:SHA256:old|SHA256:new").kind).toBe("hostChanged");
    expect(classify("NEED_PASSWORD: aucun mot de passe enregistré pour ce serveur").kind).toBe("needAuth");
    expect(classify("aucune clé privée configurée").kind).toBe("needAuth");
    expect(classify("AUTH_BLOCKED: refusé — touche « Réessayer »").kind).toBe("authFailed");
    expect(classify("Authentification échouée : refusé").kind).toBe("authFailed");
  });

  it("le reste est affiché tel quel", () => {
    expect(classify("délai dépassé")).toEqual({ kind: "other", message: "délai dépassé" });
  });
});
