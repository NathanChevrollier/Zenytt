// Journaux en direct : conteneurs, services systemd et fichiers fusionnés dans un seul flux.
// La sélection de sources reste modifiable pendant le suivi (le flux se relance tout seul) et
// peut être enregistrée en préréglage, retrouvé ensuite par serveur.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, BookmarkPlus, Download, Pause, Play, ScrollText, Search, Square, Trash2, X } from "lucide-react";
import { api, errorMessage, type LogSource } from "../lib/api";
import { useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { Badge, Button, Checkbox, EmptyState, IconButton, Input, Loading, MenuButton, Segmented, ToolbarSep, type MenuItem } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";

const MAX_LINES = 20_000;
const SHOWN = 5_000;
const MAX_SOURCES = 12;
/** Couleurs des étiquettes de source (texte des lignes toujours en couleur neutre). */
const TAG_COLORS = ["#3987e5", "#d95926", "#1baf7a", "#c98500", "#d55181", "#9085e9", "#e66767", "#39c5cf"];
const ERROR_RE = /\b(error|err|fatal|crit|critical|emerg|alert|panic|exception|failed|échec)\b|\s5\d\d\s/i;
const WARN_RE = /\b(warn|warning|avertissement)\b|\s4\d\d\s/i;

type Level = "all" | "warn" | "error";

interface Line {
  id: number;
  /** Étiquette figée à la réception : elle reste juste même si la sélection change ensuite. */
  tag: string;
  color: string;
  text: string;
  at: number;
  level: 0 | 1 | 2;
  /** Ligne insérée par Zenytt (relance du flux), pas par le serveur. */
  marker?: boolean;
}

interface Preset {
  name: string;
  sources: LogSource[];
}

const same = (a: LogSource, b: LogSource) => a.kind === b.kind && a.name === b.name;
const label = (s: LogSource) => (s.kind === "file" ? s.name.replace("/var/log/", "") : s.kind === "unit" ? s.name.replace(/\.service$/, "") : s.name);
/** Couleur stable par source : une même source garde sa teinte d'une relance à l'autre. */
const colorOf = (s: LogSource) => {
  let h = 0;
  for (const c of s.kind + s.name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
};
const levelOf = (text: string): 0 | 1 | 2 => (ERROR_RE.test(text) ? 2 : WARN_RE.test(text) ? 1 : 0);
const time = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : le réglage vaut pour la session */
  }
}

export default function LogsView() {
  return <ServerGate title="Journaux" guide="logs">{(serverId) => <Logs key={serverId} serverId={serverId} />}</ServerGate>;
}

