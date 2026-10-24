import { useEffect, useRef, useState } from "react";
import { Loader2, MessageSquarePlus, Play, SendHorizontal, Settings, Sparkles, SquareTerminal, TriangleAlert, Wrench, X } from "lucide-react";
import { answerProposal, ask, useAssistant, type Entry } from "../lib/assistant";
import { navigate } from "../lib/shell";
import { Badge, Button, CodeBlock, IconButton, ResultBanner, Textarea } from "./ui";

/** Noms d'outils tels qu'ils s'affichent dans la discussion. */
const TOOL_LABELS: Record<string, string> = {
  list_servers: "liste des serveurs",
  server_status: "état du serveur",
  list_containers: "conteneurs Docker",
  container_logs: "journaux du conteneur",
  service_logs: "journal du service",
  list_sites: "sites web",
  list_processes: "processus",
  read_file: "lecture d'un fichier",
  security_audit: "audit de sécurité",
  run_command: "commande",
};

/**
 * Rendu léger de la réponse : blocs de code (```) en police mono, listes et paragraphes.
 * Pas de bibliothèque Markdown : l'assistant répond en texte simple et en commandes.
 */
function Rendered({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed whitespace-pre-wrap select-text">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <CodeBlock key={i} className="whitespace-pre" code={part.replace(/^[a-z]*\n/, "").replace(/\n$/, "")} />
        ) : (
          part.trim() && <p key={i}>{part.trim()}</p>
        ),
      )}
    </div>
  );
}

function ToolLine({ entry }: { entry: Extract<Entry, { kind: "tool" }> }) {
  const { name, detail, ok, summary } = entry.run;
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 text-xs text-muted">
      {ok === undefined ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" /> : <Wrench size={13} className={`mt-0.5 shrink-0 ${ok ? "text-ok" : "text-danger"}`} />}
      <span className="min-w-0">
        <span className="text-fg">{TOOL_LABELS[name] ?? name}</span>
        {detail && <span> · {detail}</span>}
        {summary && <span className="block truncate font-mono text-[11px] opacity-80">{summary}</span>}
      </span>
    </div>
  );
}

