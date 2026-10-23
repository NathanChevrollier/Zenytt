//! Fichiers d'un serveur par SFTP.

use base64::Engine;
use tauri::{AppHandle, Manager, State};
use zenytt_core::sftp::{self, Listing};
use zenytt_profiles::Store;

use crate::sessions::Sessions;

/// Taille maximale d'un envoi : le fichier traverse le pont de l'interface en mémoire.
const MAX_UPLOAD: usize = 25 * 1024 * 1024;

/// Contenu d'un dossier ; sans chemin, le dossier personnel.
#[tauri::command]
pub async fn files_list(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: Option<String>,
) -> Result<Listing, String> {
    let s = sessions.sftp(&store, &server_id).await?;
    let path = match path {
        Some(p) => p,
        None => sftp::home(&s).await.map_err(|e| e.to_string())?,
    };
    sftp::list(&s, &path).await.map_err(|e| e.to_string())
}

/// Télécharge dans le dossier privé de l'app et renvoie le chemin local.
#[tauri::command]
pub async fn files_download(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("downloads");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let s = sessions.sftp(&store, &server_id).await?;
    let local = sftp::download(&s, &path, &dir, &|_| true).await.map_err(|e| e.to_string())?;
    Ok(local.to_string_lossy().into_owned())
}

/// Envoie un fichier (contenu en base64) dans `dir`.
#[tauri::command]
pub async fn files_upload(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    dir: String,
    name: String,
    data: String,
) -> Result<(), String> {
    if name.is_empty() || name.contains('/') || name == ".." {
        return Err("nom de fichier invalide".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "fichier illisible")?;
    if bytes.len() > MAX_UPLOAD {
        return Err("fichier trop volumineux pour le téléphone (25 Mo maximum)".into());
    }
    let s = sessions.sftp(&store, &server_id).await?;
    sftp::write_bytes(&s, &sftp::join(&dir, &name), &bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn files_remove(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String, path: String) -> Result<(), String> {
    let s = sessions.sftp(&store, &server_id).await?;
    sftp::remove(&s, &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn files_rename(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let s = sessions.sftp(&store, &server_id).await?;
    sftp::rename(&s, &from, &to).await.map_err(|e| e.to_string())
}
