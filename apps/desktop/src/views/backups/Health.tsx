// Diagnostic des sauvegardes : causes d'échec avec leur correction, et état de chaque source
// (conteneur arrêté, recréé, base supprimée, dossier vide…). Le diagnostic vient du serveur
// (backup_health) ; ce fichier ne fait que l'afficher et déclencher les corrections.
import { Database, FolderOpen, HardDrive, Loader2, RefreshCw } from "lucide-react";
import type { BackupFix, BackupHealth, BackupIssue, BackupSourceCheck } from "../../lib/api";
import { Badge, Button, Card, DataTable, ErrorState, Section, StatusDot } from "../../components/ui";

type Tone = "ok" | "warn" | "danger" | "muted";

export const SOURCE_STATE: Record<BackupSourceCheck["state"], { label: string; tone: Tone }> = {
  ok: { label: "à jour", tone: "ok" },
  stopped: { label: "conteneur arrêté", tone: "warn" },
  missing: { label: "introuvable", tone: "danger" },
  recreated: { label: "recréé", tone: "warn" },
  dbDropped: { label: "base supprimée", tone: "warn" },
  empty: { label: "vide", tone: "warn" },
  authFailed: { label: "accès refusé", tone: "danger" },
  unknown: { label: "non vérifié", tone: "muted" },
};

export function fixLabel(f: BackupFix): string {
  switch (f.kind) {
    case "unlock":
      return "Déverrouiller";
    case "installRestic":
      return "Installer restic";
    case "enableSchedule":
      return "Réactiver la planification";
    case "runNow":
      return "Sauvegarder maintenant";
    case "editConfig":
      return "Modifier la configuration";
    case "startContainer":
      return "Démarrer le conteneur";
    case "relink":
      return `Relier à ${f.to}`;
    case "removeSource":
      return "Retirer la source";
  }
}

export const fixKey = (f: BackupFix) => JSON.stringify(f);

const KIND_ICON = { database: Database, volume: HardDrive, path: FolderOpen } as const;
const KIND_LABEL = { database: "Base", volume: "Volume", path: "Dossier" } as const;

export function HealthPanel({
  health,
  error,
  loading,
  onRetry,
  onFix,
  busy,
}: {
  health: BackupHealth | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onFix: (f: BackupFix) => void;
  busy: string | null;
}) {
  const fixButton = (f: BackupFix | null, primary = false) =>
    f && (
      <Button size="sm" variant={primary ? "primary" : "outline"} loading={busy === fixKey(f)} disabled={busy !== null && busy !== fixKey(f)} onClick={() => onFix(f)}>
        {fixLabel(f)}
      </Button>
    );
  const okCount = health?.sources.filter((s) => s.state === "ok").length ?? 0;

  return (
    <>
      <Section
        title="Diagnostic"
        count={health?.issues.length || undefined}
        description="Planification, dépôt, verrous, disque et cause du dernier échec."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={loading} onClick={onRetry}>
            Revérifier
          </Button>
        }
      >
        {error && !health ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !health ? (
          <Card className="flex items-center gap-2.5 py-3 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" /> Vérification de la planification, du dépôt et des sources…
          </Card>
        ) : health.issues.length === 0 ? (
          <Card className="flex items-center gap-2.5 py-3 text-[13px]">
            <StatusDot tone="ok" />
            <span className="font-medium">Aucun problème détecté</span>
            <span className="truncate text-xs text-muted">
              Planification active, dépôt joignable, {okCount}/{health.sources.length} sources à jour.
            </span>
          </Card>
        ) : (
          <Card padded={false} className="divide-y divide-line overflow-hidden">
            {health.issues.map((i, n) => (
              <IssueRow key={n} issue={i} action={fixButton(i.fix, n === 0 && i.severity === "danger")} />
            ))}
          </Card>
        )}
      </Section>

      {health && health.sources.length > 0 && (
        <Section title="Sources" count={`${okCount}/${health.sources.length} à jour`}>
          <Card padded={false} className="overflow-hidden">
            <DataTable
              rows={health.sources}
              rowKey={(s) => `${s.source}:${s.name}`}
              rowHeight={40}
              initialSort={{ key: "state", dir: "asc" }}
              columns={[
                {
                  key: "name",
                  header: "Source",
                  width: "minmax(180px,1.2fr)",
                  sortValue: (s) => s.name,
                  render: (s) => {
                    const Icon = KIND_ICON[s.source];
                    return (
                      <span className="flex min-w-0 items-center gap-2" title={KIND_LABEL[s.source]}>
                        <Icon size={14} className="shrink-0 text-muted" />
                        <span className="truncate font-mono text-xs">{s.name}</span>
                      </span>
                    );
                  },
                },
                { key: "kind", header: "Type", width: "80px", sortValue: (s) => s.source, render: (s) => <span className="text-xs text-muted">{KIND_LABEL[s.source]}</span> },
                {
                  key: "state",
                  header: "État",
                  width: "140px",
                  // Les sources à corriger d'abord.
                  sortValue: (s) => (s.state === "ok" ? 2 : s.state === "unknown" ? 1 : 0),
                  render: (s) => <Badge tone={SOURCE_STATE[s.state].tone}>{SOURCE_STATE[s.state].label}</Badge>,
                },
                {
                  key: "detail",
                  header: "Détail",
                  width: "minmax(0,3fr)",
                  render: (s) => (
                    <span className="text-xs text-muted" title={s.detail}>
                      {s.detail}
                    </span>
                  ),
                },
              ]}
              actionsWidth={200}
              rowActions={(s) => fixButton(s.fix)}
            />
          </Card>
        </Section>
      )}
    </>
  );
}

function IssueRow({ issue, action }: { issue: BackupIssue; action: React.ReactNode }) {
  const tone = issue.severity === "info" ? "muted" : issue.severity;
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <StatusDot tone={tone} className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{issue.title}</p>
        <p className="text-xs text-muted">{issue.detail}</p>
        {issue.evidence && (
          <p className="mt-1 truncate font-mono text-[11px] text-faint select-text" title={issue.evidence}>
            {issue.evidence}
          </p>
        )}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
