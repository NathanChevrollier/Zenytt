import { ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Timer } from "lucide-react";
import { fullestDisk, formatBytes, formatDuration } from "../lib/api";
import { useApp } from "../lib/store";
import { useMetrics } from "../lib/metrics";
import { CRIT_AT, WARN_AT } from "./ui";

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

/** Couleur d'une jauge : normale, à surveiller, critique (seuils communs à toute l'app). */
function tone(value: number): string {
  return value >= CRIT_AT ? "text-danger" : value >= WARN_AT ? "text-warn" : "text-fg";
}

/**
 * Petit monitoring sous le terminal : ressources du serveur de l'onglet actif, rafraîchies toutes
 * les 3 s tant que le terminal est affiché et le serveur connecté (jamais de connexion ouverte pour elle).
 */
export default function TerminalStatusBar({ serverId, visible }: { serverId: string; visible: boolean }) {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  // Relevé partagé avec la supervision : une seule requête par serveur, quel que soit le nombre de lecteurs.
  const { samples, error } = useMetrics(serverId, 3000, visible && !!server?.connected);
  const m = samples[samples.length - 1] ?? null;
  const failed = !!error;

  const live = server?.connected && m && !failed;
  const root = fullestDisk(m?.disks);
  const cpu = m?.cpuPercent ?? 0;
  const mem = m ? pct(m.memUsed, m.memTotal) : 0;
  const disk = root ? pct(root.used, root.total) : 0;

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-rail px-3 font-mono text-[11px] whitespace-nowrap text-muted">
      <span className="flex items-center gap-1.5">
        <span className="size-[7px] rounded-full" style={{ background: server?.color ?? "var(--color-accent)" }} />
        <span className="text-fg">{server?.name ?? "?"}</span>
      </span>
      {!server?.connected ? (
        <span>non connecté</span>
      ) : !live ? (
        <span>{failed ? "mesures indisponibles" : "mesure…"}</span>
      ) : (
        <>
          <span className="flex items-center gap-1" title={`Processeur (${m.cpuCount} cœurs)`}>
            <Cpu size={11} />
            <span className={tone(cpu)}>{cpu.toFixed(0)} %</span>
          </span>
          <span className="flex items-center gap-1" title={`Mémoire : ${formatBytes(m.memUsed)} / ${formatBytes(m.memTotal)}`}>
            <MemoryStick size={11} />
            <span className={tone(mem)}>{mem.toFixed(0)} %</span>
            <span>{formatBytes(m.memUsed)}</span>
          </span>
          {root && (
            <span className="flex items-center gap-1" title={`Disque ${root.mount} : ${formatBytes(root.used)} / ${formatBytes(root.total)}`}>
              <HardDrive size={11} />
              <span className={tone(disk)}>{disk.toFixed(0)} %</span>
            </span>
          )}
          <span title="Charge moyenne (1, 5, 15 min)">load {m.load.map((l) => l.toFixed(2)).join(" ")}</span>
          <span className="flex items-center gap-1" title="Débit réseau (réception, émission)">
            <ArrowDown size={11} />
            {formatBytes(m.netRxRate)}/s
            <ArrowUp size={11} />
            {formatBytes(m.netTxRate)}/s
          </span>
          <span className="flex items-center gap-1" title="Démarré depuis">
            <Timer size={11} />
            {formatDuration(m.uptimeSecs)}
          </span>
        </>
      )}
    </div>
  );
}
