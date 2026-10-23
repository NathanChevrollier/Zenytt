import { create } from "zustand";
import { api } from "./api";

/**
 * Verrouillage de l'app : Zenytt ouvert donne accès (souvent root) à tous les serveurs.
 * Le mot de passe n'est jamais stocké, seulement son empreinte PBKDF2, dans le coffre de l'OS.
 * Les connexions et terminaux continuent de tourner derrière l'écran de verrouillage.
 */
interface LockState {
  /** Un mot de passe de verrouillage est défini. */
  configured: boolean;
  locked: boolean;
  /** L'état initial a été lu : avant, rien ne doit être chargé (Zenytt peut démarrer verrouillé). */
  checked: boolean;
  refresh: () => Promise<void>;
  lock: () => void;
  unlock: (password: string) => Promise<boolean>;
}

const ITERATIONS = 200_000;

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Empreinte au format `pbkdf2$itérations$sel$empreinte`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, iter, salt, hash] = stored.split("$");
  if (kind !== "pbkdf2" || !iter || !salt || !hash) return false;
  const got = await derive(password, fromB64(salt), Number(iter));
  const want = fromB64(hash);
  // Comparaison en temps constant.
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export const useLock = create<LockState>((set, get) => ({
  configured: false,
  locked: false,
  checked: false,
  refresh: async () => {
    const stored = await api.appLockGet().catch(() => null);
    // L'état « verrouillé » vit côté Rust : un rechargement de l'interface ne l'efface pas.
    const locked = await api.appIsLocked().catch(() => false);
    set({ configured: !!stored, locked: (get().locked || locked) && !!stored, checked: true });
  },
  lock: () => {
    if (!get().configured) return;
    set({ locked: true });
    void api.appLockEngage().catch(() => {});
  },
  unlock: async (password) => {
    // Vérification faite côté Rust, qui seul lève le verrou.
    const ok = await api.appUnlock(password).catch(() => false);
    if (ok) set({ locked: false });
    return ok;
  },
}));

/** Verrouille après `minutes()` minutes sans clavier ni souris (0 : jamais). Renvoie la fonction d'arrêt. */
export function watchInactivity(minutes: () => number): () => void {
  let last = Date.now();
  const touch = () => {
    last = Date.now();
  };
  const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
  for (const e of events) window.addEventListener(e, touch, { passive: true, capture: true });
  const id = setInterval(() => {
    const m = minutes();
    if (m > 0 && Date.now() - last > m * 60_000) useLock.getState().lock();
  }, 15_000);
  return () => {
    clearInterval(id);
    for (const e of events) window.removeEventListener(e, touch, { capture: true });
  };
}
