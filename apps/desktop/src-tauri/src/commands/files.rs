//! Explorateur de fichiers SFTP et édition distante.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use zenytt_core::sftp::{self, Listing, Progress};
use zenytt_core::ssh::shell_quote;
use zenytt_core::{archive, ftp, search};
use zenytt_profiles::Protocol;

use crate::commands::{admin, err, need_shell, track};
use crate::sessions::{Fs, Sessions};
use crate::store::AuditLog;
use crate::store::Store;

/// Résultat d'une opération FTP ; après un délai dépassé le canal est désynchronisé : on jette le client pour se reconnecter.
async fn ftp_res<T>(sessions: &Sessions, server_id: &str, r: zenytt_core::Result<T>) -> Result<T, String> {
    if matches!(&r, Err(zenytt_core::Error::Ftp(m)) if m == ftp::TIMEOUT_MSG) {
        sessions.drop_ftp(server_id).await;
    }
    r.map_err(err)
}

#[tauri::command]
pub async fn fs_home(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<String, String> {
    match sessions.fs(&store, &server_id).await? {
        Fs::Sftp(sftp) => sftp::home(&sftp).await.map_err(err),
        Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::home(&mut *f.lock().await).await).await,
    }
}

#[tauri::command]
pub async fn fs_list(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String, path: String) -> Result<Listing, String> {
    let sftp = match sessions.fs(&store, &server_id).await? {
        Fs::Sftp(sftp) => sftp,
        Fs::Ftp(f) => return ftp_res(&sessions, &server_id, ftp::list(&mut *f.lock().await, &path).await).await,
    };
    let mut listing = sftp::list(&sftp, &path).await.map_err(err)?;
    let conn = sessions.get(&store, &server_id).await?;
    let names = sessions.id_names(&store, &conn, &server_id).await;
    let resolve = |v: &mut Option<String>, map: &std::collections::HashMap<u32, String>| {
        if let Some(name) = v.as_deref().and_then(|s| s.parse::<u32>().ok()).and_then(|id| map.get(&id)) {
            *v = Some(name.clone());
        }
    };
    for e in &mut listing.entries {
        resolve(&mut e.owner, &names.users);
        resolve(&mut e.group, &names.groups);
    }
    Ok(listing)
}

/// Exécute une commande ponctuelle dans le dossier affiché par l'explorateur.
/// La commande est volontairement saisie par l'utilisateur, comme dans un terminal ouvert.
#[tauri::command]
pub async fn fs_exec(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    cwd: String,
    command: String,
) -> Result<zenytt_core::ExecOutput, String> {
    need_shell(&store, &server_id)?;
    let cwd = if cwd.trim().is_empty() { "/" } else { cwd.trim() };
    let command = command.trim();
    if command.is_empty() {
        return Err("Commande vide".to_string());
    }
    let shell_command = format!("cd -- {} && {}", shell_quote(cwd), command);
    sessions.get(&store, &server_id).await?.exec(&shell_command, None).await.map_err(err)
}

/// Lit en root : taille du fichier sur la première ligne, puis `len` octets à partir de `offset`
/// en base64 (les octets arrivent intacts, quel que soit l'encodage du fichier).
async fn sudo_read(conn: &zenytt_core::Connection, pw: Option<&str>, path: &str, offset: u64, len: u64) -> Result<(u64, Vec<u8>), String> {
    use base64::Engine;
    let q = shell_quote(path);
    let cmd = format!("stat -Lc %s -- {q} && tail -c +{} -- {q} | head -c {len} | base64 -w0", offset + 1);
    let out = zenytt_core::ssh::long(conn.exec_sudo(&cmd, pw, None)).await.map_err(err)?.into_result().map_err(err)?.stdout;
    let (size, b64) = out.split_once('\n').unwrap_or((&out, ""));
    let size = size.trim().parse().map_err(|_| format!("taille illisible pour {path}"))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(err)?;
    Ok((size, bytes))
}

/// Lit un fichier texte entier pour l'éditeur, renvoyé en octets bruts (pas de JSON : un fichier
/// de plusieurs dizaines de Mo arrive sans ré-encodage). Avec `sudo`, lecture en root.
/// Erreurs `TOO_BIG:<taille>` et `NOT_UTF8` : l'interface bascule sur l'affichage par fenêtres.
#[tauri::command]
pub async fn fs_read(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    sudo: bool,
) -> Result<tauri::ipc::Response, String> {
    let bytes = if sudo {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        let (size, bytes) = sudo_read(&conn, pw.as_deref(), &path, 0, sftp::MAX_EDIT_SIZE + 1).await?;
        if size > sftp::MAX_EDIT_SIZE {
            return Err(format!("TOO_BIG:{size}"));
        }
        sftp::check_text(&bytes).map_err(err)?;
        bytes
    } else {
        match sessions.fs(&store, &server_id).await? {
            Fs::Sftp(sftp) => sftp::read_text(&sftp, &path).await.map_err(err)?,
            Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::read_text(&mut *f.lock().await, &path).await).await?,
        }
    };
    Ok(tauri::ipc::Response::new(bytes))
}

