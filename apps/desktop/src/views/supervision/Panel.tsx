// Cadre commun des sections de l'onglet Sécurité : en-tête (titre, état, actions), bandeaux, corps
// en colonnes plates, pied. Le conteneur est la section elle-même : ses colonnes suivent sa largeur.
import type { ReactNode } from "react";
import type { Tone } from "../../components/ui";

/** Résumé d'une section pour le sommaire : compteur et état court. */
export type TocInfo = { count: number | null; sub: string; tone?: Tone };

export function Panel({ title, status, actions, banners, footer, children }: { title: string; status?: ReactNode; actions?: ReactNode; banners?: ReactNode; footer?: ReactNode; children?: ReactNode }) {
  return (
    <section aria-label={title} className="@container min-w-0 rounded-xl border border-border bg-panel">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {status}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      {banners && <div className="flex flex-col gap-3 border-b border-border px-4 py-3 empty:hidden">{banners}</div>}
      {children}
      {footer && <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-4 py-2.5 text-[13px]">{footer}</div>}
    </section>
  );
}

/** Titre d'une colonne du corps. */
export function ColHead({ title, count, description, actions }: { title: ReactNode; count?: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-2 px-4 py-2">
      <h3 className="shrink-0 text-[13px] font-semibold">
        {title}
        {count != null && <span className="ml-1.5 font-normal text-faint">· {count}</span>}
      </h3>
      {description && <span className="min-w-0 truncate text-xs text-muted">{description}</span>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** Corps en deux colonnes séparées d'un filet, empilées quand la section est étroite. */
export const TWO_COLS = "grid min-w-0 divide-y divide-border @min-[900px]:grid-cols-2 @min-[900px]:divide-x @min-[900px]:divide-y-0";
