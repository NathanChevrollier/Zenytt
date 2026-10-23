// Aides pures de la page Système : regroupement des mises à jour et des images, validation.
import type { ContainerImage, SystemUpdate } from "./api";

export type UpdateGroup = "kernel" | "libs" | "apps";
export const UPDATE_GROUP_LABEL: Record<UpdateGroup, string> = { kernel: "Noyau et démarrage", libs: "Bibliothèques", apps: "Applications et outils" };
const ORDER: UpdateGroup[] = ["kernel", "libs", "apps"];

/** Famille d'un paquet (apt : `linux-image-…`, dnf : `kernel-core.x86_64`). */
export function updateGroup(name: string): UpdateGroup {
  if (/^(linux-(image|headers|modules|generic|firmware)|kernel|grub|shim|firmware|initramfs|dracut)/.test(name)) return "kernel";
  if (/^lib/.test(name)) return "libs";
  return "apps";
}

/** Mises à jour triées par famille (noyau d'abord) puis par nom : `DataTable.groupBy` suit cet ordre. */
export function sortUpdates(list: SystemUpdate[]): SystemUpdate[] {
  return [...list].sort((a, b) => ORDER.indexOf(updateGroup(a.name)) - ORDER.indexOf(updateGroup(b.name)) || a.name.localeCompare(b.name));
}

/** Images triées par projet compose (conteneurs isolés à la fin) puis par service. */
export function sortImages(list: ContainerImage[]): ContainerImage[] {
  return [...list].sort((a, b) => (a.project ?? "￿").localeCompare(b.project ?? "￿") || (a.service ?? a.container).localeCompare(b.service ?? b.container));
}

/** Nom d'hôte valide (RFC 1123, une seule étiquette) : lettres, chiffres, tirets, 63 caractères au plus. */
export function validHostname(name: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name);
}

/** « 14:30 » aujourd'hui, « 24/10 14:30 » un autre jour. */
export function formatAt(unixSecs: number, now = new Date()): string {
  const d = new Date(unixSecs * 1000);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time}`;
}
