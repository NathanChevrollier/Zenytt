// Logiciels : versions installées des composants, paquets en attente (par famille, application en une
// fois avec le journal) et fraîcheur des images des conteneurs en marche, sur un seul écran.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Download, Loader2, RefreshCw, Search, X } from "lucide-react";
import { api, errorMessage, type ContainerImage, type Inventory as InventoryData, type InventoryComponent, type SystemUpdate } from "../../lib/api";
import { sortImages, sortUpdates, updateGroup, UPDATE_GROUP_LABEL, type UpdateGroup } from "../../lib/system";
import { useCachedState } from "../../lib/cache";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, CodeBlock, DataTable, ErrorState, FOCUS_RING, IconButton, Loading, ResultBanner, Section, type Column } from "../../components/ui";

const mono = (s: string, cls = "") => <span className={`truncate font-mono text-xs ${cls}`}>{s || "—"}</span>;
const GROUPS: UpdateGroup[] = ["kernel", "libs", "apps"];

const updateColumns: Column<SystemUpdate>[] = [
  { key: "name", header: "Paquet", width: "minmax(0,1.3fr)", render: (u) => mono(u.name), sortValue: (u) => u.name },
  { key: "current", header: "Installée", width: "minmax(0,1fr)", render: (u) => mono(u.current, "text-muted") },
  { key: "candidate", header: "Disponible", width: "minmax(0,1fr)", render: (u) => mono(u.candidate) },
];

