// Mises à jour des paquets : liste par famille (noyau, bibliothèques, applications), actualisation,
// application en une fois avec le journal de sortie.
import { useState } from "react";
import { CircleCheck, Download, Loader2, PackageX, RefreshCw } from "lucide-react";
import { api, errorMessage, type SystemUpdate } from "../../lib/api";
import { sortUpdates, updateGroup, UPDATE_GROUP_LABEL, type UpdateGroup } from "../../lib/system";
import { useApp } from "../../lib/store";
import { Button, Card, CodeBlock, DataTable, EmptyState, ErrorState, IconButton, Loading, ResultBanner, type Column } from "../../components/ui";

const columns: Column<SystemUpdate>[] = [
  { key: "name", header: "Paquet", width: "minmax(0,1.3fr)", render: (u) => <span className="truncate font-mono text-xs">{u.name}</span>, sortValue: (u) => u.name },
  { key: "current", header: "Installée", width: "minmax(0,1fr)", render: (u) => <span className="truncate font-mono text-xs text-muted">{u.current || "—"}</span> },
  { key: "candidate", header: "Disponible", width: "minmax(0,1fr)", render: (u) => <span className="truncate font-mono text-xs">{u.candidate}</span> },
];

export default function Updates({
  serverId,
  updates,
  error,
  checking,
  packageManager,
  refresh,
  onApplied,
}: {
  serverId: string;
  updates: SystemUpdate[] | null;
  error: string | null;
  checking: boolean;
  packageManager: string | null;
  refresh: () => void;
  onApplied: () => void;
}) {
  const { ask, notify } = useApp.getState();
  const [applying, setApplying] = useState(false);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  const n = updates?.length ?? 0;

  const apply = async () => {
    const ok = await ask({
      title: `Appliquer ${n} mise${n > 1 ? "s" : ""} à jour ?`,
      body: "Les paquets sont mis à jour sans interaction. Certains services peuvent redémarrer, et un redémarrage du serveur peut ensuite être nécessaire.",
      confirmLabel: "Tout appliquer",
      danger: true,
    });
    if (!ok) return;
    setApplying(true);
    setOutput(null);
    try {
      setOutput({ ok: true, text: await api.systemApplyUpdates(serverId) });
      notify("Mises à jour appliquées", "success");
      onApplied();
    } catch (e) {
      setOutput({ ok: false, text: errorMessage(e) });
      notify("Échec des mises à jour", "error");
    } finally {
      setApplying(false);
    }
  };

  // Message du cœur (`parse_updates`) quand le serveur n'a ni apt ni dnf.
  const unsupported = !!error?.includes("apt et dnf");
  let body;
  if (error && !updates) {
    body = unsupported ? (
      <Card>
        <EmptyState icon={<PackageX />} title="Liste indisponible">
          Seuls apt et dnf sont pris en charge{packageManager ? ` (ce serveur utilise ${packageManager})` : ""}.
        </EmptyState>
      </Card>
    ) : (
      <ErrorState message={error} onRetry={refresh} />
    );
  } else if (!updates) {
    body = <Loading rows={6} />;
  } else if (n === 0) {
    body = (
      <Card>
        <EmptyState icon={<CircleCheck />} title="Système à jour">
          Aucun paquet en attente{packageManager ? ` d'après ${packageManager}` : ""}.
        </EmptyState>
      </Card>
    );
  } else {
    body = (
      <Card padded={false} className="overflow-hidden">
        <div className="flex max-h-[max(18rem,calc(100vh-15rem))] flex-col">
          <DataTable
            className="min-h-0 flex-1"
            rows={sortUpdates(updates)}
            rowKey={(u) => u.name}
            columns={columns}
            rowHeight={32}
            groupBy={{
              key: (u) => updateGroup(u.name),
              header: (k, list) => (
                <div className="flex h-8 items-center gap-2 border-b border-border bg-subtle px-3 text-xs">
                  <span className="font-semibold">{UPDATE_GROUP_LABEL[k as UpdateGroup]}</span>
                  <span className="text-faint">{list.length}</span>
                </div>
              ),
            }}
          />
        </div>
      </Card>
    );
  }

  const perGroup = (["kernel", "libs", "apps"] as UpdateGroup[]).map((g) => [g, updates?.filter((u) => updateGroup(u.name) === g).length ?? 0] as const);
  const kernel = perGroup[0][1];

  // Liste à gauche sur toute la largeur restante ; résumé et actions dans une colonne à droite sur
  // grand écran, en barre au-dessus de la liste sinon.
  return (
    <div className="grid min-w-0 gap-4 @5xl:grid-cols-[minmax(0,1fr)_280px]">
      <aside className="min-w-0 @5xl:order-last">
        <Card padded={false} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 @5xl:flex-col @5xl:items-stretch">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold">
              {!updates ? "Mises à jour" : n ? `${n} mise${n > 1 ? "s" : ""} à jour` : "Système à jour"}
            </h2>
            {packageManager && <p className="text-xs text-muted">Paquets {packageManager}</p>}
          </div>
          {n > 0 && (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs @5xl:flex-col">
              {perGroup.map(([g, k]) => (
                <div key={g} className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted">{UPDATE_GROUP_LABEL[g]}</dt>
                  <dd className={`font-medium tabular-nums ${k ? "" : "text-faint"}`}>{k}</dd>
                </div>
              ))}
            </dl>
          )}
          {kernel > 0 && <p className="text-xs text-warn">Noyau concerné : redémarrage à prévoir.</p>}
          <div className="ml-auto flex items-center gap-1.5 @5xl:ml-0 @5xl:border-t @5xl:border-border @5xl:pt-3">
            <IconButton title="Actualiser : relit les index des paquets puis la liste" disabled={checking || applying} onClick={refresh}>
              <RefreshCw size={15} className={checking ? "animate-spin" : ""} />
            </IconButton>
            <Button variant="primary" className="@5xl:flex-1" icon={<Download size={14} />} loading={applying} disabled={!n || checking} onClick={() => void apply()}>
              Tout appliquer
            </Button>
          </div>
        </Card>
      </aside>

      <div className="flex min-w-0 flex-col gap-3">
        {applying && (
          <ResultBanner tone="accent" title="Application en cours…">
            <span className="flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" />
              Cela peut prendre plusieurs minutes. Le journal s'affiche ici à la fin.
            </span>
          </ResultBanner>
        )}
        {output && (
          <div className="flex flex-col gap-2">
            <ResultBanner tone={output.ok ? "ok" : "danger"} title={output.ok ? "Mises à jour appliquées" : "Les mises à jour ont échoué"} action={<Button size="sm" variant="ghost" onClick={() => setOutput(null)}>Masquer</Button>}>
              {output.ok ? "Journal de la commande (200 dernières lignes) :" : undefined}
            </ResultBanner>
            <CodeBlock code={output.text.split("\n").slice(-200).join("\n")} className="max-h-80 overflow-auto" />
          </div>
        )}
        {body}
      </div>
    </div>
  );
}
