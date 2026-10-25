// Suivi et affichage de journaux en direct, partagés par la page Journaux et le tiroir de logs.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, Download, Pause, Play, Search, Trash2 } from "lucide-react";
import { api, errorMessage, type LogSource } from "../lib/api";
import { useApp } from "../lib/store";
import { colorOf, countLevels, exportText, label, levelOf, matcherOf, readLocal, TAG_COLORS, time, visibleLines, writeLocal, type Level, type Line } from "../lib/logs";
import { Button, Checkbox, IconButton, Input, Segmented, ToolbarSep } from "./ui";

const MAX_LINES = 20_000;
const SHOWN = 5_000;

/** Un flux de journaux : lignes reçues regroupées, pause de l'affichage, arrêt en quittant la vue. */
export function useLogStream(serverId: string) {
  const notify = useApp((s) => s.notify);
  const [streamId, setStreamId] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [ended, setEnded] = useState<{ tag: string; error: string | null }[]>([]);
  const [paused, setPaused] = useState(false);
  /** Colle à la fin tant que l'utilisateur ne remonte pas dans le flux. */
  const [follow, setFollow] = useState(true);

  const buffer = useRef<Line[]>([]);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const seq = useRef(0);
  /** Numéro du flux en cours : les événements d'un flux remplacé sont ignorés. */
  const generation = useRef(0);
  const streamRef = useRef<number | null>(null);
  streamRef.current = streamId;

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

  /** `marker` : texte d'un repère qui remplace les lignes précédentes (relance du flux). */
  const start = useCallback(
    async (sources: LogSource[], tail = 200, marker?: string) => {
      await stop();
      const gen = ++generation.current;
      setEnded([]);
      setFollow(true);
      // Les sources déjà suivies renverraient leurs dernières lignes : on repart d'une liste propre
      // plutôt que de mélanger doublons et nouvelles lignes.
      buffer.current = [];
      setLines(marker ? [{ id: ++seq.current, tag: "zenytt", color: "", text: marker, at: Date.now(), level: 0, marker: true }] : []);
      if (!sources.length) return;
      const meta = sources.map((s) => ({ tag: label(s), color: colorOf(s) }));
      try {
        const id = await api.logsStart(serverId, sources, tail, (e) => {
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

  return { running: streamId != null, lines, setLines, ended, paused, setPaused, follow, setFollow, start, stop };
}

/** Réglages d'affichage (filtre, niveau, heure, retour à la ligne) et lignes visibles qui en découlent. */
export function useLogView(lines: Line[]) {
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [showTime, setShowTimeState] = useState(() => readLocal("zenytt.logs.time", true));
  const [wrap, setWrapState] = useState(() => readLocal("zenytt.logs.wrap", true));
  const matcher = useMemo(() => matcherOf(filter), [filter]);
  const counts = useMemo(() => countLevels(lines), [lines]);
  const visible = useMemo(() => visibleLines(lines, matcher, level, SHOWN), [lines, matcher, level]);
  const setShowTime = (v: boolean) => (setShowTimeState(v), writeLocal("zenytt.logs.time", v));
  const setWrap = (v: boolean) => (setWrapState(v), writeLocal("zenytt.logs.wrap", v));
  return { filter, setFilter, level, setLevel, showTime, setShowTime, wrap, setWrap, counts, visible };
}

type Stream = ReturnType<typeof useLogStream>;
type View = ReturnType<typeof useLogView>;

export async function exportLogs(lines: Line[], prefix = "journaux") {
  const { notify } = useApp.getState();
  const path = await save({ title: "Exporter les journaux", defaultPath: `${prefix}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log` });
  if (!path) return;
  try {
    await api.saveTextFile(path, exportText(lines));
    notify(`Exporté : ${path}`, "success");
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Barre d'outils : filtre, niveaux avec compteurs, heure, retour à la ligne, nombre de lignes, pause, vider, exporter. */
export function LogControls({ stream, view, filterClass = "w-72", exportPrefix }: { stream: Stream; view: View; filterClass?: string; exportPrefix?: string }) {
  const { counts, visible } = view;
  return (
    <>
      <label className={`relative ${filterClass}`}>
        <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
        <Input className="pl-8 font-mono text-xs" placeholder="Filtrer (texte ou regex)" value={view.filter} onChange={(e) => view.setFilter(e.target.value)} />
      </label>
      <Segmented
        label="Niveau"
        size="sm"
        value={view.level}
        onChange={view.setLevel}
        options={[
          { value: "all", label: "Tout" },
          { value: "warn", label: <>Avert. + erreurs {counts.warn + counts.error > 0 && <span className="text-warn tabular-nums">{counts.warn + counts.error}</span>}</> },
          { value: "error", label: <>Erreurs {counts.error > 0 && <span className="text-danger tabular-nums">{counts.error}</span>}</> },
        ]}
      />
      <ToolbarSep />
      <Checkbox className="text-xs" checked={view.showTime} onChange={view.setShowTime} label="Heure" />
      <Checkbox className="text-xs" checked={view.wrap} onChange={view.setWrap} label="Retour à la ligne" />
      <span className="ml-auto text-xs text-muted tabular-nums">
        {visible.length.toLocaleString("fr-FR")} ligne{visible.length > 1 ? "s" : ""}
        {stream.lines.length > visible.length ? ` sur ${stream.lines.length.toLocaleString("fr-FR")}` : ""}
      </span>
      <IconButton title={stream.paused ? "Reprendre l'affichage" : "Mettre l'affichage en pause"} disabled={!stream.running} active={stream.paused} onClick={() => stream.setPaused((p) => !p)}>
        {stream.paused ? <Play size={14} /> : <Pause size={14} />}
      </IconButton>
      <IconButton title="Vider l'affichage" disabled={!stream.lines.length} onClick={() => stream.setLines([])}>
        <Trash2 size={14} />
      </IconButton>
      <IconButton title="Exporter les lignes affichées" disabled={!visible.length} onClick={() => void exportLogs(visible, exportPrefix)}>
        <Download size={14} />
      </IconButton>
    </>
  );
}

/** Zone des lignes : défilement collé à la fin, repères de relance, « Reprendre le suivi ». */
export function LogLines({ stream, view, tags = true, children }: { stream: Stream; view: View; tags?: boolean; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const { follow, setFollow } = stream;
  const { visible, wrap, showTime } = view;

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [visible, follow, wrap, showTime]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto bg-bg px-3 py-2 font-mono text-xs leading-5 select-text">
        {children}
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
              {tags && (
                <span className="w-28 shrink-0 truncate font-sans text-[11px] leading-5 font-semibold" style={{ color: l.color }} title={l.tag}>
                  {l.tag}
                </span>
              )}
              <span className="min-w-0 text-fg/90">{l.text}</span>
            </div>
          ),
        )}
      </div>
      {!follow && stream.lines.length > 0 && (
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
  );
}
