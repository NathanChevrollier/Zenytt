import { describe, expect, it } from "vitest";
import { banDurationText, banEnd, banEndText, bannedAddresses, countryName, dayLabel, groupByDay, recidivists, timeOf, unbanKinds } from "./fail2ban";
import type { F2bEvent, F2bJail } from "./api";

const ev = (time: string, kind: F2bEvent["kind"], ip: string): F2bEvent => ({ time, jail: "sshd", kind, ip });

describe("récidivistes fail2ban", () => {
  it("repère une adresse bannie plusieurs fois (cas de la capture)", () => {
    const log = [
      ev("2026-09-27 03:47:30", "found", "45.148.10.239"),
      ev("2026-09-27 03:47:41", "ban", "45.148.10.239"),
      ev("2026-09-28 03:47:40", "unban", "45.148.10.239"),
      ev("2026-09-28 04:05:50", "found", "45.148.10.239"),
      ev("2026-09-28 04:06:02", "ban", "45.148.10.239"),
      ev("2026-09-28 15:00:31", "unban", "45.148.10.239"),
      ev("2026-09-28 15:00:31", "restore", "45.148.10.239"),
      ev("2026-09-29 04:06:02", "unban", "45.148.10.239"),
      ev("2026-09-28 21:09:10", "found", "143.198.162.57"),
      ev("2026-09-28 21:09:17", "ban", "143.198.162.57"),
    ];
    const r = recidivists(log);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ip: "45.148.10.239", bans: 2 });
  });

  it("repère une adresse débloquée qui retente", () => {
    const r = recidivists([ev("1", "found", "1.2.3.4"), ev("2", "ban", "1.2.3.4"), ev("3", "unban", "1.2.3.4"), ev("4", "found", "1.2.3.4"), ev("5", "found", "1.2.3.4")]);
    expect(r).toEqual([{ ip: "1.2.3.4", bans: 1, retriesSinceUnban: 2, lastSeen: "5" }]);
  });

  it("ne compte que les bannissements automatiques (précédés de tentatives)", () => {
    const manual = (time: string, ip: string, jail = "sshd"): F2bEvent => ({ time, jail, kind: "ban", ip });
    const log = [
      ev("1", "found", "5.5.5.5"),
      ev("2", "ban", "5.5.5.5"),
      ev("3", "unban", "5.5.5.5"),
      // Bannie à la main ensuite : dans le jail sshd sans tentative, puis dans une jail Zenytt.
      manual("4", "5.5.5.5"),
      ev("5", "unban", "5.5.5.5"),
      manual("6", "5.5.5.5", "zenytt-definitif"),
      // Même chose pour une IP qu'on n'a bannie qu'à la main : jamais récidiviste.
      manual("7", "6.6.6.6"),
      ev("8", "unban", "6.6.6.6"),
      manual("9", "6.6.6.6"),
    ];
    expect(recidivists(log)).toEqual([]);
  });

  it("ignore les simples tentatives et les bannis une seule fois", () => {
    expect(recidivists([ev("1", "found", "9.9.9.9"), ev("2", "ban", "8.8.8.8")])).toEqual([]);
  });
});

describe("nature d'un débannissement", () => {
  // Journal de la capture : 45.148.10.239 sur sshd (bannissement de 24 h).
  const log = [
    ev("2026-09-27 03:47:41", "ban", "45.148.10.239"),
    ev("2026-09-28 03:47:40", "unban", "45.148.10.239"),
    ev("2026-09-28 04:06:02", "ban", "45.148.10.239"),
    ev("2026-09-28 15:00:31", "unban", "45.148.10.239"),
    ev("2026-09-28 15:00:31", "restore", "45.148.10.239"),
    ev("2026-09-29 04:06:02", "unban", "45.148.10.239"),
    ev("2026-09-29 10:00:00", "ban", "9.9.9.9"),
    ev("2026-09-29 10:05:00", "unban", "9.9.9.9"),
    ev("2026-09-29 11:00:00", "unban", "7.7.7.7"),
  ];
  const kinds = unbanKinds(log, { sshd: 86400 });

  it("fin de durée, redémarrage, manuel, inconnu", () => {
    expect(kinds.get(1)).toBe("expired");
    expect(kinds.get(3)).toBe("restart");
    expect(kinds.get(5)).toBe("expired");
    expect(kinds.get(7)).toBe("manual");
    expect(kinds.get(8)).toBe("unknown");
  });
});

