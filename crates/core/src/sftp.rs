//! Opérations de fichiers distants via SFTP : listing, lecture/écriture, suppression récursive, transferts.

use std::path::{Path, PathBuf};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub(crate) const CHUNK: usize = 256 * 1024;
/// Taille maximale d'un fichier ouvert en entier dans l'éditeur. Au-delà, il s'affiche en
/// lecture seule par fenêtres de `MAX_WINDOW` octets (voir [`read_range`]).
pub const MAX_EDIT_SIZE: u64 = 50 * 1024 * 1024;
/// Taille maximale d'une fenêtre de lecture d'un gros fichier.
pub const MAX_WINDOW: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// Pour un lien symbolique : la cible est-elle un dossier ?
    pub target_is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: String,
    pub mode: u32,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
}

/// Progression d'un transfert.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub file: String,
    pub done: u64,
    pub total: u64,
}

/// Erreur renvoyée quand le callback de progression demande l'arrêt du transfert.
pub fn cancelled() -> Error {
    Error::Other("CANCELLED: transfert annulé".into())
}

fn sftp_err(e: impl std::fmt::Display) -> Error {
    Error::Sftp(e.to_string())
}

fn kind_of(t: FileType) -> EntryKind {
    match t {
        FileType::Dir => EntryKind::Dir,
        FileType::File => EntryKind::File,
        FileType::Symlink => EntryKind::Symlink,
        FileType::Other => EntryKind::Other,
    }
}

/// Représentation « rwxr-xr-x » des 9 bits de permission.
pub fn permission_string(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    for shift in [6, 3, 0] {
        let bits = (mode >> shift) & 0o7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

/// Joint un dossier distant et un nom avec des séparateurs POSIX.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub fn parent(path: &str) -> String {
    match path.trim_end_matches('/').rsplit_once('/') {
        Some(("", _)) | None => "/".into(),
        Some((p, _)) => p.into(),
    }
}

fn to_entry(name: String, path: String, meta: &FileAttributes, target_is_dir: bool) -> Entry {
    let mode = meta.permissions.unwrap_or(0);
    Entry {
        name,
        path,
        kind: kind_of(meta.file_type()),
        target_is_dir,
        size: meta.size.unwrap_or(0),
        modified: meta.mtime.map(u64::from),
        permissions: permission_string(mode),
        mode: mode & 0o7777,
        owner: meta.user.clone().or_else(|| meta.uid.map(|u| u.to_string())),
        group: meta.group.clone().or_else(|| meta.gid.map(|g| g.to_string())),
    }
}

pub async fn home(sftp: &SftpSession) -> Result<String> {
    sftp.canonicalize(".").await.map_err(sftp_err)
}

/// Liste un dossier : dossiers d'abord, puis tri alphabétique insensible à la casse.
pub async fn list(sftp: &SftpSession, path: &str) -> Result<Listing> {
    let path = sftp.canonicalize(path).await.map_err(sftp_err)?;
    let items: Vec<_> = sftp.read_dir(&path).await.map_err(sftp_err)?.filter(|e| e.file_name() != "." && e.file_name() != "..").collect();
    // Les cibles des liens symboliques sont résolues en parallèle : un aller-retour au lieu d'un
    // par lien (/etc en compte des dizaines).
    let dir = path.as_str();
    let mut entries = futures::future::join_all(items.into_iter().map(|e| async move {
        let name = e.file_name();
        let meta = e.metadata();
        let full = join(dir, &name);
        let target_is_dir =
            if meta.file_type() == FileType::Symlink { sftp.metadata(&full).await.map(|m| m.is_dir()).unwrap_or(false) } else { false };
        to_entry(name, full, &meta, target_is_dir)
    }))
    .await;
    entries.sort_by(|a, b| {
        let a_dir = a.kind == EntryKind::Dir || a.target_is_dir;
        let b_dir = b.kind == EntryKind::Dir || b.target_is_dir;
        b_dir.cmp(&a_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing { path, entries })
}

/// Lit un fichier texte pour l'éditeur, en octets (UTF-8 vérifié). Erreurs reconnues par l'interface :
/// `TOO_BIG:<taille>` (à afficher par fenêtres) et `NOT_UTF8` (à afficher en lecture seule).
pub async fn read_text(sftp: &SftpSession, path: &str) -> Result<Vec<u8>> {
    let meta = sftp.metadata(path).await.map_err(sftp_err)?;
    let size = meta.size.unwrap_or(0);
    if size > MAX_EDIT_SIZE {
        return Err(Error::Other(format!("TOO_BIG:{size}")));
    }
    let bytes = sftp.read(path).await.map_err(sftp_err)?;
    check_text(&bytes)?;
    Ok(bytes)
}

/// Refuse les fichiers binaires ; signale les fichiers texte dans un autre encodage que l'UTF-8.
pub fn check_text(bytes: &[u8]) -> Result<()> {
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err(Error::Other("fichier binaire : impossible de l'ouvrir dans l'éditeur".into()));
    }
    if std::str::from_utf8(bytes).is_err() {
        return Err(Error::Other("NOT_UTF8".into()));
    }
    Ok(())
}

/// Une portion d'un fichier, décodée pour l'affichage en lecture seule.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextWindow {
    pub text: String,
    /// Position du premier octet affiché.
    pub offset: u64,
    /// Nombre d'octets lus.
    pub len: u64,
    /// Taille totale du fichier.
    pub size: u64,
}

/// Décode une portion de fichier pour l'affichage (jamais réenregistrée). UTF-8 si la portion
/// l'est (hors caractères coupés aux deux bords), sinon Latin-1 : vieux fichiers de config ou journaux.
pub fn text_window(bytes: &[u8], offset: u64, size: u64) -> Result<TextWindow> {
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err(Error::Other("fichier binaire : impossible de l'afficher".into()));
    }
    // Début coupé au milieu d'un caractère : au plus 3 octets de continuation.
    let skip = bytes.iter().take(3).take_while(|&&b| b & 0xC0 == 0x80).count();
    let utf8 = match std::str::from_utf8(&bytes[skip..]) {
        Ok(_) => true,
        // Seule la fin est incomplète (caractère coupé par la fenêtre).
        Err(e) => e.error_len().is_none(),
    };
    let text = if utf8 { String::from_utf8_lossy(bytes).into_owned() } else { bytes.iter().map(|&b| b as char).collect() };
    Ok(TextWindow { text, offset, len: bytes.len() as u64, size })
}