/// Portion d'un fichier (gros fichiers, encodages autres que l'UTF-8), en lecture seule.
#[tauri::command]
pub async fn fs_read_range(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    offset: u64,
    len: u64,
    sudo: bool,
) -> Result<sftp::TextWindow, String> {
    let len = len.min(sftp::MAX_WINDOW);
    if sudo {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        let (size, bytes) = sudo_read(&conn, pw.as_deref(), &path, offset, len).await?;
        return sftp::text_window(&bytes, offset.min(size), size).map_err(err);
    }
    match sessions.fs(&store, &server_id).await? {
        Fs::Sftp(sftp) => sftp::read_range(&sftp, &path, offset, len).await.map_err(err),
        Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::read_range(&mut *f.lock().await, &path, offset, len).await).await,
    }
}

/// Date de modification et taille d'un fichier, pour détecter une modification concurrente.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Clone, Copy, Debug)]
pub struct FileStamp {
    mtime: u64,
    size: u64,
}

async fn stamp(store: &Store, sessions: &Sessions, server_id: &str, path: &str, sudo: bool) -> Result<Option<FileStamp>, String> {
    // Sans shell, pas de `stat` : l'enregistrement n'a simplement pas de détection de conflit.
    if !store.server(server_id)?.protocol.has_shell() {
        return Ok(None);
    }
    let cmd = format!("stat -L -c '%Y %s' -- {} 2>/dev/null", shell_quote(path));
    let out = if sudo {
        let (conn, pw) = admin(store, sessions, server_id).await?;
        conn.exec_sudo(&cmd, pw.as_deref(), None).await
    } else {
        sessions.get(store, server_id).await?.exec(&cmd, None).await
    }
    .map_err(err)?;
    let mut parts = out.stdout.split_whitespace().map(|x| x.parse::<u64>());
    Ok(match (parts.next(), parts.next()) {
        (Some(Ok(mtime)), Some(Ok(size))) => Some(FileStamp { mtime, size }),
        _ => None,
    })
}

#[tauri::command]
pub async fn fs_stat(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    sudo: bool,
) -> Result<Option<FileStamp>, String> {
    stamp(&store, &sessions, &server_id, &path, sudo).await
}

/// Écrit un fichier. Si `expected` est fourni et que le fichier a changé depuis (autre session,
/// déploiement, certbot…), rien n'est écrit et l'erreur commence par `CONFLICT`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_write(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    content: String,
    sudo: bool,
    expected: Option<FileStamp>,
) -> Result<Option<FileStamp>, String> {
    let detail = path.clone();
    let r: Result<(), String> = async {
        if let Some(expected) = expected {
            let current = stamp(&store, &sessions, &server_id, &path, sudo).await?;
            if current.is_some_and(|c| c != expected) {
                return Err("CONFLICT: le fichier a été modifié sur le serveur depuis son ouverture".into());
            }
        }
        if sudo {
            let (conn, pw) = admin(&store, &sessions, &server_id).await?;
            return conn.write_file_sudo(&path, &content, pw.as_deref()).await.map_err(err);
        }
        match sessions.fs(&store, &server_id).await? {
            Fs::Sftp(sftp) => {
                let conn =
                    if store.server(&server_id)?.protocol.has_shell() { Some(sessions.get(&store, &server_id).await?) } else { None };
                sftp::write_text(&sftp, conn.as_ref(), &path, &content).await.map_err(err)
            }
            Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::write_text(&mut *f.lock().await, &path, &content).await).await,
        }
    }
    .await;
    track(&audit, &store, &server_id, "file.write", &detail, r)?;
    // Nouvel état du fichier, référence pour le prochain enregistrement.
    Ok(stamp(&store, &sessions, &server_id, &path, sudo).await.unwrap_or(None))
}

#[tauri::command]
pub async fn fs_mkdir(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
) -> Result<(), String> {
    let detail = path.clone();
    let r: Result<(), String> = async {
        match sessions.fs(&store, &server_id).await? {
            Fs::Sftp(sftp) => sftp::mkdir(&sftp, &path).await.map_err(err),
            Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::mkdir(&mut *f.lock().await, &path).await).await,
        }
    }
    .await;
    track(&audit, &store, &server_id, "file.mkdir", &detail, r)
}

