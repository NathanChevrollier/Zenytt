import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Box, Cable, CircleHelp, FolderOpen, Globe, History, Layers, Monitor, Plug, RotateCw, ScrollText, Search, Server, SquareTerminal, Star, Stethoscope, Zap } from "lucide-react";
import { useDoctor } from "./ConnectionDoctor";
import { focusedTerminal } from "../lib/focus";
import { api, errorMessage, shellQuote, type DesktopView, type DockerOverview, type Snippet, type TunnelView, type WebEngine } from "../lib/api";
import { openDesktop } from "./RemoteDesktops";
import { SECTIONS } from "../sections";
import { GUIDES } from "../lib/guides";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { useShell } from "../lib/shell";
import { peekCached } from "../lib/cache";
import { display, shortcutOf } from "../lib/shortcuts";
import { Kbd } from "./ui";

type Group = "Chemins" | "Navigation" | "Serveurs" | "Conteneurs" | "Projets compose" | "Actions" | "Sites" | "Fragments" | "Raccourcis" | "Tunnels" | "Bureaux à distance" | "Historique" | "Aide";

/** Portées : un préfixe tapé en tête de recherche limite les résultats à une famille. */
const SCOPES = [
  { key: "", label: "Tout" },
  { key: ">", label: "Actions" },
  { key: "@", label: "Serveurs" },
  { key: "/", label: "Chemins" },
  { key: "#", label: "Conteneurs" },
] as const;
type ScopeKey = (typeof SCOPES)[number]["key"];

const SCOPE_GROUPS: Record<Exclude<ScopeKey, "">, Group[]> = {
  ">": ["Actions", "Navigation", "Projets compose", "Fragments", "Tunnels", "Bureaux à distance", "Sites"],
  "@": ["Serveurs"],
  "/": ["Chemins", "Raccourcis"],
  "#": ["Conteneurs"],
};

/** Ordre d'affichage des groupes quand rien n'est tapé ou sans préférence de score. */
const GROUP_ORDER: Group[] = ["Chemins", "Actions", "Navigation", "Serveurs", "Conteneurs", "Projets compose", "Sites", "Fragments", "Raccourcis", "Tunnels", "Bureaux à distance", "Historique", "Aide"];

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  group: Group;
  run: () => void | Promise<void>;
}

