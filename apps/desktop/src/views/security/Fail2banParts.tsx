// Pièces de la vue fail2ban : qui est derrière une IP (pays, opérateur, étiquette), sa fiche
// (journal, tentatives), et le bannissement manuel avec une durée au choix.
import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Ban, Globe2, RotateCcw, ShieldCheck, Tag } from "lucide-react";
import { banEnd, banEndText, countryName, dayLabel, groupByDay, recidivists, timeOf, unbanKinds, type Recidivist, type UnbanKind } from "../../lib/fail2ban";
import { api, errorMessage, MANUAL_JAILS, type BanDuration, type F2bEvent, type F2bJail, type GeoInfo, type GeoStatus, type IpLabel } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, Drawer, Field, Input, Loading, Modal, Select, Textarea } from "../../components/ui";

/** Étiquettes (communes à tous les serveurs) et localisation des IP, partagées par la vue. */
interface IpInfoState {
  labels: Record<string, IpLabel>;
  geo: Record<string, GeoInfo>;
  geoStatus: GeoStatus | null;
  loadLabels: () => Promise<void>;
  loadGeo: (ips: string[]) => Promise<void>;
  loadGeoStatus: () => Promise<void>;
}

export const useIpInfo = create<IpInfoState>((set, get) => ({
  labels: {},
  geo: {},
  geoStatus: null,
  loadLabels: async () => set({ labels: Object.fromEntries((await api.ipLabels()).map((l) => [l.ip, l])) }),
  loadGeo: async (ips) => {
    const missing = [...new Set(ips)].filter((ip) => !(ip in get().geo));
    if (!missing.length || !get().geoStatus?.installed) return;
    const found = await api.geoLookup(missing);
    // Les IP introuvables sont mémorisées vides : on ne les redemande pas à chaque rafraîchissement.
    set((s) => ({ geo: { ...s.geo, ...Object.fromEntries(missing.map((ip) => [ip, found[ip] ?? { countryCode: null, country: null, asn: null, org: null }])) } }));
  },
  loadGeoStatus: async () => set({ geoStatus: await api.geoStatus() }),
}));

export const jailLabel = (name: string) => MANUAL_JAILS[name] ?? name;

/** « sshd, jusqu'au 6 oct. 2026, 13:13 » ; « Bannissement manuel · définitif » (sans répéter « définitif »). */
export function banSummary(jail: F2bJail, ip: string): string {
  const end = banEnd(jail, ip);
  const text = banEndText(end);
  return text && end !== null ? `${jailLabel(jail.name)}, ${text}` : jail.name in MANUAL_JAILS || !text ? jailLabel(jail.name) : `${jailLabel(jail.name)}, ${text}`;
}

/** Pays, opérateur et étiquette d'une IP, en ligne. */
export function IpTags({ ip, recidivist }: { ip: string; compact?: boolean; recidivist?: Recidivist }) {
  const label = useIpInfo((s) => s.labels[ip]);
  const g = useIpInfo((s) => s.geo[ip]);
  const country = countryName(g?.countryCode) ?? g?.country;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {recidivist && <RecidivistBadge r={recidivist} />}
      {country && (
        <Badge tone="muted" title={g?.countryCode ?? undefined}>
          {country}
        </Badge>
      )}
      {g?.org && (
        <span className="max-w-56 truncate text-xs text-faint" title={`AS${g.asn ?? "?"} · ${g.org}`}>
          {g.org}
        </span>
      )}
      {label?.label && (
        <Badge tone="accent" title={label.note || undefined}>
          <Tag size={10} className="mr-0.5 inline" />
          {label.label}
        </Badge>
      )}
    </span>
  );
}

/** Adresse déjà bannie qui recommence. */
export function RecidivistBadge({ r }: { r: Recidivist }) {
  const detail = `${r.bans} bannissement(s) dans le journal${r.retriesSinceUnban ? `, ${r.retriesSinceUnban} tentative(s) depuis son dernier déblocage` : ""}${r.lastSeen ? ` · dernière tentative ${r.lastSeen}` : ""}`;
  return (
    <Badge tone="warn" title={detail}>
      <RotateCcw size={10} className="mr-0.5 inline" />
      récidiviste ×{Math.max(r.bans, 1)}
    </Badge>
  );
}

