import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Ban, FileSearch, Plus, RefreshCw, Settings2, ShieldCheck, ShieldOff, Tag, Trash2, TriangleAlert, UserCheck } from "lucide-react";
import { banDurationText, banEnd, banEndText, bannedAddresses, groupByDay, recidivists, timeOf, unbanKinds } from "../../lib/fail2ban";
import { api, errorMessage, MANUAL_JAILS, type BanDuration, type F2bEvent, type F2bState } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Loading, MenuButton, Segmented, type MenuItem } from "../../components/ui";
import { useCachedState } from "../../lib/cache";
import { BanDialog, EventKind, GeoBanner, IpDrawer, IpTags, jailLabel, LabelDialog, useIpInfo } from "./Fail2banParts";

const Fail2banSettings = lazy(() => import("./Fail2banSettings"));

/** Adresses que Zenytt ajoute toujours à la liste (boucle locale). */
const LOOPBACK = ["127.0.0.1/8", "127.0.0.0/8", "::1"];

type EventFilter = "all" | "ban" | "found";

/** Fin d'un bannissement : date (heure du serveur), ou « définitif ». */
function BanEnd({ until }: { until: string | null | undefined }) {
  const text = banEndText(until);
  if (!text) return null;
  return until === null ? <Badge tone="danger">définitif</Badge> : <span className="shrink-0 text-xs text-muted" title="Heure du serveur">{text}</span>;
}