#[tauri::command]
pub async fn fs_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
) -> Result<(), String> {
    let detail = path.clone();
    let r: Result<(), String> = async {
        match sessions.fs(&store, &server_id).await? {
            Fs::Sftp(sftp) => sftp::create_file(&sftp, &path).await.map_err(err),
            Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::create_file(&mut *f.lock().await, &path).await).await,
        }
    }
    .await;
    track(&audit, &store, &server_id, "file.create", &detail, r)
}

#[tauri::command]
pub async fn fs_rename(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let detail = format!("{from} → {to}");
    let r: Result<(), String> = async {
        match sessions.fs(&store, &server_id).await? {
            Fs::Sftp(sftp) => sftp::rename(&sftp, &from, &to).await.map_err(err),
            Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::rename(&mut *f.lock().await, &from, &to).await).await,
        }
    }
    .await;
    track(&audit, &store, &server_id, "file.rename", &detail, r)
}

#[tauri::command]
pub async fn fs_remove(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let detail = paths.join(", ");
    let r: Result<(), String> = async {
        let fs = sessions.fs(&store, &server_id).await?;
        for p in paths {
            match &fs {
                Fs::Sftp(sftp) => sftp::remove(sftp, &p).await.map_err(err)?,
                Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::remove(&mut *f.lock().await, &p).await).await?,
            }
        }
        Ok(())
    }
    .await;
    track(&audit, &store, &server_id, "file.delete", &detail, r)
}

#[tauri::command]
pub async fn fs_chmod(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let detail = format!("{path} {mode:o}");
    let r: Result<(), String> = async {
        match sessions.fs(&store, &server_id).await? {
            Fs::Sftp(sftp) => sftp::chmod(&sftp, &path, mode).await.map_err(err),
            Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::chmod(&mut *f.lock().await, &path, mode).await).await,
        }
    }
    .await;
    track(&audit, &store, &server_id, "file.chmod", &detail, r)
}

/// Transferts en cours, annulables depuis l'interface.
#[derive(Default)]
pub struct Transfers(Mutex<HashMap<u64, Arc<AtomicBool>>>);

impl Transfers {
    pub(crate) fn start(&self, id: u64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(id, flag.clone());
        flag
    }

    pub(crate) fn finish(&self, id: u64) {
        self.0.lock().unwrap().remove(&id);
    }
}

#[tauri::command]
pub fn fs_cancel(transfers: State<'_, Transfers>, transfer_id: u64) {
    if let Some(f) = transfers.0.lock().unwrap().get(&transfer_id) {
        f.store(true, Ordering::Relaxed);
    }
}

/// Callback de progression : relaie vers l'UI et renvoie `false` si le transfert a été annulé.
fn reporter(channel: &Channel<Progress>, cancel: Arc<AtomicBool>) -> impl Fn(Progress) -> bool + Send + Sync + '_ {
    move |p: Progress| {
        let _ = channel.send(p);
        !cancel.load(Ordering::Relaxed)
    }
}

