// Fenêtres, tiroirs, notifications et états (vide, chargement, erreur, résultat).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert, X } from "lucide-react";
import { useApp } from "../../lib/store";
import { Button, Field, IconButton, Input } from "./base";

// Pile des fenêtres ouvertes : Échap ne ferme que celle du dessus (une confirmation ouverte depuis
// un éditeur ne doit pas fermer l'éditeur avec elle).
const escapeStack: { current: () => void }[] = [];
let escapeListening = false;

function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || escapeStack.length === 0) return;
  e.preventDefault();
  escapeStack[escapeStack.length - 1].current();
}

/** Ferme sur Échap, seulement si cette fenêtre est au-dessus des autres. */
function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const entry = { current: () => ref.current() };
    escapeStack.push(entry);
    if (!escapeListening) {
      window.addEventListener("keydown", onEscape);
      escapeListening = true;
    }
    return () => {
      const i = escapeStack.indexOf(entry);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, []);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = "max-w-2xl",
  description,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  description?: ReactNode;
}) {
  useEscape(onClose);
  // Les fenêtres suivent la taille de l'app : sur un grand écran, une modale minuscule perdue au
  // centre ne sert personne ; sur une petite fenêtre, elle ne doit pas déborder.
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[1px] md:p-10" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`animate-pop-in flex max-h-[88vh] w-full ${width} min-w-0 flex-col rounded-xl border border-border-strong/70 bg-panel shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          <IconButton title="Fermer" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-auto p-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Panneau latéral droit : détail d'un élément ou formulaire, sans perdre la liste de vue.
 * `modal` assombrit le reste (formulaire) ; sans lui, la page reste utilisable (détail).
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
  actions,
  tabs,
  width = 480,
  modal = true,
  flush = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  width?: number;
  modal?: boolean;
  /** Contenu sans marge ni défilement propre (il gère lui-même sa zone défilante). */
  flush?: boolean;
}) {
  useEscape(onClose);
  const panel = (
    <aside
      role="dialog"
      aria-modal={modal}
      aria-label={typeof title === "string" ? title : undefined}
      style={{ width }}
      className="animate-drawer-in absolute top-0 right-0 bottom-0 flex max-w-full flex-col border-l border-border-strong/70 bg-panel shadow-[-24px_0_48px_rgba(0,0,0,0.35)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-2.5 border-b border-border px-5 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate text-xs text-muted">{subtitle}</div>}
          </div>
          <IconButton title="Fermer (Échap)" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {tabs}
      <div className={flush ? "flex min-h-0 flex-1 flex-col" : "min-h-0 flex-1 overflow-auto p-5"}>{children}</div>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
    </aside>
  );
  if (!modal) return <div className="pointer-events-none absolute inset-0 z-30 [&>aside]:pointer-events-auto">{panel}</div>;
  return (
    <div className="absolute inset-0 z-30 bg-black/45" onMouseDown={onClose}>
      {panel}
    </div>
  );
}

