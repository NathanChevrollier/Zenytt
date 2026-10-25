import { useApp } from "./store";

/** Raccourcis de Zenytt, modifiables dans Réglages → Raccourcis clavier. */
export const SHORTCUTS = {
  palette: { label: "Palette de commandes", default: "Ctrl+K" },
  switcher: { label: "Changer de serveur", default: "Ctrl+Shift+S" },
  shortcutsHelp: { label: "Aide-mémoire des raccourcis", default: "F1" },
  lock: { label: "Verrouiller Zenytt", default: "Ctrl+Shift+L" },
  newTab: { label: "Nouvel onglet de terminal", default: "Ctrl+Shift+T" },
  closeTab: { label: "Fermer l'onglet de terminal", default: "Ctrl+Shift+W" },
  nextTab: { label: "Onglet suivant", default: "Ctrl+Tab" },
  prevTab: { label: "Onglet précédent", default: "Ctrl+Shift+Tab" },
  termSearch: { label: "Rechercher dans le terminal", default: "Ctrl+Shift+F" },
  termHistory: { label: "Historique des commandes du serveur", default: "Ctrl+Shift+R" },
  assistant: { label: "Ouvrir l'assistant IA", default: "Ctrl+I" },
  machines: { label: "Sessions ouvertes (écrans distants, terminaux)", default: "Ctrl+Shift+M" },
  quit: { label: "Quitter Zenytt", default: "Ctrl+Q" },
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Combinaison d'une touche, indépendante de la disposition du clavier (« Ctrl+Shift+K »). */
export function comboOf(e: KeyboardEvent): string | null {
  const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.code;
  if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) return null;
  const parts = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", key].filter(Boolean);
  return parts.join("+");
}

export function shortcutOf(id: ShortcutId): string {
  return useApp.getState().settings.shortcuts?.[id] ?? SHORTCUTS[id].default;
}

export function matches(e: KeyboardEvent, id: ShortcutId): boolean {
  return e.type === "keydown" && comboOf(e) === shortcutOf(id);
}

/** Raccourci de l'app (à ne pas transmettre au shell quand un terminal a le focus). */
export function isAppShortcut(e: KeyboardEvent): boolean {
  const c = comboOf(e);
  return !!c && (Object.keys(SHORTCUTS) as ShortcutId[]).some((id) => shortcutOf(id) === c);
}

/** Affichage lisible (« Ctrl+Maj+K »). */
export function display(combo: string): string {
  return combo.replace("Shift", "Maj");
}
