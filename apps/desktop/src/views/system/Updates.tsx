// Mises à jour des paquets : liste par famille (noyau, bibliothèques, applications), actualisation,
// application en une fois avec le journal de sortie.
import { useState } from "react";
import { CircleCheck, Download, Loader2, PackageX, RefreshCw } from "lucide-react";
import { api, errorMessage, type SystemUpdate } from "../../lib/api";
import { sortUpdates, updateGroup, UPDATE_GROUP_LABEL } from "../../lib/system";
import { useApp } from "../../lib/store";
import { Button, Card, CodeBlock, DataTable, EmptyState, ErrorState, Loading, ResultBanner, Section, type Column } from "../../components/ui";

const columns: Column<SystemUpdate>[] = [
  { key: "name", header: "Paquet", width: "minmax(0,1.2fr)", render: (u) => <span className="truncate font-mono text-xs">{u.name}</span>, sortValue: (u) => u.name },
  {
    key: "version",
    header: "Version actuelle → nouvelle",
    width: "minmax(0,1.8fr)",
    render: (u) => (
      <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
        <span className="truncate text-muted">{u.current || "—"}</span>
        <span aria-label="vers" className="text-faint">
          →
        </span>
        <span className="truncate text-fg">{u.candidate}</span>
      </span>
    ),
  },
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
        <EmptyState icon={<CircleCheck />} title="Système à jour" action={<Button icon={<RefreshCw size={14} />} loading={checking} onClick={refresh}>Vérifier à nouveau</Button>}>
          Aucun paquet en attente{packageManager ? ` d'après ${packageManager}` : ""}.
        </EmptyState>
      </Card>
    );
  } else {
    body = (
      <Card padded={false} className="overflow-hidden">
        <div className="flex max-h-[min(60vh,560px)] flex-col">
          <DataTable
            className="min-h-0 flex-1"
            rows={sortUpdates(updates)}
            rowKey={(u) => u.name}
            columns={columns}
            rowHeight={34}
            groupBy={{
              key: (u) => updateGroup(u.name),
              header: (k, list) => (
                <div className="flex h-8 items-center gap-2 border-b border-border bg-subtle px-3 text-xs">
                  <span className="font-semibold">{UPDATE_GROUP_LABEL[k as keyof typeof UPDATE_GROUP_LABEL]}</span>
                  <span className="text-faint">{list.length}</span>
                </div>
              ),
            }}
          />
        </div>
      </Card>
    );
  }

  return (
    <Section
      title="Mises à jour"
      count={updates ? n : undefined}
      description={packageManager ? `Paquets ${packageManager}` : undefined}
      actions={
        <>
          <Button size="sm" icon={<RefreshCw size={13} />} loading={checking} disabled={applying} onClick={refresh} title="Actualise les index des paquets puis relit la liste">
            Actualiser
          </Button>
          <Button size="sm" variant="primary" icon={<Download size={13} />} loading={applying} disabled={!n || checking} onClick={() => void apply()}>
            Tout appliquer
          </Button>
        </>
      }
    >
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
    </Section>
  );
}
