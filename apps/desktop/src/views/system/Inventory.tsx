// Inventaire : versions des composants installés et fraîcheur des images des conteneurs en marche.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api, errorMessage, type ContainerImage, type Inventory as InventoryData, type InventoryComponent } from "../../lib/api";
import { useCachedState } from "../../lib/cache";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, DataTable, Section, type Column } from "../../components/ui";

const mono = (s: string) => <span className="font-mono text-xs">{s || "—"}</span>;

export default function Inventory({ serverId }: { serverId: string }) {
  const notify = useApp((s) => s.notify);
  const [inv, setInv] = useCachedState<InventoryData | null>(`inventory:${serverId}`, null);
  const [images, setImages] = useCachedState<ContainerImage[] | null>(`inventory:images:${serverId}`, null);
  const [busy, setBusy] = useState<"inv" | "images" | null>(null);

  const loadInventory = useCallback(async () => {
    setBusy("inv");
    try {
      setInv(await api.systemInventory(serverId));
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  }, [serverId, notify, setInv]);

  // `check` interroge les registres : lent, donc déclenché à la main seulement.
  const loadImages = useCallback(
    async (check: boolean) => {
      setBusy("images");
      try {
        setImages(await api.dockerImagesCheck(serverId, check));
      } catch (e) {
        // Docker absent ou inaccessible : la liste reste vide, sans bruit au chargement.
        if (check) notify(errorMessage(e), "error");
        else setImages((prev) => prev ?? []);
      } finally {
        setBusy(null);
      }
    },
    [serverId, notify, setImages],
  );

  useEffect(() => {
    void loadInventory();
    void loadImages(false);
  }, [loadInventory, loadImages]);

  const goUpdates = () => document.getElementById("system-updates")?.scrollIntoView({ behavior: "smooth" });

  const componentColumns: Column<InventoryComponent>[] = [
    { key: "label", header: "Composant", render: (c) => c.label, sortValue: (c) => c.label },
    { key: "version", header: "Version installée", width: "minmax(0,1.5fr)", render: (c) => mono(c.version) },
    {
      key: "update",
      header: "Mise à jour",
      render: (c) =>
        !c.trackable ? (
          <span className="text-faint">—</span>
        ) : c.update ? (
          <button onClick={goUpdates} title="Voir la liste des mises à jour">
            <Badge tone="warn">{c.update} disponible</Badge>
          </button>
        ) : (
          <Badge tone={inv?.updatesKnown ? "ok" : "muted"}>{inv?.updatesKnown ? "à jour" : "inconnu"}</Badge>
        ),
    },
  ];

  const stateBadge = (i: ContainerImage) =>
    i.state === "updateAvailable" ? <Badge tone="warn">mise à jour dispo</Badge> :
    i.state === "upToDate" ? <Badge tone="ok">à jour</Badge> :
    i.state === "pinned" ? <Badge tone="accent">épinglée</Badge> :
    <Badge tone="muted">inconnu</Badge>;

  const imageColumns: Column<ContainerImage>[] = [
    {
      key: "container",
      header: "Projet / conteneur",
      render: (i) => (
        <span className="truncate">
          {i.project ? <span className="text-muted">{i.project} / </span> : null}
          {i.service ?? i.container}
        </span>
      ),
      sortValue: (i) => `${i.project ?? "~"}/${i.container}`,
    },
    { key: "image", header: "Image", width: "minmax(0,1.5fr)", render: (i) => mono(i.name), sortValue: (i) => i.name },
    {
      key: "tag",
      header: "Tag",
      render: (i) => (
        <span className="flex items-center gap-1.5">
          {mono(i.tag || "latest")}
          {i.floating && <Badge tone="warn" title="Tag flottant : l'image peut changer sans que la référence change">flottant</Badge>}
        </span>
      ),
    },
    { key: "state", header: "État", render: stateBadge },
  ];

  return (
    <>
      <Section
        title="Inventaire"
        count={inv?.components.length}
        description="Versions installées sur le serveur"
        actions={
          <Button size="sm" icon={<RefreshCw size={13} />} loading={busy === "inv"} onClick={() => void loadInventory()}>
            Actualiser
          </Button>
        }
      >
        <Card padded={false}>
          <div className="flex h-72 flex-col">
            <DataTable className="min-h-0 flex-1" rows={inv?.components ?? []} rowKey={(c) => c.id} columns={componentColumns} rowHeight={34} empty={inv ? "Rien de détecté." : "Chargement…"} />
          </div>
        </Card>
        {inv && !inv.updatesKnown && <p className="text-xs text-muted">Mises à jour inconnues : seuls apt et dnf sont pris en charge.</p>}
      </Section>

      <Section
        title="Images des conteneurs"
        count={images?.length}
        description="Conteneurs en marche, regroupés par projet compose"
        actions={
          <Button size="sm" icon={<Search size={13} />} loading={busy === "images"} disabled={!!busy} onClick={() => void loadImages(true)}>
            Vérifier les mises à jour d'images
          </Button>
        }
      >
        <Card padded={false}>
          <div className="flex h-72 flex-col">
            <DataTable
              className="min-h-0 flex-1"
              rows={[...(images ?? [])].sort((a, b) => (a.project ?? "~").localeCompare(b.project ?? "~") || a.container.localeCompare(b.container))}
              rowKey={(i) => i.container}
              columns={imageColumns}
              rowHeight={34}
              empty={images ? "Aucun conteneur en marche (ou Docker inaccessible)." : "Chargement…"}
            />
          </div>
        </Card>
        <p className="text-xs text-muted">
          La vérification compare l'empreinte locale à celle du registre (docker buildx requis sur le serveur, sinon « inconnu »). Rien n'est téléchargé.
        </p>
      </Section>
    </>
  );
}
