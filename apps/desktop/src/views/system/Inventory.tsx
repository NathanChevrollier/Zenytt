// Inventaire : versions des composants installés et fraîcheur des images des conteneurs en marche.
import { useCallback, useEffect, useState } from "react";
import { Boxes, Loader2, RefreshCw, Search } from "lucide-react";
import { api, errorMessage, type ContainerImage, type Inventory as InventoryData, type InventoryComponent } from "../../lib/api";
import { sortImages } from "../../lib/system";
import { useCachedState } from "../../lib/cache";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, FOCUS_RING, Loading, ResultBanner, Section, type Column } from "../../components/ui";

const mono = (s: string) => <span className="truncate font-mono text-xs">{s || "—"}</span>;

export default function Inventory({ serverId, onShowUpdates }: { serverId: string; onShowUpdates: () => void }) {
  const notify = useApp((s) => s.notify);
  const [inv, setInv] = useCachedState<InventoryData | null>(`inventory:${serverId}`, null);
  const [images, setImages] = useCachedState<ContainerImage[] | null>(`inventory:images:${serverId}`, null);
  const [checked, setChecked] = useCachedState(`inventory:images-checked:${serverId}`, false);
  const [invError, setInvError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inv" | "images" | null>(null);

  const loadInventory = useCallback(async () => {
    setBusy("inv");
    try {
      setInv(await api.systemInventory(serverId));
      setInvError(null);
    } catch (e) {
      setInvError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [serverId, setInv]);

  // `check` interroge les registres : lent, donc déclenché à la main seulement.
  const loadImages = useCallback(
    async (check: boolean) => {
      setBusy("images");
      try {
        setImages(await api.dockerImagesCheck(serverId, check));
        if (check) setChecked(true);
      } catch (e) {
        // Docker absent ou inaccessible : la liste reste vide, sans bruit au chargement.
        if (check) notify(errorMessage(e), "error");
        else setImages((prev) => prev ?? []);
      } finally {
        setBusy(null);
      }
    },
    [serverId, notify, setImages, setChecked],
  );

  // Une liste déjà vérifiée (cache) est gardée : la relire sans `check` effacerait les verdicts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void loadInventory();
    if (!checked) void loadImages(false);
  }, [loadInventory, loadImages]);

  const status = (c: InventoryComponent) =>
    !c.trackable ? (
      <Badge title="Aucun paquet associé : pas de verdict">non suivi</Badge>
    ) : c.update ? (
      <button type="button" onClick={onShowUpdates} title={`${c.update} disponible : voir les mises à jour`} className={`rounded-full ${FOCUS_RING}`}>
        <Badge tone="warn">mise à jour dispo</Badge>
      </button>
    ) : inv?.updatesKnown ? (
      <Badge tone="ok">à jour</Badge>
    ) : (
      <Badge title="Seuls apt et dnf sont pris en charge">inconnu</Badge>
    );

  const stateBadge = (i: ContainerImage) =>
    i.state === "updateAvailable" ? <Badge tone="warn">mise à jour dispo</Badge> :
    i.state === "upToDate" ? <Badge tone="ok">à jour</Badge> :
    i.state === "pinned" ? <Badge tone="accent" title="Référencée par empreinte (@sha256) : elle ne change jamais">épinglée</Badge> :
    checked ? <Badge title="Empreinte du registre illisible (docker buildx absent, ou image construite localement)">inconnu</Badge> :
    <Badge title="Lance « Vérifier les images » pour comparer au registre">non vérifiée</Badge>;

  const imageColumns: Column<ContainerImage>[] = [
    { key: "container", header: "Service", width: "minmax(0,1fr)", render: (i) => <span className="truncate">{i.service ?? i.container}</span>, sortValue: (i) => i.service ?? i.container },
    { key: "image", header: "Image", width: "minmax(0,1.6fr)", render: (i) => mono(i.name), sortValue: (i) => i.name },
    {
      key: "tag",
      header: "Tag",
      width: "minmax(0,1fr)",
      render: (i) => (
        <span className="flex min-w-0 items-center gap-1.5">
          {mono(i.tag || "latest")}
          {i.floating && <Badge tone="warn" title="Tag flottant : l'image peut changer sans que la référence change">flottant</Badge>}
        </span>
      ),
    },
    { key: "state", header: "État", width: "140px", render: stateBadge },
  ];

  const unknown = checked ? (images ?? []).filter((i) => i.state === "unknown").length : 0;
  const outdated = (images ?? []).filter((i) => i.state === "updateAvailable").length;

  return (
    <>
      <Section
        title="Composants"
        count={inv?.components.length}
        description="Versions installées sur le serveur"
        actions={
          <Button size="sm" icon={<RefreshCw size={13} />} loading={busy === "inv"} disabled={busy === "images"} onClick={() => void loadInventory()}>
            Actualiser
          </Button>
        }
      >
        {invError && !inv ? (
          <ErrorState message={invError} onRetry={() => void loadInventory()} />
        ) : !inv ? (
          <Loading rows={3} />
        ) : inv.components.length === 0 ? (
          <Card>
            <EmptyState title="Rien de détecté">Aucun composant connu (nginx, Docker, bases de données…) n'est installé.</EmptyState>
          </Card>
        ) : (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            {inv.components.map((c) => (
              <Card key={c.id} className="flex min-w-0 flex-col gap-1.5 !px-3.5 !py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-medium">{c.label}</span>
                  {status(c)}
                </div>
                <span className="truncate font-mono text-xs text-muted" title={c.update ? `${c.version} → ${c.update}` : c.version}>
                  {c.version || "—"}
                  {c.update && <span className="text-warn"> → {c.update}</span>}
                </span>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Images des conteneurs"
        count={images?.length}
        description={checked && outdated ? `${outdated} à mettre à jour` : "Conteneurs en marche, par projet compose"}
        actions={
          <Button size="sm" icon={<Search size={13} />} loading={busy === "images"} disabled={!!busy || !images?.length} onClick={() => void loadImages(true)}>
            Vérifier les images
          </Button>
        }
      >
        {busy === "images" && images?.length ? (
          <ResultBanner tone="accent" title={`Interrogation des registres pour ${images.length} image${images.length > 1 ? "s" : ""}…`}>
            <span className="flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" />
              Comparaison des empreintes, rien n'est téléchargé.
            </span>
          </ResultBanner>
        ) : unknown > 0 ? (
          <ResultBanner tone="warn" title={`${unknown} image${unknown > 1 ? "s" : ""} à l'état inconnu`}>
            Le registre n'a pas pu être lu : installe docker buildx sur le serveur, ou l'image a été construite localement.
          </ResultBanner>
        ) : null}
        {!images ? (
          <Loading rows={4} />
        ) : images.length === 0 ? (
          <Card>
            <EmptyState icon={<Boxes />} title="Aucun conteneur en marche">
              Ou Docker n'est pas accessible sur ce serveur.
            </EmptyState>
          </Card>
        ) : (
          <Card padded={false} className="overflow-hidden">
            <div className="flex max-h-[min(60vh,560px)] flex-col">
              <DataTable
                className="min-h-0 flex-1"
                rows={sortImages(images)}
                rowKey={(i) => i.container}
                columns={imageColumns}
                rowHeight={34}
                groupBy={{
                  key: (i) => i.project ?? "",
                  header: (k, list) => {
                    const n = list.filter((i) => i.state === "updateAvailable").length;
                    return (
                      <div className="flex h-8 items-center gap-2 border-b border-border bg-subtle px-3 text-xs">
                        <span className={`font-semibold ${k ? "" : "text-muted"}`}>{k || "Hors compose"}</span>
                        <span className="text-faint">{list.length}</span>
                        {n > 0 && <Badge tone="warn" className="ml-auto">{n} à mettre à jour</Badge>}
                      </div>
                    );
                  },
                }}
              />
            </div>
          </Card>
        )}
        {!checked && images && images.length > 0 && (
          <p className="text-xs text-muted">La vérification compare l'empreinte locale à celle du registre (docker buildx requis sur le serveur). Rien n'est téléchargé.</p>
        )}
      </Section>
    </>
  );
}