/** Score de correspondance approximative (0 = pas de correspondance). */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || t[idx - 1] === " " ? 50 : 0);
  let ti = 0;
  let points = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    points += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return points;
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const { servers, activeServerId, setSection, setActiveServer, openTab, ask, notify, recent, pushRecent, setFilesPath } = useAppPick(
    "servers", "activeServerId", "setSection", "setActiveServer", "openTab", "ask", "notify", "recent", "pushRecent", "setFilesPath",
  );
  const initial = useShell((s) => s.paletteQuery);
  const [raw, setQuery] = useState(initial);
  const scope: ScopeKey = raw.startsWith(">") || raw.startsWith("@") || raw.startsWith("#") ? (raw[0] as ScopeKey) : raw.startsWith("/") ? "/" : "";
  // « / » fait partie du chemin : il reste dans la requête. Les autres préfixes sont retirés.
  const query = scope && scope !== "/" ? raw.slice(1).trimStart() : raw;
  const [index, setIndex] = useState(0);
  const [docker, setDocker] = useState<DockerOverview | null>(null);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [tunnels, setTunnels] = useState<TunnelView[]>([]);
  const [desktops, setDesktops] = useState<DesktopView[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  // Historique du shell du serveur de l'onglet actif, quand on vient d'un terminal.
  const termServer = useApp((s) => (s.section === "terminal" ? s.tabs.find((t) => t.key === s.activeTab)?.serverId : undefined));
  const [history, setHistory] = useState<string[]>([]);
  useEffect(() => {
    if (termServer) void api.shellHistory(termServer).then(setHistory).catch(() => {});
  }, [termServer]);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const server = servers.find((s) => s.id === activeServerId);

  useEffect(() => {
    input.current?.focus();
    void api.snippets().then(setSnippets);
    void api.tunnels().then(setTunnels);
    void api.desktops().then(setDesktops).catch(() => {});
    // Les données du serveur ne sont chargées que s'il est déjà connecté (aucune connexion imposée).
    if (server?.connected) {
      void api.dockerOverview(server.id).then(setDocker).catch(() => {});
      void api
        .sitesState(server.id)
        .then((s) => setDomains([...new Set(s.files.flatMap((f) => f.servers.flatMap((b) => b.serverNames)))].filter((d) => d.includes("."))))
        .catch(() => {});
    }
  }, [server?.id, server?.connected]);

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = SECTIONS.map((s) => ({ group: "Navigation", id: `go:${s.id}`, label: `Aller à ${s.label}`, icon: <s.icon size={15} />, run: () => setSection(s.id) }));
    // Les fiches d'aide sont cherchables ici : « tmux », « compose », « restic »… mènent droit au mode d'emploi.
    for (const g of GUIDES) {
      list.push({ group: "Aide", id: `guide:${g.id}`, label: `Aide : ${g.title}`, hint: g.summary, icon: <CircleHelp size={15} />, run: () => useApp.getState().openHelpPage(g.id) });
    }
    for (const s of servers) {
      list.push({ group: "Serveurs", id: `server:${s.id}`, label: `Serveur : ${s.name}`, hint: s.host, icon: <Server size={15} />, run: () => setActiveServer(s.id) });
      list.push({ group: "Serveurs", id: `term:${s.id}`, label: `Terminal sur ${s.name}`, icon: <SquareTerminal size={15} />, run: () => openTab(s.id) });
      list.push({
        group: "Serveurs", id: `doctor:${s.id}`,
        label: `Diagnostiquer la connexion à ${s.name}`,
        hint: "IP bannie, sshd arrêté, serveur éteint…",
        icon: <Stethoscope size={15} />,
        run: () => useDoctor.getState().open(s.id),
      });
      if (!s.connected) {
        list.push({
          group: "Serveurs", id: `connect:${s.id}`,
          label: `Se connecter à ${s.name}`,
          icon: <Plug size={15} />,
          run: async () => {
            if (await ensureConnected(s.id, { force: true })) notify(`Connecté à ${s.name}`, "success");
          },
        });
      }
    }
    if (server) {
      const sid = server.id;
      const dk = `${docker?.access === "sudo" ? "sudo " : ""}${docker?.engine ?? "docker"}`;
      list.push({
        group: "Actions", id: "nginx:test",
        label: "Tester la configuration du serveur web",
        hint: server.name,
        icon: <Zap size={15} />,
        run: async () => {
          const r = await api.sitesTest(sid, peekCached<WebEngine>(`sitesEngine:${sid}`) ?? "nginx").catch((e) => ({ ok: false, output: errorMessage(e) }));
          notify(r.ok ? "Configuration du serveur web valide" : r.output, r.ok ? "success" : "error");
        },
      });
      for (const c of docker?.containers ?? []) {
        list.push({ group: "Conteneurs", id: `logs:${c.name}`, label: `Logs de ${c.name}`, hint: server.name, icon: <ScrollText size={15} />, run: () => openTab(sid, { title: `${c.name} (logs)`, command: `${dk} logs -f --tail 300 ${shellQuote(c.id)}` }) });
        if (c.state === "running") {
          list.push({
            group: "Conteneurs", id: `shell:${c.name}`,
            label: `Shell dans ${c.name}`,
            hint: server.name,
            icon: <SquareTerminal size={15} />,
            run: () => openTab(sid, { title: `${c.name} (shell)`, command: `${dk} exec -it ${shellQuote(c.id)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'` }),
          });
        }
        list.push({
          group: "Conteneurs", id: `restart:${c.name}`,
          label: `Redémarrer ${c.name}`,
          hint: server.name,
          icon: <RotateCw size={15} />,
          run: async () => {
            if (!(await ask({ title: `Redémarrer ${c.name} ?`, confirmLabel: "Redémarrer" }))) return;
            try {
              await api.dockerAction(sid, c.id, "restart");
              notify(`${c.name} redémarré`, "success");
            } catch (e) {
              notify(errorMessage(e), "error");
            }
          },
        });
      }
      for (const p of docker?.projects ?? []) {
        list.push({
          group: "Projets compose", id: `deploy:${p.name}`,
          label: `Déployer ${p.name}`,
          hint: "pull, redémarrage, vérification, retour arrière si échec",
          icon: <Layers size={15} />,
          run: async () => {
            if (!(await ask({ title: `Déployer ${p.name} ?`, body: "Télécharge les nouvelles images, redémarre le projet et revient à la version précédente si la vérification échoue.", confirmLabel: "Déployer" }))) return;
            try {
              const host = await api.deploySuggestHost(sid, p.name).catch(() => null);
              const cmd = await api.deployPrepare(sid, p, host);
              openTab(sid, { title: `Déploiement ${p.name}`, command: `${cmd}; echo; echo 'Tu peux fermer cet onglet.'; exec "$SHELL" -l` });
            } catch (e) {
              notify(errorMessage(e), "error");
            }
          },
        });
      }
      for (const d of domains) {
        list.push({ group: "Sites", id: `open:${d}`, label: `Ouvrir ${d}`, icon: <Globe size={15} />, run: () => void openUrl(`https://${d}`) });
      }
      for (const sn of snippets) {
        list.push({
          group: "Fragments", id: `snippet:${sn.id}`,
          label: `Lancer le fragment « ${sn.name} »`,
          hint: sn.command,
          icon: <ScrollText size={15} />,
          run: () => openTab(sid, { title: sn.name, command: `${sn.command}; echo; exec "$SHELL" -l` }),
        });
      }
    }
    for (const d of desktops) {
      list.push({ group: "Bureaux à distance", id: `rdp:${d.id}`, label: `Bureau à distance : ${d.name}`, hint: d.host, icon: <Monitor size={15} />, run: () => void openDesktop(d, useApp.getState().settings.vmScreen ?? "internal") });
    }
    for (const t of tunnels) {
      list.push({
        group: "Tunnels", id: `tunnel:${t.id}`,
        label: `${t.running ? "Arrêter" : "Démarrer"} le tunnel ${t.name || t.localPort}`,
        hint: `127.0.0.1:${t.localPort} → ${t.remoteHost}:${t.remotePort}`,
        icon: <Cable size={15} />,
        run: () => void (t.running ? api.tunnelStop(t.id) : api.tunnelStart(t.id)).catch((e) => notify(errorMessage(e), "error")),
      });
    }
    // Commandes déjà tapées : insérées dans le terminal actif, sans être exécutées.
    if (query && focusedTerminal.id != null) {
      history.forEach((cmd, i) =>
        list.push({
          group: "Historique", id: `history:${i}`,
          label: cmd,
          hint: "historique · insérer dans le terminal",
          icon: <History size={15} />,
          run: () => {
            if (focusedTerminal.id != null) void api.termWrite(focusedTerminal.id, cmd);
            focusedTerminal.focus?.();
          },
        }),
      );
    }
    if (server) {
      for (const b of useApp.getState().bookmarks[server.id] ?? []) {
        list.push({
          group: "Raccourcis", id: `bookmark:${server.id}:${b.path}`,
          label: `Raccourci : ${b.name}`,
          hint: b.path,
          icon: <Star size={15} />,
          run: () => {
            setFilesPath(server.id, b.path);
            setSection("files");
          },
        });
      }
    }
    if (query.startsWith("/") && server) {
      list.unshift({
        group: "Chemins", id: "path",
        label: `Ouvrir ${query} dans Fichiers`,
        hint: server.name,
        icon: <FolderOpen size={15} />,
        run: () => {
          setFilesPath(server.id, query);
          setSection("files");
        },
      });
    }
    return list;
  }, [servers, server, docker, snippets, tunnels, desktops, domains, history, query, setSection, setActiveServer, openTab, ask, notify, setFilesPath]);

  const results = useMemo(() => {
    const allowed = scope ? SCOPE_GROUPS[scope] : null;
    const pool = allowed ? actions.filter((a) => allowed.includes(a.group)) : actions;
    if (!query || (scope === "/" && query === "/")) {
      const rank = (a: Action) => {
        const r = recent.indexOf(a.id);
        return r < 0 ? 999 : r;
      };
      return [...pool].sort((a, b) => rank(a) - rank(b)).slice(0, 40);
    }
    return pool
      .map((a) => ({ a, s: score(query, `${a.label} ${a.hint ?? ""}`) + (recent.includes(a.id) ? 5 : 0) + (a.group === "Chemins" ? 1000 : 0) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 40)
      .map((x) => x.a);
  }, [actions, query, scope, recent]);

  // Sans recherche : résultats groupés par famille. Avec une recherche : un seul bloc, du meilleur au moins bon.
  const sections = useMemo(() => {
    if (query && !(scope === "/" && query === "/")) return [{ group: null as Group | null, items: results }];
    const by = new Map<Group, Action[]>();
    for (const a of results) by.set(a.group, [...(by.get(a.group) ?? []), a]);
    const recentItems = results.filter((a) => recent.includes(a.id)).slice(0, 6);
    const out: { group: Group | "Récents" | null; items: Action[] }[] = recentItems.length && !scope ? [{ group: "Récents", items: recentItems }] : [];
    for (const g of GROUP_ORDER) {
      const items = (by.get(g) ?? []).filter((a) => !out[0] || out[0].group !== "Récents" || !out[0].items.includes(a));
      if (items.length) out.push({ group: g, items: items.slice(0, scope ? 40 : 6) });
    }
    return out;
  }, [results, query, scope, recent]);
  const flat = sections.flatMap((s) => s.items);

  useEffect(() => setIndex(0), [raw]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const execute = (a: Action | undefined) => {
    if (!a) return;
    if (a.id !== "path" && !a.id.startsWith("history:")) pushRecent(a.id);
    onClose();
    void a.run();
  };

  const cycleScope = (dir: 1 | -1) => {
    const i = SCOPES.findIndex((x) => x.key === scope);
    const next = SCOPES[(i + dir + SCOPES.length) % SCOPES.length].key;
    setQuery(next === "/" ? "/" : next + (query && scope !== "/" ? query : ""));
  };

  let n = -1;
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/55 pt-[12vh] backdrop-blur-[1px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Palette de commandes"
        className="animate-pop-in flex h-fit max-h-[72vh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-border-strong bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={18} className="shrink-0 text-muted" />
          <input
            ref={input}
            className="h-[52px] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            placeholder={server ? `Rechercher une action, un serveur, un conteneur de ${server.name}…` : "Rechercher une action ou un serveur…"}
            value={raw}
            aria-activedescendant={flat[index] ? `pal-${index}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "Tab") {
                e.preventDefault();
                cycleScope(e.shiftKey ? -1 : 1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") execute(flat[index]);
            }}
          />
          <Kbd>Échap</Kbd>
        </div>
        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2" role="radiogroup" aria-label="Portée">
          {SCOPES.map((sc) => (
            <button
              key={sc.key || "all"}
              type="button"
              role="radio"
              aria-checked={scope === sc.key}
              onClick={() => {
                setQuery(sc.key === "/" ? "/" : sc.key + (scope === "/" ? "" : query));
                input.current?.focus();
              }}
              className={`flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-xs ${scope === sc.key ? "border-accent/45 bg-accent/14 text-accent" : "border-border text-muted hover:text-fg"}`}
            >
              {sc.key && <span className="font-mono">{sc.key}</span>}
              {sc.label}
            </button>
          ))}
        </div>
        <div ref={listRef} className="min-h-0 overflow-auto py-1.5" role="listbox">
          {sections.map((sec, si) => (
            <div key={`${sec.group ?? "r"}-${si}`}>
              {sec.group && <div className="px-4 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">{sec.group}</div>}
              {sec.items.map((a) => {
                n++;
                const i = n;
                return (
                  <button
                    key={`${sec.group}-${a.id}`}
                    id={`pal-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === index}
                    onMouseMove={() => i !== index && setIndex(i)}
                    onClick={() => execute(a)}
                    className={`mx-1.5 flex w-[calc(100%-12px)] items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] ${i === index ? "bg-accent/12" : ""}`}
                  >
                    <span className={i === index ? "text-accent" : "text-muted"}>{a.icon}</span>
                    <span className="truncate">{a.label}</span>
                    {a.hint && <span className="ml-auto max-w-72 shrink-0 truncate pl-4 text-xs text-faint">{a.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-muted">
              <Box size={15} /> Aucun résultat{scope ? " dans cette portée" : ""}.
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-subtle px-4 py-2 text-[11.5px] text-faint">
          <span>
            <Kbd>↑↓</Kbd> naviguer
          </span>
          <span>
            <Kbd>Entrée</Kbd> ouvrir
          </span>
          <span>
            <Kbd>Tab</Kbd> portée
          </span>
          <span className="ml-auto">
            {display(shortcutOf("switcher"))} : changer de serveur
          </span>
        </div>
      </div>
    </div>
  );
}