export default function Fail2ban({ serverId, onCount, onAudit }: { serverId: string; onCount?: (n: number) => void; onAudit?: () => void }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [state, setState] = useCachedState<F2bState | null>(`fail2ban:${serverId}`, null);
  const [events, setEvents] = useState<F2bEvent[] | null>(null);
  const [eventFilter, setEventFilter] = useState<EventFilter>("ban");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [myIp, setMyIp] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [banning, setBanning] = useState<{ ip?: string; duration?: BanDuration } | null>(null);
  const [labeling, setLabeling] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { loadLabels, loadGeo } = useIpInfo();
  const geoInstalled = useIpInfo((s) => !!s.geoStatus?.installed);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api.f2bState(serverId));
      setError(null);
      // Le journal est un plus : son absence (droits, format inconnu) n'empêche pas la gestion.
      setEvents(await api.f2bEvents(serverId, null, 800).catch(() => []));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    void api.myPublicIp().then(setMyIp);
    void loadLabels().catch(() => {});
  }, [load, loadLabels]);

  // Localisation des IP affichées (bannies et journal), dès que la base est là.
  const allIps = useMemo(() => [...new Set([...(state?.jails.flatMap((j) => j.banned) ?? []), ...(events?.map((e) => e.ip) ?? [])])], [state, events]);
  useEffect(() => {
    if (geoInstalled && allIps.length) void loadGeo(allIps).catch(() => {});
  }, [geoInstalled, allIps, loadGeo]);

  // Adresses distinctes : une même IP peut figurer dans plusieurs jails.
  const bannedCount = state ? bannedAddresses(state.jails).size : null;
  useEffect(() => {
    if (bannedCount != null) onCount?.(bannedCount);
  }, [bannedCount, onCount]);

  // Liste commune à tous les jails (Zenytt les garde synchronisées), hors boucle locale.
  const ignored = [...new Set(state?.jails.flatMap((j) => j.ignoreip) ?? [])].filter((a) => !LOOPBACK.includes(a));

  // Adresses déjà bannies qui recommencent : signalées partout, et en tête de page.
  // Celles déjà bannies à la main (7 j, 30 j, définitif) ne peuvent plus recommencer : on ne les
  // propose plus (elles restaient affichées avec leurs boutons « 30 jours » et « Définitivement »).
  const recid = useMemo(() => {
    const manual = new Set(state?.jails.filter((j) => j.name in MANUAL_JAILS).flatMap((j) => j.banned) ?? []);
    return recidivists(events ?? []).filter((r) => !manual.has(r.ip));
  }, [events, state]);
  const recidOf = useMemo(() => new Map(recid.map((r) => [r.ip, r])), [recid]);

  // Les plus insistants : tentatives repérées par IP dans le journal récent.
  const topAttackers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events ?? []) if (e.kind === "found") counts.set(e.ip, (counts.get(e.ip) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [events]);

  const saveIgnore = async (addresses: string[], message: string) => {
    setSaving(true);
    try {
      await api.f2bSetIgnore(serverId, addresses);
      notify(message, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const add = (addr: string) => {
    const a = addr.trim();
    if (!a || ignored.includes(a)) return;
    void saveIgnore([...ignored, a], `${a} ne sera plus jamais bannie`);
    setDraft("");
  };

  const unban = async (jail: string, ip: string) => {
    if (!(await ask({ title: `Débloquer ${ip} ?`, body: `Elle pourra de nouveau se connecter (${jailLabel(jail)}).`, confirmLabel: "Débloquer" }))) return;
    try {
      await api.f2bUnban(serverId, jail, ip);
      notify(`${ip} débloquée`, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const ipMenu = (jail: string, ip: string): MenuItem[] => [
    { label: "Détails et tentatives", icon: <FileSearch size={14} />, onClick: () => setDetail(ip) },
    { label: "Étiqueter…", icon: <Tag size={14} />, onClick: () => setLabeling(ip) },
    "separator",
    { heading: jail in MANUAL_JAILS ? "Changer la durée" : "Bannir plus longtemps" },
    ...(jail !== "zenytt-7j" ? [{ label: "7 jours", icon: <Ban size={14} />, onClick: () => setBanning({ ip, duration: "week" }) }] : []),
    ...(jail !== "zenytt-30j" ? [{ label: "30 jours", icon: <Ban size={14} />, onClick: () => setBanning({ ip, duration: "month" }) }] : []),
    ...(jail !== "zenytt-definitif" ? [{ label: "Définitivement", icon: <Ban size={14} />, danger: true, onClick: () => setBanning({ ip, duration: "forever" }) }] : []),
    "separator",
    { label: "Débloquer", icon: <ShieldCheck size={14} />, onClick: () => void unban(jail, ip) },
  ];

  if (error && !state) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!state) return <Loading label="Lecture de fail2ban…" rows={4} />;
  if (!state.installed || !state.running)
    return (
      <EmptyState
        icon={<ShieldOff />}
        title={state.installed ? "fail2ban est arrêté" : "fail2ban n'est pas installé"}
        action={onAudit && <Button onClick={onAudit}>{state.installed ? "Le démarrer depuis l'audit" : "L'installer depuis l'audit"}</Button>}
      >
        fail2ban bannit les adresses qui multiplient les échecs de connexion.
      </EmptyState>
    );

  const myIpIgnored = !!myIp && ignored.includes(myIp);
  const myIpBanned = !!myIp && state.jails.some((j) => j.banned.includes(myIp));
  // Jails Zenytt vides : inutile de les montrer tant qu'aucune IP n'y a été bannie.
  const jails = state.jails.filter((j) => !(j.name in MANUAL_JAILS) || j.banned.length > 0);
  const unbans = unbanKinds(events ?? [], Object.fromEntries(state.jails.map((j) => [j.name, j.bantime])));
  const shownEvents = (events ?? []).map((e, i) => ({ ...e, unban: unbans.get(i) })).filter((e) => eventFilter === "all" || (eventFilter === "ban" ? e.kind === "ban" || e.kind === "restore" || e.kind === "unban" : e.kind === "found"));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        fail2ban {state.version} · {jails.length} jail(s) actif(s)
        <Button size="sm" className="ml-auto" icon={<Settings2 size={13} />} onClick={() => setSettingsOpen(true)}>
          Réglages…
        </Button>
        <Button size="sm" variant="danger" icon={<Ban size={13} />} onClick={() => setBanning({})}>
          Bannir une IP…
        </Button>
        <IconButton title="Actualiser" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>

      <GeoBanner />

      {recid.length > 0 && (
        <section className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn/8 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warn">
            <TriangleAlert size={16} />
            {recid.length === 1 ? "Une adresse déjà bannie recommence" : `${recid.length} adresses déjà bannies recommencent`}
          </div>
          <p className="text-xs text-muted">Débloquées au bout de la durée du jail, elles reviennent aussitôt. Un bannissement long ou définitif les écarte pour de bon.</p>
          <ul className="flex flex-col gap-1">
            {recid.slice(0, 6).map((r) => (
              <li key={r.ip} className="flex flex-wrap items-center gap-2.5 text-sm">
                <button type="button" className="shrink-0 font-mono hover:text-accent" onClick={() => setDetail(r.ip)}>
                  {r.ip}
                </button>
                <IpTags ip={r.ip} compact recidivist={r} />
                <span className="ml-auto flex shrink-0 gap-1">
                  <Button size="sm" onClick={() => setBanning({ ip: r.ip, duration: "month" })}>
                    30 jours
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setBanning({ ip: r.ip, duration: "forever" })}>
                    Définitivement
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {myIp && !myIpIgnored && (
        <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${myIpBanned ? "border-danger/40 bg-danger/10" : "border-warn/40 bg-warn/10"}`}>
          <UserCheck size={16} className="shrink-0" />
          <span className="flex-1">
            Ton IP actuelle <span className="font-mono">{myIp}</span>
            {myIpBanned ? " est bannie. " : " peut être bannie après quelques échecs de connexion. "}
            L'ajouter aux exceptions évite de te retrouver bloqué dehors (fais-le seulement si c'est ton IP fixe, par exemple celle de ta box).
          </span>
          <Button size="sm" variant="primary" loading={saving} onClick={() => add(myIp)}>
            Ne jamais bannir mon IP
          </Button>
        </div>
      )}

      {jails.map((j) => (
        <section key={j.name} className="rounded-xl border border-border bg-panel">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="font-medium">{jailLabel(j.name)}</span>
            <Badge tone={j.currentlyBanned ? "danger" : "ok"}>{j.currentlyBanned} bannie(s)</Badge>
            <span className="ml-auto text-xs text-muted">
              {j.name in MANUAL_JAILS
                ? `${j.totalBanned} bannissement(s) manuel(s)`
                : `Bannissement de ${banDurationText(j.bantime)} après ${j.maxretry} échec(s) en ${banDurationText(j.findtime)} · ${j.totalBanned} bannissement(s) depuis le démarrage · ${j.currentlyFailed} échec(s) en cours`}
            </span>
          </header>
          {j.banned.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Aucune adresse bannie.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {j.banned.map((ip) => (
                <li key={ip} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <button type="button" className="shrink-0 font-mono hover:text-accent" title="Détails et tentatives" onClick={() => setDetail(ip)}>
                    {ip}
                  </button>
                  {ip === myIp && <Badge tone="danger">ton IP</Badge>}
                  <IpTags ip={ip} compact recidivist={recidOf.get(ip)} />
                  <BanEnd until={banEnd(j, ip)} />
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <Button size="sm" onClick={() => void unban(j.name, ip)}>
                      Débloquer
                    </Button>
                    <MenuButton size="sm" title="Plus d'actions" items={() => ipMenu(j.name, ip)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {topAttackers.length > 0 && (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-4">
          <h2 className="font-medium">Les plus insistants</h2>
          <p className="text-xs text-muted">Tentatives repérées par fail2ban dans son journal récent.</p>
          <ul className="flex flex-col gap-1">
            {topAttackers.map(([ip, n]) => (
              <li key={ip} className="flex items-center gap-3 text-sm">
                <span className="w-12 shrink-0 text-right font-semibold tabular-nums">{n}</span>
                <button type="button" className="shrink-0 font-mono hover:text-accent" onClick={() => setDetail(ip)}>
                  {ip}
                </button>
                <IpTags ip={ip} compact recidivist={recidOf.get(ip)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">Journal</h2>
          <Segmented
            size="sm"
            className="ml-auto"
            label="Événements affichés"
            value={eventFilter}
            onChange={setEventFilter}
            options={[
              { value: "ban", label: "Bannissements" },
              { value: "found", label: "Tentatives" },
              { value: "all", label: "Tout" },
            ]}
          />
        </div>
        {events === null ? (
          <Loading rows={3} />
        ) : shownEvents.length === 0 ? (
          <p className="text-sm text-muted">Rien dans le journal récent de fail2ban.</p>
        ) : (
          <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
            {groupByDay([...shownEvents].reverse().slice(0, 300)).map((g) => (
              <section key={g.day}>
                <h3 className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-subtle px-3 py-1.5 text-xs font-semibold">
                  {g.day}
                  <span className="font-normal text-faint">
                    {g.items.length} événement{g.items.length > 1 ? "s" : ""}
                  </span>
                </h3>
                <ul className="divide-y divide-line">
                  {g.items.map((e, i) => (
                    <li key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-hover-soft">
                      <span className="w-16 shrink-0 font-mono text-[12px] text-muted tabular-nums" title={e.time}>
                        {timeOf(e.time)}
                      </span>
                      <span className="w-40 shrink-0">
                        <EventKind kind={e.kind} unban={e.unban} />
                      </span>
                      <button type="button" className="shrink-0 font-mono text-[12.5px] hover:text-accent" onClick={() => setDetail(e.ip)}>
                        {e.ip}
                      </button>
                      <IpTags ip={e.ip} compact />
                      <span className="ml-auto shrink-0 text-muted">{jailLabel(e.jail)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
        <div>
          <h2 className="font-medium">Adresses jamais bannies</h2>
          <p className="text-sm text-muted">
            Appliquées à tous les jails. Zenytt les écrit dans son propre fichier ({"/etc/fail2ban/jail.d/zz-zenytt-ignore.local"}), teste la configuration puis recharge fail2ban ; tes fichiers ne sont pas modifiés.
          </p>
        </div>
        <ul className="flex flex-wrap gap-2">
          {LOOPBACK.filter((a) => state.jails.some((j) => j.ignoreip.includes(a))).map((a) => (
            <li key={a} className="rounded-full border border-border px-3 py-1 font-mono text-xs text-muted">
              {a}
            </li>
          ))}
          {ignored.map((a) => (
            <li key={a} className="flex items-center gap-1 rounded-full border border-accent/40 py-1 pr-1 pl-3 font-mono text-xs">
              {a}
              {a === myIp && <span className="font-sans text-[10px] text-accent">(toi)</span>}
              <button
                className="rounded-full p-0.5 text-muted hover:text-danger"
                title="Retirer"
                onClick={async () => {
                  if (await ask({ title: `Retirer ${a} des exceptions ?`, body: "Elle pourra de nouveau être bannie.", confirmLabel: "Retirer", danger: true }))
                    void saveIgnore(
                      ignored.filter((x) => x !== a),
                      `${a} retirée des exceptions`,
                    );
                }}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add(draft);
          }}
        >
          <Input className="!w-72 font-mono" placeholder="IP ou réseau (ex. 203.0.113.4 ou 10.0.0.0/8)" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button size="sm" icon={<Plus size={13} />} type="submit" loading={saving} disabled={!draft.trim()}>
            Ajouter
          </Button>
        </form>
      </section>

      {detail && (
        <IpDrawer
          serverId={serverId}
          ip={detail}
          jails={state.jails}
          onClose={() => setDetail(null)}
          onChanged={() => void load()}
          onUnban={(jail) => void unban(jail, detail)}
        />
      )}
      {banning && <BanDialog serverId={serverId} jails={state.jails} ip={banning.ip} initialDuration={banning.duration} onClose={() => setBanning(null)} onDone={() => void load()} />}
      {labeling && <LabelDialog ip={labeling} onClose={() => setLabeling(null)} />}
      {settingsOpen && (
        <Suspense fallback={null}>
          <Fail2banSettings serverId={serverId} jails={state.jails} onClose={() => setSettingsOpen(false)} onSaved={() => void load()} />
        </Suspense>
      )}
    </div>
  );
}
