// Corps d'une fiche d'aide, partagé par la section Aide et la fenêtre du « ? » d'une page.
import { useState } from "react";
import { ArrowUpRight, Check, Copy, TerminalSquare } from "lucide-react";
import type { Guide } from "../lib/guides";
import { api } from "../lib/api";
import { usePanes } from "../lib/panes";
import { useApp } from "../lib/store";
import { navigate } from "../lib/shell";
import { writeClipboard } from "../lib/clipboard";
import { SECTIONS } from "../sections";
import { Button, FOCUS_RING } from "./ui";

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

  return (
    <div className="flex items-start gap-1 rounded-md border border-border bg-bg px-3 py-2">
      <code className="min-w-0 flex-1 py-1 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap select-text">
        {sudo && <span className="text-muted">sudo </span>}
        {command}
      </code>
      <button
        onClick={() => void copy()}
        title="Copier la commande"
        aria-label="Copier la commande"
        className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover-strong hover:text-fg ${FOCUS_RING}`}
      >
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </button>
      <button
        onClick={toTerminal}
        title="Écrire dans le terminal actif (sans l'exécuter)"
        aria-label="Écrire dans le terminal actif"
        className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover-strong hover:text-fg ${FOCUS_RING}`}
      >
        <TerminalSquare size={14} />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

export default function GuideContent({ guide, showOpen = true }: { guide: Guide; showOpen?: boolean }) {
  const section = guide.section ? SECTIONS.find((s) => s.id === guide.section) : undefined;

  return (
    <div className="flex flex-col gap-5">
      {guide.automatic && (
        <p className="rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-[13px] leading-relaxed">{guide.automatic}</p>
      )}

      {guide.how && guide.how.length > 0 && (
        <Section title="Comment ça marche dans Zenytt">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed">
            {guide.how.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </Section>
      )}

      {guide.requirements && guide.requirements.length > 0 && (
        <Section title="Ce qu'il faut sur le serveur">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed">
            {guide.requirements.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Section>
      )}

      {guide.steps && guide.steps.length > 0 && (
        <Section title="Mise en place">
          <div className="flex flex-col gap-2.5">
            {guide.steps.map((s, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <p className="text-[13px] leading-relaxed">{s.text}</p>
                {s.command && <Command command={s.command} sudo={s.sudo} />}
              </div>
            ))}
          </div>
        </Section>
      )}

      {guide.troubleshooting && guide.troubleshooting.length > 0 && (
        <Section title="Quand ça coince">
          <div className="flex flex-col gap-2.5">
            {guide.troubleshooting.map((p) => (
              <div key={p.symptom} className="flex flex-col gap-1.5 rounded-md border border-border bg-bg/60 px-3 py-2.5">
                <p className="text-[13px] font-medium">{p.symptom}</p>
                <p className="text-[13px] leading-relaxed text-muted">{p.answer}</p>
                {p.command && <Command command={p.command} sudo={p.sudo} />}
              </div>
            ))}
          </div>
        </Section>
      )}

      {guide.notes && guide.notes.length > 0 && (
        <Section title="Bon à savoir">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-muted">
            {guide.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Section>
      )}

      {showOpen && section && (
        <div>
          <Button size="sm" icon={<ArrowUpRight size={13} />} onClick={() => navigate(section.id, guide.tab)}>
            Ouvrir {guide.tab === "security" ? "Système › Sécurité" : section.label}
          </Button>
        </div>
      )}
    </div>
  );
}