describe("bannissements longs (ticket #27)", () => {
  const jail = (name: string, bantime: number, banned: string[], bans: F2bJail["bans"] = []): F2bJail => ({
    name, bantime, banned, bans, currentlyFailed: 0, totalFailed: 0, currentlyBanned: banned.length, totalBanned: banned.length, findtime: 600, maxretry: 3, ignoreip: [],
  });

  it("écrit les durées sans unités nulles", () => {
    expect(banDurationText(30 * 86400)).toBe("30 jours");
    expect(banDurationText(7 * 86400)).toBe("1 semaine");
    expect(banDurationText(86400)).toBe("1 jour");
    expect(banDurationText(36 * 3600)).toBe("1 jour 12 h");
    expect(banDurationText(600)).toBe("10 min");
    expect(banDurationText(-1)).toBe("définitif");
  });

  it("donne la fin d'un bannissement, ou définitif", () => {
    const month = jail("zenytt-30j", 2592000, ["203.0.113.30"], [{ ip: "203.0.113.30", since: "2026-10-05 13:13:42", until: "2026-11-04 13:13:42" }]);
    const forever = jail("zenytt-definitif", -1, ["203.0.113.99"], [{ ip: "203.0.113.99", since: "2026-10-05 13:13:42", until: null }]);
    expect(banEnd(month, "203.0.113.30")).toBe("2026-11-04 13:13:42");
    expect(banEndText(banEnd(month, "203.0.113.30"))).toBe("jusqu'au 4 nov. 2026, 13:13");
    expect(banEnd(forever, "203.0.113.99")).toBeNull();
    // fail2ban ancien (sans --with-time) : définitif d'après le jail, sinon inconnu.
    expect(banEnd(jail("zenytt-definitif", -1, ["1.1.1.1"]), "1.1.1.1")).toBeNull();
    expect(banEnd(jail("sshd", 600, ["1.1.1.1"]), "1.1.1.1")).toBeUndefined();
  });

  it("compte une adresse une seule fois, même dans deux jails", () => {
    expect(bannedAddresses([jail("sshd", 600, ["1.1.1.1", "2.2.2.2"]), jail("zenytt-30j", 2592000, ["1.1.1.1"])]).size).toBe(2);
  });

  it("un débannissement définitif est forcément manuel", () => {
    const log: F2bEvent[] = [
      { time: "2026-10-01 10:00:00", jail: "zenytt-definitif", kind: "ban", ip: "9.9.9.9" },
      { time: "2026-10-05 10:00:00", jail: "zenytt-definitif", kind: "unban", ip: "9.9.9.9" },
    ];
    expect(unbanKinds(log, { "zenytt-definitif": -1 }).get(1)).toBe("manual");
  });
});

describe("dates du journal", () => {
  const now = new Date(2026, 8, 30, 10, 0, 0); // 30 septembre 2026

  it("jour relatif, puis jour de la semaine", () => {
    expect(dayLabel("2026-09-30 01:02:03", now)).toBe("Aujourd'hui");
    expect(dayLabel("2026-09-29 21:12:10", now)).toBe("Hier");
    expect(dayLabel("2026-09-28 21:12:10", now)).toBe("Lundi 28 septembre");
    expect(dayLabel("2025-12-31 08:00:00", now)).toBe("Mercredi 31 décembre 2025");
    expect(timeOf("2026-09-28 21:12:10")).toBe("21:12:10");
  });

  it("regroupe par jour dans l'ordre", () => {
    const g = groupByDay([{ time: "2026-09-30 09:00:00" }, { time: "2026-09-30 08:00:00" }, { time: "2026-09-29 23:00:00" }], now);
    expect(g.map((x) => [x.day, x.items.length])).toEqual([
      ["Aujourd'hui", 2],
      ["Hier", 1],
    ]);
  });
});

describe("nom du pays", () => {
  it("traduit le code ISO en français", () => {
    expect(countryName("US")).toBe("États-Unis");
    expect(countryName("de")).toBe("Allemagne");
    expect(countryName(null)).toBeNull();
  });
});