/** Proposition d'activer la localisation (base DB-IP hors ligne). */
export function GeoBanner() {
  const { geoStatus, loadGeoStatus } = useIpInfo();
  const { notify } = useAppPick("notify");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!geoStatus) void loadGeoStatus().catch(() => {});
  }, [geoStatus, loadGeoStatus]);
  const install = async () => {
    setBusy(true);
    try {
      useIpInfo.setState({ geoStatus: await api.geoInstall(), geo: {} });
      notify("Localisation des IP activée : la base est sur ton PC, aucune IP n'est envoyée à l'extérieur.", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  if (!geoStatus) return null;
  if (geoStatus.installed && !geoStatus.stale)
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-faint">
        <Globe2 size={12} /> Localisation hors ligne :{" "}
        <button type="button" className="underline hover:text-fg" onClick={() => void openUrl("https://db-ip.com")}>
          IP Geolocation by DB-IP
        </button>{" "}
        (CC BY 4.0){geoStatus.updatedAt ? `, base du ${new Date(geoStatus.updatedAt * 1000).toLocaleDateString("fr-FR")}` : ""}.
      </p>
    );
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-subtle px-4 py-3 text-[13px]">
      <Globe2 size={16} className="shrink-0 text-accent" />
      <span className="flex-1 text-muted">
        {geoStatus.installed ? "La base de localisation a plus d'un mois : la rafraîchir ?" : "Savoir d'où viennent les tentatives (pays, hébergeur ou opérateur) ?"} Zenytt télécharge une fois la base libre de DB-IP (environ 9 Mo) et la consulte sur ton PC : aucune IP n'est envoyée à un service extérieur.
      </span>
      <Button size="sm" variant="primary" loading={busy} onClick={() => void install()}>
        {geoStatus.installed ? "Rafraîchir" : "Activer"}
      </Button>
    </div>
  );
}

const DURATIONS: { value: BanDuration; label: string }[] = [
  { value: "jail", label: "Durée du jail choisi" },
  { value: "week", label: "7 jours" },
  { value: "month", label: "30 jours" },
  { value: "forever", label: "Définitivement" },
];

