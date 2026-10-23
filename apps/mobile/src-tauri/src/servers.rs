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

/// Clé privée collée sur ce téléphone (son chemin vit dans les secrets, pas dans le profil synchronisé).
fn phone_key(id: &str) -> Option<String> {
    secrets::get(id, secrets::MOBILE_KEY).filter(|k| Path::new(k).is_file())
}

fn auth_ready(p: &ServerProfile) -> bool {
    // Un mot de passe saisi sur le téléphone vaut pour une clé du PC (voir `Store::connect_params`).
    match p.auth_kind {
        AuthKind::Password => secrets::has(&p.id, "password"),
        AuthKind::Key if phone_key(&p.id).is_none() => secrets::has(&p.id, "password"),
        AuthKind::Key => phone_key(&p.id).is_some(),
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
    // Son chemin reste dans les secrets du téléphone : `key_path` et `auth_kind` d'un profil existant
    // sont synchronisés avec le PC et ne doivent jamais recevoir de valeur propre au téléphone.
    if let Some(key) = input.private_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("keys");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(&id);
        secrets::write_private(
            &path,
            format!(
                "{key}
"
            )
            .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        secrets::set(&id, secrets::MOBILE_KEY, &path.to_string_lossy())?;
    }
    if input.auth_kind == AuthKind::Key && phone_key(&id).is_none() {
        return Err("colle la clé privée du serveur".into());
    }
    // Mot de passe choisi : la clé du téléphone ne doit plus primer.
    if input.auth_kind == AuthKind::Password {
        secrets::set(&id, secrets::MOBILE_KEY, "")?;
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
        // Profil existant : type d'authentification et chemin de clé restent ceux du PC.
        auth_kind: existing.as_ref().map_or(input.auth_kind, |e| e.auth_kind),
        key_path: existing.as_ref().and_then(|e| e.key_path.clone()),
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
pub async fn server_delete(app: AppHandle, store: State<'_, Store>, sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.disconnect(&id).await;
    secrets::delete_all(&id);
    let _ = secrets::set(&id, secrets::MOBILE_KEY, "");
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(dir.join("keys").join(&id));
    }
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
