//! Sauvegardes planifiées (restic) : configuration, sauvegardes existantes, restauration.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use zenytt_core::backup::{self, BackupConfig, DbSource, Destination, Node, Snapshot, Status};
use zenytt_core::docker::{self, Access};
use zenytt_core::ssh::shell_quote;

use crate::commands::{admin, err, track};
use crate::sessions::Sessions;
use crate::store::{secrets, AuditLog, Store};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    status: Status,
    default_config: BackupConfig,
    volumes: Vec<String>,
    databases: Vec<DbSource>,
    /// Le mot de passe restic est aussi gardé dans le coffre de ce PC.
    password_in_keyring: bool,
}

#[tauri::command]
pub async fn backup_overview(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Overview, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let s = sudo.as_deref();
    let status = backup::status(&conn, s).await.map_err(err)?;
    let (mut volumes, mut databases) = (vec![], vec![]);
    if let Ok((access, _)) = docker::access(&conn, s).await {
        if access != Access::Unavailable {
            if let Ok(out) = docker::run(&conn, access, s, "volume ls --format '{{.Name}}'").await {
                // Les volumes anonymes (longs identifiants hexadécimaux) sont ignorés.
                volumes = out
                    .stdout
                    .lines()
                    .map(str::trim)
                    .filter(|v| !(v.is_empty() || v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit())))
                    .map(str::to_string)
                    .collect();
            }
            if let Ok(list) = docker::containers(&conn, access, s).await {
                for c in list {
                    let img = c.image.to_lowercase();
                    let kind = if img.contains("mysql") || img.contains("mariadb") {
                        "mysql"
                    } else if img.contains("postgres") || img.contains("postgis") || img.contains("timescale") {
                        "postgres"
                    } else {
                        continue;
                    };
                    databases.push(DbSource { container: c.name, kind: kind.into() });
                }
            }
        }
    }
    Ok(Overview {
        status,
        default_config: BackupConfig::default(),
        volumes,
        databases,
        password_in_keyring: secrets::get(&server_id, "restic").is_some(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    log: String,
    /// Mot de passe généré à l'instant : à conserver précieusement (affiché une seule fois).
    generated_password: Option<String>,
}

fn random_password() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

#[tauri::command]
pub async fn backup_save(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    config: BackupConfig,
    restic_password: Option<String>,
    s3_secret: Option<String>,
) -> Result<SaveResult, String> {
    let detail = config.repository();
    let r = async {
        config.validate().map_err(err)?;
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        let s = sudo.as_deref();
        let existing = backup::current_secret(&conn, s, "RESTIC_PASSWORD").await.ok().flatten();
        let mut generated = None;
        let password = match restic_password.filter(|p| !p.is_empty()).or(existing).or_else(|| secrets::get(&server_id, "restic")) {
            Some(p) => p,
            None => {
                let p = random_password();
                generated = Some(p.clone());
                p
            }
        };
        let s3 = match (&config.destination, s3_secret.filter(|x| !x.is_empty())) {
            (Destination::S3 { .. }, Some(x)) => Some(x),
            (Destination::S3 { .. }, None) => backup::current_secret(&conn, s, "AWS_SECRET_ACCESS_KEY").await.ok().flatten(),
            _ => None,
        };
        let env = backup::env_file(&config, &password, s3.as_deref()).map_err(err)?;
        let log = backup::install(&conn, s, &config, &env).await.map_err(err)?;
        // Sans ce mot de passe, les sauvegardes sont illisibles : on en garde une copie sur ce PC.
        secrets::set(&server_id, "restic", &password)?;
        Ok(SaveResult { log, generated_password: generated })
    }
    .await;
    track(&audit, &store, &server_id, "backup.configure", &detail, r)
}

#[tauri::command]
pub async fn backup_snapshots(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Snapshot>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    backup::snapshots(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn backup_list(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    snapshot: String,
    path: String,
) -> Result<Vec<Node>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    backup::list(&conn, sudo.as_deref(), &snapshot, &path).await.map_err(err)
}

#[tauri::command]
pub async fn backup_restore(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    snapshot: String,
    path: String,
) -> Result<String, String> {
    let detail = format!("{snapshot} {path}");
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        backup::restore_to_temp(&conn, sudo.as_deref(), &snapshot, &path).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "backup.restore_temp", &detail, r)
}

#[tauri::command]
pub async fn backup_put_back(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    restored: String,
    original: String,
) -> Result<String, String> {
    let detail = original.clone();
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        backup::put_back(&conn, sudo.as_deref(), &restored, &original).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "backup.put_back", &detail, r)
}

#[tauri::command]
pub async fn backup_import_dump(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    dump: String,
    database: DbSource,
) -> Result<String, String> {
    let detail = format!("{} ← {dump}", database.container);
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        backup::import_dump(&conn, sudo.as_deref(), &dump, &database).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "backup.import_dump", &detail, r)
}

/// Copie un élément restauré dans le dossier personnel de l'utilisateur SSH, pour le télécharger via SFTP.
#[tauri::command]
pub async fn backup_stage_download(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    restored: String,
) -> Result<String, String> {
    if !restored.starts_with(&format!("{}/", backup::RESTORE_ROOT)) || restored.contains("..") {
        return Err("chemin invalide".into());
    }
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let user = conn.run("id -un").await.map_err(err)?.trim().to_string();
    let home = conn.run("printf %s \"$HOME\"").await.map_err(err)?;
    let dest = format!("{home}/zenytt-restauration");
    let cmd = format!(
        "mkdir -p {d} && cp -a {r} {d}/ && chown -R {u}: {d}",
        d = shell_quote(&dest),
        r = shell_quote(&restored),
        u = shell_quote(&user)
    );
    zenytt_core::ssh::long(conn.exec_sudo(&cmd, sudo.as_deref(), None)).await.map_err(err)?.into_result().map_err(err)?;
    let name = restored.rsplit('/').next().unwrap_or("");
    Ok(format!("{dest}/{name}"))
}

