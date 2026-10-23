// Réglages : navigation latérale par thème, chaque réglage simple s'enregistre dès qu'on le change.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
  Download,
  Heart,
  History,
  Keyboard,
  Lock,
  Minus,
  Monitor,
  Plug,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { SPONSORS_URL } from "../lib/links";
import { api, errorMessage, importHasWarnings, importMessage, type AuditEntry, type McpConfig } from "../lib/api";
import { useAppPick } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { hashPassword, useLock } from "../lib/lock";
import type { ThemeSetting } from "../lib/theme";
import { comboOf, display, SHORTCUTS, shortcutOf, type ShortcutId } from "../lib/shortcuts";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge, Button, Card, Checkbox, CodeBlock, DataTable, Field, IconButton, Input, Loading, Segmented, Select, Switch, type Column } from "../components/ui";
import PageLayout from "../components/PageLayout";
import { checkForUpdate } from "../lib/updater";
import SyncSettings from "../components/SyncSettings";
import AiSettingsPanel from "../components/AiSettings";
import { ALWAYS_VISIBLE, SECTIONS } from "../sections";

/** Nom du système, pour parler de « Windows », « macOS » ou « Linux » plutôt que d'un seul. */
const OS_NAME = /Windows/i.test(navigator.userAgent) ? "Windows" : /Mac/i.test(navigator.userAgent) ? "macOS" : "Linux";
const VAULT = OS_NAME === "Windows" ? "Gestionnaire d'identification de Windows" : OS_NAME === "macOS" ? "Trousseau de macOS" : "coffre-fort du système (Secret Service)";

type TabId = "general" | "terminal" | "shortcuts" | "lock" | "ai" | "mcp" | "sync" | "maintenance" | "journal";
const NAV: { id: TabId; label: string; icon: LucideIcon; description: string }[] = [
  { id: "general", label: "Général", icon: Monitor, description: "Thème, actualisation, notifications et fichiers." },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, description: "Sessions persistantes, police, clic droit, monitoring." },
  { id: "shortcuts", label: "Raccourcis", icon: Keyboard, description: "Tous modifiables : clique sur un raccourci puis tape la combinaison voulue." },
  { id: "lock", label: "Sécurité de l'app", icon: Lock, description: "Verrouillage de Zenytt sur ce poste." },
  { id: "ai", label: "Assistant IA", icon: Bot, description: "Fournisseur, modèle, clé et ce que l'assistant a le droit de consulter." },
  { id: "mcp", label: "Accès IA (MCP)", icon: Plug, description: "Serveurs lisibles par l'IA et branchement de Claude Code ou Claude Desktop." },
  { id: "sync", label: "Synchronisation", icon: RefreshCw, description: "Retrouver sa configuration sur un autre poste, ou l'exporter dans un fichier chiffré." },
  { id: "maintenance", label: "Maintenance", icon: Wrench, description: "Mises à jour et journaux de l'app." },
  { id: "journal", label: "Journal d'actions", icon: History, description: "Chaque modification faite par Zenytt sur un serveur, et chaque lecture de l'IA via MCP." },
];

/** Groupe de réglages : un titre, puis des lignes dans une même carte. */
function Group({ title, description, children, wide }: { title?: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className="flex flex-col gap-2.5">
      {(title || description) && (
        <div>
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {description && <p className="text-[13px] text-muted">{description}</p>}
        </div>
      )}
      {wide ? <div className="flex flex-col gap-3">{children}</div> : <Card padded={false} className="divide-y divide-border">{children}</Card>}
    </section>
  );
}

/**
 * Réglage à valeur (liste, bouton…) : ce que l'on règle à gauche, la valeur en cours à droite.
 * Même disposition partout, pour qu'on sache d'un coup d'œil ce que l'on modifie.
 */
