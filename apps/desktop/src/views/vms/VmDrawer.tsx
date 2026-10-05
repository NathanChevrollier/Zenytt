// Fiche d'une machine virtuelle : système, adresses, disques, réseau et écran.
import { useEffect, useState } from "react";
import { ExternalLink, Lock } from "lucide-react";
import { api, errorMessage, type Vm, type VmDetail } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { formatMemory, stateLabel } from "../../lib/vm";
import { openVmScreen } from "../../lib/rdp";
import { Badge, Button, Drawer, ErrorState, KeyValue, Loading, MenuButton, Section, type MenuItem } from "../../components/ui";

export default function VmDrawer({ serverId, vm, onClose, menu }: { serverId: string; vm: Vm; onClose: () => void; menu: (vm: Vm) => MenuItem[] }) {
  const [detail, setDetail] = useState<VmDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [restricting, setRestricting] = useState(false);
  const { ask, notify } = useAppPick("ask", "notify");

  /** Écran VNC ouvert sur le réseau : on le limite à la boucle locale du serveur. */
  const restrict = async () => {
    const ok = await ask({
      title: `Restreindre l'écran de « ${vm.name} » à 127.0.0.1 ?`,
      body: "La définition de la VM est modifiée (virsh define). Le changement prend effet au prochain démarrage complet de la VM (arrêt puis démarrage, pas un simple redémarrage). Zenytt continuera d'afficher l'écran par son tunnel SSH.",
      confirmLabel: "Restreindre",
    });
    if (!ok) return;
    setRestricting(true);
    try {
      await api.vmVncRestrict(serverId, vm);
      notify(vm.state === "running" ? `Écran de « ${vm.name} » restreint : éteins puis rallume la VM pour l'appliquer.` : `Écran de « ${vm.name} » restreint à 127.0.0.1.`, "success");
      setReload((n) => n + 1);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setRestricting(false);
    }
  };

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    api.vmDetail(serverId, vm.uuid).then(
      (d) => alive && setDetail(d),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
    // L'état change (démarrage) : adresses IP et port d'écran aussi.
  }, [serverId, vm.uuid, vm.state, reload]);

  const s = stateLabel(vm.state);
  const g = detail?.graphics;

  return (
    <Drawer
      title={vm.name}
      subtitle={
        <span className="flex items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span>
            {vm.vcpus} vCPU · {formatMemory(vm.memoryKib)}
          </span>
        </span>
      }
      actions={<MenuButton size="sm" items={() => menu(vm)} />}
      onClose={onClose}
      width={520}
    >
      {error && <ErrorState message={error} />}
      {!detail && !error && <Loading rows={6} />}
      {detail && (
        <div className="flex flex-col gap-6">
          <Section title="Système">
            <KeyValue
              items={[
                ["UUID", <span className="font-mono text-xs">{vm.uuid}</span>],
                ["Type", detail.os],
                ["Machine", detail.machine || "—"],
                ["Micrologiciel", detail.firmware === "uefi" ? "UEFI" : "BIOS"],
                ["Démarrage auto", vm.autostart ? "oui, avec le serveur" : "non"],
              ]}
            />
          </Section>
          <Section title="Adresses IP">
            {detail.ips.length ? (
              <div className="flex flex-wrap gap-1.5">
                {detail.ips.map((ip) => (
                  <span key={ip} className="rounded bg-hover-strong px-2 py-0.5 font-mono text-xs select-text">
                    {ip}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">{vm.state === "running" ? "Aucune adresse connue (ni bail DHCP de libvirt, ni agent invité)." : "La VM est éteinte."}</p>
            )}
          </Section>
          <Section title="Disques" count={detail.disks.length}>
            <KeyValue items={detail.disks.map((d) => [<span className="font-mono">{d.target}</span>, <span className="font-mono text-xs">{d.device === "cdrom" ? "CD-ROM · " : ""}{d.source ?? "vide"}{d.format ? ` (${d.format})` : ""}</span>])} />
          </Section>
          <Section title="Réseau" count={detail.nics.length}>
            <KeyValue items={detail.nics.map((n) => [<span className="font-mono text-xs">{n.mac}</span>, `${n.source || "—"}${n.model ? ` · ${n.model}` : ""}`])} />
          </Section>
          <Section title="Écran">
            {g?.kind === "vnc" && (
              <div className="flex flex-col gap-2 text-[13px]">
                <span>
                  VNC {g.port ? <span className="font-mono">{`${g.listen}:${g.port}`}</span> : "(port attribué au démarrage)"}
                  {g.password ? " · protégé par mot de passe" : ""}
                </span>
                {g.public && (
                  <div className="flex flex-col items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 p-2.5">
                    <p className="text-xs text-warn">Écouté sur le réseau ({g.listen}) : d'autres peuvent s'y connecter. Zenytt, lui, passe par un tunnel SSH et n'a pas besoin de cette ouverture.</p>
                    <Button size="sm" icon={<Lock size={12} />} loading={restricting} onClick={() => void restrict()}>
                      Restreindre à 127.0.0.1
                    </Button>
                  </div>
                )}
              </div>
            )}
            {g?.kind === "spice" && (
              <div className="flex flex-col items-start gap-2 text-[13px]">
                <span>
                  SPICE {g.port ? <span className="font-mono">{`${g.listen}:${g.port}`}</span> : "(port attribué au démarrage)"}
                  {g.password ? " · protégé par mot de passe" : ""}
                </span>
                <p className="text-xs text-muted">Zenytt n'affiche pas le SPICE lui-même : l'écran s'ouvre dans remote-viewer (virt-viewer), par un tunnel SSH.</p>
                {vm.state === "running" && g.port && (
                  <Button size="sm" icon={<ExternalLink size={12} />} onClick={() => void openVmScreen(serverId, vm, "external")}>
                    Ouvrir dans le client du système
                  </Button>
                )}
              </div>
            )}
            {g?.kind === "none" && <p className="text-xs text-muted">Pas d'écran : utilise la console série.</p>}
            {g?.kind === "vncSocket" && <p className="text-xs text-muted">VNC sur un socket Unix : Zenytt ne peut pas l'afficher. Utilise la console série, ou fais écouter l'écran sur 127.0.0.1.</p>}
          </Section>
          <Section title="Console série">
            <p className="text-xs leading-relaxed text-muted">
              Si la console reste sur « Escape character is ^] » sans invite de connexion, le système de la VM n'ouvre pas de session sur son port série. Dans la VM :{" "}
              <code className="rounded bg-hover-strong px-1 font-mono select-text">sudo systemctl enable --now serial-getty@ttyS0</code>. Pour quitter la console : Ctrl+].
            </p>
          </Section>
        </div>
      )}
    </Drawer>
  );
}
