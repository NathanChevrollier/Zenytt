import { describe, expect, it } from "vitest";
import type { ContainerImage, Finding } from "./api";
import { auditSummary, formatAt, resolveSystemTab, scoreVerdict, sortImages, sortUpdates, splitTab, updateGroup, validHostname } from "./system";

const img = (container: string, project: string | null, service: string | null = null) => ({ container, project, service }) as ContainerImage;

describe("système", () => {
  it("familles de paquets", () => {
    expect(updateGroup("linux-image-6.1.0-18-amd64")).toBe("kernel");
    expect(updateGroup("kernel-core.x86_64")).toBe("kernel");
    expect(updateGroup("libc6")).toBe("libs");
    expect(updateGroup("nginx")).toBe("apps");
  });

  it("mises à jour : noyau d'abord, puis par nom", () => {
    const names = sortUpdates([{ name: "nginx" }, { name: "libssl3" }, { name: "curl" }, { name: "linux-image-amd64" }].map((u) => ({ ...u, current: "", candidate: "" })));
    expect(names.map((u) => u.name)).toEqual(["linux-image-amd64", "libssl3", "curl", "nginx"]);
  });

  it("images : par projet, conteneurs isolés à la fin", () => {
    const sorted = sortImages([img("solo", null), img("b-web", "blog", "web"), img("a-db", "app", "db"), img("a-api", "app", "api")]);
    expect(sorted.map((i) => i.container)).toEqual(["a-api", "a-db", "b-web", "solo"]);
  });

  it("nom d'hôte", () => {
    expect(validHostname("web-01")).toBe(true);
    expect(validHostname("-web")).toBe(false);
    expect(validHostname("web.example")).toBe(false);
    expect(validHostname("a".repeat(64))).toBe(false);
  });

  it("heure programmée", () => {
    const now = new Date(2026, 9, 23, 10, 0);
    expect(formatAt(new Date(2026, 9, 23, 14, 30).getTime() / 1000, now)).toBe("14:30");
    expect(formatAt(new Date(2026, 9, 24, 8, 5).getTime() / 1000, now)).toBe("24/10 08:05");
  });

  it("résumé de l'audit", () => {
    const f = (id: string, severity: Finding["severity"]) => ({ id, severity, title: id, detail: "", fix: null, fixLabel: null });
    const s = auditSummary([f("a", "critical"), f("b", "medium"), f("c", "ok"), f("d", "high")], ["d"]);
    expect(s.problems.map((p) => p.id)).toEqual(["a", "b"]);
    expect(s.serious).toBe(1);
    expect(s.ok).toHaveLength(1);
    expect(s.score).toBe(64);
    expect(auditSummary([f("x", "critical"), f("y", "critical"), f("z", "critical"), f("w", "critical")], []).score).toBe(0);
    expect(scoreVerdict(95)).toBe("Serveur bien protégé");
  });

  it("onglet et sous-onglet", () => {
    expect(splitTab("security/fail2ban")).toEqual(["security", "fail2ban"]);
    expect(splitTab("updates")).toEqual(["updates", null]);
  });

  it("anciens onglets et liens", () => {
    expect(resolveSystemTab("updates").tab).toBe("software");
    expect(resolveSystemTab("inventory").tab).toBe("software");
    expect(resolveSystemTab("security")).toEqual({ tab: "overview", sub: null, audit: true });
    expect(resolveSystemTab("security/audit")).toEqual({ tab: "overview", sub: null, audit: true });
    expect(resolveSystemTab("security/fail2ban")).toEqual({ tab: "security", sub: "fail2ban", audit: false });
    expect(resolveSystemTab("provider").tab).toBe("provider");
    expect(resolveSystemTab("n'importe quoi").tab).toBe("overview");
  });
});