function Setting({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Réglage à deux états. */
function Toggle({ title, description, checked, onChange }: { title: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Setting title={title} description={description}>
      <Switch checked={checked} onChange={onChange} label={title} />
    </Setting>
  );
}

export default function SettingsView() {
  const [tab, setTab] = useTabIntent<TabId>("settings", "general");
  const current = NAV.find((n) => n.id === tab) ?? NAV[0];
  return (
    <PageLayout title="Réglages" subtitle="Préférences de l'app, verrouillage, assistant, synchronisation et journal des actions." guide="settings" scroll={false}>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 overflow-auto border-r border-border bg-panel p-2" aria-label="Rubriques des réglages">
          {NAV.map((n) => {
            const on = n.id === current.id;
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                type="button"
                aria-current={on ? "page" : undefined}
                onClick={() => setTab(n.id)}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${on ? "bg-accent/12 font-medium text-fg" : "text-fg/80 hover:bg-hover"}`}
              >
                <Icon size={15} className={on ? "text-accent" : "text-muted"} />
                {n.label}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto">
          <div className={`mx-auto flex flex-col gap-6 px-8 py-6 ${current.id === "journal" ? "max-w-6xl" : "max-w-3xl"}`}>
            <header>
              <h2 className="text-lg font-semibold tracking-tight">{current.label}</h2>
              <p className="text-[13px] text-muted">{current.description}</p>
            </header>
            {current.id === "general" && <General />}
            {current.id === "terminal" && <TerminalPrefs />}
            {current.id === "shortcuts" && <Shortcuts />}
            {current.id === "lock" && <AppLock />}
            {current.id === "ai" && <AiSettingsPanel onOpenAccess={() => setTab("mcp")} />}
            {current.id === "mcp" && <AiAccess />}
            {current.id === "sync" && (
              <>
                <SyncSettings />
                <ExportImport />
              </>
            )}
            {current.id === "maintenance" && <Maintenance />}
            {current.id === "journal" && <Journal />}
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

function General() {
  const { settings, setSettings, notify } = useAppPick("settings", "setSettings", "notify");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    api.autostartGet().then(setAutostart, () => setAutostart(null));
  }, []);
  const toggleAutostart = async (enabled: boolean) => {
    try {
      await api.autostartSet(enabled);
      setAutostart(enabled);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };
  return (
    <>
      <Group title="Démarrage et fermeture">
        <Toggle
          title="Lancer Zenytt à l'ouverture de ma session"
          description="Zenytt démarre discrètement dans la zone de notification. Les serveurs marqués « Se connecter au démarrage » (dans leur profil) se connectent, une fois Zenytt déverrouillé si tu as défini un mot de passe."
          checked={autostart ?? false}
          onChange={(v) => void toggleAutostart(v)}
        />
        <Setting title="Quand je ferme la fenêtre" description="Réduit, Zenytt continue en arrière-plan : tunnels, transferts, synchronisation et alertes. « Quitter » (menu de l'icône ou Ctrl+Q) arrête tout.">
          <Select
            className="w-64"
            value={settings.closeAction}
            onChange={(closeAction) => setSettings({ closeAction })}
            options={[
              { value: "ask", label: "Me demander" },
              { value: "tray", label: "Réduire dans la zone de notification" },
              { value: "quit", label: "Quitter Zenytt" },
            ]}
          />
        </Setting>
        <Toggle
          title="Avertir avant de quitter"
          description="S'il reste des tunnels, des transferts ou des terminaux ouverts, Zenytt les liste et demande confirmation. Désactivé, « Quitter » (et Ctrl+Q) ferme tout immédiatement."
          checked={settings.confirmQuit}
          onChange={(confirmQuit) => setSettings({ confirmQuit })}
        />
      </Group>
      <Group title="Affichage">
        <Setting title="Thème" description={`« Système » suit le thème clair ou sombre de ${OS_NAME}.`}>
          <Segmented
            label="Thème"
            size="sm"
            value={settings.theme}
            onChange={(theme: ThemeSetting) => setSettings({ theme })}
            options={[
              { value: "dark", label: "Sombre" },
              { value: "light", label: "Clair" },
              { value: "system", label: "Système" },
            ]}
          />
        </Setting>
        <Setting title="Actualisation automatique" description="Conteneurs, sites, services, fichiers… relus régulièrement sur les serveurs connectés. F5 ou ⟳ actualisent à tout moment.">
          <Select
            className="w-44"
            value={settings.autoRefreshSecs}
            onChange={(autoRefreshSecs) => setSettings({ autoRefreshSecs })}
            options={[
              { value: 0, label: "Manuelle" },
              { value: 5, label: "Toutes les 5 s" },
              { value: 15, label: "Toutes les 15 s" },
              { value: 30, label: "Toutes les 30 s" },
              { value: 60, label: "Toutes les minutes" },
            ]}
          />
        </Setting>
      </Group>
      <Group title="Onglets de la barre latérale" description="Décoche ce dont tu ne te sers pas : l'onglet disparaît de la barre latérale, sans rien désactiver (la palette Ctrl+K y mène toujours). Accueil, Aide et Réglages restent affichés.">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-4 py-3.5">
          {SECTIONS.filter((s) => !ALWAYS_VISIBLE.includes(s.id)).map((s) => {
            const hidden = settings.hiddenSections ?? [];
            const Icon = s.icon;
            return (
              <Checkbox
                key={s.id}
                checked={!hidden.includes(s.id)}
                onChange={(on) => setSettings({ hiddenSections: on ? hidden.filter((h) => h !== s.id) : [...hidden, s.id] })}
                label={
                  <span className="flex items-center gap-1.5">
                    <Icon size={14} className="text-muted" />
                    {s.label}
                  </span>
                }
              />
            );
          })}
        </div>
      </Group>
      <Group title="Notifications et fichiers">
        <Toggle
          title={`Notifications ${OS_NAME} pour les alertes`}
          description="Tant que Zenytt est ouvert, une notification apparaît dès qu'une alerte se déclenche (CPU, mémoire, disque, site injoignable…). Zenytt fermé, c'est l'agent qui prévient (Discord, ntfy, webhook)."
          checked={settings.alertNotifications}
          onChange={(alertNotifications) => setSettings({ alertNotifications })}
        />
        <Toggle
          title="Afficher les fichiers cachés"
          description="Fichiers et dossiers dont le nom commence par un point (.env, .ssh…), dans l'explorateur de fichiers."
          checked={settings.showHiddenFiles}
          onChange={(showHiddenFiles) => setSettings({ showHiddenFiles })}
        />
      </Group>
    </>
  );
}

function TerminalPrefs() {
  const { settings, setSettings, servers } = useAppPick("settings", "setSettings", "servers");
  const declined = Object.keys(settings.tmuxDeclined).filter((id) => settings.tmuxDeclined[id]);
  const size = settings.terminalFontSize;
  const setSize = (n: number) => setSettings({ terminalFontSize: Math.min(28, Math.max(9, n)) });
  return (
    <>
      <Group>
        <Toggle
          title="Sessions persistantes (tmux)"
          description="Les nouveaux terminaux tournent dans une session tmux : ils survivent aux coupures réseau et à la fermeture de Zenytt, et se rattachent automatiquement."
          checked={settings.persistentSessions}
          onChange={(persistentSessions) => setSettings({ persistentSessions })}
        />
        <Setting title="Taille du texte" description="Aussi Ctrl+= / Ctrl+- / Ctrl+0 dans un terminal.">
          <IconButton size="sm" title="Plus petit" disabled={size <= 9} onClick={() => setSize(size - 1)}>
            <Minus size={14} />
          </IconButton>
          <span className="w-12 text-center font-mono text-[13px] tabular-nums">{size} px</span>
          <IconButton size="sm" title="Plus grand" disabled={size >= 28} onClick={() => setSize(size + 1)}>
            <Plus size={14} />
          </IconButton>
        </Setting>
        <Setting title="Clic droit" description="Menu (copier, coller, envoyer des fichiers, ouvrir le dossier…) ou copier/coller immédiat, comme PuTTY.">
          <Select
            className="w-52"
            value={settings.terminalRightClick}
            onChange={(terminalRightClick) => setSettings({ terminalRightClick })}
            options={[
              { value: "menu", label: "Menu contextuel" },
              { value: "paste", label: "Copier / coller (PuTTY)" },
            ]}
          />
        </Setting>
        <Toggle
          title="Monitoring sous le terminal"
          description="CPU, mémoire, disque, charge et réseau du serveur du terminal actif, rafraîchis toutes les 3 secondes."
          checked={settings.terminalStatusBar}
          onChange={(terminalStatusBar) => setSettings({ terminalStatusBar })}
        />
        {declined.length > 0 && (
          <Setting title="Installation de tmux refusée" description={declined.map((id) => servers.find((s) => s.id === id)?.name ?? "serveur supprimé").join(", ")}>
            <Button size="sm" onClick={() => setSettings({ tmuxDeclined: {} })}>
              Reproposer
            </Button>
          </Setting>
        )}
      </Group>
      <div className="rounded-lg border border-border bg-term p-3 font-mono text-fg" style={{ fontSize: size }}>
        <span className="text-ok">debian@prod-01</span>:<span className="text-accent">~</span>$ docker compose ps
      </div>
    </>
  );
}

function Maintenance() {
  const { notify } = useAppPick("notify");
  const [checking, setChecking] = useState(false);
  return (
    <Group>
      <Setting title="Mises à jour" description="Zenytt vérifie au démarrage si une nouvelle version est publiée sur GitHub. Les mises à jour sont signées : une version modifiée est refusée.">
        <Button
          size="sm"
          loading={checking}
          onClick={() => {
            setChecking(true);
            void checkForUpdate(true).finally(() => setChecking(false));
          }}
        >
          Rechercher
        </Button>
      </Setting>
      <Setting title="Journaux de Zenytt" description="Connexions, actions et erreurs de l'app, sans aucun secret. Utile pour comprendre un problème.">
        <Button size="sm" onClick={() => void api.logsOpenDir().catch((e) => notify(errorMessage(e), "error"))}>
          Ouvrir le dossier
        </Button>
      </Setting>
      <Setting title="Soutenir Zenytt" description="Zenytt est gratuit et développé sur mon temps libre. S'il te rend service, un don sur GitHub Sponsors aide à le faire avancer.">
        <Button size="sm" icon={<Heart size={14} />} onClick={() => void openUrl(SPONSORS_URL)}>
          Soutenir
        </Button>
      </Setting>
      <Setting title="Licence et confidentialité" description="Zenytt n'envoie aucune télémétrie : tes données restent sur ton ordinateur. © 2026 Nathan Chevrollier, licence PolyForm Shield 1.0.0.">
        <div className="flex flex-wrap justify-end gap-2">
          {LEGAL_DOCS.map(([label, path]) => (
            <Button key={path} size="sm" onClick={() => void openUrl(`${REPO_BLOB}/${path}`)}>
              {label}
            </Button>
          ))}
        </div>
      </Setting>
    </Group>
  );
}

const REPO_BLOB = "https://github.com/NathanChevrollier/Zenytt/blob/main";
const LEGAL_DOCS = [
  ["Confidentialité", "docs/legal/confidentialite.md"],
  ["Conditions", "docs/legal/conditions-utilisation.md"],
  ["Licence", "LICENSE"],
  ["Composants tiers", "THIRD_PARTY_NOTICES.md"],
  ["Mentions légales", "docs/legal/mentions-legales.md"],
] as const;

const PERIODS = [
  { value: "1", label: "24 dernières heures" },
  { value: "7", label: "7 derniers jours" },
  { value: "30", label: "30 derniers jours" },
  { value: "all", label: "Tout" },
] as const;
type Period = (typeof PERIODS)[number]["value"];

function Journal() {
  const { notify } = useAppPick("notify");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [origin, setOrigin] = useState<"all" | "app" | "mcp">("all");
  const [period, setPeriod] = useState<Period>("all");
  const [failedOnly, setFailedOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await api.auditList(5000));
    } catch (e) {
      notify(errorMessage(e), "error");
      setEntries((x) => x ?? []);
    } finally {
      setLoading(false);
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const since = period === "all" ? 0 : Date.now() - Number(period) * 86_400_000;
    return (entries ?? []).filter(
      (e) =>
        e.t >= since &&
        (!failedOnly || !e.ok) &&
        (origin === "all" || e.origin === origin) &&
        (!f || `${e.serverName} ${e.action} ${e.detail} ${e.error ?? ""}`.toLowerCase().includes(f)),
    );
  }, [entries, filter, origin, period, failedOnly]);

  const exportCsv = async () => {
    const path = await saveDialog({ title: "Exporter le journal", defaultPath: `zenytt-journal-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      ["date", "origine", "serveur", "action", "détail", "résultat", "erreur"].join(";"),
      ...rows.map((e) => [new Date(e.t).toISOString(), e.origin, e.serverName, e.action, e.detail, e.ok ? "ok" : "échec", e.error ?? ""].map((v) => cell(String(v))).join(";")),
    ];
    try {
      // BOM : Excel reconnaît l'UTF-8 et affiche correctement les accents.
      await api.saveTextFile(path, "\ufeff" + lines.join("\r\n"));
      notify(`${rows.length} entrée(s) exportée(s)`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const columns: Column<AuditEntry>[] = [
    { key: "t", header: "Date", width: "150px", sortValue: (e) => e.t, render: (e) => <span className="text-xs text-muted tabular-nums">{new Date(e.t).toLocaleString("fr-FR")}</span> },
    { key: "origin", header: "Origine", width: "80px", sortValue: (e) => e.origin, render: (e) => (e.origin === "mcp" ? <Badge tone="accent">IA</Badge> : <Badge>Zenytt</Badge>) },
    { key: "server", header: "Serveur", width: "130px", sortValue: (e) => e.serverName, render: (e) => <span className="truncate text-xs">{e.serverName}</span> },
    { key: "action", header: "Action", width: "170px", sortValue: (e) => e.action, render: (e) => <span className="truncate font-mono text-xs">{e.action}</span> },
    {
      key: "detail",
      header: "Détail",
      render: (e) => (
        <span className="truncate text-xs text-muted" title={e.detail}>
          {e.detail}
        </span>
      ),
    },
    {
      key: "ok",
      header: "Résultat",
      width: "minmax(0,0.6fr)",
      sortValue: (e) => (e.ok ? 1 : 0),
      render: (e) =>
        e.ok ? (
          <CheckCircle2 size={14} className="text-ok" />
        ) : (
          <span className="flex min-w-0 items-center gap-1 text-xs text-danger" title={e.error ?? ""}>
            <XCircle size={14} className="shrink-0" /> <span className="truncate">{e.error}</span>
          </span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">Fichier local, jamais envoyé ailleurs.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-64">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input className="pl-8" placeholder="Serveur, action, détail" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <Segmented
          label="Origine"
          size="sm"
          value={origin}
          onChange={setOrigin}
          options={[
            { value: "all", label: "Tout" },
            { value: "app", label: "Zenytt" },
            { value: "mcp", label: "IA" },
          ]}
        />
        <Select className="w-48" aria-label="Période" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
        <Checkbox className="text-xs" checked={failedOnly} onChange={setFailedOnly} label="Échecs seulement" />
        <span className="ml-auto text-xs text-muted tabular-nums">{rows.length} entrée(s)</span>
        <IconButton title="Actualiser" onClick={() => void load()}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </IconButton>
        <Button size="sm" icon={<Download size={13} />} disabled={!rows.length} onClick={() => void exportCsv()}>
          Exporter en CSV
        </Button>
      </div>
      {entries === null ? (
        <Loading rows={8} />
      ) : (
        <Card padded={false} className="h-[min(620px,calc(100vh-300px))] overflow-hidden">
          <DataTable className="h-full" rows={rows} rowKey={(e) => `${e.t}${e.action}${e.detail}`} columns={columns} rowHeight={34} initialSort={{ key: "t", dir: "desc" }} empty="Aucune action enregistrée." />
        </Card>
      )}
    </div>
  );
}

function AiAccess() {
  const { servers, refreshServers, notify } = useAppPick("servers", "refreshServers", "notify");
  const [config, setConfig] = useState<McpConfig | null>(null);
  useEffect(() => {
    void api.mcpConfig().then(setConfig);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Ce que l'IA peut faire</h2>
        <ul className="flex flex-col gap-1 text-sm text-muted">
          <li>• <strong className="text-fg">Lire uniquement</strong> : état, métriques, alertes, conteneurs, logs, sites, configuration nginx, audit, sauvegardes.</li>
          <li>• <strong className="text-fg">Aucune action</strong> : aucun outil ne peut modifier un serveur ni exécuter une commande libre.</li>
          <li>• Les mots de passe, jetons et clés sont masqués avant l'envoi ; clés privées et fichiers sensibles restent illisibles.</li>
          <li>• Chaque lecture est inscrite dans le journal d'actions (origine « IA »).</li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Serveurs accessibles par l'IA</h2>
        <p className="text-xs text-muted">Désactivé par défaut. Les données lues sont envoyées au fournisseur du modèle que tu utilises.</p>
        <Card padded={false} className="divide-y divide-border">
          {servers.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{s.name}</span>
                <span className="block truncate font-mono text-xs text-muted">{s.host}</span>
              </span>
              <Switch
                label={`Accès IA pour ${s.name}`}
                checked={!!s.aiAccess}
                onChange={async (on) => {
                  try {
                    await api.setAiAccess(s.id, on);
                    await refreshServers();
                  } catch (err) {
                    notify(errorMessage(err), "error");
                  }
                }}
              />
            </div>
          ))}
          {servers.length === 0 && <p className="p-4 text-sm text-muted">Aucun serveur.</p>}
        </Card>
      </section>

      {config && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Brancher Claude</h2>
          <Field label="Claude Code (dans un terminal)">
            <CodeBlock code={config.claudeCode} />
          </Field>
          <Field label="Claude Desktop (fichier claude_desktop_config.json)">
            <CodeBlock code={config.claudeDesktop} />
          </Field>
          <p className="text-xs text-muted">Le serveur MCP est l'app Zenytt elle-même, lancée avec l'option --mcp (sans fenêtre). Réinstalle la config si tu déplaces Zenytt.</p>
        </section>
      )}
    </div>
  );
}

const LOCK_DELAYS = [
  { minutes: 0, label: "Jamais (verrouillage manuel uniquement)" },
  { minutes: 5, label: "Après 5 minutes d'inactivité" },
  { minutes: 15, label: "Après 15 minutes d'inactivité" },
  { minutes: 30, label: "Après 30 minutes d'inactivité" },
  { minutes: 60, label: "Après 1 heure d'inactivité" },
];

/** Mot de passe de verrouillage de Zenytt et délai de verrouillage automatique. */
function AppLock() {
  const { settings, setSettings, notify, ask } = useAppPick("settings", "setSettings", "notify", "ask");
  const configured = useLock((s) => s.configured);
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (pw.length < 6) return notify("Choisis au moins 6 caractères.", "error");
    if (pw !== confirm) return notify("Les deux mots de passe ne correspondent pas.", "error");
    setBusy(true);
    try {
      await api.appLockSet(await hashPassword(pw));
      await useLock.getState().refresh();
      setEditing(false);
      setPw("");
      setConfirm("");
      notify("Mot de passe de verrouillage enregistré (Ctrl+Maj+L pour verrouiller)", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await ask({ title: "Désactiver le verrouillage ?", body: "Zenytt ne sera plus protégé par un mot de passe.", confirmLabel: "Désactiver", danger: true }))) return;
    await api.appLockSet("");
    setSettings({ lockMinutes: 0 });
    await useLock.getState().refresh();
  };

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <Lock size={14} /> Verrouillage de Zenytt {configured ? <Badge tone="ok">activé</Badge> : <Badge>désactivé</Badge>}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">
          Zenytt ouvert donne accès à tous tes serveurs. Un mot de passe masque l'interface quand tu t'absentes ; connexions et terminaux continuent en arrière-plan. Seule son empreinte est conservée, dans le {VAULT}.
        </span>
      </div>
      {configured && !editing && (
        <>
          <Field label="Verrouillage automatique">
            <Select className="w-80" value={settings.lockMinutes} onChange={(lockMinutes) => setSettings({ lockMinutes })} options={LOCK_DELAYS.map((d) => ({ value: d.minutes, label: d.label }))} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              Changer le mot de passe
            </Button>
            <Button size="sm" variant="danger" onClick={() => void remove()}>
              Désactiver
            </Button>
          </div>
        </>
      )}
      {(!configured || editing) && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid max-w-xl grid-cols-2 gap-3">
            <Field label="Nouveau mot de passe" hint="6 caractères minimum.">
              <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            <Field label="Confirmation">
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" type="submit" loading={busy}>
              {configured ? "Enregistrer" : "Activer le verrouillage"}
            </Button>
            {editing && (
              <Button size="sm" onClick={() => setEditing(false)}>
                Annuler
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

/** Export / import des réglages (changement de PC, copie de secours). */
function ExportImport() {
  const { notify, ask, refreshServers } = useAppPick("notify", "ask", "refreshServers");
  const [exporting, setExporting] = useState(false);
  const [pw, setPw] = useState("");
  const [withSecrets, setWithSecrets] = useState(false);

  const doExport = async () => {
    if (withSecrets && pw.length < 8) return notify("Avec les secrets, choisis un mot de passe d'au moins 8 caractères.", "error");
    const path = await saveDialog({ defaultPath: `zenytt-reglages-${new Date().toISOString().slice(0, 10)}.zenytt`, filters: [{ name: "Réglages Zenytt", extensions: ["zenytt"] }] });
    if (!path) return;
    try {
      await api.settingsExport(path, pw, withSecrets);
      notify(pw ? "Réglages exportés (fichier chiffré)" : "Réglages exportés", "success");
      setExporting(false);
      setPw("");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const doImport = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Réglages Zenytt", extensions: ["zenytt", "json"] }] });
    if (typeof path !== "string") return;
    try {
      let password = "";
      if (await api.settingsImportEncrypted(path)) {
        const v = await ask({ title: "Fichier chiffré", body: "Mot de passe choisi lors de l'export :", input: { label: "Mot de passe", secret: true }, confirmLabel: "Importer" });
        if (typeof v !== "string" || !v) return;
        password = v;
      }
      const r = await api.settingsImport(path, password);
      await refreshServers();
      notify(importMessage(r), importHasWarnings(r) ? "info" : "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <span className="text-[13px] font-medium">Exporter / importer mes réglages</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">
          Serveurs, bureaux à distance, identifiants, clés d'hôte approuvées, snippets et tunnels, pour changer de PC ou garder une copie. L'import complète la configuration actuelle sans rien supprimer.
        </span>
      </div>
      {exporting ? (
        <div className="flex flex-col gap-2">
          <Field label="Mot de passe de chiffrement" hint="Recommandé ; obligatoire avec les secrets (8 caractères minimum).">
            <Input className="max-w-80" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Checkbox
            checked={withSecrets}
            onChange={setWithSecrets}
            label="Inclure les secrets"
            hint="Mots de passe SSH et sudo, passphrases, mot de passe restic."
          />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void doExport()}>
              Choisir l'emplacement…
            </Button>
            <Button size="sm" onClick={() => setExporting(false)}>
              Annuler
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setExporting(true)}>
            Exporter…
          </Button>
          <Button size="sm" onClick={() => void doImport()}>
            Importer…
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Raccourcis clavier : clique sur un raccourci puis appuie sur la nouvelle combinaison. */
function Shortcuts() {
  const { settings, setSettings, notify } = useAppPick("settings", "setSettings", "notify");
  const [recording, setRecording] = useState<ShortcutId | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      const combo = comboOf(e);
      if (!combo) return;
      if (!/Ctrl|Alt/.test(combo) && !/^F\d+$/.test(combo)) return notify("Utilise Ctrl ou Alt (ou une touche F1–F12), pour ne pas gêner la saisie.", "error");
      const taken = (Object.keys(SHORTCUTS) as ShortcutId[]).find((id) => id !== recording && shortcutOf(id) === combo);
      if (taken) return notify(`${display(combo)} est déjà utilisé par « ${SHORTCUTS[taken].label} ».`, "error");
      setSettings({ shortcuts: { ...settings.shortcuts, [recording]: combo } });
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, settings.shortcuts, setSettings, notify]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center">
        <span className="flex-1 text-xs text-muted">Échap pour annuler la saisie. Ctrl ou Alt obligatoire (ou une touche F1–F12), pour ne pas gêner la frappe.</span>
        {settings.shortcuts && Object.keys(settings.shortcuts).length > 0 && (
          <Button size="sm" onClick={() => setSettings({ shortcuts: {} })}>
            Tout réinitialiser
          </Button>
        )}
      </div>
      <Card padded={false} className="divide-y divide-border">
        {(Object.keys(SHORTCUTS) as ShortcutId[]).map((id) => (
          <div key={id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
            <span className="flex-1">{SHORTCUTS[id].label}</span>
            <button
              className={`min-w-36 rounded-md border px-2 py-1 font-mono text-xs ${recording === id ? "border-accent text-accent" : "border-border hover:bg-hover"}`}
              onClick={() => setRecording(recording === id ? null : id)}
            >
              {recording === id ? "Appuie sur les touches…" : display(shortcutOf(id))}
            </button>
          </div>
        ))}
      </Card>
    </div>
  );
}
