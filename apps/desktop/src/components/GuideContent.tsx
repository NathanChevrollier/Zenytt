// Corps d'une fiche d'aide, partagé par la section Aide et la fenêtre du « ? » d'une page.
import { useState, type ReactNode } from "react";
import { Check, Copy, TerminalSquare } from "lucide-react";
import type { Guide } from "../lib/guides";
import { api } from "../lib/api";
import { usePanes } from "../lib/panes";
import { useApp } from "../lib/store";
import { writeClipboard } from "../lib/clipboard";
import { FOCUS_RING } from "./ui";

/** Une commande : copiable, et insérable dans le terminal actif sans être exécutée. */
function Command({ command, sudo }: { command: string; sudo?: boolean }) {
  const [copied, setCopied] = useState(false);
  const full = sudo ? `sudo ${command}` : command;

  const copy = async () => {
    await writeClipboard(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Écrite sans retour à la ligne : elle attend une relecture avant d'être lancée.
  const toTerminal = () => {
    const panes = usePanes.getState();
    const id = panes.active ? (panes.panes[panes.active]?.termId ?? null) : null;
    if (id == null) return useApp.getState().notify("Ouvre d'abord un terminal sur le serveur concerné.", "info");
    void api.termWrite(id, full);
    useApp.getState().setSection("terminal");
  };

  const btn = `flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover-strong hover:text-fg ${FOCUS_RING}`;
  return (
    <div className="flex items-start gap-0.5 rounded-md border border-border bg-bg py-0.5 pr-0.5 pl-2.5">
      <code className="min-w-0 flex-1 py-1 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap select-text">
        {sudo && <span className="text-muted">sudo </span>}
        {command}
      </code>
      <button onClick={() => void copy()} title="Copier la commande" aria-label="Copier la commande" className={btn}>
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </button>
      <button onClick={toTerminal} title="Écrire dans le terminal actif (sans l'exécuter)" aria-label="Écrire dans le terminal actif" className={btn}>
        <TerminalSquare size={14} />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Deux colonnes dès que la place le permet : ce qu'on lit d'abord (fonctionnement, mise en place)
 * à gauche, ce qu'on consulte (prérequis, pannes, notes, `aside`) à droite.
 */
export default function GuideContent({ guide, aside }: { guide: Guide; aside?: ReactNode }) {
  const side = [
    guide.requirements?.length ? (
      <Section key="req" title="Ce qu'il faut sur le serveur">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-relaxed">
          {guide.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Section>
    ) : null,
    guide.troubleshooting?.length ? (
      <Section key="pb" title="Quand ça coince">
        <div className="flex flex-col divide-y divide-line">
          {guide.troubleshooting.map((p) => (
            <div key={p.symptom} className="flex flex-col gap-1 py-2 first:pt-0">
              <p className="text-[13px] font-medium">{p.symptom}</p>
              <p className="text-[13px] leading-relaxed text-muted">{p.answer}</p>
              {p.command && <Command command={p.command} sudo={p.sudo} />}
            </div>
          ))}
        </div>
      </Section>
    ) : null,
    guide.notes?.length ? (
      <Section key="notes" title="Bon à savoir">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-relaxed text-muted">
          {guide.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Section>
    ) : null,
    aside ?? null,
  ].filter(Boolean);

  return (
    <div className="@container">
      <div className="grid gap-x-8 gap-y-5 @min-[820px]:grid-cols-[minmax(0,1.55fr)_minmax(260px,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {guide.automatic && <p className="border-l-2 border-ok pl-3 text-[13px] leading-relaxed">{guide.automatic}</p>}

          {guide.how && guide.how.length > 0 && (
            <Section title="Comment ça marche dans Zenytt">
              <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-relaxed">
                {guide.how.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </Section>
          )}

          {guide.steps && guide.steps.length > 0 && (
            <Section title="Mise en place">
              <ol className="flex flex-col gap-2.5">
                {guide.steps.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-4 shrink-0 text-right text-[12px] leading-[1.6] text-faint tabular-nums">{i + 1}.</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <p className="text-[13px] leading-relaxed">{s.text}</p>
                      {s.command && <Command command={s.command} sudo={s.sudo} />}
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </div>
        {side.length > 0 && <div className="flex min-w-0 flex-col gap-5 @min-[820px]:border-l @min-[820px]:border-line @min-[820px]:pl-8">{side}</div>}
      </div>
    </div>
  );
}
