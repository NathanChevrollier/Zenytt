// Aide intégrée en deux colonnes : sommaire par thème (avec recherche) à gauche, fiche à droite.
// Le « ? » d'une page ouvre, lui, une fenêtre ne contenant que la fiche de cette page (GuideDialog).
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Heart, MessagesSquare, Search, X } from "lucide-react";
import { GUIDES, TOPICS, type Guide } from "../lib/guides";
import { useAppPick } from "../lib/store";
import { navigate } from "../lib/shell";
import { SECTIONS } from "../sections";
import PageLayout from "../components/PageLayout";
import GuideContent from "../components/GuideContent";
import { SPONSORS_URL } from "../lib/links";
import { Badge, Button, FOCUS_RING, Input, Kbd } from "../components/ui";

/** Tout le texte d'une fiche, pour la recherche. */
const texteDe = (g: Guide) =>
  [
    g.title,
    g.summary,
    g.automatic ?? "",
    ...(g.how ?? []),
    ...(g.requirements ?? []),
    ...(g.steps ?? []).map((s) => `${s.text} ${s.command ?? ""}`),
    ...(g.troubleshooting ?? []).map((p) => `${p.symptom} ${p.answer} ${p.command ?? ""}`),
    ...(g.notes ?? []),
  ]
    .join(" ")
    .toLowerCase();

export default function HelpView() {
  const { guide, guideInPage, openHelpPage } = useAppPick("guide", "guideInPage", "openHelpPage");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLDivElement>(null);
  const selected = GUIDES.find((g) => g.id === (guideInPage ? guide : null)) ?? GUIDES[0];

  const resultats = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? GUIDES.filter((g) => texteDe(g).includes(q)) : GUIDES;
  }, [query]);

  // Nouvelle fiche : on repart du haut de l'article.
  useEffect(() => {
    article.current?.scrollTo({ top: 0 });
  }, [selected.id]);

  const section = selected.section ? SECTIONS.find((s) => s.id === selected.section) : undefined;
  const topic = TOPICS.find((t) => t.id === selected.topic);

  return (
    <PageLayout title="Aide" subtitle="Ce que fait chaque fonctionnalité, ce qu'elle demande sur le serveur, et les commandes à coller." scroll={false}>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-panel">
          <div className="border-b border-border p-3">
            <label className="relative block">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
              <Input
                ref={searchRef}
                className="pr-7 pl-8"
                placeholder="tmux, compose, restic, certificat…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && resultats[0]) openHelpPage(resultats[0].id);
                }}
              />
              {query && (
                <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted hover:text-fg" aria-label="Effacer la recherche" onClick={() => setQuery("")}>
                  <X size={13} />
                </button>
              )}
            </label>
          </div>
          <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-2" aria-label="Sommaire de l'aide">
            {TOPICS.map((t) => {
              const fiches = resultats.filter((g) => g.topic === t.id);
              if (!fiches.length) return null;
              return (
                <div key={t.id}>
                  <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{t.label}</div>
                  {fiches.map((g) => {
                    const on = g.id === selected.id;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        aria-current={on ? "page" : undefined}
                        onClick={() => openHelpPage(g.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${FOCUS_RING} ${
                          on ? "bg-accent/12 font-medium text-fg" : "text-fg/85 hover:bg-hover"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{g.title}</span>
                        {g.automatic && <span className="size-1.5 shrink-0 rounded-full bg-ok" title="Installé par Zenytt" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {resultats.length === 0 && <p className="px-2 py-4 text-xs text-muted">Aucune fiche ne correspond à « {query} ».</p>}
          </nav>
          <div className="flex flex-col gap-2 border-t border-border p-3 text-xs text-muted">
            <span>
              <Kbd>F1</Kbd> liste des raccourcis · <Kbd>Ctrl+K</Kbd> palette
            </span>
            <button type="button" className={`flex items-center gap-1.5 rounded hover:text-fg ${FOCUS_RING}`} onClick={() => void openUrl("https://discord.gg/ctEWWqCj9B")}>
              <MessagesSquare size={13} /> Une question ? Le Discord de Zenytt
            </button>
            <button type="button" className={`flex items-center gap-1.5 rounded hover:text-fg ${FOCUS_RING}`} onClick={() => void openUrl(SPONSORS_URL)}>
              <Heart size={13} /> Zenytt te plaît ? Soutiens le projet
            </button>
          </div>
        </aside>

        <div ref={article} className="min-w-0 flex-1 overflow-auto">
          <article className="mx-auto flex max-w-3xl flex-col gap-4 px-8 py-6">
            <header className="flex flex-col gap-2 border-b border-border pb-4">
              <span className="text-xs text-muted">{topic?.label}</span>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight">{selected.title}</h2>
                {selected.automatic && <Badge tone="ok">Installé par Zenytt</Badge>}
              </div>
              <p className="text-[14px] leading-relaxed text-muted">{selected.summary}</p>
              {section && (
                <div>
                  <Button size="sm" icon={<ArrowRight size={13} />} onClick={() => navigate(section.id, selected.tab)}>
                    Ouvrir {selected.tab === "security" ? "Système › Sécurité" : section.label}
                  </Button>
                </div>
              )}
            </header>
            <GuideContent guide={selected} />
          </article>
        </div>
      </div>
    </PageLayout>
  );
}