/// Lit `len` octets (au plus [`MAX_WINDOW`]) à partir de `offset`.
pub async fn read_range(sftp: &SftpSession, path: &str, offset: u64, len: u64) -> Result<TextWindow> {
    let size = sftp.metadata(path).await.map_err(sftp_err)?.size.unwrap_or(0);
    let offset = offset.min(size);
    let len = len.min(MAX_WINDOW).min(size - offset) as usize;
    let mut file = sftp.open(path).await.map_err(sftp_err)?;
    file.seek(std::io::SeekFrom::Start(offset)).await.map_err(sftp_err)?;
    let mut buf = vec![0u8; len];
    let mut got = 0;
    while got < len {
        let n = file.read(&mut buf[got..]).await.map_err(sftp_err)?;
        if n == 0 {
            break;
        }
        got += n;
    }
    buf.truncate(got);
    text_window(&buf, offset, size)
}

/// Écrit un fichier en conservant ses permissions, son propriétaire et ses liens.
///
/// - Un lien symbolique est suivi : c'est sa cible qui est modifiée, le lien reste intact.
/// - Le contenu est écrit dans un fichier temporaire voisin, puis remplace l'original
///   atomiquement (`mv -f` via `conn`), pour ne jamais laisser un fichier à moitié écrit.
/// - Si le propriétaire d'origine ne peut pas être conservé (fichier d'un autre utilisateur),
///   l'écriture se fait en place : le fichier garde son propriétaire et ses liens physiques.
pub async fn write_text(sftp: &SftpSession, conn: Option<&Connection>, path: &str, content: &str) -> Result<()> {
    let target = match sftp.symlink_metadata(path).await {
        Ok(m) if m.file_type() == FileType::Symlink => sftp.canonicalize(path).await.map_err(sftp_err)?,
        _ => path.to_string(),
    };
    let Some(existing) = sftp.metadata(&target).await.ok() else {
        return write_in_place(sftp, &target, content).await;
    };
    let tmp = format!("{}/.{}.zenytt-tmp", parent(&target), target.rsplit('/').next().unwrap_or("fichier"));
    write_in_place(sftp, &tmp, content).await?;
    let mut attrs = FileAttributes::empty();
    attrs.permissions = existing.permissions.map(|p| p & 0o7777);
    let _ = sftp.set_metadata(&tmp, attrs).await;
    let mut owner = FileAttributes::empty();
    (owner.uid, owner.gid) = (existing.uid, existing.gid);
    let _ = sftp.set_metadata(&tmp, owner).await;
    let written = sftp.metadata(&tmp).await.map_err(sftp_err)?;
    if (written.uid, written.gid) != (existing.uid, existing.gid) {
        let _ = sftp.remove_file(&tmp).await;
        return write_in_place(sftp, &target, content).await;
    }
    match conn {
        Some(c) => {
            let out = c.exec(&format!("mv -f -- {} {}", shell_quote(&tmp), shell_quote(&target)), None).await?;
            if !out.success() {
                let _ = sftp.remove_file(&tmp).await;
                return Err(Error::Remote(out.stderr.trim().to_string()));
            }
            Ok(())
        }
        // Sans shell : SFTP v3 refuse de renommer par-dessus un fichier existant.
        None => {
            sftp.remove_file(&target).await.map_err(sftp_err)?;
            sftp.rename(&tmp, &target).await.map_err(sftp_err)
        }
    }
}

