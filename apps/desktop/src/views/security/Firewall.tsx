import { useCallback, useEffect, useState } from "react";
import { BrickWall, Globe, Lock, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, errorMessage, type FwState } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, ErrorState, IconButton, Input, Loading, Select } from "../../components/ui";
import { useCachedState } from "../../lib/cache";

const STATUS = {
  open: { label: "exposé", tone: "warn" },
  blocked: { label: "bloqué", tone: "ok" },
  local: { label: "local", tone: "muted" },
} as const;

export default function Firewall({ serverId, onCount, onAudit }: { serverId: string; onCount?: (n: number) => void; onAudit?: () => void }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [state, setState] = useCachedState<FwState | null>(`firewall:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState("");
  const [proto, setProto] = useState<"tcp" | "udp">("tcp");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api.fwState(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);
  const exposedCount = state?.exposures.filter((e) => e.status === "open").length;
  useEffect(() => {
    if (exposedCount != null) onCount?.(exposedCount);
  }, [exposedCount, onCount]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify(ok, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  if (error && !state) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!state) return <Loading label="Lecture du pare-feu…" rows={4} />;

  const exposed = state.exposures.filter((e) => e.status === "open");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-2 text-[13px]">
        <BrickWall size={15} className="text-muted" />
        {state.kind === "none" ? (
          <span className="flex items-center gap-2 text-warn">
            Aucun pare-feu détecté (ni ufw, ni firewalld).
            {onAudit && (
              <Button size="sm" variant="ghost" onClick={onAudit}>
                Activer ufw depuis l'audit
              </Button>
            )}
          </span>
        ) : (
          <span>
            {state.kind} <Badge tone={state.active ? "ok" : "danger"}>{state.active ? "actif" : "inactif"}</Badge>
            {state.defaults && <span className="ml-2 text-xs text-muted">Par défaut : {state.defaults}</span>}
          </span>
        )}
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>

      {/* Ports et règles côte à côte sur grand écran, empilés sinon. */}
      <div className="grid min-w-0 items-start gap-4 @6xl:grid-cols-2">
        <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-panel">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Globe size={14} />
            <span className="text-[13px] font-semibold">Ports en écoute</span>
            <span className="text-xs text-muted">· {exposed.length} joignable(s) depuis Internet</span>
          </header>
          <table className="w-full table-fixed text-[13px]">
            <thead className="border-b border-border bg-subtle text-left text-xs text-muted">
              <tr>
                <th className="w-24 px-4 py-1.5 font-medium">Port</th>
                <th className="w-24 px-2 py-1.5 font-medium">État</th>
                <th className="w-44 px-2 py-1.5 font-medium">Processus</th>
                <th className="px-2 py-1.5 font-medium">Détail</th>
              </tr>
            </thead>
            <tbody>
              {state.exposures.map((e) => (
                <tr key={`${e.proto}${e.port}${e.public}`} className="border-t border-border/50 align-top first:border-t-0">
                  <td className="px-4 py-1.5 font-mono text-xs">
                    {e.port}/{e.proto}
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                  </td>
                  <td className="truncate px-2 py-1.5 text-xs" title={e.owner || undefined}>{e.owner || <span className="text-muted">inconnu</span>}</td>
                  <td className={`px-2 py-1.5 text-xs ${e.docker && e.status === "open" && state.active ? "text-warn" : "text-muted"}`}>{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {state.kind === "ufw" && (
          <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-panel">
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <Lock size={14} />
              <span className="text-[13px] font-semibold">Règles ufw</span>
              {state.sshPorts.length > 0 && <span className="truncate text-xs text-muted">· SSH sur le port {state.sshPorts.join(", ")} (règles protégées)</span>}
            </header>
            {state.rules.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted">Aucune règle.</p>
            ) : (
              <ul className="divide-y divide-border/50">
                {state.rules.map((r) => (
                  <li key={r.num} className="grid grid-cols-[2.5rem_minmax(0,1.4fr)_6.5rem_minmax(0,1fr)_2rem] items-center gap-3 py-1 pr-2 pl-4 text-[13px]">
                    <span className="text-xs text-muted tabular-nums">#{r.num}</span>
                    <span className="truncate font-mono text-xs" title={r.to}>{r.to}</span>
                    <Badge tone={r.action.startsWith("ALLOW") || r.action.startsWith("LIMIT") ? "ok" : "danger"}>{r.action}</Badge>
                    <span className="truncate text-xs text-muted" title={r.from}>depuis {r.from}</span>
                    <IconButton
                      size="sm"
                      title="Supprimer la règle"
                      onClick={async () => {
                        if (await ask({ title: `Supprimer la règle #${r.num} ?`, code: `${r.to}  ${r.action}  ${r.from}`, confirmLabel: "Supprimer", danger: true }))
                          void run(() => api.fwDelete(serverId, r.num), `Règle #${r.num} supprimée`);
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                const p = Number(port);
                if (!Number.isInteger(p) || p < 1 || p > 65535) return notify("Port invalide.", "error");
                void run(() => api.fwAllow(serverId, p, proto), `Port ${p}/${proto} ouvert`).then(() => setPort(""));
              }}
            >
              <span className="text-[13px]">Ouvrir un port :</span>
              <Input className="!w-24 font-mono" placeholder="8080" value={port} onChange={(e) => setPort(e.target.value)} />
              <Select aria-label="Protocole" value={proto} onChange={setProto} options={[{ value: "tcp", label: "tcp" }, { value: "udp", label: "udp" }]} />
              <Button size="sm" icon={<Plus size={13} />} type="submit" disabled={!port}>
                Autoriser
              </Button>
            </form>
          </section>
        )}

        {state.kind === "firewalld" && state.raw && (
          <section className="min-w-0 rounded-xl border border-border bg-panel p-4">
            <h2 className="mb-2 text-[13px] font-semibold">Configuration firewalld (lecture seule)</h2>
            <pre className="overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap">{state.raw}</pre>
          </section>
        )}
      </div>
    </div>
  );
}
