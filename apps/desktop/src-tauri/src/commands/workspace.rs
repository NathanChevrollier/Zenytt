//! Espace de travail : état de l'interface, journal d'actions et sessions tmux.

use tauri::State;
use zenytt_core::tmux::{self, Session};
use zenytt_profiles::audit::Entry;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub fn ui_state_get(store: State<'_, Store>) -> serde_json::Value {
    store.read(|d| d.ui_state.clone())
}

/// Ouvre le dossier des journaux de Zenytt dans l'explorateur.
#[tauri::command]
pub fn logs_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<String>).map_err(|e| e.to_string())
}

/// Zenytt est verrouillé. Gardé côté Rust : recharger l'interface (F5) ne déverrouille pas.
static LOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Commandes permises quand Zenytt est verrouillé : de quoi afficher l'écran de verrouillage et
/// le lever. Tout le reste est refusé par `lib.rs` avant d'atteindre la commande : sans cela, le
/// verrou ne serait qu'un calque d'interface, contournable depuis les outils de développement.
pub const ALLOWED_WHILE_LOCKED: &[&str] = &[
    "app_version",
    "app_is_locked",
    // Présence seule du mot de passe (jamais l'empreinte) : l'interface relancée verrouillée en a besoin.
    "app_lock_get",
    "app_unlock",
    "app_lock_engage",
    "ui_state_get",
    "store_warning",
    "app_notices",
    "term_resize",
    "app_ui_ready",
    "app_hide",
    "app_quit",
];

/// Vrai si Zenytt est verrouillé (mot de passe défini et verrou engagé).
pub fn is_locked() -> bool {
    LOCKED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Un seul essai de déverrouillage à la fois : lancer des essais en parallèle ne contourne pas
/// le délai imposé après un échec.
static UNLOCK_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Au moins autant d'itérations que l'interface en utilise (200 000) à 50 % près : une empreinte
/// faible, fabriquée à la main, est refusée.
const MIN_LOCK_ITERATIONS: u32 = 100_000;

/// Verrouillage configuré ? L'empreinte (PBKDF2, calculée par l'interface, conservée dans le
/// coffre de l'OS) ne quitte plus le backend : l'interface n'a besoin que de savoir qu'elle existe,
/// et la vérification se fait ici (`app_unlock`). `None` : verrouillage désactivé.
#[tauri::command]
pub fn app_lock_get() -> Option<String> {
    crate::store::secrets::get("app", "lock").filter(|s| !s.is_empty()).map(|_| "configured".into())
}

#[tauri::command]
pub fn app_lock_set(hash: String) -> Result<(), String> {
    if LOCKED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Zenytt est verrouillé".into());
    }
    if hash.is_empty() {
        // Désactivation du verrouillage.
        return crate::store::secrets::set("app", "lock", "");
    }
    check_lock_hash(&hash)?;
    crate::store::secrets::set("app", "lock", &hash)
}

/// Refuse une empreinte mal formée ou trop faible (peu d'itérations, sel court).
fn check_lock_hash(stored: &str) -> Result<(), String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let parts: Vec<&str> = stored.split('$').collect();
    let [kind, iter, salt, hash] = parts.as_slice() else { return Err("Empreinte de mot de passe invalide".into()) };
    let ok = *kind == "pbkdf2"
        && iter.parse::<u32>().is_ok_and(|n| n >= MIN_LOCK_ITERATIONS)
        && b64.decode(salt).is_ok_and(|s| s.len() >= 16)
        && b64.decode(hash).is_ok_and(|h| h.len() == 32);
    if ok {
        Ok(())
    } else {
        Err("Empreinte de mot de passe refusée : format ou paramètres trop faibles".into())
    }
}

/// État du verrouillage (relu au démarrage de l'interface).
#[tauri::command]
pub fn app_is_locked() -> bool {
    LOCKED.load(std::sync::atomic::Ordering::SeqCst) && crate::store::secrets::get("app", "lock").is_some_and(|s| !s.is_empty())
}

