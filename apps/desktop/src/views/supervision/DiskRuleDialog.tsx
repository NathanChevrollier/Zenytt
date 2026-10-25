// Réglage d'un point de montage : l'écarter des alertes, ou saisir sa vraie taille.
//
// Cas typique : un hébergement mutualisé, dont la racine vue par `df` est une image en lecture
// seule de quelques Go, pleine par nature, alors que l'espace de l'abonnement est ailleurs (quota).
import { useState } from "react";
import { api, errorMessage, formatBytes, type Disk, type DiskRule } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Button, Checkbox, Field, Input, Modal } from "../../components/ui";

const GB = 1024 ** 3;

/** « 50 », « 50 Go », « 1,5 To », « 800 Mo » → octets ; vide → null. */
export function parseSize(text: string): number | null | undefined {
  const t = text.trim().replace(",", ".").toLowerCase();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(o|ko|k|mo|m|go|g|to|t|b|kb|mb|gb|tb)?$/.exec(t);
  if (!m) return undefined;
  const unit = m[2] ?? "go";
  const mult: Record<string, number> = { o: 1, b: 1, ko: 1024, k: 1024, kb: 1024, mo: 1024 ** 2, m: 1024 ** 2, mb: 1024 ** 2, go: GB, g: GB, gb: GB, to: 1024 ** 4, t: 1024 ** 4, tb: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * mult[unit]);
}

const toGb = (v: number | null | undefined) => (v == null ? "" : String(Math.round((v / GB) * 100) / 100));

export default function DiskRuleDialog({ serverId, disk, rule, onClose, onSaved }: { serverId: string; disk: Disk; rule?: DiskRule; onClose: () => void; onSaved: () => void }) {
  const { notify } = useAppPick("notify");
  const [ignore, setIgnore] = useState(rule?.ignore ?? false);
  const [total, setTotal] = useState(toGb(rule?.total));
  const [used, setUsed] = useState(toGb(rule?.used));
  const [busy, setBusy] = useState(false);
  const totalBytes = parseSize(total);
  const usedBytes = parseSize(used);
  const invalid = totalBytes === undefined || usedBytes === undefined || (totalBytes != null && usedBytes != null && usedBytes > totalBytes);

  const save = async (next: DiskRule) => {
    setBusy(true);
    try {
      const agentUpdated = await api.diskRuleSave(next);
      notify(agentUpdated ? `Réglage de ${disk.mount} enregistré, et transmis à l'agent zenyttd.` : `Réglage de ${disk.mount} enregistré.`, "success");
      onSaved();
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Point de montage ${disk.mount}`}
      description={`${disk.device} · ${formatBytes(disk.used)} / ${formatBytes(disk.total)} lus par df${disk.readOnly ? " · lecture seule" : ""}`}
      width="max-w-lg"
      onClose={onClose}
      footer={
        <>
          {rule && (
            <Button variant="ghost" disabled={busy} onClick={() => void save({ serverId, mount: disk.mount, ignore: false, total: null, used: null })}>
              Réinitialiser
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={busy} disabled={invalid} onClick={() => void save({ serverId, mount: disk.mount, ignore, total: totalBytes ?? null, used: usedBytes ?? null })}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {disk.readOnly && (
          <p className="rounded-lg border border-border bg-subtle p-2.5 text-xs leading-relaxed text-muted">
            Ce système de fichiers est en lecture seule : il paraît plein par nature (image système d'un hébergement mutualisé, snap, ISO…). Zenytt ne le compte déjà plus dans l'alerte « Disque ».
          </p>
        )}
        <Checkbox checked={ignore} onChange={setIgnore} label="Ignorer ce point de montage dans les alertes" hint="Toujours affiché, mais ne déclenche plus l'alerte « Disque » (l'agent zenyttd suit ce réglage s'il est installé)." />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Capacité réelle" hint="Ex. 50 Go (vide : valeur de df)" error={totalBytes === undefined ? "Taille illisible" : undefined}>
            <Input value={total} onChange={(e) => setTotal(e.target.value)} placeholder={toGb(disk.total)} inputMode="decimal" />
          </Field>
          <Field
            label="Espace utilisé"
            hint="Ex. 2,5 Go (vide : valeur de df)"
            error={usedBytes === undefined ? "Taille illisible" : usedBytes != null && totalBytes != null && usedBytes > totalBytes ? "Plus grand que la capacité" : undefined}
          >
            <Input value={used} onChange={(e) => setUsed(e.target.value)} placeholder={toGb(disk.used)} inputMode="decimal" />
          </Field>
        </div>
        <p className="text-xs leading-relaxed text-faint">
          Les tailles saisies remplacent celles lues sur le serveur dans Zenytt (jauges, accueil), utile quand l'hébergeur applique un quota que df ne voit pas. Sans unité, la valeur est en Go.
        </p>
      </div>
    </Modal>
  );
}
