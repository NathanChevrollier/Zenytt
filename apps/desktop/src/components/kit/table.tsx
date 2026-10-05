// Tableau commun à toute l'app : en-tête collant, tri dans les deux sens, sélection, actions de
// ligne toujours visibles, menu « ⋯ » identique au clic droit, et rendu fenêtré au-delà de quelques
// centaines de lignes (répertoires ou résultats SQL de plusieurs milliers d'entrées).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal } from "lucide-react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { FOCUS_RING, IconButton } from "./base";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Largeur CSS de la piste de grille (`120px`, `minmax(0,2fr)`…). Défaut : `minmax(0,1fr)`. */
  width?: string;
  render: (row: T) => ReactNode;
  /** Valeur de tri ; absente = colonne non triable. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: "left" | "right";
  className?: string;
}

export type SortState = { key: string; dir: "asc" | "desc" } | null;

const VIRTUAL_FROM = 200;
const OVERSCAN = 12;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  onRowDoubleClick,
  onRowMouseDown,
  isSelected,
  rowActions,
  rowMenu,
  rowClassName,
  empty,
  initialSort = null,
  sort: controlledSort,
  onSortChange,
  rowHeight = 40,
  className = "",
  stickyHeader = true,
  footer,
  groupBy,
  onBackgroundClick,
  actionsWidth,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T, e: React.MouseEvent) => void;
  onRowDoubleClick?: (row: T) => void;
  onRowMouseDown?: (row: T, e: React.MouseEvent) => void;
  isSelected?: (row: T) => boolean;
  /** Actions fréquentes, toujours visibles à droite de la ligne. */
  rowActions?: (row: T) => ReactNode;
  /** Actions complètes : bouton « ⋯ » et clic droit. */
  rowMenu?: (row: T) => MenuItem[];
  rowClassName?: (row: T) => string;
  empty?: ReactNode;
  initialSort?: SortState;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  rowHeight?: number;
  className?: string;
  stickyHeader?: boolean;
  footer?: ReactNode;
  /** Regroupement visuel : titre de groupe pour chaque ligne (les lignes doivent être triées par groupe). */
  groupBy?: { key: (row: T) => string; header: (key: string, rows: T[]) => ReactNode; collapsed?: (key: string) => boolean };
  /** Clic dans la zone vide sous les lignes (désélection). */
  onBackgroundClick?: () => void;
  /** Largeur (px) de la colonne d'actions : fixe, pour que les colonnes restent alignées d'une ligne à l'autre. */
  actionsWidth?: number;
}) {
  const [localSort, setLocalSort] = useState<SortState>(initialSort);
  const sort = controlledSort !== undefined ? controlledSort : localSort;
  const setSort = (s: SortState) => (onSortChange ? onSortChange(s) : setLocalSort(s));
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; align?: "start" | "end" } | null>(null);

  const hasActions = !!rowActions || !!rowMenu;
  const actionsCol = actionsWidth ?? (rowActions ? 120 : 44);
  const template = [...columns.map((c) => c.width ?? "minmax(0,1fr)"), ...(hasActions ? [`${actionsCol}px`] : [])].join(" ");

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const mul = sort.dir === "asc" ? 1 : -1;
    // Groupés : le tri s'applique dans chaque groupe, qui garde sa place (sinon les groupes se
    // mélangent et leurs en-têtes se répètent).
    const groupRank = new Map<string, number>();
    if (groupBy) for (const r of rows) if (!groupRank.has(groupBy.key(r))) groupRank.set(groupBy.key(r), groupRank.size);
    return [...rows].sort((a, b) => {
      if (groupBy) {
        const g = groupRank.get(groupBy.key(a))! - groupRank.get(groupBy.key(b))!;
        if (g) return g;
      }
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * mul;
      return String(x).localeCompare(String(y), "fr", { numeric: true, sensitivity: "base" }) * mul;
    });
  }, [rows, sort, columns, groupBy]);

  // Rendu fenêtré : seules les lignes visibles (plus une marge) sont dans le DOM.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const virtual = !groupBy && sorted.length > VIRTUAL_FROM;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !virtual) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [virtual]);

  const headerOffset = stickyHeader ? 34 : 0;
  let start = 0;
  let end = sorted.length;
  if (virtual) {
    start = Math.max(0, Math.floor((viewport.top - headerOffset) / rowHeight) - OVERSCAN);
    end = Math.min(sorted.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN);
  }

  const openMenu = (e: React.MouseEvent, row: T) => {
    if (!rowMenu) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(row) });
  };

  const renderRow = (row: T) => {
    const selected = isSelected?.(row) ?? false;
    return (
      <div
        key={rowKey(row)}
        role="row"
        aria-selected={isSelected ? selected : undefined}
        onClick={onRowClick ? (e) => onRowClick(row, e) : undefined}
        onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
        onMouseDown={onRowMouseDown ? (e) => onRowMouseDown(row, e) : undefined}
        onContextMenu={rowMenu ? (e) => openMenu(e, row) : undefined}
        style={{ gridTemplateColumns: template, height: rowHeight }}
        className={`grid items-center border-b border-line text-[13px] ${onRowClick ? "cursor-default" : ""} ${
          selected ? "bg-accent/10" : "hover:bg-hover-soft"
        } ${rowClassName?.(row) ?? ""}`}
      >
        {columns.map((c) => (
          <div key={c.key} role="cell" className={`min-w-0 truncate px-3 ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
            {c.render(row)}
          </div>
        ))}
        {hasActions && (
          <div role="cell" className="flex items-center justify-end gap-0.5 pr-2 pl-1" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {rowActions?.(row)}
            {rowMenu && (
              <IconButton
                size="sm"
                title="Plus d'actions"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: r.right, y: r.bottom + 4, items: rowMenu(row), align: "end" });
                }}
              >
                <MoreHorizontal size={16} />
              </IconButton>
            )}
          </div>
        )}
      </div>
    );
  };

  let body: ReactNode;
  if (sorted.length === 0) {
    body = <div className="px-4 py-10 text-center text-[13px] text-muted">{empty ?? "Aucun élément."}</div>;
  } else if (groupBy) {
    const groups: [string, T[]][] = [];
    for (const r of sorted) {
      const k = groupBy.key(r);
      const last = groups[groups.length - 1];
      if (last && last[0] === k) last[1].push(r);
      else groups.push([k, [r]]);
    }
    body = groups.map(([k, list]) => (
      <div key={`g:${k}`} role="rowgroup">
        {groupBy.header(k, list)}
        {!groupBy.collapsed?.(k) && list.map(renderRow)}
      </div>
    ));
  } else if (virtual) {
    body = (
      <>
        <div style={{ height: start * rowHeight }} />
        {sorted.slice(start, end).map(renderRow)}
        <div style={{ height: (sorted.length - end) * rowHeight }} />
      </>
    );
  } else {
    body = sorted.map(renderRow);
  }

  return (
    <div ref={scrollRef} role="table" className={`min-h-0 overflow-auto ${className}`}>
      <div
        role="row"
        style={{ gridTemplateColumns: template }}
        className={`grid h-[34px] items-center border-b border-border bg-subtle text-xs font-medium text-muted ${stickyHeader ? "sticky top-0 z-10" : ""}`}
      >
        {columns.map((c) => {
          const active = sort?.key === c.key;
          const content = (
            <>
              <span className="truncate">{c.header}</span>
              {active && (sort.dir === "asc" ? <ArrowUp size={12} className="shrink-0 text-accent" /> : <ArrowDown size={12} className="shrink-0 text-accent" />)}
            </>
          );
          return (
            <div key={c.key} role="columnheader" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} className={`min-w-0 px-3 ${c.align === "right" ? "text-right" : ""}`}>
              {c.sortValue ? (
                <button
                  type="button"
                  className={`inline-flex max-w-full items-center gap-1 rounded hover:text-fg ${FOCUS_RING} ${active ? "text-fg" : ""} ${c.align === "right" ? "flex-row-reverse" : ""}`}
                  onClick={() => setSort(!active ? { key: c.key, dir: "asc" } : sort.dir === "asc" ? { key: c.key, dir: "desc" } : null)}
                >
                  {content}
                </button>
              ) : (
                <span className="inline-flex max-w-full items-center gap-1">{content}</span>
              )}
            </div>
          );
        })}
        {hasActions && <div />}
      </div>
      {body}
      {onBackgroundClick && <div className="min-h-16" onClick={onBackgroundClick} />}
      {footer}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} align={menu.align} onClose={() => setMenu(null)} />}
    </div>
  );
}