#[tauri::command]
pub fn app_lock_engage() {
    if crate::store::secrets::get("app", "lock").is_some_and(|s| !s.is_empty()) {
        LOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Déverrouille si le mot de passe correspond à l'empreinte PBKDF2 enregistrée (format de
/// l'interface : `pbkdf2$itérations$sel$empreinte`, en base64).
#[tauri::command]
pub async fn app_unlock(password: String) -> bool {
    let _gate = UNLOCK_GATE.lock().await;
    let Some(stored) = crate::store::secrets::get("app", "lock").filter(|s| !s.is_empty()) else {
        LOCKED.store(false, std::sync::atomic::Ordering::SeqCst);
        return true;
    };
    // PBKDF2 (200 000 tours) prend un moment : hors du fil des commandes.
    let ok = tokio::task::spawn_blocking(move || verify_lock_password(&password, &stored)).await.unwrap_or(false);
    if ok {
        LOCKED.store(false, std::sync::atomic::Ordering::SeqCst);
    } else {
        // Freine les essais au hasard.
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
    ok
}

fn verify_lock_password(password: &str, stored: &str) -> bool {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let parts: Vec<&str> = stored.split('$').collect();
    let [kind, iter, salt, hash] = parts.as_slice() else { return false };
    let (Ok(iter), Ok(salt), Ok(hash)) = (iter.parse::<u32>(), b64.decode(salt), b64.decode(hash)) else { return false };
    let Some(iter) = std::num::NonZeroU32::new(iter) else { return false };
    *kind == "pbkdf2" && ring::pbkdf2::verify(ring::pbkdf2::PBKDF2_HMAC_SHA256, iter, &salt, password.as_bytes(), &hash).is_ok()
}

/// Problème rencontré au chargement de la configuration, à afficher au démarrage.
#[tauri::command]
pub fn store_warning(store: State<'_, Store>) -> Option<String> {
    store.warning()
}

#[tauri::command]
pub fn ui_state_set(store: State<'_, Store>, state: serde_json::Value) -> Result<(), String> {
    store.write(|d| d.ui_state = state)
}

#[tauri::command]
pub fn audit_list(audit: State<'_, AuditLog>, limit: usize) -> Vec<Entry> {
    audit.recent(limit.min(5000))
}

/// Version de tmux installée, ou `None`.
#[tauri::command]
pub async fn tmux_check(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Option<String>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    tmux::available(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn tmux_install(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        tmux::install(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "tmux.install", "", r)
}

#[tauri::command]
pub async fn tmux_sessions(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Session>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    tmux::sessions(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn tmux_kill(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    name: String,
) -> Result<(), String> {
    let r = async {
        let conn = sessions.get(&store, &server_id).await?;
        tmux::kill(&conn, &name).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "tmux.kill", &name, r)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    command: String,
    claude_desktop: String,
    claude_code: String,
}

/// Configuration à copier dans Claude Desktop / Claude Code pour brancher le serveur MCP de Zenytt.
#[tauri::command]
pub fn mcp_config() -> Result<McpConfig, String> {
    let exe = std::env::current_exe().map_err(err)?.display().to_string();
    let desktop = serde_json::json!({ "mcpServers": { "zenytt": { "command": exe, "args": ["--mcp"] } } });
    Ok(McpConfig {
        claude_desktop: serde_json::to_string_pretty(&desktop).map_err(err)?,
        claude_code: format!("claude mcp add zenytt -- \"{exe}\" --mcp"),
        command: exe,
    })
}

/// Lit un fichier texte du PC choisi par l'utilisateur (partage reçu, au plus 8 Mo).
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() > 8_000_000 {
        return Err("fichier trop volumineux".into());
    }
    std::fs::read_to_string(&path).map_err(err)
}

/// Écrit un fichier texte sur le PC (chemin choisi par l'utilisateur dans la boîte de dialogue native).
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(err)
}

/// Taille maximale d'un fichier lu sur le PC pour être envoyé dans une session de bureau à
/// distance : au-delà, il transiterait entièrement en mémoire dans l'interface.
const MAX_LOCAL_READ: u64 = 512 * 1024 * 1024;

/// Décode un en-tête encodé avec `encodeURIComponent` (les en-têtes HTTP sont en ASCII).
fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(err)?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "en-tête mal encodé".to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "en-tête mal encodé".into())
}

/// Enregistre sur le PC un fichier reçu d'une session de bureau à distance (octets bruts dans le
/// corps de la requête, dossier et nom dans les en-têtes). Le nom vient de la machine distante :
/// il est donc tenu pour hostile — ramené à un simple nom de fichier valide sous Windows, sans
/// séparateur ni « .. » — et un fichier existant n'est jamais écrasé. Renvoie le chemin écrit.
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn save_binary_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("contenu du fichier attendu en octets bruts".into());
    };
    let header = |name: &str| -> Result<String, String> {
        let v = request.headers().get(name).ok_or_else(|| format!("en-tête {name} manquant"))?;
        percent_decode(v.to_str().map_err(err)?)
    };
    let dir = std::path::PathBuf::from(header("x-zenytt-dir")?);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("dossier de destination invalide".into());
    }
    let name = zenytt_core::sftp::local_name(&header("x-zenytt-name")?);
    let path = zenytt_core::sftp::unique_local(&dir, &name);
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Lit un fichier du PC (déposé sur une session de bureau à distance) et le renvoie en octets
/// bruts, sans passer par du JSON.
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    let meta = std::fs::metadata(&path).map_err(err)?;
    if !meta.is_file() {
        return Err("seuls les fichiers peuvent être envoyés (pas les dossiers)".into());
    }
    if meta.len() > MAX_LOCAL_READ {
        return Err(format!("fichier trop volumineux pour un envoi dans la session (plus de {} Mo)", MAX_LOCAL_READ / 1024 / 1024));
    }
    Ok(tauri::ipc::Response::new(std::fs::read(&path).map_err(err)?))
}