export default function Software({
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
  /** Relit les index des paquets puis la liste. */
  refresh: () => Promise<void>;
  onApplied: () => void;
}) {
  const { ask, notify } = useApp.getState();
  const [inv, setInv] = useCachedState<InventoryData | null>(`inventory:${serverId}`, null);
  const [images, setImages] = useCachedState<ContainerImage[] | null>(`inventory:images:${serverId}`, null);
  const [checked, setChecked] = useCachedState(`inventory:images-checked:${serverId}`, false);
  const [invError, setInvError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inv" | "images" | null>(null);
  const [applying, setApplying] = useState(false);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  /** Composant choisi dans le tableau : la liste des paquets ne montre que sa mise à jour. */
  const [focus, setFocus] = useState<InventoryComponent | null>(null);
  const packagesRef = useRef<HTMLDivElement>(null);
  const n = updates?.length ?? 0;

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

  const refreshAll = async () => {
    await refresh();
    await loadInventory();
  };

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
    setFocus(null);
    try {
      setOutput({ ok: true, text: await api.systemApplyUpdates(serverId) });
      notify("Mises à jour appliquées", "success");
      onApplied();
      void loadInventory();
    } catch (e) {
      setOutput({ ok: false, text: errorMessage(e) });
      notify("Échec des mises à jour", "error");
    } finally {
      setApplying(false);
    }
  };

  const showPackage = (c: InventoryComponent) => {
    setFocus(c);
    packagesRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  // Le cœur associe un composant à la version candidate de son paquet : même critère ici.
  const focused = focus && updates?.some((u) => u.candidate === focus.update) ? focus : null;
  const packageRows = updates ? sortUpdates(focused ? updates.filter((u) => u.candidate === focused.update) : updates) : [];

  const available = (c: InventoryComponent) =>
    c.update ? (
      <button
        type="button"
        onClick={() => showPackage(c)}
        title="Voir le paquet dans la liste des mises à jour"
        className={`flex min-w-0 items-center gap-1 rounded text-warn hover:underline ${FOCUS_RING}`}
      >
        <ArrowRight size={12} className="shrink-0" />
        {mono(c.update)}
      </button>
    ) : !c.trackable ? (
      <Badge title="Aucun paquet associé : pas de verdict">non suivi</Badge>
    ) : inv?.updatesKnown ? (
      <Badge tone="ok">à jour</Badge>
    ) : (
      <Badge title="Seuls apt et dnf sont pris en charge">inconnu</Badge>
    );

  const componentColumns: Column<InventoryComponent>[] = [
    { key: "label", header: "Composant", width: "minmax(0,1fr)", render: (c) => <span className="truncate font-medium">{c.label}</span>, sortValue: (c) => c.label },
    { key: "version", header: "Installée", width: "minmax(0,1.3fr)", render: (c) => mono(c.version, "text-muted") },
    { key: "update", header: "Mise à jour", width: "minmax(0,1.2fr)", render: available, sortValue: (c) => (c.update ? 0 : 1) },
  ];

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
  const perGroup = GROUPS.map((g) => [g, updates?.filter((u) => updateGroup(u.name) === g).length ?? 0] as const);
  const kernel = perGroup[0][1];
  // Message du cœur (`parse_updates`) quand le serveur n'a ni apt ni dnf.
  const unsupported = !!error?.includes("apt et dnf");

  const components = (
    <Section title="Composants" count={inv?.components.length} description="Versions installées">
      {invError && !inv ? (
        <ErrorState message={invError} onRetry={() => void loadInventory()} />
      ) : !inv ? (
        <Loading rows={3} />
      ) : inv.components.length === 0 ? (
        <Card className="text-[13px] text-muted">Aucun composant connu (nginx, Docker, bases de données…) n'est installé.</Card>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <DataTable rows={inv.components} rowKey={(c) => c.id} columns={componentColumns} rowHeight={32} stickyHeader={false} />
        </Card>
      )}
    </Section>
  );

  const imagesSection = (
    <Section
      title="Images des conteneurs"
      count={images?.length}
      description={checked && outdated ? `${outdated} à mettre à jour` : "Conteneurs en marche, par projet compose"}
      actions={
        <Button
          size="sm"
          title="Compare l'empreinte locale à celle du registre (docker buildx requis sur le serveur), sans rien télécharger"
          icon={<Search size={13} />}
          loading={busy === "images"}
          disabled={!!busy || !images?.length}
          onClick={() => void loadImages(true)}
        >
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
        <Card className="text-[13px] text-muted">Aucun conteneur en marche, ou Docker n'est pas accessible sur ce serveur.</Card>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="flex max-h-[max(18rem,calc(100vh-15rem))] flex-col">
            <DataTable
              className="min-h-0 flex-1"
              rows={sortImages(images)}
              rowKey={(i) => i.container}
              columns={imageColumns}
              rowHeight={34}
              groupBy={{
                key: (i) => i.project ?? "",
                header: (k, list) => {
                  const m = list.filter((i) => i.state === "updateAvailable").length;
                  return (
                    <div className="flex h-8 items-center gap-2 border-b border-border bg-subtle px-3 text-xs">
                      <span className={`font-semibold ${k ? "" : "text-muted"}`}>{k || "Hors compose"}</span>
                      <span className="text-faint">{list.length}</span>
                      {m > 0 && (
                        <Badge tone="warn" className="ml-auto">
                          {m} à mettre à jour
                        </Badge>
                      )}
                    </div>
                  );
                },
              }}
            />
          </div>
        </Card>
      )}
    </Section>
  );

  // Paquets : seulement s'il y en a (ou si la liste est en erreur) ; « système à jour » tient dans la barre.
  const packages =
    error && !updates && !unsupported ? (
      <ErrorState message={error} onRetry={() => void refreshAll()} />
    ) : n > 0 ? (
      <Section
        title="Paquets à mettre à jour"
        count={focused ? `${packageRows.length} / ${n}` : n}
        actions={
          focused && (
            <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => setFocus(null)}>
              {focused.label} · tout afficher
            </Button>
          )
        }
      >
        <Card padded={false} className="overflow-hidden">
          <div className="flex max-h-[max(18rem,calc(100vh-15rem))] flex-col">
            <DataTable
              className="min-h-0 flex-1"
              rows={packageRows}
              rowKey={(u) => u.name}
              columns={updateColumns}
              rowHeight={32}
              groupBy={{
                key: (u) => updateGroup(u.name),
                header: (k, list) => (
                  <div className="flex h-8 items-center gap-2 border-b border-border bg-subtle px-3 text-xs">
                    <span className="font-semibold">{UPDATE_GROUP_LABEL[k as UpdateGroup]}</span>
                    <span className="text-faint">{list.length}</span>
                  </div>
                ),
              }}
            />
          </div>
        </Card>
      </Section>
    ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Barre d'état : bilan des paquets, familles, et les deux actions de l'onglet. */}
      <Card padded={false} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">
            {unsupported ? "Mises à jour indisponibles" : !updates ? "Mises à jour…" : n ? `${n} mise${n > 1 ? "s" : ""} à jour disponible${n > 1 ? "s" : ""}` : "Système à jour"}
          </h2>
          <p className="text-xs text-muted">
            {unsupported ? `Seuls apt et dnf sont pris en charge${packageManager ? ` (ce serveur utilise ${packageManager})` : ""}` : packageManager ? `Paquets ${packageManager}` : "Paquets du système"}
            {checked && outdated ? ` · ${outdated} image${outdated > 1 ? "s" : ""} à mettre à jour` : ""}
          </p>
        </div>
        {n > 0 && (
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {perGroup.map(([g, k]) => (
              <div key={g} className="flex items-baseline gap-1.5">
                <dt className="text-muted">{UPDATE_GROUP_LABEL[g]}</dt>
                <dd className={`font-medium tabular-nums ${k ? "" : "text-faint"}`}>{k}</dd>
              </div>
            ))}
          </dl>
        )}
        {kernel > 0 && <p className="text-xs text-warn">Noyau concerné : redémarrage à prévoir.</p>}
        <div className="ml-auto flex items-center gap-1.5">
          <IconButton title="Actualiser : relit les index des paquets, la liste et les versions" disabled={checking || applying || busy === "inv"} onClick={() => void refreshAll()}>
            <RefreshCw size={15} className={checking || busy === "inv" ? "animate-spin" : ""} />
          </IconButton>
          <Button variant="primary" icon={<Download size={14} />} loading={applying} disabled={!n || checking} onClick={() => void apply()}>
            Tout appliquer
          </Button>
        </div>
      </Card>

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
          <ResultBanner
            tone={output.ok ? "ok" : "danger"}
            title={output.ok ? "Mises à jour appliquées" : "Les mises à jour ont échoué"}
            action={
              <Button size="sm" variant="ghost" onClick={() => setOutput(null)}>
                Masquer
              </Button>
            }
          >
            {output.ok ? "Journal de la commande (200 dernières lignes) :" : undefined}
          </ResultBanner>
          <CodeBlock code={output.text.split("\n").slice(-200).join("\n")} className="max-h-80 overflow-auto" />
        </div>
      )}

      {/* Large : composants et images à gauche, paquets à droite ; sans paquets, composants | images. */}
      <div className="grid min-w-0 items-start gap-5 @7xl:grid-cols-2">
        {packages ? (
          <>
            <div className="flex min-w-0 flex-col gap-5">
              {components}
              {imagesSection}
            </div>
            <div ref={packagesRef} className="min-w-0 scroll-mt-4 @7xl:sticky @7xl:top-0">
              {packages}
            </div>
          </>
        ) : (
          <>
            {components}
            {imagesSection}
          </>
        )}
      </div>
    </div>
  );
}
