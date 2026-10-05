// Sessions de bureau à distance ouvertes dans Zenytt (clients RDP et VNC intégrés).
//
// La connexion part toujours du PC : directement, ou à travers un tunnel SSH monté par Zenytt quand
// la machine n'est joignable que depuis un serveur. Le pont local (côté Rust) parle le protocole
// de passerelle attendu par le client web ; l'interface ne connaît que l'adresse et le jeton.
import { create } from "zustand";
import { api, errorMessage, type DesktopView, type RdpSessionInfo, type VncSessionInfo } from "./api";
import { useApp } from "./store";
import type { SectionId } from "../sections";

/** VM dont l'écran est affiché (le bureau affiché porte alors l'identifiant `vm-<uuid>`). */
export interface VmTarget {
  serverId: string;
  uuid: string;
  name: string;
}

/** Étape de la session, pour l'affichage. */
export type RdpState = { kind: "ouverture" } | { kind: "connexion" } | { kind: "connecte" } | { kind: "erreur"; message: string } | { kind: "ferme"; message: string };

interface RdpStore {
  /** Bureau affiché, `null` quand aucune session n'est ouverte. */
  desktop: DesktopView | null;
  session: RdpSessionInfo | null;
  /** Session VNC : l'une ou l'autre est remplie, selon le protocole du bureau. */
  vnc: VncSessionInfo | null;
  state: RdpState;
  vm: VmTarget | null;
  /** Section d'où la session a été ouverte : l'écran ne recouvre qu'elle, les autres restent accessibles. */
  origin: SectionId | null;
  open: (desktop: DesktopView) => Promise<void>;
  /** Écran d'une VM : même client VNC, fermé comme un bureau (clé `vm-<uuid>`). */
  openVm: (serverId: string, vm: { uuid: string; name: string }) => Promise<void>;
  setState: (state: RdpState) => void;
  close: () => void;
}

export const useRdp = create<RdpStore>((set, get) => ({
  desktop: null,
  session: null,
  vnc: null,
  state: { kind: "ouverture" },
  vm: null,
  origin: null,

  open: async (desktop) => {
    // « Réessayer » sur l'écran d'une VM : on rouvre la VM, pas un bureau enregistré.
    const vm = get().vm;
    if (vm && desktop.id === `vm-${vm.uuid}`) return get().openVm(vm.serverId, vm);
    // Une seule session à la fois : la précédente est refermée proprement (pont et tunnel).
    const ouvert = get().desktop;
    if (ouvert) await api.desktopSessionClose(ouvert.id).catch(() => {});
    set({ desktop, session: null, vnc: null, vm: null, origin: useApp.getState().section, state: { kind: "ouverture" } });
    try {
      if (desktop.protocol === "vnc") {
        set({ vnc: await api.vncSessionOpen(desktop.id), state: { kind: "connexion" } });
        return;
      }
      const session = await api.desktopSessionOpen(desktop.id);
      set({ session, state: { kind: "connexion" } });
    } catch (e) {
      set({ state: { kind: "erreur", message: e instanceof Error ? e.message : String(e) } });
    }
  },

  openVm: async (serverId, vm) => {
    const ouvert = get().desktop;
    if (ouvert) await api.desktopSessionClose(ouvert.id).catch(() => {});
    const server = useApp.getState().servers.find((s) => s.id === serverId);
    // Bureau « virtuel » pour l'affichage : l'écran est joint sur la boucle locale du serveur.
    const desktop: DesktopView = {
      id: `vm-${vm.uuid}`,
      name: vm.name,
      protocol: "vnc",
      host: server ? `écran de la VM sur ${server.name}` : "écran de la VM",
      port: 0,
      username: "",
      viaServerId: serverId,
      fullscreen: false,
      multimon: false,
      redirectDrives: false,
      hasPassword: false,
    };
    set({ desktop, session: null, vnc: null, vm: { serverId, uuid: vm.uuid, name: vm.name }, origin: useApp.getState().section, state: { kind: "ouverture" } });
    try {
      const { session, warning } = await api.vmConsoleOpen(serverId, vm.uuid, vm.name);
      if (warning) useApp.getState().notify(warning, "warn");
      set({ vnc: session, state: { kind: "connexion" } });
    } catch (e) {
      // VM sans écran VNC (SPICE, aucun, éteinte) : l'écran se referme et l'explication, qui
      // propose la console série, s'affiche seule. Les conseils d'un bureau VNC n'ont pas de sens ici.
      set({ desktop: null, session: null, vnc: null, vm: null, origin: null, state: { kind: "ouverture" } });
      useApp.getState().notify(e instanceof Error ? e.message : String(e), "error");
    }
  },

  setState: (state) => set({ state }),

  close: () => {
    const ouvert = get().desktop;
    if (ouvert) void api.desktopSessionClose(ouvert.id).catch(() => {});
    set({ desktop: null, session: null, vnc: null, vm: null, origin: null, state: { kind: "ouverture" } });
  },
}));

/** Où s'ouvre l'écran d'une VM : dans Zenytt (VNC intégré) ou dans le client du système (remote-viewer). */
export type ScreenMode = "internal" | "external";

/** Ouvre l'écran d'une VM dans le mode choisi. Le client du système affiche aussi le SPICE. */
export async function openVmScreen(serverId: string, vm: { uuid: string; name: string }, mode: ScreenMode) {
  if (mode === "internal") return useRdp.getState().openVm(serverId, vm);
  const { notify } = useApp.getState();
  try {
    notify(await api.vmConsoleExternal(serverId, vm), "success");
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}