/** Dialogue global de confirmation / saisie piloté par `useApp().ask`. */
export function DialogHost() {
  const dialog = useApp((s) => s.dialog);
  const close = useApp((s) => s.closeDialog);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setValue(dialog?.input?.initial ?? "");
    setTimeout(() => (dialog?.input ? inputRef.current?.focus() : confirmRef.current?.focus()), 0);
  }, [dialog]);

  if (!dialog) return null;
  const submit = () => close(dialog.input ? value : true);

  return (
    <Modal
      title={dialog.title}
      width="max-w-lg"
      onClose={() => close(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Annuler
          </Button>
          <Button ref={confirmRef} variant={dialog.danger ? "danger" : "primary"} onClick={submit}>
            {dialog.confirmLabel ?? "Confirmer"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {dialog.body && <p className="text-[13px] leading-relaxed text-muted">{dialog.body}</p>}
        {dialog.code && (
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">{dialog.code}</pre>
        )}
        {dialog.input && (
          <Field label={dialog.input.label}>
            <Input ref={inputRef} type={dialog.input.secret ? "password" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
      </form>
    </Modal>
  );
}

const TOAST_ICONS = {
  info: <Info size={16} className="text-accent" />,
  warn: <TriangleAlert size={16} className="text-warn" />,
  error: <CircleAlert size={16} className="text-danger" />,
  success: <CircleCheck size={16} className="text-ok" />,
};

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="animate-pop-in pointer-events-auto flex items-start gap-2.5 rounded-xl border border-border-strong/70 bg-raised py-2.5 pr-2 pl-3 text-[13px] shadow-2xl select-text"
        >
          <span className="mt-px shrink-0">{TOAST_ICONS[t.kind]}</span>
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <IconButton title="Fermer" size="sm" className="-my-1 size-6!" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-48 w-full flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/10 text-accent [&>svg]:size-7">{icon}</div>}
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children && <div className="max-w-md text-[13px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * Squelette de chargement : il prend la forme de ce qui va s'afficher, pour que la page ne saute
 * pas quand les données arrivent. À n'afficher que si l'attente dépasse un instant perceptible
 * (voir `useDelayed`), sinon il ne fait que clignoter.
 */
export function Skeleton({ rows = 3, className = "", height = "h-9" }: { rows?: number; className?: string; height?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`${height} animate-pulse rounded-lg bg-hover`} style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

/** Vrai seulement si la condition dure : évite de faire clignoter un squelette sur 80 ms. */
function useDelayed(active: boolean, delay = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) return setShown(false);
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);
  return shown;
}

/** Indicateur de chargement centré, affiché seulement si l'attente dure. */
export function Loading({ label = "Chargement…", rows }: { label?: string; rows?: number }) {
  const shown = useDelayed(true);
  if (!shown) return null;
  if (rows) return <Skeleton rows={rows} />;
  return (
    <div className="flex h-full min-h-32 items-center justify-center gap-2 text-[13px] text-muted">
      <Loader2 size={16} className="animate-spin" />
      {label}
    </div>
  );
}

/**
 * Erreur qui empêche la vue de fonctionner : elle reste affichée (contrairement à une notification)
 * et porte l'action qui répare, parce qu'un message seul laisse l'utilisateur sans issue.
 */
export function ErrorState({ message, onRetry, retryLabel = "Réessayer", children }: { message: ReactNode; onRetry?: () => void; retryLabel?: string; children?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/35 bg-danger/8 px-3.5 py-3 text-[13px] text-danger">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 break-words select-text">{message}</div>
      {children}
      {onRetry && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export type Tone = "muted" | "ok" | "warn" | "danger" | "accent";

export function Badge({ children, tone = "muted", className = "", title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  const tones: Record<Tone, string> = {
    muted: "bg-hover-strong text-muted",
    ok: "bg-ok/12 text-ok",
    warn: "bg-warn/14 text-warn",
    danger: "bg-danger/14 text-danger",
    accent: "bg-accent/14 text-accent",
  };
  return (
    <span title={title} className={`inline-flex h-[19px] shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

/** Pastille d'état (connecté, en cours, arrêté…). */
export function StatusDot({ tone = "muted", className = "", pulse }: { tone?: Tone; className?: string; pulse?: boolean }) {
  const colors: Record<Tone, string> = { muted: "bg-muted/40", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", accent: "bg-accent" };
  return <span aria-hidden className={`inline-block size-[7px] shrink-0 rounded-full ${colors[tone]} ${pulse ? "animate-pulse" : ""} ${className}`} />;
}

/** Résultat d'une action (sortie d'une commande, test de config) : succès, avertissement ou échec. */
export function ResultBanner({ tone, title, children, action }: { tone: "ok" | "warn" | "danger" | "accent"; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const styles = {
    ok: ["border-ok/35 bg-ok/8", <CircleCheck key="i" size={16} className="text-ok" />],
    warn: ["border-warn/35 bg-warn/8", <TriangleAlert key="i" size={16} className="text-warn" />],
    danger: ["border-danger/35 bg-danger/8", <CircleAlert key="i" size={16} className="text-danger" />],
    accent: ["border-accent/35 bg-accent/8", <Info key="i" size={16} className="text-accent" />],
  } as const;
  const [cls, icon] = styles[tone];
  return (
    <div className={`flex flex-col gap-2 rounded-xl border px-3.5 py-3 text-[13px] ${cls}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-px shrink-0">{icon}</span>
        <div className="min-w-0 flex-1 font-medium">{title}</div>
        {action}
      </div>
      {children && <div className="min-w-0 pl-[26px] text-muted select-text">{children}</div>}
    </div>
  );
}