async fn write_in_place(sftp: &SftpSession, path: &str, content: &str) -> Result<()> {
    let mut f = sftp.open_with_flags(path, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(sftp_err)?;
    f.write_all(content.as_bytes()).await.map_err(sftp_err)?;
    f.shutdown().await.map_err(sftp_err)
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<()> {
    sftp.create_dir(path).await.map_err(sftp_err)
}

pub async fn create_file(sftp: &SftpSession, path: &str) -> Result<()> {
    if sftp.try_exists(path).await.map_err(sftp_err)? {
        return Err(Error::Other("un fichier porte déjà ce nom".into()));
    }
    sftp.create(path).await.map_err(sftp_err)?;
    Ok(())
}

pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<()> {
    sftp.rename(from, to).await.map_err(sftp_err)
}

pub async fn chmod(sftp: &SftpSession, path: &str, mode: u32) -> Result<()> {
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(mode & 0o7777);
    sftp.set_metadata(path, attrs).await.map_err(sftp_err)
}

/// Supprime un fichier, un lien ou un dossier (récursivement).
pub async fn remove(sftp: &SftpSession, path: &str) -> Result<()> {
    let meta = sftp.symlink_metadata(path).await.map_err(sftp_err)?;
    if !meta.is_dir() {
        return sftp.remove_file(path).await.map_err(sftp_err);
    }
    // Parcours itératif en profondeur : on vide les dossiers avant de les supprimer.
    let mut stack = vec![(path.to_string(), false)];
    while let Some((dir, emptied)) = stack.pop() {
        if emptied {
            sftp.remove_dir(&dir).await.map_err(sftp_err)?;
            continue;
        }
        stack.push((dir.clone(), true));
        for e in sftp.read_dir(&dir).await.map_err(sftp_err)? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = join(&dir, &name);
            if e.metadata().is_dir() {
                stack.push((child, false));
            } else {
                sftp.remove_file(&child).await.map_err(sftp_err)?;
            }
        }
    }
    Ok(())
}

/// Nom de fichier Linux rendu valide sous Windows (`: ? * " < > | \` et caractères de contrôle
/// remplacés, noms réservés comme `CON` ou `NUL` préfixés, points et espaces finaux retirés).
pub fn local_name(name: &str) -> String {
    let mut out: String = name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    while out.ends_with(['.', ' ']) {
        out.pop();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
        "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        out.insert(0, '_');
    }
    if out.is_empty() {
        "fichier".into()
    } else {
        out
    }
}

/// Premier chemin libre parmi `nom.ext`, `nom (1).ext`, `nom (2).ext`…
pub fn unique_local(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// Télécharge un fichier ou un dossier distant vers `local_dir`.
pub async fn download(
    sftp: &SftpSession,
    remote: &str,
    local_dir: &Path,
    on_progress: &(dyn Fn(Progress) -> bool + Send + Sync),
) -> Result<PathBuf> {
    let name = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("fichier");
    // Jamais d'écrasement silencieux d'un fichier local : « nom (1).ext » si besoin.
    let target = unique_local(local_dir, &local_name(name));
    let meta = sftp.metadata(remote).await.map_err(sftp_err)?;
    if meta.is_dir() {
        let mut stack = vec![(remote.to_string(), target.clone())];
        while let Some((rdir, ldir)) = stack.pop() {
            tokio::fs::create_dir_all(&ldir).await.map_err(|e| Error::Other(e.to_string()))?;
            for e in sftp.read_dir(&rdir).await.map_err(sftp_err)? {
                let n = e.file_name();
                if n == "." || n == ".." {
                    continue;
                }
                let (r, l) = (join(&rdir, &n), ldir.join(local_name(&n)));
                match e.file_type() {
                    FileType::Dir => stack.push((r, l)),
                    FileType::File => download_file(sftp, &r, &l, e.metadata().size.unwrap_or(0), on_progress).await?,
                    _ => {}
                }
            }
        }
    } else {
        download_file(sftp, remote, &target, meta.size.unwrap_or(0), on_progress).await?;
    }
    Ok(target)
}

async fn download_file(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    total: u64,
    on_progress: &(dyn Fn(Progress) -> bool + Send + Sync),
) -> Result<()> {
    let mut src = sftp.open(remote).await.map_err(sftp_err)?;
    let mut dst = tokio::fs::File::create(local).await.map_err(|e| Error::Other(e.to_string()))?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).await.map_err(sftp_err)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| Error::Other(e.to_string()))?;
        done += n as u64;
        if !on_progress(Progress { file: remote.to_string(), done, total }) {
            return Err(cancelled());
        }
    }
    dst.flush().await.map_err(|e| Error::Other(e.to_string()))?;
    let _ = on_progress(Progress { file: remote.to_string(), done, total: total.max(done) });
    Ok(())
}

