import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, errorMessage, type AiCapabilities, type AiExecMode, type AiSettings as Settings, type AiView } from "../lib/api";
import { useApp } from "../lib/store";
import { ask, useAssistant } from "../lib/assistant";
import { Badge, Button, Checkbox, Field, Input } from "./ui";

/** Fournisseurs prêts à l'emploi : le reste (adresse, modèle) se règle à la main. */
const PRESETS: { id: string; label: string; settings: Partial<Settings>; hint: string }[] = [
  { id: "claude", label: "Claude (Anthropic)", settings: { provider: "anthropic", baseUrl: "", model: "claude-opus-5" }, hint: "Clé sur console.anthropic.com. Le plus à l'aise sur les tâches d'administration." },
  { id: "openai", label: "OpenAI", settings: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" }, hint: "Clé sur platform.openai.com." },
  { id: "gemini", label: "Gemini (Google)", settings: { provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash" }, hint: "Clé gratuite sur aistudio.google.com/apikey (quota limité), payante au-delà." },
  { id: "mistral", label: "Mistral", settings: { provider: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest" }, hint: "Clé sur console.mistral.ai." },
  { id: "openrouter", label: "OpenRouter", settings: { provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" }, hint: "Un seul compte pour de nombreux modèles." },
  { id: "ollama", label: "Ollama (local)", settings: { provider: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.1" }, hint: "Rien ne sort de ton réseau. Choisis un modèle qui gère les outils." },
  { id: "lmstudio", label: "LM Studio (local)", settings: { provider: "openai", baseUrl: "http://localhost:1234/v1", model: "local-model" }, hint: "Serveur local de LM Studio." },
];

const CAPABILITIES: { key: keyof AiCapabilities; label: string; hint: string }[] = [
  { key: "status", label: "État des serveurs", hint: "CPU, mémoire, disques, charge, alertes." },
  { key: "containers", label: "Conteneurs Docker", hint: "Noms, images, états, ports." },
  { key: "logs", label: "Journaux", hint: "Conteneurs et services systemd." },
  { key: "sites", label: "Sites web", hint: "Domaines nginx, certificats." },
  { key: "processes", label: "Processus", hint: "Les plus gourmands en CPU." },
  { key: "security", label: "Audit de sécurité", hint: "SSH, pare-feu, fail2ban, mises à jour." },
  { key: "files", label: "Fichiers de configuration", hint: "Lecture limitée (clés et secrets exclus). Désactivé par défaut." },
];

const MODES: { id: AiExecMode; label: string; hint: string }[] = [
  { id: "off", label: "Lecture seule", hint: "L'assistant explique ; c'est toi qui tapes les commandes." },
  { id: "propose", label: "Propose, tu valides", hint: "Chaque commande s'affiche dans la discussion avec Exécuter / Refuser." },
  { id: "auto", label: "Exécution autonome", hint: "Il exécute lui-même ; les commandes sensibles demandent quand même ta validation." },
];

/** Réglages de l'assistant IA (Réglages → Préférences). */
export default function AiSettingsPanel({ onOpenAccess }: { onOpenAccess?: () => void } = {}) {
  const notify = useApp((s) => s.notify);
  const [view, setView] = useState<AiView | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.aiGet().then((v) => {
      setView(v);
      const { hasKey: _ignored, ...rest } = v;
      setSettings(rest);
    });
  useEffect(() => {
    void load();
  }, []);

  if (!settings) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });
  // Une clé d'API ne doit jamais partir en clair : http:// n'est admis que vers la machine locale.
  const insecure = settings.provider === "openai" && /^http:\/\//i.test(settings.baseUrl) && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(settings.baseUrl);

  const save = async () => {
    setSaving(true);
    try {
      await api.aiSet(settings, key || undefined);
      setKey("");
      await load();
      await useAssistant.getState().reload();
      notify("Assistant enregistré", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    await save();
    await useAssistant.getState().reset();
    useAssistant.getState().setOpen(true);
    void ask("Dis bonjour en une phrase et indique quel modèle tu es.");
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-panel p-4">
      <div>
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <Sparkles size={15} className="text-accent" />
          Assistant IA {view?.hasKey && <Badge tone="ok">clé enregistrée</Badge>}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">
          Un panneau de discussion qui peut consulter tes serveurs pour t'aider à comprendre une erreur. Les données lues (journaux, configurations) partent chez le fournisseur choisi : les mots de passe, clés et jetons sont masqués avant l'envoi.
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const active = settings.provider === p.settings.provider && settings.baseUrl === (p.settings.baseUrl ?? "");
          return (
            <Button key={p.id} size="sm" title={p.hint} variant={active ? "subtle" : "outline"} className={active ? "!border-accent/50" : ""} onClick={() => setSettings({ ...settings, ...p.settings } as Settings)}>
              {p.label}
            </Button>
          );
        })}
      </div>

      <p className="text-xs leading-relaxed text-muted">
        Une clé d'API est nécessaire : les abonnements grand public (Claude Pro, ChatGPT Plus, Gemini Advanced / Google One AI Premium) ne donnent pas accès à l'API. Gemini propose une clé gratuite (quota limité) sur Google AI Studio, aistudio.google.com/apikey.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Modèle">
          <Input value={settings.model} onChange={(e) => set("model", e.target.value)} />
        </Field>
        <Field label="Clé d'API" hint={view?.hasKey ? "Déjà enregistrée : laisse vide pour la conserver." : "Inutile pour un modèle local."}>
          <Input type="password" value={key} autoComplete="new-password" onChange={(e) => setKey(e.target.value)} />
        </Field>
        {settings.provider === "openai" && (
          <div className="col-span-2">
            <Field
              label="Adresse de l'API"
              hint="Doit se terminer par /v1 pour la plupart des fournisseurs."
              error={insecure ? "http:// n'est accepté que pour un modèle local (localhost ou réseau privé) : la clé et tes données circuleraient en clair sur Internet." : null}
            >
              <Input value={settings.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => set("baseUrl", e.target.value)} />
            </Field>
          </div>
        )}
      </div>

      <div>
        <span className="text-xs font-medium text-muted">Ce qu'il peut consulter</span>
        <div className="mt-1 grid grid-cols-2 gap-x-4">
          {CAPABILITIES.map((c) => (
            <Checkbox
              key={c.key}
              className="py-1"
              checked={settings.capabilities[c.key]}
              onChange={(on) => set("capabilities", { ...settings.capabilities, [c.key]: on })}
              label={c.label}
              hint={c.hint}
            />
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">
          Il ne voit que les serveurs autorisés dans{" "}
          {onOpenAccess ? (
            <button type="button" className="text-accent hover:underline" onClick={onOpenAccess}>
              Outils IA externes (plus bas)
            </button>
          ) : (
            "Réglages › IA › Outils IA externes"
          )}
          . Rien n'est consulté sans que tu poses une question.
        </p>
      </div>

      <div>
        <span className="text-xs font-medium text-muted">Commandes</span>
        <div role="radiogroup" aria-label="Commandes" className="mt-1.5 grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => {
            const on = settings.execMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set("execMode", m.id)}
                className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? "border-accent bg-accent/8" : "border-border hover:bg-hover"}`}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  <span className={`size-3 shrink-0 rounded-full border-2 ${on ? "border-accent bg-accent" : "border-border-strong"}`} />
                  {m.label}
                </span>
                <span className="text-xs leading-snug text-muted">{m.hint}</span>
                {m.id === "auto" && <Badge tone="warn">en connaissance de cause</Badge>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" loading={saving} disabled={insecure} onClick={() => void save()}>
          Enregistrer
        </Button>
        <Button size="sm" icon={<Sparkles size={13} />} disabled={insecure} onClick={() => void test()}>
          Enregistrer et tester
        </Button>
      </div>
    </div>
  );
}
