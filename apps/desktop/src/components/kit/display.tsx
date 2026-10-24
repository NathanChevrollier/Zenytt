// Mise en page et affichage de données : cartes, tuiles de chiffres, jauges, paires clé/valeur,
// blocs de code, sélecteur de couleur et poignée de redimensionnement.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { writeClipboard } from "../../lib/clipboard";
import { FOCUS_RING, IconButton } from "./base";
import type { Tone } from "./feedback";

export function Card({ children, className = "", padded = true, tone }: { children: ReactNode; className?: string; padded?: boolean; tone?: "danger" | "warn" | "accent" }) {
  const border = tone === "danger" ? "border-danger/40" : tone === "warn" ? "border-warn/40" : tone === "accent" ? "border-accent/40" : "border-border";
  return <div className={`rounded-xl border bg-panel ${border} ${padded ? "p-4" : ""} ${className}`}>{children}</div>;
}

/** Bloc titré d'une page : un titre, des actions à droite, puis le contenu. */
export function Section({ title, count, actions, children, className = "", description }: { title: ReactNode; count?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; description?: ReactNode }) {
  return (
    <section className={`flex min-w-0 flex-col gap-3 ${className}`}>
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="text-sm font-semibold">
          {title}
          {count != null && <span className="ml-1.5 font-normal text-faint">· {count}</span>}
        </h2>
        {description && <span className="truncate text-xs text-muted">{description}</span>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Petite étiquette en capitales pour les groupes (barre latérale, colonnes). */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase ${className}`}>{children}</div>;
}

export function KeyValue({ items, labelWidth = 130 }: { items: [ReactNode, ReactNode][]; labelWidth?: number }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-[13px]" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words select-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Seuils uniques de toute l'app : 80 % demande de l'attention, 90 % est critique. */
export const WARN_AT = 80;
export const CRIT_AT = 90;

export function meterTone(pct: number): Tone {
  return pct >= CRIT_AT ? "danger" : pct >= WARN_AT ? "warn" : "accent";
}

const FILL: Record<Tone, string> = { accent: "bg-accent", warn: "bg-warn", danger: "bg-danger", ok: "bg-ok", muted: "bg-muted/50" };
const TEXT: Record<Tone, string> = { accent: "text-fg", warn: "text-warn", danger: "text-danger", ok: "text-ok", muted: "text-muted" };

/** Jauge horizontale. La couleur suit les seuils, sauf si `tone` est imposé. */
export function Meter({ value, tone, className = "", height = 4 }: { value: number; tone?: Tone; className?: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const t = tone ?? meterTone(pct);
  return (
    <div className={`overflow-hidden rounded-full bg-hover-strong ${className}`} style={{ height }} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-[width] duration-500 ${FILL[t]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Jauge avec libellé et pourcentage, pour les cartes de santé. */
export function LabeledMeter({ label, value, detail }: { label: ReactNode; value: number | null; detail?: ReactNode }) {
  const t = value == null ? "muted" : meterTone(value);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="truncate text-muted">{label}</span>
        <span className={`tabular-nums ${value != null && value >= WARN_AT ? TEXT[t] : "text-fg"}`}>{value == null ? "—" : `${Math.round(value)} %`}</span>
      </div>
      <Meter value={value ?? 0} tone={value == null ? "muted" : undefined} />
      {detail && <div className="truncate text-[11px] text-faint">{detail}</div>}
    </div>
  );
}

/**
 * Mini-courbe sans axes : une tendance, pas une mesure. Avec `max`, l'échelle va de 0 à `max`
 * (pourcentages) ; sans, elle suit l'écart des valeurs et une série constante reste au milieu.
 */
function Sparkline({ values, tone = "accent", width = 84, height = 28, max }: { values: number[]; tone?: Tone; width?: number; height?: number; max?: number }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const lo = max != null ? 0 : Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo;
  const y = (v: number) => (span > 0 ? height - 2 - ((Math.min(hi, Math.max(lo, v)) - lo) / span) * (height - 4) : height / 2);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const stroke: Record<Tone, string> = { accent: "var(--color-accent)", ok: "var(--color-ok)", warn: "var(--color-warn)", danger: "var(--color-danger)", muted: "var(--color-muted)" };
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
      <polyline points={pts} fill="none" stroke={stroke[tone]} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Tuile de chiffre clé : libellé, valeur, précision, et éventuellement une tendance. */
export function StatTile({
  label,
  value,
  hint,
  tone,
  trend,
  trendMax,
  onClick,
  flag,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  trend?: number[];
  /** Haut de l'échelle de la tendance (100 pour un pourcentage) ; sinon, échelle relative. */
  trendMax?: number;
  onClick?: () => void;
  flag?: ReactNode;
}) {
  const dot: Record<Tone, string> = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", muted: "bg-muted/40" };
  const border = tone === "danger" && flag ? "border-danger/40" : "border-border";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`@container flex min-w-0 flex-col gap-1.5 rounded-xl border bg-panel px-4 py-3 text-left ${border} ${onClick ? `transition-colors hover:border-border-strong ${FOCUS_RING}` : ""}`}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">{label}</span>
        {flag ? <span className={`text-[11px] font-semibold ${tone === "danger" ? "text-danger" : "text-warn"}`}>{flag}</span> : tone && <span className={`size-[7px] rounded-full ${dot[tone]}`} />}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="truncate text-2xl leading-tight font-semibold tracking-tight tabular-nums">{value}</span>
        {/* Tuile étroite (six par rangée) : la valeur passe avant la tendance. */}
        {trend && (
          <span className="hidden @min-[13rem]:block">
            <Sparkline values={trend} tone={tone ?? "accent"} max={trendMax} />
          </span>
        )}
      </div>
      {hint && <div className="truncate text-[11.5px] text-faint">{hint}</div>}
    </Tag>
  );
}

/** Bloc de commande copiable ; `actions` ajoute par exemple « Écrire dans le terminal ». */
export function CodeBlock({ code, actions, className = "" }: { code: string; actions?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`flex items-start gap-2 rounded-lg border border-border bg-term py-2 pr-2 pl-3 ${className}`}>
      <pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs leading-relaxed whitespace-pre-wrap select-text">{code}</pre>
      <IconButton
        size="sm"
        title={copied ? "Copié" : "Copier"}
        onClick={() => {
          void writeClipboard(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </IconButton>
      {actions}
    </div>
  );
}

export const PROFILE_COLORS = ["#8ab4ff", "#3dd6b5", "#f5a524", "#ff6b6b", "#c792ea", "#9aa0aa"];

export function ColorPicker({ value, onChange, colors = PROFILE_COLORS }: { value: string | null | undefined; onChange: (c: string) => void; colors?: string[] }) {
  return (
    <div role="radiogroup" aria-label="Couleur" className="flex flex-wrap gap-2">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={`size-7 rounded-full transition-transform hover:scale-110 ${FOCUS_RING} ${value === c ? "ring-2 ring-fg ring-offset-2 ring-offset-panel" : ""}`}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

/** « prod-01 » → « P1 », « web-02 » → « W2 », « staging » → « ST », « Mon VPS » → « MV ». */
function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const last = words[words.length - 1];
  const second = /^\d+$/.test(last) ? String(Number(last)).slice(-1) : last[0];
  return (words[0][0] + second).toUpperCase();
}

/** Pastille de profil (initiales sur la couleur du serveur). */
export function Avatar({ name, color, size = 32 }: { name: string; color?: string | null; size?: number }) {
  const c = color || "#8ab4ff";
  const initials = initialsOf(name);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[28%] font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c }}
    >
      {initials}
    </span>
  );
}

/**
 * Largeur d'un panneau redimensionnable, retenue d'une session à l'autre.
 * `side` : de quel côté du panneau se trouve la poignée.
 */
export function useResizable(key: string, initial: number, min: number, max: number, side: "left" | "right" = "left") {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(`zenytt.size.${key}`));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    try {
      localStorage.setItem(`zenytt.size.${key}`, String(size));
    } catch {
      /* stockage indisponible : la largeur ne sera pas retenue */
    }
  }, [key, size]);
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const start = e.clientX;
      const from = sizeRef.current;
      const move = (ev: MouseEvent) => {
        const delta = side === "left" ? start - ev.clientX : ev.clientX - start;
        setSize(Math.max(min, Math.min(max, from + delta)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [min, max, side],
  );
  return { size, setSize, handle: { onMouseDown, onDoubleClick: () => setSize(initial) } };
}

/** Poignée verticale entre deux colonnes. Double-clic : largeur par défaut. */
export function ResizeHandle(props: { onMouseDown: (e: React.MouseEvent) => void; onDoubleClick: () => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Glisser pour redimensionner · double-clic pour revenir à la largeur par défaut"
      {...props}
      className="group relative z-10 w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30"
    >
      <span className="absolute top-1/2 left-1/2 h-8 w-0.5 -translate-1/2 rounded bg-border-strong group-hover:bg-accent" />
    </div>
  );
}