/// Télécharge des éléments distants dans `local_dir` (par défaut : le dossier Téléchargements).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_download(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    server_id: String,
    paths: Vec<String>,
    local_dir: Option<String>,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<String, String> {
    let cancel = transfers.start(transfer_id);
    let r = async {
        let fs = sessions.fs(&store, &server_id).await?;
        let dir = match local_dir {
            Some(d) => PathBuf::from(d),
            None => app.path().download_dir().map_err(err)?,
        };
        let report = reporter(&on_progress, cancel.clone());
        for p in &paths {
            match &fs {
                Fs::Sftp(sftp) => sftp::download(sftp, p, &dir, &report).await.map_err(err)?,
                Fs::Ftp(f) => ftp_res(&sessions, &server_id, ftp::download(&mut *f.lock().await, p, &dir, &report).await).await?,
            };
        }
        Ok(dir.display().to_string())
    }
    .await;
    transfers.finish(transfer_id);
    r
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_upload(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    server_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let detail = format!("{} → {remote_dir}", local_paths.len());
    let cancel = transfers.start(transfer_id);
    let r: Result<(), String> = async {
        let fs = sessions.fs(&store, &server_id).await?;
        let report = reporter(&on_progress, cancel.clone());
        for p in &local_paths {
            match &fs {
                Fs::Sftp(sftp) => sftp::upload(sftp, &PathBuf::from(p), &remote_dir, &report).await.map_err(err)?,
                Fs::Ftp(f) => {
                    ftp_res(&sessions, &server_id, ftp::upload(&mut *f.lock().await, &PathBuf::from(p), &remote_dir, &report).await).await?
                }
            }
        }
        Ok(())
    }
    .await;
    transfers.finish(transfer_id);
    track(&audit, &store, &server_id, "file.upload", &detail, r)
}

/// Copie des éléments d'un serveur (ou dossier) vers un autre. Sur un même serveur : `cp -a`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_copy_between(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    src_server: String,
    paths: Vec<String>,
    dst_server: String,
    dst_dir: String,
    overwrite: bool,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let dst_name = store.server(&dst_server).map(|s| s.name).unwrap_or_default();
    let detail = format!("{} élément(s) → {dst_name}:{dst_dir}", paths.len());
    let cancel = transfers.start(transfer_id);
    let r: Result<(), String> = async {
        if [&src_server, &dst_server].iter().any(|id| matches!(store.server(id).map(|s| s.protocol), Ok(Protocol::Ftp | Protocol::Ftps))) {
            return Err("indisponible : la copie entre serveurs ne gère pas le FTP".into());
        }
        if src_server == dst_server {
            need_shell(&store, &src_server)?;
            let conn = sessions.get(&store, &src_server).await?;
            for p in &paths {
                let name = p.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                let target = sftp::join(&dst_dir, name);
                if !overwrite && conn.exec(&format!("test -e {}", shell_quote(&target)), None).await.map_err(err)?.success() {
                    return Err(format!("EXISTS:{target}"));
                }
                conn.run(&format!("cp -a -- {} {}", shell_quote(p), shell_quote(&dst_dir))).await.map_err(err)?;
            }
            return Ok(());
        }
        let src = sessions.sftp(&store, &src_server).await?;
        let dst = sessions.sftp(&store, &dst_server).await?;
        let report = reporter(&on_progress, cancel.clone());
        for p in &paths {
            sftp::copy_between(&src, p, &dst, &dst_dir, overwrite, &report).await.map_err(err)?;
        }
        Ok(())
    }
    .await;
    transfers.finish(transfer_id);
    // L'écriture a lieu sur le serveur de destination : c'est lui qui figure au journal.
    track(&audit, &store, &dst_server, "file.copy_between", &detail, r)
}

/// Cherche un fichier par son nom dans toute l'arborescence d'un dossier. `find` tourne sur le
/// serveur : rien n'est téléchargé, et les dossiers virtuels ou immenses sont écartés.
#[tauri::command]
pub async fn fs_find(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    root: String,
    pattern: String,
    depth: Option<u8>,
) -> Result<search::Results<search::Hit>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    search::find(&conn, pw.as_deref(), &root, &pattern, depth.unwrap_or(10)).await.map_err(err)
}

/// Cherche du texte dans les fichiers d'un dossier, sans les télécharger (`grep` distant).
#[tauri::command]
pub async fn fs_grep(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    root: String,
    needle: String,
    glob: Option<String>,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
) -> Result<search::Results<search::Match>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    let glob = glob.filter(|g| !g.trim().is_empty());
    search::grep(&conn, pw.as_deref(), &root, &needle, glob.as_deref(), case_sensitive.unwrap_or(false), regex.unwrap_or(false))
        .await
        .map_err(err)
}

/// Nom d'archive proposé pour une sélection.
#[tauri::command]
pub fn fs_archive_name(paths: Vec<String>, format: archive::Format) -> String {
    archive::suggested_name(&paths, format)
}

/// Compresse une sélection sur le serveur et renvoie la taille de l'archive, en octets.
#[tauri::command]
pub async fn fs_archive(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    paths: Vec<String>,
    dest: String,
    format: archive::Format,
) -> Result<u64, String> {
    let detail = format!("{dest} ← {}", paths.join(", "));
    let r: Result<u64, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        archive::create(&conn, pw.as_deref(), &paths, &dest, format).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "file.archive", &detail, r)
}

/// Contenu d'une archive, sans l'extraire : de quoi montrer ce qu'elle va déposer.
#[tauri::command]
pub async fn fs_archive_list(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
) -> Result<Vec<String>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    archive::list(&conn, pw.as_deref(), &path, 200).await.map_err(err)
}

/// Extrait une archive dans un dossier du serveur (créé au besoin).
#[tauri::command]
pub async fn fs_extract(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    dest: String,
) -> Result<(), String> {
    let detail = format!("{path} → {dest}");
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        archive::extract(&conn, pw.as_deref(), &path, &dest).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "file.extract", &detail, r)
}
