//! Profils de serveurs, secrets, clés d'hôte, snippets et import depuis PuTTY.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::track;
use crate::sessions::Sessions;
use crate::store::AuditLog;
use crate::store::{secrets, ServerProfile, Snippet, Store};
use zenytt_profiles::AuthKind;
use zenytt_profiles::Protocol;

/// Secrets transmis avec un profil : `None` = inchangé, `Some("")` = supprimé.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsInput {
    password: Option<String>,
    passphrase: Option<String>,
    sudo_password: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    #[serde(flatten)]
    profile: ServerProfile,
    has_password: bool,
    has_passphrase: bool,
    has_sudo_password: bool,
    connected: bool,
}

#[tauri::command]
pub async fn servers_list(store: State<'_, Store>, sessions: State<'_, Sessions>) -> Result<Vec<ServerView>, String> {
    let servers = store.read(|d| d.servers.clone());
    let mut out = Vec::with_capacity(servers.len());
    for profile in servers {
        let id = profile.id.clone();
        out.push(ServerView {
            has_password: secrets::has(&id, "password"),
            has_passphrase: secrets::has(&id, "passphrase"),
            has_sudo_password: secrets::has(&id, "sudo"),
            connected: sessions.is_connected(&id).await,
            profile,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn server_save(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    mut profile: ServerProfile,
    secrets_input: SecretsInput,
) -> Result<String, String> {
    if profile.identity_id.as_deref() == Some("") {
        profile.identity_id = None;
    }
    // Identifiant de la banque : le profil affiche son utilisateur.
    if let Some(i) = &profile.identity_id {
        profile.username = store.identity(i)?.username;
    }
    if profile.host.trim().is_empty() || profile.username.trim().is_empty() {
        return Err("l'hôte et l'utilisateur sont obligatoires".into());
    }
    // Le FTP n'a ni clé ni rebond : mot de passe uniquement.
    if matches!(profile.protocol, Protocol::Ftp | Protocol::Ftps) {
        profile.auth_kind = AuthKind::Password;
        profile.key_path = None;
        profile.jump_id = None;
        profile.identity_id = None;
    }
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    let id = profile.id.clone();
    // Le lien avec l'hébergeur se règle dans la page Système, pas ici.
    profile.provider = store.server(&id).ok().and_then(|s| s.provider);
    if profile.jump_id.as_deref() == Some("") {
        profile.jump_id = None;
    }
    if let Some(j) = &profile.jump_id {
        if *j == id {
            return Err("un serveur ne peut pas être son propre serveur de rebond".into());
        }
        // Le bastion ne doit pas lui-même passer par ce serveur.
        if store.jump_chain(j).map_err(|e| format!("serveur de rebond : {e}"))?.contains(&id) {
            return Err("les serveurs de rebond formeraient une boucle".into());
        }
    }
    for (kind, value) in
        [("password", &secrets_input.password), ("passphrase", &secrets_input.passphrase), ("sudo", &secrets_input.sudo_password)]
    {
        if let Some(v) = value {
            secrets::set(&id, kind, v)?;
        }
    }
    store.write(|d| match d.servers.iter_mut().find(|s| s.id == id) {
        Some(existing) => *existing = profile,
        None => d.servers.push(profile),
    })?;
    // Les paramètres ont pu changer : la prochaine action se reconnectera avec les nouveaux.
    sessions.disconnect(&id).await;
    sessions.unblock(&id);
    Ok(id)
}

/// Range des serveurs et des bureaux à distance (dossiers communs) dans un dossier (`None` : hors
/// dossier). Contrairement à `server_save`, les connexions en cours ne sont pas coupées.
#[tauri::command]
pub fn servers_set_group(store: State<'_, Store>, ids: Vec<String>, group: Option<String>) -> Result<(), String> {
    let group = group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
    store.write(|d| {
        for s in d.servers.iter_mut().filter(|s| ids.contains(&s.id)) {
            s.group = group.clone();
        }
        for r in d.desktops.iter_mut().filter(|r| ids.contains(&r.id)) {
            r.group = group.clone();
        }
    })
}

#[tauri::command]
pub async fn server_delete(store: State<'_, Store>, sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.disconnect(&id).await;
    secrets::delete_all(&id);
    secrets::delete_all(&ServerProfile::provider_owner(&id));
    store.write(|d| d.servers.retain(|s| s.id != id))
}

/// Approuve la clé d'hôte présentée par le serveur (premier contact ou changement confirmé).
#[tauri::command]
pub fn host_trust(audit: State<'_, AuditLog>, store: State<'_, Store>, id: String, fingerprint: String) -> Result<(), String> {
    let s = store.server(&id)?;
    let r = store.write(|d| {
        d.known_hosts.insert(format!("{}:{}", s.host, s.port), fingerprint.clone());
    });
    track(&audit, &store, &id, "ssh.trust_host", &fingerprint, r)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    fingerprint: String,
    hostname: String,
    os: String,
}

#[tauri::command]
pub async fn ssh_connect(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    id: String,
    user_initiated: Option<bool>,
) -> Result<ConnectInfo, String> {
    // Seule une action de l'utilisateur lève la suspension après un échec d'authentification.
    if user_initiated.unwrap_or(false) {
        sessions.unblock(&id);
    }
    let protocol = store.server(&id)?.protocol;
    if matches!(protocol, Protocol::Ftp | Protocol::Ftps) {
        // Pas de SSH : se connecter, c'est ouvrir le client FTP.
        sessions.fs(&store, &id).await?;
        return Ok(ConnectInfo {
            fingerprint: String::new(),
            hostname: store.server(&id)?.host,
            os: format!("{protocol:?}").to_uppercase(),
        });
    }
    let conn = sessions.get(&store, &id).await?;
    if !protocol.has_shell() {
        return Ok(ConnectInfo { fingerprint: conn.fingerprint.clone(), hostname: store.server(&id)?.host, os: "SFTP".into() });
    }
    let out = conn
        .exec("hostname; . /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" || uname -sr", None)
        .await
        .map_err(|e| e.to_string())?;
    let mut lines = out.stdout.lines();
    Ok(ConnectInfo {
        fingerprint: conn.fingerprint.clone(),
        hostname: lines.next().unwrap_or_default().to_string(),
        os: lines.next().unwrap_or_default().to_string(),
    })
}

/// Diagnostic réseau d'un serveur injoignable, sans tentative d'authentification.
#[tauri::command]
pub async fn ssh_diagnose(store: State<'_, Store>, id: String) -> Result<zenytt_core::diagnose::Diagnosis, String> {
    let p = store.server(&id)?;
    let d = zenytt_core::diagnose::diagnose(&p.host, p.port).await;
    log::info!("diagnostic de {} : {}", p.host, d.verdict);
    Ok(d)
}

#[tauri::command]
pub async fn ssh_disconnect(sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub fn snippets_list(store: State<'_, Store>) -> Vec<Snippet> {
    store.read(|d| d.snippets.clone())
}

#[tauri::command]
pub fn snippet_save(store: State<'_, Store>, mut snippet: Snippet) -> Result<(), String> {
    if snippet.id.is_empty() {
        snippet.id = uuid::Uuid::new_v4().to_string();
    }
    store.write(|d| match d.snippets.iter_mut().find(|s| s.id == snippet.id) {
        Some(existing) => *existing = snippet,
        None => d.snippets.push(snippet),
    })
}

#[tauri::command]
pub fn snippet_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.write(|d| d.snippets.retain(|s| s.id != id))
}

/// Serveurs déclarés dans `~/.ssh/config` (OpenSSH), prêts à être importés.
#[tauri::command]
pub fn ssh_config_sessions() -> Vec<ServerProfile> {
    zenytt_profiles::ssh_config::read_user_config()
}

/// Sessions SSH enregistrées dans PuTTY (Windows uniquement), prêtes à être importées.
#[tauri::command]
pub fn putty_sessions() -> Vec<ServerProfile> {
    #[cfg(windows)]
    {
        read_putty_sessions().unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn read_putty_sessions() -> Option<Vec<ServerProfile>> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let root = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\SimonTatham\PuTTY\Sessions").ok()?;
    let mut out = Vec::new();
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else { continue };
        let protocol: String = key.get_value("Protocol").unwrap_or_else(|_| "ssh".into());
        let raw_host: String = key.get_value("HostName").unwrap_or_default();
        if protocol != "ssh" || raw_host.is_empty() {
            continue;
        }
        // PuTTY accepte « user@hôte » dans HostName.
        let (user_in_host, host) = match raw_host.split_once('@') {
            Some((u, h)) => (Some(u.to_string()), h.to_string()),
            None => (None, raw_host),
        };
        let username: String = key.get_value("UserName").unwrap_or_default();
        let port: u32 = key.get_value("PortNumber").unwrap_or(22);
        let key_file: String = key.get_value("PublicKeyFile").unwrap_or_default();
        out.push(ServerProfile {
            id: String::new(),
            name: percent_decode(&name),
            host,
            port: port as u16,
            username: if username.is_empty() { user_in_host.unwrap_or_else(|| "root".into()) } else { username },
            auth_kind: if key_file.is_empty() { AuthKind::Password } else { AuthKind::Key },
            key_path: (!key_file.is_empty()).then_some(key_file),
            color: None,
            group: None,
            ai_access: false,
            jump_id: None,
            identity_id: None,
            protocol: Default::default(),
            auto_connect: false,
            provider: None,
        });
    }
    Some(out)
}

/// PuTTY encode les noms de session en « %XX ».
#[cfg(windows)]
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(Ok(b)) = s.get(i + 1..i + 3).map(|hex| u8::from_str_radix(hex, 16)) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Autorise (ou non) le serveur MCP à lire ce serveur. Ne touche pas à la connexion en cours.
#[tauri::command]
pub fn server_set_ai_access(audit: State<'_, AuditLog>, store: State<'_, Store>, id: String, enabled: bool) -> Result<(), String> {
    let r = store.write(|d| {
        if let Some(s) = d.servers.iter_mut().find(|s| s.id == id) {
            s.ai_access = enabled;
        }
    });
    track(&audit, &store, &id, "ai.access", if enabled { "activé" } else { "désactivé" }, r)
}
