// Onglet « Activité » : services systemd (à gauche) et tâches planifiées (à droite) sur un écran.
// Le journal d'un service et la liste complète des processus s'ouvrent dans des tiroirs.
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { Cpu } from "lucide-react";
import { Button } from "../../components/ui";
import Services, { type ServiceList } from "./Services";
import ScheduleView from "./Schedule";

export default function Activity({
  serverId,
  services,
  setServices,
  procCount,
  onAllProcesses,
  focusSchedule,
}: {
  serverId: string;
  services: ServiceList;
  setServices: Dispatch<SetStateAction<ServiceList>>;
  procCount: number | null;
  onAllProcesses: () => void;
  /** Change à chaque lien vers les tâches planifiées : la colonne se fait défiler à l'écran. */
  focusSchedule: number;
}) {
  const scheduleRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusSchedule) scheduleRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusSchedule]);

  return (
    // Large : deux colonnes qui défilent chacune ; étroit : une colonne, la liste des services bornée.
    <div className="@container flex min-h-0 w-full flex-1">
      <div className="grid min-h-0 w-full flex-1 overflow-auto @min-[1100px]:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)] @min-[1100px]:overflow-hidden">
        <div className="flex h-[70vh] min-h-0 min-w-0 flex-col @min-[1100px]:h-auto">
          <Services
            serverId={serverId}
            list={services}
            setList={setServices}
            extra={
              <Button size="sm" icon={<Cpu size={13} />} onClick={onAllProcesses}>
                Tous les processus{procCount ? ` (${procCount})` : ""}…
              </Button>
            }
          />
        </div>
        <section ref={scheduleRef} aria-label="Tâches planifiées" className="min-h-0 min-w-0 border-t border-border px-5 py-3 @min-[1100px]:overflow-auto @min-[1100px]:border-t-0 @min-[1100px]:border-l">
          <ScheduleView serverId={serverId} />
        </section>
      </div>
    </div>
  );
}
