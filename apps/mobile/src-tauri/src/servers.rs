//! Serveurs : liste, ajout à la main, secrets et clé d'hôte.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zenytt_profiles::{secrets, valid_id, AuthKind, ServerProfile, Store};

use crate::sessions::Sessions;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    #[serde(flatten)]
    profile: ServerProfile,
    /// De quoi se connecter est présent sur ce téléphone (sinon : mot de passe ou clé à saisir).
    auth_ready: bool,
}

fn auth_ready(p: &ServerProfile) -> bool {
    match p.auth_kind {
        AuthKind::Password => secrets::has(&p.id, "password"),
        AuthKind::Key => p.key_path.as_deref().is_some_and(|k| Path::new(k).is_file()),
        // Pas d'agent SSH sur un téléphone.
        AuthKind::Agent => false,
    }
}

#[tauri::command]
pub fn servers_list(store: State<'_, Store>) -> Vec<ServerView> {
    // shortcut: les serveurs sans shell (SFTP seul, FTP) sont masqués, l'app ne sait parler que SSH ; à ouvrir si un onglet Fichiers seul est demandé.
    store
        .read(|d| d.servers.clone())
        .into_iter()
        .filter(|p| p.protocol.has_shell())
        .map(|profile| ServerView { auth_ready: auth_ready(&profile), profile })
        .collect()
}

/// Formulaire d'un serveur. Secrets : `None` = inchangé, `Some("")` = supprimé.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    /// Absent : nouveau serveur.
    id: Option<String>,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_kind: AuthKind,
    password: Option<String>,
    /// Clé privée collée (texte PEM / OpenSSH).
    private_key: Option<String>,
    passphrase: Option<String>,
    sudo_password: Option<String>,
}

#[tauri::command]
pub async fn server_save(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    input: ServerInput,
) -> Result<String, String> {
    let host = input.host.trim().to_string();
    if host.is_empty() || host.contains(char::is_whitespace) || input.username.trim().is_empty() || input.port == 0 {
        return Err("l'hôte, le port et l'utilisateur sont obligatoires".into());
    }
    if input.auth_kind == AuthKind::Agent {
        return Err("l'agent SSH n'existe pas sur mobile : choisis un mot de passe ou une clé".into());
    }
    let id = match input.id {
        Some(id) if valid_id(&id) => id,
        Some(_) => return Err("identifiant de serveur invalide".into()),
        None => uuid::Uuid::new_v4().to_string(),
    };
    let existing = store.server(&id).ok();

    // La clé collée est rangée dans un fichier privé de l'app (le SSH de Zenytt lit une clé par son chemin).
    // shortcut: secrets in app-private storage, not Android Keystore/iOS Keychain; upgrade to a keystore plugin before store release
    let mut key_path = existing.as_ref().and_then(|s| s.key_path.clone());
    if let Some(key) = input.private_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("keys");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(&id);
        std::fs::write(&path, format!("{key}\n")).map_err(|e| e.to_string())?;
        key_path = Some(path.to_string_lossy().into_owned());
    }
    if input.auth_kind == AuthKind::Key && !key_path.as_deref().is_some_and(|k| Path::new(k).is_file()) {
        return Err("colle la clé privée du serveur".into());
    }

    for (kind, value) in [("password", &input.password), ("passphrase", &input.passphrase), ("sudo", &input.sudo_password)] {
        if let Some(v) = value {
            secrets::set(&id, kind, v)?;
        }
    }
    let profile = ServerProfile {
        id: id.clone(),
        name: if input.name.trim().is_empty() { host.clone() } else { input.name.trim().to_string() },
        host,
        port: input.port,
        username: input.username.trim().to_string(),
        auth_kind: input.auth_kind,
        key_path,
        // Le reste (groupe, rebond…) vient du PC et ne se règle pas ici.
        ..existing.unwrap_or(ServerProfile {
            id: String::new(),
            name: String::new(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_kind: AuthKind::Password,
            key_path: None,
            color: None,
            group: None,
            ai_access: false,
            jump_id: None,
            identity_id: None,
            auto_connect: false,
            protocol: Default::default(),
            provider: None,
        })
    };
    store.write(|d| match d.servers.iter_mut().find(|s| s.id == id) {
        Some(s) => *s = profile,
        None => d.servers.push(profile),
    })?;
    // Les paramètres ont pu changer : la prochaine action se reconnectera avec les nouveaux.
    sessions.disconnect(&id).await;
    sessions.unblock(&id);
    Ok(id)
}

#[tauri::command]
pub async fn server_delete(store: State<'_, Store>, sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.disconnect(&id).await;
    secrets::delete_all(&id);
    secrets::delete_all(&ServerProfile::provider_owner(&id));
    store.write(|d| d.servers.retain(|s| s.id != id))
}

/// Relance la connexion à la demande de l'utilisateur (lève le blocage après un refus d'authentification).
#[tauri::command]
pub async fn server_retry(sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.disconnect(&id).await;
    sessions.unblock(&id);
    Ok(())
}

/// Approuve la clé d'hôte présentée par le serveur au premier contact.
#[tauri::command]
pub fn host_trust(store: State<'_, Store>, id: String, fingerprint: String) -> Result<(), String> {
    let s = store.server(&id)?;
    store.write(|d| {
        d.known_hosts.insert(format!("{}:{}", s.host, s.port), fingerprint);
    })
}