/// Envoie un fichier ou un dossier local dans le dossier distant `remote_dir`.
pub async fn upload(
    sftp: &SftpSession,
    local: &Path,
    remote_dir: &str,
    on_progress: &(dyn Fn(Progress) -> bool + Send + Sync),
) -> Result<()> {
    let name = local.file_name().and_then(|n| n.to_str()).ok_or_else(|| Error::Other("nom de fichier invalide".into()))?;
    let target = join(remote_dir, name);
    if local.is_dir() {
        let mut stack = vec![(local.to_path_buf(), target)];
        while let Some((ldir, rdir)) = stack.pop() {
            if !sftp.try_exists(&rdir).await.map_err(sftp_err)? {
                sftp.create_dir(&rdir).await.map_err(sftp_err)?;
            }
            let mut rd = tokio::fs::read_dir(&ldir).await.map_err(|e| Error::Other(e.to_string()))?;
            while let Some(entry) = rd.next_entry().await.map_err(|e| Error::Other(e.to_string()))? {
                let path = entry.path();
                let n = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    stack.push((path, join(&rdir, &n)));
                } else {
                    upload_file(sftp, &path, &join(&rdir, &n), on_progress).await?;
                }
            }
        }
        Ok(())
    } else {
        upload_file(sftp, local, &target, on_progress).await
    }
}

