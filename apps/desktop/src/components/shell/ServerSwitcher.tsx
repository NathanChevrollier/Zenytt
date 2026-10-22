// Sélecteur de serveur : recherche, dossiers, état de chaque serveur. Ouvert depuis le haut de la
// barre latérale ou par raccourci. Choisir un serveur change le contexte de tout le groupe « Serveur ».
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, Settings2, SquareTerminal } from "lucide-react";
import { useApp } from "../../lib/store";
import { badgesOf, useHealth } from "../../lib/health";
import { fuzzyMatch } from "../../lib/fuzzy";
import { useShell } from "../../lib/shell";
import { display, shortcutOf } from "../../lib/shortcuts";
import { protocolBadge, type ServerView } from "../../lib/api";
import { FOCUS_RING, IconButton, Kbd, StatusDot } from "../ui";

export default function ServerSwitcher({ onClose }: { onClose: () => void }) {
  const servers = useApp((s) => s.servers);
  const activeId = useApp((s) => s.activeServerId);
  const setActive = useApp((s) => s.setActiveServer);
  const setSection = useApp((s) => s.setSection);
  const openTab = useApp((s) => s.openTab);
  const summaries = useHealth((s) => s.summaries);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[aria-haspopup=dialog]")) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  // Ordre : dossiers par ordre alphabétique, « sans dossier » à la fin ; filtré par la recherche.
  const list = useMemo(() => {
    const q = query.trim();
    const matched = servers
      .map((s) => ({ s, score: q ? (fuzzyMatch(`${s.name} ${s.host} ${s.username} ${s.group ?? ""}`, q)?.score ?? -1) + 1 : 1 }))
      .filter((x) => x.score > 0);
    if (q) return matched.sort((a, b) => b.score - a.score).map((x) => x.s);
    return matched
      .map((x) => x.s)
      .sort((a, b) => {
        const ga = a.group || "￿";
        const gb = b.group || "￿";
        return ga.localeCompare(gb, "fr") || a.name.localeCompare(b.name, "fr");
      });
  }, [servers, query]);

  useEffect(() => setIndex(0), [query]);

  const pick = (s: ServerView | undefined) => {
    if (!s) return;
    setActive(s.id);
    onClose();
  };

  const hintOf = (s: ServerView) => {
    const sum = summaries[s.id];
    if (!s.connected) return sum && !sum.connected && sum.error ? { text: "injoignable", tone: "text-danger" } : { text: "hors ligne", tone: "text-faint" };
    const b = badgesOf(sum);
    if (b.alerts) return { text: `${b.alerts} alerte${b.alerts > 1 ? "s" : ""}`, tone: "text-danger" };
    if (b.failed) return { text: `${b.failed} en panne`, tone: "text-warn" };
    return null;
  };

  let lastGroup: string | null | undefined;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Changer de serveur"
      className="animate-pop-in absolute top-full left-0 z-50 mt-1.5 flex max-h-[70vh] w-[320px] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setIndex((i) => Math.min(i + 1, list.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          pick(list[index]);
        }
      }}
    >
      <div className="border-b border-border p-2.5">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-accent/70 bg-bg px-2.5 text-[13px]">
          <Search size={14} className="text-faint" />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Changer de serveur…" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
          <Kbd>{display(shortcutOf("switcher"))}</Kbd>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Serveurs">
        {list.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted">Aucun serveur ne correspond.</p>}
        {list.map((s, i) => {
          const heading = !query && s.group !== lastGroup ? (s.group || "Sans dossier") : null;
          lastGroup = s.group;
          const hint = hintOf(s);
          const active = s.id === activeId;
          return (
            <div key={s.id}>
              {heading && <div className="px-4 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">{heading}</div>}
              <div
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(s)}
                className={`group mx-1.5 flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${i === index ? "bg-hover-strong" : ""} ${active ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""}`}
              >
                <StatusDot tone={s.connected ? "ok" : summaries[s.id]?.error ? "danger" : "muted"} className="size-2!" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-medium">{s.name}</span>
                  <span className="truncate font-mono text-[10.5px] text-muted">
                    {s.username}@{s.host}{protocolBadge(s) ? ` · ${protocolBadge(s)}` : ""}
                  </span>
                </span>
                {hint && <span className={`shrink-0 text-[11px] ${hint.tone}`}>{hint.text}</span>}
                <IconButton
                  size="sm"
                  title={`Terminal sur ${s.name}`}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActive(s.id);
                    openTab(s.id);
                    onClose();
                  }}
                >
                  <SquareTerminal size={14} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-1 border-t border-border p-1.5">
        <button
          type="button"
          onClick={() => {
            setSection("servers");
            onClose();
          }}
          className={`flex h-8 flex-1 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg ${FOCUS_RING}`}
        >
          <Settings2 size={14} /> Gérer les serveurs
        </button>
        <button
          type="button"
          onClick={() => {
            setSection("servers");
            useShell.getState().requestNewServer(true);
            onClose();
          }}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-accent hover:bg-accent/10 ${FOCUS_RING}`}
        >
          <Plus size={14} /> Ajouter
        </button>
      </div>
    </div>
  );
}