#[tauri::command]
pub async fn backup_check(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<String, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    backup::check(&conn, sudo.as_deref()).await.map_err(err)
}

/// Installe restic sur le serveur (paquet de la distribution, sinon binaire officiel vérifié).
#[tauri::command]
pub async fn backup_install_restic(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        backup::install_restic(&conn, sudo.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "backup.install_restic", "restic", r)
}

/// Avancement de la copie du dépôt sur le PC.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MirrorProgress {
    files_done: usize,
    files_total: usize,
    bytes_done: u64,
    bytes_total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorResult {
    /// Dossier de la copie (le dossier choisi, ou un sous-dossier créé dedans).
    dir: String,
    downloaded: usize,
    deleted: usize,
    bytes: u64,
    /// Taille et nombre de fichiers de la copie, une fois à jour.
    files: usize,
    total_bytes: u64,
}

/// Dossier local de la copie : le dossier choisi s'il est vide ou contient déjà un dépôt restic,
/// sinon un sous-dossier dédié (les fichiers qui ne sont pas du dépôt ne sont jamais touchés).
fn mirror_dir(chosen: &Path, server_name: &str) -> Result<PathBuf, String> {
    if !chosen.is_absolute() {
        return Err("choisis un dossier de ce PC".into());
    }
    let is_repo = |p: &Path| p.join("config").is_file() && p.join("keys").is_dir();
    if is_repo(chosen) || std::fs::read_dir(chosen).map(|mut d| d.next().is_none()).unwrap_or(true) {
        return Ok(chosen.to_path_buf());
    }
    let slug: String =
        server_name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' }).collect();
    Ok(chosen.join(format!("zenytt-restic-{}", slug.trim_matches('-'))))
}

/// Fichiers du dépôt déjà copiés (les `.part` d'une copie interrompue sont supprimés).
fn local_repo_files(dir: &Path) -> Vec<backup::RepoFile> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "part") {
                let _ = std::fs::remove_file(&p);
            } else if let Ok(rel) = p.strip_prefix(dir) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if backup::valid_repo_path(&rel) {
                    out.push(backup::RepoFile { path: rel, size: meta.len() });
                }
            }
        }
    }
    out
}

/// Copie (ou met à jour) sur ce PC le dépôt restic gardé sur le serveur : seuls les fichiers
/// nouveaux sont téléchargés, ceux que la rétention a supprimés le sont aussi en local. La copie
/// reste chiffrée : restic l'ouvre avec le mot de passe des sauvegardes.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn backup_mirror(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    transfers: State<'_, crate::commands::files::Transfers>,
    server_id: String,
    dir: String,
    transfer_id: u64,
    on_progress: Channel<MirrorProgress>,
) -> Result<MirrorResult, String> {
    let cancel = transfers.start(transfer_id);
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        let s = sudo.as_deref();
        let status = backup::status(&conn, s).await.map_err(err)?;
        let repo = match status.config.map(|c| c.destination) {
            Some(Destination::Local { path }) => path,
            Some(Destination::S3 { .. }) => {
                return Err(
                    "les sauvegardes partent déjà hors du serveur (S3) : la copie sur ce PC concerne un dépôt gardé sur le serveur".into()
                )
            }
            None => return Err("aucune sauvegarde configurée sur ce serveur".into()),
        };
        let name = store.read(|d| d.servers.iter().find(|x| x.id == server_id).map(|x| x.name.clone())).unwrap_or_default();
        let target = mirror_dir(Path::new(&dir), &name)?;
        std::fs::create_dir_all(&target).map_err(|e| format!("{} : {e}", target.display()))?;
        let remote = backup::repo_files(&conn, s, &repo).await.map_err(err)?;
        let plan = backup::plan_mirror(&remote, &local_repo_files(&target));
        let progress = std::sync::Mutex::new(MirrorProgress {
            files_done: 0,
            files_total: plan.download.len(),
            bytes_done: 0,
            bytes_total: plan.download.iter().map(|f| f.size).sum(),
        });
        let _ = on_progress.send(progress.lock().unwrap().clone());
        let on_bytes = |n: u64| {
            let mut p = progress.lock().unwrap();
            p.bytes_done += n;
            let _ = on_progress.send(p.clone());
            !cancel.load(std::sync::atomic::Ordering::Relaxed)
        };
        for f in &plan.download {
            let local = target.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            backup::fetch_file_sudo(&conn, s, &format!("{}/{}", repo.trim_end_matches('/'), f.path), f.size, &local, &on_bytes)
                .await
                .map_err(err)?;
            progress.lock().unwrap().files_done += 1;
        }
        for p in &plan.delete {
            let _ = std::fs::remove_file(target.join(p.replace('/', std::path::MAIN_SEPARATOR_STR)));
        }
        Ok(MirrorResult {
            dir: target.display().to_string(),
            downloaded: plan.download.len(),
            deleted: plan.delete.len(),
            bytes: plan.download.iter().map(|f| f.size).sum(),
            files: remote.len(),
            total_bytes: remote.iter().map(|f| f.size).sum(),
        })
    }
    .await;
    transfers.finish(transfer_id);
    let detail = r.as_ref().map(|m| format!("{} ({} fichier(s) copié(s))", m.dir, m.downloaded)).unwrap_or_else(|_| dir.clone());
    track(&audit, &store, &server_id, "backup.mirror", &detail, r)
}