/** Commande qui en enchaîne plusieurs ou en imbrique une autre : sa fin peut cacher autre chose. */
const CHAINED = /[;|\n\r`]|&&|\$\(/;

function ProposalCard({ entry }: { entry: Extract<Entry, { kind: "proposal" }> }) {
  const { callId, server, command, why, dangerous, answer } = entry.proposal;
  const chained = CHAINED.test(command);
  return (
    <div className={`rounded-lg border p-3 ${dangerous ? "border-danger/50 bg-danger/5" : "border-accent/40 bg-accent/5"}`}>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <SquareTerminal size={13} className={dangerous ? "text-danger" : "text-accent"} />
        <span className="font-medium">Commande sur {server}</span>
        {dangerous && (
          <Badge tone="danger">
            <TriangleAlert size={10} className="mr-1" /> sensible
          </Badge>
        )}
        {chained && (
          <Badge tone="warn" title="Plusieurs commandes enchaînées ou imbriquées : relis-la jusqu'au bout">
            <TriangleAlert size={10} className="mr-1" /> enchaînée
          </Badge>
        )}
      </div>
      {why && <p className="mb-2 text-xs text-muted">{why}</p>}
      {/* Retour à la ligne forcé : des espaces ajoutés ne doivent pas repousser la fin hors de vue. */}
      <pre className="mb-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg p-2 font-mono text-xs select-text">{command}</pre>
      {answer ? (
        <p className="text-xs text-muted">{answer === "accepted" ? "Exécutée." : "Refusée."}</p>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant={dangerous ? "danger" : "primary"} icon={<Play size={12} />} onClick={() => void answerProposal(callId, true)}>
            Exécuter
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void answerProposal(callId, false)}>
            Refuser
          </Button>
        </div>
      )}
    </div>
  );
}

/** Panneau de discussion avec l'assistant, ouvrable depuis n'importe quelle page. */
export default function AssistantPanel() {
  const { entries, running, config, setOpen, reset } = useAssistant();
  const openSettings = () => navigate("settings", "ai");
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [entries, running]);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const send = () => {
    const question = text.trim();
    if (!question || running) return;
    setText("");
    void ask(question);
  };

  const configured = config && (config.hasKey || config.provider === "openai");

  return (
    <aside className="relative z-30 flex w-[420px] shrink-0 flex-col border-l border-border bg-panel max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:max-w-[calc(100%-3rem)] max-xl:shadow-2xl xl:max-w-[34vw]">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles size={15} className="text-accent" />
        <span className="text-sm font-medium">Assistant</span>
        {config && <span className="truncate text-[11px] text-muted">{config.model}</span>}
        <span className="ml-auto flex">
          <IconButton title="Nouvelle discussion" disabled={!entries.length || running} onClick={() => void reset()}>
            <MessageSquarePlus size={15} />
          </IconButton>
          <IconButton title="Réglages de l'assistant" onClick={openSettings}>
            <Settings size={15} />
          </IconButton>
          <IconButton title="Fermer le panneau" onClick={() => setOpen(false)}>
            <X size={15} />
          </IconButton>
        </span>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {!configured && (
          <ResultBanner
            tone="warn"
            title="L'assistant n'est pas configuré"
            action={
              <Button size="sm" onClick={openSettings}>
                Configurer
              </Button>
            }
          >
            <span className="text-xs text-muted">Choisis un fournisseur, un modèle et une clé dans Réglages › Assistant IA.</span>
          </ResultBanner>
        )}
        {entries.length === 0 && configured && (
          <div className="text-sm text-muted">
            <p className="mb-2">Pose ta question sur tes serveurs. Par exemple :</p>
            <ul className="flex flex-col gap-1 text-xs">
              {["pourquoi mon site ne répond plus ?", "quel conteneur consomme toute la mémoire ?", "explique cette erreur nginx", "comment renouveler mon certificat ?"].map((q) => (
                <li key={q}>
                  <button className="rounded-md border border-border px-2 py-1 text-left hover:border-accent/60 hover:text-fg" onClick={() => void ask(q)}>
                    {q}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs">
              Il ne voit que les serveurs autorisés dans Réglages › Accès IA.{" "}
              {config?.execMode === "off"
                ? "Il n'exécute aucune commande : il explique, tu tapes."
                : config?.execMode === "auto"
                  ? "Il exécute lui-même les commandes courantes ; les commandes sensibles demandent ton accord."
                  : "Il te demande ton accord avant chaque commande."}
            </p>
          </div>
        )}
        {entries.map((e, i) =>
          e.kind === "user" ? (
            <div key={i} className="ml-6 rounded-lg bg-hover px-3 py-2 text-sm whitespace-pre-wrap select-text">
              {e.text}
            </div>
          ) : e.kind === "assistant" ? (
            <Rendered key={i} text={e.text} />
          ) : e.kind === "tool" ? (
            <ToolLine key={i} entry={e} />
          ) : e.kind === "proposal" ? (
            <ProposalCard key={i} entry={e} />
          ) : (
            <p key={i} className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger select-text">
              {e.text}
            </p>
          ),
        )}
        {running && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" /> l'assistant travaille…
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="border-t border-border p-2">
        <Textarea
          ref={input}
          className="h-20 min-h-0 resize-none"
          placeholder="Ta question… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"
          value={text}
          disabled={!configured}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-1 flex items-center gap-2">
          <button type="button" className="text-[11px] text-muted hover:text-fg" title="Changer le mode d'exécution" onClick={openSettings}>
            {config?.execMode === "auto" ? "exécution autonome activée" : config?.execMode === "off" ? "lecture seule" : "commandes soumises à validation"}
          </button>
          <Button size="sm" variant="primary" className="ml-auto" icon={<SendHorizontal size={13} />} loading={running} disabled={!text.trim() || !configured} onClick={send}>
            Envoyer
          </Button>
        </div>
      </div>
    </aside>
  );
}
