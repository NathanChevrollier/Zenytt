// Journaux en direct : conteneurs, services systemd et fichiers fusionnés dans un seul flux.
// La sélection de sources reste modifiable pendant le suivi (le flux se relance tout seul) et
// peut être enregistrée en préréglage, retrouvé ensuite par serveur.
import { useCallback, useEffect, useRef, useState } from "react";
import { BookmarkPlus, Play, ScrollText, Search, Square, Trash2, X } from "lucide-react";
import { api, errorMessage, type LogSource } from "../lib/api";
import { useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { colorOf, label, parseLogLink, readLocal, same, writeLocal } from "../lib/logs";
import { Badge, Button, Checkbox, EmptyState, Input, Loading, MenuButton, type MenuItem } from "../components/ui";
import { LogControls, LogLines, useLogStream, useLogView } from "../components/LogStream";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";

const MAX_SOURCES = 12;

interface Preset {
  name: string;
  sources: LogSource[];
}

export default function LogsView() {
  return <ServerGate title="Journaux" guide="logs">{(serverId) => <Logs key={serverId} serverId={serverId} />}</ServerGate>;
}

function Logs({ serverId }: { serverId: string }) {
  const notify = useApp((s) => s.notify);
  const ask = useApp((s) => s.ask);
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const presetKey = `zenytt.logPresets.${serverId}`;

  const [available, setAvailable] = useState<{ containers: string[]; units: string[]; files: string[] } | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<LogSource[]>([]);
  const [presets, setPresets] = useState<Preset[]>(() => readLocal(presetKey, []));
  const [sourceQuery, setSourceQuery] = useState("");
  const stream = useLogStream(serverId);
  const view = useLogView(stream.lines);
  const { running, lines, ended, paused, stop } = stream;
  const start = useCallback((sources: LogSource[], restart = false) => stream.start(sources, 200, restart ? `Sources modifiées : ${sources.map(label).join(", ")}` : undefined), [stream.start]);

  const loadSources = useCallback(() => {
    setSourcesError(null);
    api.logSources(serverId).then(setAvailable, (e) => setSourcesError(errorMessage(e)));
  }, [serverId]);
  useEffect(loadSources, [loadSources]);

  // Lien « Ouvrir dans Journaux » (tiroir de logs) : `unit:<nom>`, `docker:<nom>,docker:<nom>`… suit ces sources.
  const [wanted, setWanted] = useTabIntent<string>("logs", "");
  useEffect(() => {
    const src = parseLogLink(wanted).slice(0, MAX_SOURCES);
    if (!src.length) return;
    setWanted("");
    setChosen(src);
    void start(src);
  }, [wanted, setWanted, start]);

  // Sélection modifiée pendant le suivi : relance après une courte pause, le temps de cocher
  // plusieurs cases d'affilée sans relancer le flux à chaque clic.
  const liveRef = useRef(false);
  liveRef.current = running;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!liveRef.current) return;
    if (chosen.length === 0) {
      void stop();
      return;
    }
    if (chosen.length > MAX_SOURCES) return;
    const t = setTimeout(() => void start(chosen, true), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen]);

  const toggle = (src: LogSource) => setChosen((c) => (c.some((x) => same(x, src)) ? c.filter((x) => !same(x, src)) : [...c, src]));

  const savePresets = (next: Preset[]) => {
    setPresets(next);
    writeLocal(presetKey, next);
  };
  const saveCurrentAsPreset = async () => {
    const name = await ask({ title: "Enregistrer la sélection", body: `${chosen.length} source(s) : ${chosen.map(label).join(", ")}`, input: { label: "Nom du préréglage" }, confirmLabel: "Enregistrer" });
    if (typeof name !== "string" || !name.trim()) return;
    savePresets([...presets.filter((p) => p.name !== name.trim()), { name: name.trim(), sources: chosen }]);
    notify(`Préréglage « ${name.trim()} » enregistré.`, "success");
  };
  const applyPreset = (p: Preset) => {
    setChosen(p.sources);
    if (!running) void start(p.sources);
  };

  /** Sources correspondant à la recherche ; celles déjà cochées restent visibles. */
  const filtrer = (kind: LogSource["kind"], names: string[]) => {
    const q = sourceQuery.trim().toLowerCase();
    return q ? names.filter((n) => n.toLowerCase().includes(q) || chosen.some((c) => same(c, { kind, name: n }))) : names;
  };

  const presetMenu = (): MenuItem[] => [
    { heading: "Préréglages" },
    ...(presets.length
      ? presets.map((p) => ({ label: `${p.name} · ${p.sources.length} source${p.sources.length > 1 ? "s" : ""}`, onClick: () => applyPreset(p) }))
      : [{ label: "Aucun préréglage enregistré", disabled: true, onClick: () => {} }]),
    "separator",
    { label: "Enregistrer la sélection…", icon: <BookmarkPlus size={14} />, disabled: chosen.length === 0, onClick: () => void saveCurrentAsPreset() },
    ...(presets.length
      ? [
          { heading: "Supprimer" } as MenuItem,
          ...presets.map((p) => ({ label: p.name, icon: <Trash2 size={14} />, danger: true, onClick: () => savePresets(presets.filter((x) => x !== p)) })),
        ]
      : []),
  ];

  const groups: { title: string; kind: LogSource["kind"]; names: string[] }[] = available
    ? [
        { title: "Conteneurs", kind: "docker", names: available.containers },
        { title: "Services", kind: "unit", names: available.units },
        { title: "Fichiers", kind: "file", names: available.files },
      ]
    : [];
  const tooMany = chosen.length > MAX_SOURCES;

  return (
    <PageLayout
      title="Journaux"
      context={server && <ServerContext server={server} />}
      subtitle="Conteneurs, services et fichiers suivis en direct dans un seul flux."
      guide="logs"
      scroll={false}
      actions={
        running ? (
          <Button variant="danger" icon={<Square size={13} />} onClick={() => void stop()}>
            Arrêter le suivi
          </Button>
        ) : (
          <Button variant="primary" icon={<Play size={13} />} disabled={!chosen.length || tooMany} onClick={() => void start(chosen)}>
            Suivre {chosen.length ? `${chosen.length} source${chosen.length > 1 ? "s" : ""}` : "les sources"}
          </Button>
        )
      }
      status={
        <>
          {running ? (
            <Badge tone={paused ? "warn" : "ok"}>{paused ? "en pause" : "en direct"}</Badge>
          ) : (
            <Badge tone="muted">arrêté</Badge>
          )}
          {ended.map((e, i) => (
            <Badge key={i} tone={e.error ? "danger" : "muted"} title={e.error ?? undefined}>
              {e.tag} : {e.error ? "interrompu" : "terminé"}
            </Badge>
          ))}
        </>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <LogControls stream={stream} view={view} />
        </div>
      }
    >
      <div className="flex min-h-0 w-full flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
          <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
            <div className="flex items-center gap-1">
              <span className="flex-1 text-xs text-muted">
                Sources <span className={tooMany ? "text-danger" : ""}>{chosen.length}/{MAX_SOURCES}</span>
              </span>
              {chosen.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setChosen([])}>
                  Aucune
                </Button>
              )}
              <MenuButton size="sm" variant="ghost" title="Préréglages de sources" icon={<BookmarkPlus size={14} />} items={presetMenu} align="end" />
            </div>
            {/* Un serveur bien rempli propose des dizaines de services : la recherche évite de
                parcourir toute la liste pour trouver « nginx » ou « postgres ». */}
            <label className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
              <Input size_="sm" className="pr-7 pl-8" placeholder="Chercher une source" value={sourceQuery} onChange={(e) => setSourceQuery(e.target.value)} />
              {sourceQuery && (
                <button className="absolute top-1/2 right-2 -translate-y-1/2 text-muted hover:text-fg" aria-label="Effacer la recherche" onClick={() => setSourceQuery("")}>
                  <X size={13} />
                </button>
              )}
            </label>
            {running && <p className="text-[11px] leading-snug text-faint">Cocher ou décocher relance le suivi.</p>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
            {sourcesError ? (
              <div className="flex flex-col gap-2 text-xs text-danger">
                <p>{sourcesError}</p>
                <Button size="sm" onClick={loadSources}>
                  Réessayer
                </Button>
              </div>
            ) : !available ? (
              <Loading rows={6} />
            ) : (
              <>
                {groups.map((g) => {
                  const names = filtrer(g.kind, g.names);
                  if (!names.length) return null;
                  return (
                    <div key={g.kind}>
                      <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                        {g.title} <span className="font-normal text-faint">{names.length}</span>
                      </div>
                      {names.map((n) => {
                        const src = { kind: g.kind, name: n };
                        const on = chosen.some((c) => same(c, src));
                        return (
                          <div key={n} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover" title={n}>
                            <Checkbox className="min-w-0 flex-1 text-xs [&_span]:truncate" checked={on} onChange={() => toggle(src)} label={label(src)} />
                            {on && <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(src) }} />}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {groups.every((g) => filtrer(g.kind, g.names).length === 0) && (
                  <p className="text-xs text-muted">{sourceQuery ? `Aucune source ne correspond à « ${sourceQuery} ».` : "Aucune source détectée sur ce serveur."}</p>
                )}
              </>
            )}
          </div>
        </aside>

        <LogLines stream={stream} view={view}>
            {!running && lines.length === 0 && (
              <div className="h-full font-sans">
                <EmptyState icon={<ScrollText />} title={chosen.length ? "Prêt à suivre" : "Choisis des sources à suivre"}>
                  {chosen.length
                    ? "Lance le suivi depuis l'en-tête : les 200 dernières lignes de chaque source s'affichent, puis les nouvelles en direct."
                    : presets.length
                      ? "Coche des sources à gauche, ou reprends un préréglage enregistré."
                      : "Coche des conteneurs, services ou fichiers dans la colonne de gauche."}
                </EmptyState>
              </div>
            )}
            {running && lines.length === 0 && <p className="py-2 font-sans text-muted">En attente des premières lignes…</p>}
        </LogLines>
      </div>
    </PageLayout>
  );
}