/// Exporte les réglages dans un fichier (chiffré si un mot de passe est donné).
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn settings_export(store: State<'_, Store>, path: String, password: String, include_secrets: bool) -> Result<(), String> {
    let text = zenytt_profiles::export::export(&store, &password, include_secrets)?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    log::info!("réglages exportés vers {path} (chiffré : {}, secrets : {include_secrets})", !password.is_empty());
    Ok(())
}

/// Partage d'une sélection de serveurs : texte chiffré, à enregistrer ou à envoyer.
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn settings_share(store: State<'_, Store>, ids: Vec<String>, password: String, include_secrets: bool) -> Result<String, String> {
    let text = zenytt_profiles::export::share(&store, &ids, &password, include_secrets)?;
    log::info!("partage de {} serveur(s) (secrets : {include_secrets})", ids.len());
    Ok(text)
}

/// Même partage, sous forme de code d'une seule ligne à coller dans une conversation.
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn settings_share_code(store: State<'_, Store>, ids: Vec<String>, password: String, include_secrets: bool) -> Result<String, String> {
    Ok(zenytt_profiles::export::to_code(&settings_share(store, ids, password, include_secrets)?))
}

/// Importe un partage reçu (contenu de fichier ou code collé).
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn settings_import_text(
    store: State<'_, Store>,
    text: String,
    password: String,
) -> Result<zenytt_profiles::export::ImportSummary, String> {
    let content = zenytt_profiles::export::from_code(&text)?;
    let summary = zenytt_profiles::export::import(&store, &content, &password)?;
    log::info!("partage importé : {summary:?}");
    Ok(summary)
}

/// Un partage reçu est-il chiffré (faut-il demander son mot de passe) ?
#[tauri::command]
pub fn settings_text_encrypted(text: String) -> Result<bool, String> {
    zenytt_profiles::export::is_encrypted(&zenytt_profiles::export::from_code(&text)?)
}

/// Le fichier à importer est-il chiffré ?
// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn settings_import_encrypted(path: String) -> Result<bool, String> {
    zenytt_profiles::export::is_encrypted(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
}

// Hors du fil principal : chiffrement (PBKDF2, 600 000 tours) ou lecture de gros fichiers
// figeraient toute l'interface le temps de l'opération.
#[tauri::command(async)]
pub fn settings_import(store: State<'_, Store>, path: String, password: String) -> Result<zenytt_profiles::export::ImportSummary, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let summary = zenytt_profiles::export::import(&store, &text, &password)?;
    log::info!("réglages importés depuis {path} : {summary:?}");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    #[test]
    fn lock_password_format() {
        // Même format que lib/lock.ts : pbkdf2$itérations$sel$empreinte (base64).
        let b64 = base64::engine::general_purpose::STANDARD;
        let salt = [7u8; 16];
        let mut hash = [0u8; 32];
        ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, std::num::NonZeroU32::new(1000).unwrap(), &salt, b"secret", &mut hash);
        let stored = format!("pbkdf2$1000${}${}", b64.encode(salt), b64.encode(hash));
        assert!(super::verify_lock_password("secret", &stored));
        assert!(!super::verify_lock_password("Secret", &stored));
        assert!(!super::verify_lock_password("secret", "n'importe quoi"));
        assert!(super::check_lock_hash(&stored).is_err(), "1 000 tours : empreinte trop faible, refusée");
        let strong = format!("pbkdf2$200000${}${}", b64.encode(salt), b64.encode(hash));
        assert!(super::check_lock_hash(&strong).is_ok());
        assert!(super::check_lock_hash(&format!("pbkdf2$200000${}${}", b64.encode([1u8; 8]), b64.encode(hash))).is_err(), "sel trop court");
    }

    #[test]
    fn headers_are_decoded() {
        // Ce qu'écrit encodeURIComponent pour un nom accentué avec espace.
        assert_eq!(super::percent_decode("rapport%20d%C3%A9cembre.pdf").unwrap(), "rapport décembre.pdf");
        assert_eq!(super::percent_decode("C%3A%5CUsers%5Calice").unwrap(), "C:\\Users\\alice");
        assert_eq!(super::percent_decode("").unwrap(), "");
        // Un « % » en fin de chaîne n'est pas une séquence : il reste tel quel, sans débordement.
        assert_eq!(super::percent_decode("100%").unwrap(), "100%");
        assert!(super::percent_decode("%zz%41").is_err());
    }

    #[test]
    fn remote_names_cannot_escape_the_folder() {
        // Le nom d'un fichier reçu vient de la machine distante : il est ramené à un simple nom.
        for hostile in ["../../Windows/System32/evil.dll", "..\\..\\evil.exe", "CON", "..", "a/b\\c.txt"] {
            let n = zenytt_core::sftp::local_name(hostile);
            assert!(!n.contains('/') && !n.contains('\\') && n != ".." && !n.is_empty(), "{hostile} -> {n}");
        }
    }
}
