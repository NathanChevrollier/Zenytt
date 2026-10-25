import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useTheme } from "../lib/theme";

/** Couleurs catégorielles validées (dataviz) sur le fond sombre #0d1117. */
export const SERIES_COLORS = ["#3987e5", "#d95926"];

export interface ChartSeries {
  label: string;
  values: (number | null)[];
}

/**
 * Série temporelle : une seule échelle Y, lignes fines, curseur en croix avec infobulle.
 * `times` en millisecondes.
 */
export default function TimeChart({
  times,
  series,
  format,
  max,
  height = 180,
  threshold,
}: {
  times: number[];
  series: ChartSeries[];
  format: (v: number) => string;
  /** Borne haute fixe (ex. 100 pour un pourcentage) ; auto sinon. */
  max?: number;
  height?: number;
  /** Seuil tracé en pointillés (règle d'alerte, nombre de cœurs…). */
  threshold?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const fmt = useRef(format);
  // Dernières données, pour les réafficher quand le graphique est recréé (changement de thème).
  const timesRef = useRef(times);
  timesRef.current = times;
  const seriesRef = useRef(series);
  seriesRef.current = series;
  fmt.current = format;
  const labels = series.map((s) => s.label).join("|");
  const theme = useTheme((s) => s.theme);

  useEffect(() => {
    const el = host.current!;
    // Couleurs des axes prises dans le thème courant (le graphique est recréé s'il change).
    const css = getComputedStyle(document.documentElement);
    const axis = {
      stroke: css.getPropertyValue("--color-muted").trim() || "#8b949e",
      grid: { stroke: `${css.getPropertyValue("--color-border").trim() || "#262c36"}80`, width: 1 },
      ticks: { show: false },
      font: "11px Inter, 'Segoe UI', sans-serif",
    };
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      legend: { show: false },
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      scales: { x: { time: true }, y: { range: (_u, _min, dataMax) => [0, max ?? Math.max(dataMax * 1.15, 1, (threshold ?? 0) * 1.1)] } },
      axes: [
        {
          ...axis,
          space: 70,
          // Heures françaises ; la date n'apparaît que si la fenêtre dépasse une journée.
          values: (u, splits) => {
            const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0);
            const opts: Intl.DateTimeFormatOptions =
              span > 86400 ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", second: span < 600 ? "2-digit" : undefined };
            return splits.map((t) => new Date(t * 1000).toLocaleString("fr-FR", opts));
          },
        },
        { ...axis, size: 56, values: (_u, vals) => vals.map((v) => fmt.current(v)) },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          stroke: SERIES_COLORS[i],
          width: 2,
          fill: series.length === 1 ? `${SERIES_COLORS[i]}22` : undefined,
          points: { show: false },
          spanGaps: false,
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            if (threshold == null) return;
            const y = Math.round(u.valToPos(threshold, "y", true)) + 0.5;
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = css.getPropertyValue("--color-danger").trim() || "#e5484d";
            ctx.globalAlpha = 0.7;
            ctx.lineWidth = devicePixelRatio;
            ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
            ctx.beginPath();
            ctx.moveTo(u.bbox.left, y);
            ctx.lineTo(u.bbox.left + u.bbox.width, y);
            ctx.stroke();
            ctx.restore();
          },
        ],
        setCursor: [
          (u) => {
            const t = tip.current!;
            const idx = u.cursor.idx;
            if (idx == null || u.cursor.left == null || u.cursor.left < 0) {
              t.style.display = "none";
              return;
            }
            const when = new Date(u.data[0][idx] * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
            // Construit en DOM (textContent), jamais en HTML : aucune donnée ne peut y injecter de balise.
            const el_ = (cls: string, text?: string) => {
              const d = document.createElement(cls.startsWith("span") ? "span" : "div");
              d.className = cls.replace(/^span /, "");
              if (text !== undefined) d.textContent = text;
              return d;
            };
            const head = el_("mb-1 text-muted", when);
            const rows = u.series.slice(1).map((s, i) => {
              const v = u.data[i + 1][idx];
              const row = el_("flex items-center gap-2");
              const dot = el_("span inline-block size-2 rounded-full");
              dot.style.background = SERIES_COLORS[i];
              row.append(dot, el_("span text-muted", String(s.label ?? "")), el_("span ml-auto pl-3 tabular-nums", v == null ? "—" : fmt.current(v)));
              return row;
            });
            t.replaceChildren(head, ...rows);
            t.style.display = "block";
            const left = u.cursor.left + 60;
            t.style.left = `${Math.min(left, el.clientWidth - t.offsetWidth - 4)}px`;
            t.style.top = `${(u.cursor.top ?? 0) + 8}px`;
          },
        ],
      },
    };
    plot.current = new uPlot(opts, [[], ...series.map(() => [])], el);
    plot.current.setData([timesRef.current.map((t) => t / 1000), ...seriesRef.current.map((s) => s.values)] as uPlot.AlignedData);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // Le graphique est recréé si la structure des séries change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, height, max, theme, threshold]);

  useEffect(() => {
    plot.current?.setData([times.map((t) => t / 1000), ...series.map((s) => s.values)] as uPlot.AlignedData);
  }, [times, series]);

  return (
    <div className="relative">
      <div ref={host} />
      <div
        ref={tip}
        className="pointer-events-none absolute z-10 hidden min-w-40 rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs shadow-xl"
      />
    </div>
  );
}
