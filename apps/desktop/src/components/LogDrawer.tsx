// Tiroir de logs unique : conteneur, projet compose (tous ses services) ou service systemd, suivis en
// direct avec la même mécanique que la page Journaux.
import { useEffect, useState } from "react";
import { ExternalLink, SquareTerminal } from "lucide-react";
import { logLink } from "../lib/logs";
import { navigate, openLogs, type LogTarget } from "../lib/shell";
import { Badge, Button, Drawer, MenuButton } from "./ui";
import { LogControls, LogLines, useLogStream, useLogView } from "./LogStream";

const FIRST = 300;
const MORE = 700;
/** Limite de `logs_start` (lignes par source). */
const MAX_TAIL = 5000;

export default function LogDrawer({ target }: { target: LogTarget }) {
  const { serverId, kind, name, sources, skipped, terminal } = target;
  const stream = useLogStream(serverId);
  const view = useLogView(stream.lines);
  const [tail, setTail] = useState(FIRST);
  const close = () => openLogs(null);

  useEffect(() => {
    void stream.start(sources, tail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tail]);

  const status = !stream.running ? <Badge tone="muted">arrêté</Badge> : <Badge tone={stream.paused ? "warn" : "ok"}>{stream.paused ? "en pause" : "en direct"}</Badge>;

  return (
    <Drawer
      title={
        <span className="flex min-w-0 items-center gap-2">
          Logs
          <span className="truncate rounded-md bg-hover px-2 py-0.5 font-mono text-xs font-normal text-fg/80">
            {kind} · {name}
          </span>
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          {status}
          {skipped ? <span>{skipped} service(s) non suivi(s) : 12 sources au plus.</span> : null}
          {stream.ended.map((e, i) => (
            <Badge key={i} tone={e.error ? "danger" : "muted"} title={e.error ?? undefined}>
              {e.tag} : {e.error ? "interrompu" : "terminé"}
            </Badge>
          ))}
        </span>
      }
      width={760}
      modal={false}
      flush
      onClose={close}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={<ExternalLink size={13} />}
            onClick={() => {
              close();
              navigate("logs", logLink(sources), serverId);
            }}
          >
            Ouvrir dans Journaux
          </Button>
          {terminal && (
            <MenuButton
              size="sm"
              title="Autres actions"
              items={[
                {
                  label: "Ouvrir dans un terminal",
                  icon: <SquareTerminal size={14} />,
                  onClick: () => {
                    close();
                    terminal();
                  },
                },
              ]}
            />
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <LogControls stream={stream} view={view} filterClass="min-w-48 flex-1" exportPrefix={`logs-${name}`} />
      </div>
      <LogLines stream={stream} view={view} tags={sources.length > 1}>
        {!sources.length && <p className="py-2 font-sans text-muted">Aucun conteneur à suivre : le projet n'est pas lancé.</p>}
        {sources.length > 0 && tail < MAX_TAIL && (
          <div className="pb-2 text-center font-sans">
            <Button size="sm" onClick={() => setTail((t) => Math.min(MAX_TAIL, t + MORE))}>
              Charger {Math.min(MORE, MAX_TAIL - tail)} lignes de plus
            </Button>
          </div>
        )}
        {stream.running && stream.lines.length === 0 && <p className="py-2 font-sans text-muted">En attente des premières lignes…</p>}
      </LogLines>
    </Drawer>
  );
}