/** Bannir une IP à la main (nouvelle IP, ou prolonger celle d'une liste). */
export function BanDialog({ serverId, jails, ip: initialIp, initialDuration = "week", onClose, onDone }: { serverId: string; jails: F2bJail[]; ip?: string; initialDuration?: BanDuration; onClose: () => void; onDone: () => void }) {
  const { notify } = useAppPick("notify");
  const regular = jails.filter((j) => !(j.name in MANUAL_JAILS));
  const [ip, setIp] = useState(initialIp ?? "");
  const [duration, setDuration] = useState<BanDuration>(initialDuration);
  const [jail, setJail] = useState(regular.find((j) => j.name === "sshd")?.name ?? regular[0]?.name ?? "");
  const [label, setLabel] = useState(useIpInfo.getState().labels[initialIp ?? ""]?.label ?? "");
  const [busy, setBusy] = useState(false);
  const valid = /^[0-9a-fA-F:.]+$/.test(ip.trim()) && (duration !== "jail" || !!jail);
  // Bannissements en cours de l'adresse : une durée 7 j / 30 j / définitive les remplace.
  const current = jails.filter((j) => j.banned.includes(ip.trim())).map((j) => banSummary(j, ip.trim()));

  const submit = async () => {
    setBusy(true);
    try {
      await api.f2bBan(serverId, jail, ip.trim(), duration);
      if (label.trim() && label.trim() !== useIpInfo.getState().labels[ip.trim()]?.label) {
        await api.ipLabelSet(ip.trim(), label, useIpInfo.getState().labels[ip.trim()]?.note ?? "");
        await useIpInfo.getState().loadLabels();
      }
      notify(`${ip.trim()} bannie ${duration === "forever" ? "définitivement" : duration === "week" ? "pour 7 jours" : duration === "month" ? "pour 30 jours" : `(jail ${jail})`}`, "success");
      onDone();
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initialIp ? `Bannir ${initialIp}` : "Bannir une adresse IP"}
      width="max-w-lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="danger" icon={<Ban size={13} />} loading={busy} disabled={!valid} onClick={() => void submit()}>
            Bannir
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!initialIp && (
          <Field label="Adresse IP">
            <Input className="font-mono" placeholder="203.0.113.4" value={ip} onChange={(e) => setIp(e.target.value)} autoFocus />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Durée">
            <Select value={duration} onChange={setDuration} options={DURATIONS} />
          </Field>
          {duration === "jail" && (
            <Field label="Jail">
              <Select value={jail} onChange={setJail} options={regular.map((j) => ({ value: j.name, label: j.name }))} />
            </Field>
          )}
        </div>
        {current.length > 0 && (
          <p className="rounded-md border border-border bg-subtle px-3 py-2 text-xs text-muted">
            Actuellement bannie : {current.join(", ")}.{duration !== "jail" && " La nouvelle durée remplace ce bannissement : l'adresse ne restera listée qu'une fois."}
          </p>
        )}
        <Field label="Étiquette (facultatif)" hint="Pour la reconnaître plus tard : « scanner », « bot WordPress »…">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </Field>
        <p className="text-xs leading-relaxed text-faint">
          7 jours, 30 jours et « définitivement » passent par des jails créées par Zenytt (zenytt-7j, zenytt-30j, zenytt-definitif) : l'adresse est bloquée sur tous les ports, et le bannissement survit aux redémarrages. La configuration est testée avant d'être appliquée.
        </p>
      </div>
    </Modal>
  );
}

/** Poser ou modifier l'étiquette d'une IP. */
export function LabelDialog({ ip, onClose }: { ip: string; onClose: () => void }) {
  const { notify } = useAppPick("notify");
  const current = useIpInfo((s) => s.labels[ip]);
  const [label, setLabel] = useState(current?.label ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  const save = async (l: string, n: string) => {
    try {
      await api.ipLabelSet(ip, l, n);
      await useIpInfo.getState().loadLabels();
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };
  return (
    <Modal
      title={`Étiquette de ${ip}`}
      description="Visible sur tous tes serveurs, gardée sur ce PC."
      width="max-w-md"
      onClose={onClose}
      footer={
        <>
          {current && (
            <Button variant="ghost" onClick={() => void save("", "")}>
              Retirer
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" onClick={() => void save(label, note)}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Étiquette">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="scanner, mon bureau, bot…" autoFocus />
        </Field>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  );
}

const KIND_LABEL: Record<F2bEvent["kind"], { label: string; tone: "danger" | "warn" | "ok" | "muted" }> = {
  found: { label: "tentative", tone: "warn" },
  ban: { label: "bannie", tone: "danger" },
  restore: { label: "rebannie (redémarrage)", tone: "danger" },
  unban: { label: "débannie", tone: "muted" },
  ignore: { label: "ignorée (exception)", tone: "muted" },
};

/** Un débannissement n'est mis en avant (vert) que s'il a été fait à la main. */
const UNBAN_LABEL: Record<UnbanKind, { label: string; tone: "ok" | "muted"; title: string }> = {
  manual: { label: "débannie à la main", tone: "ok", title: "Levé avant la fin de la durée du jail : depuis Zenytt ou fail2ban-client" },
  expired: { label: "débannie (fin de durée)", tone: "muted", title: "La durée de bannissement du jail est écoulée" },
  restart: { label: "débannie (redémarrage)", tone: "muted", title: "fail2ban a redémarré : il lève tout puis rebannit aussitôt" },
  unknown: { label: "débannie", tone: "muted", title: "Le bannissement d'origine n'est plus dans le journal" },
};

export function EventKind({ kind, unban }: { kind: F2bEvent["kind"]; unban?: UnbanKind }) {
  if (kind === "unban") {
    const u = UNBAN_LABEL[unban ?? "unknown"];
    return (
      <Badge tone={u.tone} title={u.title}>
        {u.label}
      </Badge>
    );
  }
  const k = KIND_LABEL[kind];
  return <Badge tone={k.tone}>{k.label}</Badge>;
}

/** Fiche d'une IP : qui c'est, ce qu'elle a fait (journal fail2ban, tentatives dans les logs). */
export function IpDrawer({ serverId, ip, jails, onClose, onChanged, onUnban }: { serverId: string; ip: string; jails: F2bJail[]; onClose: () => void; onChanged: () => void; onUnban: (jail: string) => void }) {
  const [events, setEvents] = useState<F2bEvent[] | null>(null);
  const [attempts, setAttempts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banning, setBanning] = useState<BanDuration | null>(null);
  const [labeling, setLabeling] = useState(false);
  const g = useIpInfo((s) => s.geo[ip]);
  const label = useIpInfo((s) => s.labels[ip]);
  const bannedIn = jails.filter((j) => j.banned.includes(ip)).map((j) => j.name);

  const load = useCallback(() => {
    setEvents(null);
    setAttempts(null);
    api.f2bEvents(serverId, ip, 300).then(setEvents, (e) => setError(errorMessage(e)));
    api.f2bAttempts(serverId, ip).then(setAttempts, () => setAttempts([]));
  }, [serverId, ip]);
  useEffect(load, [load]);

  const found = events?.filter((e) => e.kind === "found") ?? [];
  const unbans = unbanKinds(events ?? [], Object.fromEntries(jails.map((j) => [j.name, j.bantime])));
  const bans = events?.filter((e) => e.kind === "ban" || e.kind === "restore") ?? [];

  return (
    <Drawer
      title={<span className="font-mono">{ip}</span>}
      subtitle={bannedIn.length ? `Bannie : ${jails.filter((j) => bannedIn.includes(j.name)).map((j) => banSummary(j, ip)).join(" · ")}` : "Non bannie actuellement"}
      width={560}
      onClose={onClose}
      actions={
        <>
          <Button size="sm" icon={<Tag size={13} />} onClick={() => setLabeling(true)}>
            {label ? "Modifier l'étiquette" : "Étiqueter"}
          </Button>
          <Button size="sm" variant="danger" icon={<Ban size={13} />} onClick={() => setBanning("forever")}>
            Bannir plus longtemps…
          </Button>
          {bannedIn.map((j) => (
            <Button key={j} size="sm" icon={<ShieldCheck size={13} />} onClick={() => onUnban(j)}>
              Débloquer ({jailLabel(j)})
            </Button>
          ))}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-1.5 text-[13px]">
          <h3 className="text-xs font-semibold text-muted">Identité</h3>
          <IpTags ip={ip} recidivist={events ? recidivists(events)[0] : undefined} />
          {!g && <p className="text-xs text-faint">Localisation non disponible (active-la en haut de la page fail2ban).</p>}
          {label?.note && <p className="text-xs whitespace-pre-wrap text-muted">{label.note}</p>}
        </section>
        <section className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Tentatives repérées" value={events ? found.length : "…"} />
          <Stat label="Bannissements" value={events ? bans.length : "…"} />
          <Stat label="Première / dernière tentative" value={found.length ? `${dayLabel(found[0].time)} ${timeOf(found[0].time).slice(0, 5)} → ${dayLabel(found[found.length - 1].time)} ${timeOf(found[found.length - 1].time).slice(0, 5)}` : "—"} small />
        </section>
        {error && <p className="text-xs text-danger">{error}</p>}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted">Journal fail2ban</h3>
          {!events ? (
            <Loading rows={3} />
          ) : events.length === 0 ? (
            <p className="text-xs text-faint">Rien dans le journal de fail2ban (il a peut-être été archivé).</p>
          ) : (
            <div className="max-h-72 overflow-auto rounded-lg border border-border">
              {groupByDay(events.map((e, i) => ({ ...e, unban: unbans.get(i) })).reverse()).map((g) => (
                <section key={g.day}>
                  <h4 className="sticky top-0 z-10 border-b border-border bg-subtle px-3 py-1 text-[11.5px] font-semibold">{g.day}</h4>
                  <ul className="divide-y divide-line">
                    {g.items.map((e, i) => (
                      <li key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                        <span className="w-16 shrink-0 font-mono text-[12px] text-muted tabular-nums" title={e.time}>
                          {timeOf(e.time)}
                        </span>
                        <EventKind kind={e.kind} unban={e.unban} />
                        <span className="ml-auto truncate text-muted">{jailLabel(e.jail)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted">Tentatives dans les journaux du serveur</h3>
          {!attempts ? (
            <Loading rows={3} />
          ) : attempts.length === 0 ? (
            <p className="text-xs text-faint">Aucune ligne trouvée (auth.log, secure, journald SSH, logs nginx).</p>
          ) : (
            <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-term p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap select-text">{attempts.join("\n")}</pre>
          )}
        </section>
      </div>
      {banning && (
        <BanDialog
          serverId={serverId}
          jails={jails}
          ip={ip}
          initialDuration={banning}
          onClose={() => setBanning(null)}
          onDone={() => {
            onChanged();
            load();
          }}
        />
      )}
      {labeling && <LabelDialog ip={ip} onClose={() => setLabeling(false)} />}
    </Drawer>
  );
}

function Stat({ label, value, small }: { label: string; value: React.ReactNode; small?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-subtle px-2 py-2">
      <div className={small ? "font-mono text-[11px]" : "text-lg font-semibold tabular-nums"}>{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}
