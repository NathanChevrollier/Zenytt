// Recherche inversée dans l'historique du shell distant (Ctrl+R).
//
// Zenytt lit les fichiers d'historique que le shell tient déjà : rien n'est installé sur le serveur.
// La recherche est approximative (« dcps » trouve « docker compose ps »), les commandes habituelles
// remontent, et la durée d'exécution s'affiche quand le shell l'a enregistrée — zsh en mode
// EXTENDED_HISTORY le fait, bash jamais. Zenytt ne l'invente pas dans les autres cas.
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, History, Repeat } from "lucide-react";
import { api, errorMessage, formatAgo, formatDuration, type ShellHistoryEntry } from "../lib/api";
import { rankCommands } from "../lib/fuzzy";
import { Input, Modal } from "./ui";

/** Commande avec les lettres trouvées mises en évidence. */
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const marked = new Set(positions);
  return (
    <>
      {[...text].map((c, i) => (
        <span key={i} className={marked.has(i) ? "text-accent" : undefined}>
          {c}
        </span>
      ))}
    </>
  );
}

export default function HistoryPalette({
  serverId,
  onClose,
  onPick,
}: {
  serverId: string;
  onClose: () => void;
  /** Commande choisie : envoyée telle quelle au terminal, ou seulement écrite sans être lancée. */
  onPick: (command: string, run: boolean) => void;
}) {
  return (
    <Modal title="Historique du shell" width="max-w-3xl" onClose={onClose}>
      <HistoryList serverId={serverId} onPick={onPick} autoFocus />
    </Modal>
  );
}

/** Liste de l'historique avec sa recherche : dans la fenêtre Ctrl+R ou dans le dock du terminal. */
export function HistoryList({ serverId, onPick, autoFocus, compact }: { serverId: string; onPick: (command: string, run: boolean) => void; autoFocus?: boolean; compact?: boolean }) {
  const [entries, setEntries] = useState<ShellHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.termHistory(serverId).then(
      (l) => !cancelled && setEntries(l),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const results = useMemo(() => rankCommands(entries ?? [], query).slice(0, 200), [entries, query]);
  // Une nouvelle recherche repart du premier résultat.
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, results]);

  const choose = (run: boolean) => {
    const pick = results[cursor];
    if (pick) onPick(pick.item.command, run);
  };

  return (
    <div
      className={compact ? "flex h-full min-h-0 flex-col" : ""}
      onKeyDown={(e) => {
          if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, results.length - 1));
          } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            // Maj+Entrée écrit la commande sans la lancer : de quoi la relire ou la corriger.
            choose(!e.shiftKey);
          } else if (e.key === "Tab") {
            e.preventDefault();
            choose(false);
          }
        }}
      >
        <Input
          className="font-mono"
          placeholder="Chercher une commande… (dcps trouve docker compose ps)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus={autoFocus}
        />
        <p className="mt-1.5 text-[11px] text-faint">
          {compact ? "Entrée : lancer · Maj+Entrée : écrire sans lancer" : "↑ ↓ pour choisir · Entrée pour lancer · Maj+Entrée ou Tab pour écrire sans lancer"}
        </p>

        {error && <pre className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}
        {entries === null && !error && <p className="mt-3 text-sm text-muted">Lecture de l'historique…</p>}
        {entries !== null && entries.length === 0 && (
          <p className="mt-3 text-sm text-muted">
            Aucun historique lisible sur ce serveur. Zenytt lit <span className="font-mono">~/.bash_history</span>,{" "}
            <span className="font-mono">~/.zsh_history</span> et l'historique de fish ; le shell ne les écrit parfois qu'à la déconnexion.
          </p>
        )}

        <div ref={listRef} className={`mt-2 overflow-auto ${compact ? "min-h-0 flex-1" : "max-h-[55vh]"}`}>
          {results.map((r, i) => (
            <button
              key={r.item.command}
              data-selected={i === cursor}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${i === cursor ? "bg-accent/15" : "hover:bg-hover"}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(r.item.command, true)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                <Highlighted text={r.item.command} positions={r.positions} />
              </span>
              {r.item.count > 1 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted" title={`${r.item.count} fois dans l'historique`}>
                  <Repeat size={9} />
                  {r.item.count}
                </span>
              )}
              {/* Seul zsh en mode étendu enregistre la durée : elle n'apparaît donc pas partout. */}
              {r.item.duration != null && (
                <span className="shrink-0 text-[10px] text-warn" title="Durée de la dernière exécution">
                  {formatDuration(r.item.duration)}
                </span>
              )}
              <span className={`shrink-0 text-right text-[10px] text-muted ${compact ? "w-14" : "w-24"}`}>{r.item.last ? formatAgo(Date.now() - r.item.last * 1000) : ""}</span>
              {i === cursor && <CornerDownLeft size={11} className="shrink-0 text-accent" />}
            </button>
          ))}
          {entries !== null && entries.length > 0 && results.length === 0 && (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted">
              <History size={13} /> Aucune commande ne correspond.
            </p>
          )}
        </div>
    </div>
  );
}
