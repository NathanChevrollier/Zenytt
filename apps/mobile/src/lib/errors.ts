// Les commandes Rust renvoient des chaînes dont le préfixe indique l'action attendue de l'utilisateur.

export type Problem =
  | { kind: "unknownHost"; fingerprint: string }
  | { kind: "hostChanged" }
  | { kind: "needAuth"; message: string }
  | { kind: "authFailed"; message: string }
  | { kind: "other"; message: string };

export function classify(error: string): Problem {
  if (error.startsWith("UNKNOWN_HOST_KEY:")) return { kind: "unknownHost", fingerprint: error.slice("UNKNOWN_HOST_KEY:".length) };
  if (error.startsWith("HOST_KEY_MISMATCH:")) return { kind: "hostChanged" };
  if (error.startsWith("NEED_PASSWORD:")) return { kind: "needAuth", message: error.slice("NEED_PASSWORD:".length).trim() };
  if (error.includes("aucune clé privée")) return { kind: "needAuth", message: "aucune clé privée enregistrée sur ce téléphone" };
  if (error.startsWith("AUTH_BLOCKED:") || error.startsWith("Authentification échouée")) return { kind: "authFailed", message: error };
  return { kind: "other", message: error };
}