/// Écrit des octets tenus en mémoire dans un fichier distant (créé ou tronqué), sans fichier
/// local intermédiaire : rien ne peut être substitué entre la vérification et l'envoi.
pub async fn write_bytes(sftp: &SftpSession, remote: &str, bytes: &[u8]) -> Result<()> {
    let mut dst = sftp.open_with_flags(remote, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(sftp_err)?;
    for chunk in bytes.chunks(CHUNK) {
        dst.write_all(chunk).await.map_err(sftp_err)?;
    }
    dst.shutdown().await.map_err(sftp_err)?;
    Ok(())
}

async fn upload_file(sftp: &SftpSession, local: &Path, remote: &str, on_progress: &(dyn Fn(Progress) -> bool + Send + Sync)) -> Result<()> {
    let mut src = tokio::fs::File::open(local).await.map_err(|e| Error::Other(e.to_string()))?;
    let total = src.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut dst = sftp.open_with_flags(remote, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(sftp_err)?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let label = local.display().to_string();
    loop {
        let n = src.read(&mut buf).await.map_err(|e| Error::Other(e.to_string()))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(sftp_err)?;
        done += n as u64;
        if !on_progress(Progress { file: label.clone(), done, total }) {
            return Err(cancelled());
        }
    }
    dst.shutdown().await.map_err(sftp_err)?;
    Ok(())
}

/// Copie un fichier ou un dossier d'un serveur à un autre, en flux (A → PC → B) par blocs :
/// la mémoire utilisée reste bornée quelle que soit la taille, et aucune clé n'est transmise aux serveurs.
/// Si la cible existe déjà et que `overwrite` est faux, renvoie une erreur `EXISTS:<chemin>`.
pub async fn copy_between(
    src: &SftpSession,
    src_path: &str,
    dst: &SftpSession,
    dst_dir: &str,
    overwrite: bool,
    on_progress: &(dyn Fn(Progress) -> bool + Send + Sync),
) -> Result<String> {
    let name = src_path.trim_end_matches('/').rsplit('/').next().unwrap_or("fichier").to_string();
    let target = join(dst_dir, &name);
    if !overwrite && dst.try_exists(&target).await.map_err(sftp_err)? {
        return Err(Error::Other(format!("EXISTS:{target}")));
    }
    let meta = src.metadata(src_path).await.map_err(sftp_err)?;
    if !meta.is_dir() {
        copy_file(src, src_path, dst, &target, meta.size.unwrap_or(0), meta.permissions, on_progress).await?;
        return Ok(target);
    }
    let mut stack = vec![(src_path.to_string(), target.clone())];
    while let Some((sdir, ddir)) = stack.pop() {
        if !dst.try_exists(&ddir).await.map_err(sftp_err)? {
            dst.create_dir(&ddir).await.map_err(sftp_err)?;
        }
        for e in src.read_dir(&sdir).await.map_err(sftp_err)? {
            let n = e.file_name();
            if n == "." || n == ".." {
                continue;
            }
            let (s, d) = (join(&sdir, &n), join(&ddir, &n));
            let m = e.metadata();
            match m.file_type() {
                FileType::Dir => stack.push((s, d)),
                FileType::File => copy_file(src, &s, dst, &d, m.size.unwrap_or(0), m.permissions, on_progress).await?,
                // Les liens symboliques et fichiers spéciaux ne sont pas recopiés.
                _ => {}
            }
        }
    }
    Ok(target)
}

async fn copy_file(
    src: &SftpSession,
    from: &str,
    dst: &SftpSession,
    to: &str,
    total: u64,
    mode: Option<u32>,
    on_progress: &(dyn Fn(Progress) -> bool + Send + Sync),
) -> Result<()> {
    let mut r = src.open(from).await.map_err(sftp_err)?;
    let mut w = dst.open_with_flags(to, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(sftp_err)?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = r.read(&mut buf).await.map_err(sftp_err)?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).await.map_err(sftp_err)?;
        done += n as u64;
        if !on_progress(Progress { file: from.to_string(), done, total }) {
            let _ = w.shutdown().await;
            let _ = dst.remove_file(to).await;
            return Err(cancelled());
        }
    }
    w.shutdown().await.map_err(sftp_err)?;
    if let Some(m) = mode {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(m & 0o7777);
        let _ = dst.set_metadata(to, attrs).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn text_windows() {
        // Caractères coupés aux bords d'une fenêtre UTF-8 : pas de bascule en Latin-1.
        let s = "é".repeat(10);
        let w = text_window(&s.as_bytes()[1..s.len() - 1], 1, 20).unwrap();
        assert_eq!(w.text.chars().filter(|&c| c == 'é').count(), 8);
        // Fichier Latin-1.
        assert_eq!(text_window(b"caf\xe9 cr\xe8me", 0, 10).unwrap().text, "café crème");
        assert!(text_window(b"a\0b", 0, 3).is_err());
        assert!(check_text("déjà".as_bytes()).is_ok());
        assert_eq!(check_text(b"caf\xe9").unwrap_err().to_string(), "NOT_UTF8");
    }

    use super::*;

    #[test]
    fn windows_safe_names() {
        assert_eq!(local_name("rapport:2026?.log"), "rapport_2026_.log");
        assert_eq!(local_name("con.txt"), "_con.txt");
        assert_eq!(local_name("fin. "), "fin");
        assert_eq!(local_name("normal.tar.gz"), "normal.tar.gz");
    }

    #[test]
    fn permissions() {
        assert_eq!(permission_string(0o755), "rwxr-xr-x");
        assert_eq!(permission_string(0o100644), "rw-r--r--");
        assert_eq!(permission_string(0o600), "rw-------");
    }

    #[test]
    fn paths() {
        assert_eq!(join("/etc", "nginx"), "/etc/nginx");
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(parent("/etc/nginx"), "/etc");
        assert_eq!(parent("/etc"), "/");
        assert_eq!(parent("/"), "/");
    }
}