function Logs({ serverId }: { serverId: string }) {
  const notify = useApp((s) => s.notify);
  const ask = useApp((s) => s.ask);
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const presetKey = `zenytt.logPresets.${serverId}`;

  const [available, setAvailable] = useState<{ containers: string[]; units: string[]; files: string[] } | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<LogSource[]>([]);
  const [presets, setPresets] = useState<Preset[]>(() => readLocal(presetKey, []));
  const [streamId, setStreamId] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [ended, setEnded] = useState<{ tag: string; error: string | null }[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [showTime, setShowTime] = useState(() => readLocal("zenytt.logs.time", true));
  const [wrap, setWrap] = useState(() => readLocal("zenytt.logs.wrap", true));
  /** Colle à la fin tant que l'utilisateur ne remonte pas dans le flux. */
  const [follow, setFollow] = useState(true);

  const buffer = useRef<Line[]>([]);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const seq = useRef(0);
  /** Numéro du flux en cours : les événements d'un flux remplacé sont ignorés. */
  const generation = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const streamRef = useRef<number | null>(null);
  streamRef.current = streamId;
  const running = streamId != null;

  const loadSources = useCallback(() => {
    setSourcesError(null);
    api.logSources(serverId).then(setAvailable, (e) => setSourcesError(errorMessage(e)));
  }, [serverId]);
  useEffect(loadSources, [loadSources]);

  // Les lignes reçues sont regroupées et affichées au plus 5 fois par seconde.
  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current || buffer.current.length === 0) return;
      const incoming = buffer.current;
      buffer.current = [];
      setLines((prev) => {
        const next = prev.concat(incoming);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }, 200);
    return () => clearInterval(id);
  }, []);

  const stop = useCallback(async () => {
    generation.current++;
    const id = streamRef.current;
    streamRef.current = null;
    setStreamId(null);
    if (id != null) await api.logsStop(id).catch(() => {});
  }, []);

  // Arrêt du suivi en quittant la vue : aucune commande ne reste active sur le serveur.
  useEffect(() => () => void (streamRef.current != null && api.logsStop(streamRef.current)), []);

  const start = useCallback(
    async (sources: LogSource[], restart = false) => {
      await stop();
      const gen = ++generation.current;
      setEnded([]);
      setFollow(true);
      if (restart) {
        // Les sources déjà suivies renverraient leurs 200 dernières lignes : on repart d'une liste
        // propre plutôt que de mélanger doublons et nouvelles lignes.
        buffer.current = [];
        setLines([{ id: ++seq.current, tag: "zenytt", color: "", text: `Sources modifiées : ${sources.map(label).join(", ")}`, at: Date.now(), level: 0, marker: true }]);
      } else {
        buffer.current = [];
        setLines([]);
      }
      if (!sources.length) return;
      const meta = sources.map((s) => ({ tag: label(s), color: colorOf(s) }));
      try {
        const id = await api.logsStart(serverId, sources, 200, (e) => {
          if (gen !== generation.current) return;
          if (e.type === "lines") {
            const now = Date.now();
            for (const l of e.lines) {
              const m = meta[l.source] ?? { tag: "?", color: TAG_COLORS[0] };
              buffer.current.push({ id: ++seq.current, tag: m.tag, color: m.color, text: l.text, at: now, level: levelOf(l.text) });
            }
          } else {
            setEnded((x) => [...x, { tag: meta[e.source]?.tag ?? "?", error: e.error }]);
          }
        });
        if (gen !== generation.current) {
          void api.logsStop(id).catch(() => {});
          return;
        }
        streamRef.current = id;
        setStreamId(id);
      } catch (e) {
        notify(errorMessage(e), "error");
      }
    },
    [serverId, stop, notify],
  );

  // Lien « Ouvrir dans Journaux » (journal d'un service, depuis Supervision) : `unit:<nom>` suit ce service.
  const [wanted, setWanted] = useTabIntent<string>("logs", "");
  useEffect(() => {
    if (!wanted.startsWith("unit:")) return;
    const src: LogSource = { kind: "unit", name: wanted.slice(5) };
    setWanted("");
    setChosen([src]);
    void start([src]);
  }, [wanted, setWanted, start]);

  // Sélection modifiée pendant le suivi : relance après une courte pause, le temps de cocher
  // plusieurs cases d'affilée sans relancer le flux à chaque clic.
  const liveRef = useRef(false);
  liveRef.current = running;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!liveRef.current) return;
    if (chosen.length === 0) {
      void stop();
      return;
    }
    if (chosen.length > MAX_SOURCES) return;
    const t = setTimeout(() => void start(chosen, true), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen]);

  const toggle = (src: LogSource) => setChosen((c) => (c.some((x) => same(x, src)) ? c.filter((x) => !same(x, src)) : [...c, src]));

  const savePresets = (next: Preset[]) => {
    setPresets(next);
    writeLocal(presetKey, next);
  };
  const saveCurrentAsPreset = async () => {
    const name = await ask({ title: "Enregistrer la sélection", body: `${chosen.length} source(s) : ${chosen.map(label).join(", ")}`, input: { label: "Nom du préréglage" }, confirmLabel: "Enregistrer" });
    if (typeof name !== "string" || !name.trim()) return;
    savePresets([...presets.filter((p) => p.name !== name.trim()), { name: name.trim(), sources: chosen }]);
    notify(`Préréglage « ${name.trim()} » enregistré.`, "success");
  };
  const applyPreset = (p: Preset) => {
    setChosen(p.sources);
    if (!running) void start(p.sources);
  };

  const matcher = useMemo(() => {
    if (!filter) return null;
    try {
      return new RegExp(filter, "i");
    } catch {
      const f = filter.toLowerCase();
      return { test: (s: string) => s.toLowerCase().includes(f) };
    }
  }, [filter]);

  const counts = useMemo(() => {
    let warn = 0;
    let error = 0;
    for (const l of lines) {
      if (l.level === 2) error++;
      else if (l.level === 1) warn++;
    }
    return { warn, error };
  }, [lines]);

  const visible = useMemo(() => {
    const min = level === "error" ? 2 : level === "warn" ? 1 : 0;
    const out = lines.filter((l) => l.marker || (l.level >= min && (!matcher || matcher.test(l.text))));
    return out.slice(-SHOWN);
  }, [lines, matcher, level]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [visible, follow, wrap, showTime]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  /** Sources correspondant à la recherche ; celles déjà cochées restent visibles. */
  const filtrer = (kind: LogSource["kind"], names: string[]) => {
    const q = sourceQuery.trim().toLowerCase();
    return q ? names.filter((n) => n.toLowerCase().includes(q) || chosen.some((c) => same(c, { kind, name: n }))) : names;
  };

  const exportLogs = async () => {
    const path = await save({ title: "Exporter les journaux", defaultPath: `journaux-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log` });
    if (!path) return;
    const content = visible
      .filter((l) => !l.marker)
      .map((l) => `${new Date(l.at).toISOString()} [${l.tag}] ${l.text}`)
      .join("\n");
    try {
      await api.saveTextFile(path, content);
      notify(`Exporté : ${path}`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const presetMenu = (): MenuItem[] => [
    { heading: "Préréglages" },
    ...(presets.length
      ? presets.map((p) => ({ label: `${p.name} · ${p.sources.length} source${p.sources.length > 1 ? "s" : ""}`, onClick: () => applyPreset(p) }))
      : [{ label: "Aucun préréglage enregistré", disabled: true, onClick: () => {} }]),
    "separator",
    { label: "Enregistrer la sélection…", icon: <BookmarkPlus size={14} />, disabled: chosen.length === 0, onClick: () => void saveCurrentAsPreset() },
    ...(presets.length
      ? [
          { heading: "Supprimer" } as MenuItem,
          ...presets.map((p) => ({ label: p.name, icon: <Trash2 size={14} />, danger: true, onClick: () => savePresets(presets.filter((x) => x !== p)) })),
        ]
      : []),
  ];

  const groups: { title: string; kind: LogSource["kind"]; names: string[] }[] = available
    ? [
        { title: "Conteneurs", kind: "docker", names: available.containers },
        { title: "Services", kind: "unit", names: available.units },
        { title: "Fichiers", kind: "file", names: available.files },
      ]
    : [];
  const tooMany = chosen.length > MAX_SOURCES;

  return (
    <PageLayout
      title="Journaux"
      context={server && <ServerContext server={server} />}
      subtitle="Conteneurs, services et fichiers suivis en direct dans un seul flux."
      guide="logs"
      scroll={false}
      actions={
        running ? (
          <Button variant="danger" icon={<Square size={13} />} onClick={() => void stop()}>
            Arrêter le suivi
          </Button>
        ) : (
          <Button variant="primary" icon={<Play size={13} />} disabled={!chosen.length || tooMany} onClick={() => void start(chosen)}>
            Suivre {chosen.length ? `${chosen.length} source${chosen.length > 1 ? "s" : ""}` : "les sources"}
          </Button>
        )
      }
      status={
        <>
          {running ? (
            <Badge tone={paused ? "warn" : "ok"}>{paused ? "en pause" : "en direct"}</Badge>
          ) : (
            <Badge tone="muted">arrêté</Badge>
          )}
          {ended.map((e, i) => (
            <Badge key={i} tone={e.error ? "danger" : "muted"} title={e.error ?? undefined}>
              {e.tag} : {e.error ? "interrompu" : "terminé"}
            </Badge>
          ))}
        </>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative w-72">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <Input className="pl-8 font-mono text-xs" placeholder="Filtrer (texte ou regex)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <Segmented
            label="Niveau"
            size="sm"
            value={level}
            onChange={setLevel}
            options={[
              { value: "all", label: "Tout" },
              { value: "warn", label: <>Avert. + erreurs {counts.warn + counts.error > 0 && <span className="text-warn tabular-nums">{counts.warn + counts.error}</span>}</> },
              { value: "error", label: <>Erreurs {counts.error > 0 && <span className="text-danger tabular-nums">{counts.error}</span>}</> },
            ]}
          />
          <ToolbarSep />
          <Checkbox className="text-xs" checked={showTime} onChange={(v) => (setShowTime(v), writeLocal("zenytt.logs.time", v))} label="Heure" />
          <Checkbox className="text-xs" checked={wrap} onChange={(v) => (setWrap(v), writeLocal("zenytt.logs.wrap", v))} label="Retour à la ligne" />
          <span className="ml-auto text-xs text-muted tabular-nums">
            {visible.length.toLocaleString("fr-FR")} ligne{visible.length > 1 ? "s" : ""}
            {lines.length > visible.length ? ` sur ${lines.length.toLocaleString("fr-FR")}` : ""}
          </span>
          <IconButton title={paused ? "Reprendre l'affichage" : "Mettre l'affichage en pause"} disabled={!running} active={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </IconButton>
          <IconButton title="Vider l'affichage" disabled={!lines.length} onClick={() => setLines([])}>
            <Trash2 size={14} />
          </IconButton>
          <IconButton title="Exporter les lignes affichées" disabled={!visible.length} onClick={() => void exportLogs()}>
            <Download size={14} />
          </IconButton>
        </div>
      }
    >
      <div className="flex min-h-0 w-full flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
          <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
            <div className="flex items-center gap-1">
              <span className="flex-1 text-xs text-muted">
                Sources <span className={tooMany ? "text-danger" : ""}>{chosen.length}/{MAX_SOURCES}</span>
              </span>
              {chosen.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setChosen([])}>
                  Aucune
                </Button>
              )}
              <MenuButton size="sm" variant="ghost" title="Préréglages de sources" icon={<BookmarkPlus size={14} />} items={presetMenu} align="end" />
            </div>
            {/* Un serveur bien rempli propose des dizaines de services : la recherche évite de
                parcourir toute la liste pour trouver « nginx » ou « postgres ». */}
            <label className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
              <Input size_="sm" className="pr-7 pl-8" placeholder="Chercher une source" value={sourceQuery} onChange={(e) => setSourceQuery(e.target.value)} />
              {sourceQuery && (
                <button className="absolute top-1/2 right-2 -translate-y-1/2 text-muted hover:text-fg" aria-label="Effacer la recherche" onClick={() => setSourceQuery("")}>
                  <X size={13} />
                </button>
              )}
            </label>
            {running && <p className="text-[11px] leading-snug text-faint">Cocher ou décocher relance le suivi.</p>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
            {sourcesError ? (
              <div className="flex flex-col gap-2 text-xs text-danger">
                <p>{sourcesError}</p>
                <Button size="sm" onClick={loadSources}>
                  Réessayer
                </Button>
              </div>
            ) : !available ? (
              <Loading rows={6} />
            ) : (
              <>
                {groups.map((g) => {
                  const names = filtrer(g.kind, g.names);
                  if (!names.length) return null;
                  return (
                    <div key={g.kind}>
                      <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                        {g.title} <span className="font-normal text-faint">{names.length}</span>
                      </div>
                      {names.map((n) => {
                        const src = { kind: g.kind, name: n };
                        const on = chosen.some((c) => same(c, src));
                        return (
                          <div key={n} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover" title={n}>
                            <Checkbox className="min-w-0 flex-1 text-xs [&_span]:truncate" checked={on} onChange={() => toggle(src)} label={label(src)} />
                            {on && <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(src) }} />}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {groups.every((g) => filtrer(g.kind, g.names).length === 0) && (
                  <p className="text-xs text-muted">{sourceQuery ? `Aucune source ne correspond à « ${sourceQuery} ».` : "Aucune source détectée sur ce serveur."}</p>
                )}
              </>
            )}
          </div>
        </aside>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto bg-bg px-3 py-2 font-mono text-xs leading-5 select-text">
            {!running && lines.length === 0 && (
              <div className="h-full font-sans">
                <EmptyState icon={<ScrollText />} title={chosen.length ? "Prêt à suivre" : "Choisis des sources à suivre"}>
                  {chosen.length
                    ? "Lance le suivi depuis l'en-tête : les 200 dernières lignes de chaque source s'affichent, puis les nouvelles en direct."
                    : presets.length
                      ? "Coche des sources à gauche, ou reprends un préréglage enregistré."
                      : "Coche des conteneurs, services ou fichiers dans la colonne de gauche."}
                </EmptyState>
              </div>
            )}
            {running && lines.length === 0 && <p className="py-2 font-sans text-muted">En attente des premières lignes…</p>}
            {visible.map((l) =>
              l.marker ? (
                <div key={l.id} className="my-1 flex items-center gap-2 font-sans text-[11px] text-faint">
                  <span className="h-px flex-1 bg-border" />
                  {l.text}
                  <span className="h-px flex-1 bg-border" />
                </div>
              ) : (
                <div
                  key={l.id}
                  // Les lignes hors écran ne sont ni mises en page ni peintes : des milliers de
                  // lignes défilent sans à-coups.
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 20px" }}
                  className={`flex gap-2 rounded-sm px-1 ${wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"} ${l.level === 2 ? "bg-danger/10" : l.level === 1 ? "bg-warn/8" : ""}`}
                >
                  {showTime && <span className="shrink-0 text-faint tabular-nums">{time(l.at)}</span>}
                  <span className="w-28 shrink-0 truncate font-sans text-[11px] leading-5 font-semibold" style={{ color: l.color }} title={l.tag}>
                    {l.tag}
                  </span>
                  <span className="min-w-0 text-fg/90">{l.text}</span>
                </div>
              ),
            )}
          </div>
          {!follow && lines.length > 0 && (
            <Button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg"
              size="sm"
              variant="primary"
              icon={<ArrowDown size={13} />}
              onClick={() => {
                setFollow(true);
                if (box.current) box.current.scrollTop = box.current.scrollHeight;
              }}
            >
              Reprendre le suivi
            </Button>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
