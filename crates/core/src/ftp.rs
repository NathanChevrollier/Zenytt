//! Opérations de fichiers distants via FTP et FTPS (TLS explicite), pendant de [`crate::sftp`].
//! Un client FTP ne fait qu'une chose à la fois : l'appelant le garde derrière un verrou.
//! Tous les chemins sont absolus (le dossier courant du serveur n'est jamais utilisé).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use suppaftp::list::{File, FileType as ListType, ListParser, PosixPexQuery};
use suppaftp::tokio::{AsyncRustlsConnector, ImplAsyncFtpStream};
use suppaftp::tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use suppaftp::tokio_rustls::rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use suppaftp::tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use suppaftp::tokio_rustls::rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use suppaftp::tokio_rustls::TlsConnector;
use suppaftp::types::FileType;
use suppaftp::{FtpError, Mode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::sftp::{
    cancelled, check_text, join, local_name, permission_string, text_window, unique_local, Entry, EntryKind, Listing, Progress, TextWindow,
    CHUNK, MAX_EDIT_SIZE, MAX_WINDOW,
};
use crate::{Error, Result};

pub type Ftp = ImplAsyncFtpStream<suppaftp::tokio::AsyncRustlsStream>;

fn ftp_err(e: impl std::fmt::Display) -> Error {
    Error::Ftp(e.to_string())
}

fn io_err(e: impl std::fmt::Display) -> Error {
    Error::Other(e.to_string())
}

/// Accepte tout certificat : les serveurs FTPS auto-hébergés sont presque toujours auto-signés.
/// shortcut: pas de vérification du certificat ni d'épinglage, à ajouter si FTPS sert sur Internet public.
#[derive(Debug)]
struct AcceptAny(Arc<CryptoProvider>);

type TlsResult<T> = std::result::Result<T, suppaftp::tokio_rustls::rustls::Error>;

impl ServerCertVerifier for AcceptAny {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> TlsResult<ServerCertVerified> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> TlsResult<HandshakeSignatureValid> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> TlsResult<HandshakeSignatureValid> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Se connecte et s'authentifie ; avec `secure`, passe en TLS explicite (`AUTH TLS`) avant l'identification.
pub async fn connect(host: &str, port: u16, user: &str, password: &str, secure: bool) -> Result<Ftp> {
    let mut ftp = tokio::time::timeout(Duration::from_secs(15), Ftp::connect((host, port)))
        .await
        .map_err(|_| Error::Connection(format!("{host}:{port} ne répond pas")))?
        .map_err(|e| Error::Connection(e.to_string()))?;
    if secure {
        let provider = Arc::new(ring::default_provider());
        let config = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(ftp_err)?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAny(provider)))
            .with_no_client_auth();
        let connector = AsyncRustlsConnector::from(TlsConnector::from(Arc::new(config)));
        ftp = ftp.into_secure(connector, host).await.map_err(|e| Error::Connection(e.to_string()))?;
    }
    ftp.login(user, password).await.map_err(|e| Error::Auth(e.to_string()))?;
    ftp.set_mode(Mode::Passive);
    // Serveurs derrière un NAT ou Docker qui annoncent leur adresse privée en mode passif.
    ftp.set_passive_nat_workaround(true);
    ftp.transfer_type(FileType::Binary).await.map_err(ftp_err)?;
    Ok(ftp)
}

pub async fn home(ftp: &mut Ftp) -> Result<String> {
    ftp.pwd().await.map_err(ftp_err)
}

/// Convertit une ligne `MLSD` ou `LIST` déjà analysée en entrée de l'explorateur.
fn to_entry(f: &File, dir: &str) -> Entry {
    let kind = match f.file_type() {
        ListType::Directory => EntryKind::Dir,
        ListType::File => EntryKind::File,
        ListType::Symlink(_) => EntryKind::Symlink,
    };
    let mut mode = 0;
    for who in [PosixPexQuery::Owner, PosixPexQuery::Group, PosixPexQuery::Others] {
        mode = mode << 3 | u32::from(f.can_read(who)) << 2 | u32::from(f.can_write(who)) << 1 | u32::from(f.can_execute(who));
    }
    let name = f.name().to_string();
    Entry {
        path: join(dir, &name),
        name,
        kind,
        target_is_dir: false,
        size: f.size() as u64,
        modified: f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()).filter(|&s| s > 0),
        permissions: permission_string(mode),
        mode,
        owner: f.uid().map(|u| u.to_string()),
        group: f.gid().map(|g| g.to_string()),
    }
}

/// Lignes d'un listing : `MLSD` si le serveur le connaît, sinon `LIST` au format Unix ou DOS.
/// Les lignes illisibles (« total 12 », types exotiques) sont ignorées.
fn parse_listing(lines: &[String], mlsd: bool) -> Vec<File> {
    lines
        .iter()
        .filter_map(|l| {
            if mlsd { ListParser::parse_mlsd(l) } else { ListParser::parse_posix(l).or_else(|_| ListParser::parse_dos(l)) }.ok()
        })
        .filter(|f| f.name() != "." && f.name() != "..")
        .collect()
}

/// Un dossier existe-t-il ? (`CWD` est la seule question portable.)
async fn is_dir(ftp: &mut Ftp, path: &str) -> bool {
    ftp.cwd(path).await.is_ok()
}

/// Liste un dossier : dossiers d'abord, puis tri alphabétique insensible à la casse.
pub async fn list(ftp: &mut Ftp, path: &str) -> Result<Listing> {
    let path = if path.starts_with('/') { path.to_string() } else { join(&home(ftp).await?, path.trim_start_matches("./")) };
    let path = if path.len() > 1 { path.trim_end_matches('/').to_string() } else { path };
    let files = match ftp.mlsd(Some(&path)).await {
        Ok(lines) => parse_listing(&lines, true),
        Err(FtpError::UnexpectedResponse(_)) => parse_listing(&ftp.list(Some(&path)).await.map_err(ftp_err)?, false),
        Err(e) => return Err(ftp_err(e)),
    };
    let mut entries: Vec<Entry> = files.iter().map(|f| to_entry(f, &path)).collect();
    for e in entries.iter_mut().filter(|e| e.kind == EntryKind::Symlink) {
        e.target_is_dir = is_dir(ftp, &e.path).await;
    }
    entries.sort_by(|a, b| {
        let a_dir = a.kind == EntryKind::Dir || a.target_is_dir;
        let b_dir = b.kind == EntryKind::Dir || b.target_is_dir;
        b_dir.cmp(&a_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing { path, entries })
}

/// Lit au plus `max` octets à partir de `offset`.
async fn read_from(ftp: &mut Ftp, path: &str, offset: u64, max: u64) -> Result<Vec<u8>> {
    if offset > 0 {
        ftp.resume_transfer(offset as usize).await.map_err(ftp_err)?;
    }
    let mut stream = ftp.retr_as_stream(path).await.map_err(ftp_err)?;
    let mut buf = Vec::new();
    (&mut stream).take(max).read_to_end(&mut buf).await.map_err(io_err)?;
    if buf.len() as u64 >= max {
        // Fichier plus long que demandé : le transfert est interrompu, pas terminé.
        let _ = ftp.abort(stream).await;
    } else {
        stream.finish().await.map_err(ftp_err)?;
    }
    Ok(buf)
}

/// Lit un fichier texte pour l'éditeur (mêmes erreurs `TOO_BIG` et `NOT_UTF8` que SFTP).
pub async fn read_text(ftp: &mut Ftp, path: &str) -> Result<Vec<u8>> {
    if let Ok(size) = ftp.size(path).await {
        if size as u64 > MAX_EDIT_SIZE {
            return Err(Error::Other(format!("TOO_BIG:{size}")));
        }
    }
    let bytes = read_from(ftp, path, 0, MAX_EDIT_SIZE + 1).await?;
    if bytes.len() as u64 > MAX_EDIT_SIZE {
        return Err(Error::Other(format!("TOO_BIG:{}", bytes.len())));
    }
    check_text(&bytes)?;
    Ok(bytes)
}

/// Lit `len` octets (au plus `MAX_WINDOW`) à partir de `offset`.
pub async fn read_range(ftp: &mut Ftp, path: &str, offset: u64, len: u64) -> Result<TextWindow> {
    let size = ftp.size(path).await.map_err(ftp_err)? as u64;
    let offset = offset.min(size);
    let len = len.min(MAX_WINDOW).min(size - offset);
    if len == 0 {
        return text_window(&[], offset, size);
    }
    let buf = read_from(ftp, path, offset, len).await?;
    text_window(&buf, offset, size)
}

/// Écrit des octets dans un fichier distant (créé ou tronqué).
/// shortcut: écriture en place, sans fichier temporaire ni conservation des permissions (FTP ne sait pas renommer par-dessus).
pub async fn write_bytes(ftp: &mut Ftp, remote: &str, bytes: &[u8]) -> Result<()> {
    let mut dst = ftp.put_with_stream(remote).await.map_err(ftp_err)?;
    for chunk in bytes.chunks(CHUNK) {
        dst.write_all(chunk).await.map_err(io_err)?;
    }
    dst.finish().await.map_err(ftp_err)
}

pub async fn write_text(ftp: &mut Ftp, path: &str, content: &str) -> Result<()> {
    write_bytes(ftp, path, content.as_bytes()).await
}

pub async fn mkdir(ftp: &mut Ftp, path: &str) -> Result<()> {
    ftp.mkdir(path).await.map_err(ftp_err)
}

pub async fn create_file(ftp: &mut Ftp, path: &str) -> Result<()> {
    if ftp.size(path).await.is_ok() || is_dir(ftp, path).await {
        return Err(Error::Other("un fichier porte déjà ce nom".into()));
    }
    write_bytes(ftp, path, &[]).await
}

pub async fn rename(ftp: &mut Ftp, from: &str, to: &str) -> Result<()> {
    ftp.rename(from, to).await.map_err(ftp_err)
}

/// Meilleur effort : `SITE CHMOD` n'est pas standard et beaucoup de serveurs le refusent.
pub async fn chmod(ftp: &mut Ftp, path: &str, mode: u32) -> Result<()> {
    ftp.site(format!("CHMOD {:o} {path}", mode & 0o7777)).await.map(|_| ()).map_err(ftp_err)
}

/// Supprime un fichier, un lien ou un dossier (récursivement).
pub async fn remove(ftp: &mut Ftp, path: &str) -> Result<()> {
    if ftp.rm(path).await.is_ok() {
        return Ok(());
    }
    // Pas un fichier : on vide les dossiers avant de les supprimer.
    let mut stack = vec![(path.to_string(), false)];
    while let Some((dir, emptied)) = stack.pop() {
        if emptied {
            ftp.rmdir(&dir).await.map_err(ftp_err)?;
            continue;
        }
        stack.push((dir.clone(), true));
        for e in list(ftp, &dir).await?.entries {
            if e.kind == EntryKind::Dir {
                stack.push((e.path, false));
            } else {
                ftp.rm(&e.path).await.map_err(ftp_err)?;
            }
        }
    }
    Ok(())
}

/// Télécharge un fichier ou un dossier distant vers `local_dir`.
pub async fn download(
    ftp: &mut Ftp,
    remote: &str,
    local_dir: &Path,
    on_progress: &(dyn Fn(Progress) -> bool + Send + Sync),
) -> Result<PathBuf> {
    let name = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("fichier");
    // Jamais d'écrasement silencieux d'un fichier local : « nom (1).ext » si besoin.
    let target = unique_local(local_dir, &local_name(name));
    if !is_dir(ftp, remote).await {
        let total = ftp.size(remote).await.unwrap_or(0) as u64;
        download_file(ftp, remote, &target, total, on_progress).await?;
        return Ok(target);
    }
    let mut stack = vec![(remote.to_string(), target.clone())];
    while let Some((rdir, ldir)) = stack.pop() {
        tokio::fs::create_dir_all(&ldir).await.map_err(io_err)?;
        for e in list(ftp, &rdir).await?.entries {
            let l = ldir.join(local_name(&e.name));
            match e.kind {
                EntryKind::Dir => stack.push((e.path, l)),
                EntryKind::File => download_file(ftp, &e.path, &l, e.size, on_progress).await?,
                _ => {}
            }
        }
    }
    Ok(target)
}

async fn download_file(
    ftp: &mut Ftp,
    remote: &str,
    local: &Path,
    total: u64,
    on_progress: &(dyn Fn(Progress) -> bool + Send + Sync),
) -> Result<()> {
    let mut src = ftp.retr_as_stream(remote).await.map_err(ftp_err)?;
    let mut dst = tokio::fs::File::create(local).await.map_err(io_err)?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).await.map_err(io_err)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(io_err)?;
        done += n as u64;
        if !on_progress(Progress { file: remote.to_string(), done, total }) {
            let _ = ftp.abort(src).await;
            return Err(cancelled());
        }
    }
    src.finish().await.map_err(ftp_err)?;
    dst.flush().await.map_err(io_err)?;
    let _ = on_progress(Progress { file: remote.to_string(), done, total: total.max(done) });
    Ok(())
}

/// Envoie un fichier ou un dossier local dans le dossier distant `remote_dir`.
pub async fn upload(ftp: &mut Ftp, local: &Path, remote_dir: &str, on_progress: &(dyn Fn(Progress) -> bool + Send + Sync)) -> Result<()> {
    let name = local.file_name().and_then(|n| n.to_str()).ok_or_else(|| Error::Other("nom de fichier invalide".into()))?;
    let target = join(remote_dir, name);
    if !local.is_dir() {
        return upload_file(ftp, local, &target, on_progress).await;
    }
    let mut stack = vec![(local.to_path_buf(), target)];
    while let Some((ldir, rdir)) = stack.pop() {
        if !is_dir(ftp, &rdir).await {
            mkdir(ftp, &rdir).await?;
        }
        let mut rd = tokio::fs::read_dir(&ldir).await.map_err(io_err)?;
        while let Some(entry) = rd.next_entry().await.map_err(io_err)? {
            let path = entry.path();
            let n = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                stack.push((path, join(&rdir, &n)));
            } else {
                upload_file(ftp, &path, &join(&rdir, &n), on_progress).await?;
            }
        }
    }
    Ok(())
}

async fn upload_file(ftp: &mut Ftp, local: &Path, remote: &str, on_progress: &(dyn Fn(Progress) -> bool + Send + Sync)) -> Result<()> {
    let mut src = tokio::fs::File::open(local).await.map_err(io_err)?;
    let total = src.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut dst = ftp.put_with_stream(remote).await.map_err(ftp_err)?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let label = local.display().to_string();
    loop {
        let n = src.read(&mut buf).await.map_err(io_err)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(io_err)?;
        done += n as u64;
        if !on_progress(Progress { file: label.clone(), done, total }) {
            let _ = ftp.abort(dst).await;
            return Err(cancelled());
        }
    }
    dst.finish().await.map_err(ftp_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_unix_format() {
        let lines: Vec<String> = [
            "total 12",
            "drwxr-xr-x   2 ftp      ftp          4096 Jan 15 10:30 www",
            "-rw-r--r--   1 1000     1000         1234 Mar 02  2024 notes final.txt",
            "lrwxrwxrwx   1 ftp      ftp             3 Jan 15 10:30 lien -> www",
            "drwxr-xr-x   2 ftp      ftp          4096 Jan 15 10:30 .",
            "drwxr-xr-x   2 ftp      ftp          4096 Jan 15 10:30 ..",
        ]
        .map(String::from)
        .into();
        let files = parse_listing(&lines, false);
        let entries: Vec<Entry> = files.iter().map(|f| to_entry(f, "/srv")).collect();
        assert_eq!(entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>(), ["www", "notes final.txt", "lien"]);
        assert_eq!((entries[0].kind, entries[0].permissions.as_str(), entries[0].mode), (EntryKind::Dir, "rwxr-xr-x", 0o755));
        assert_eq!(
            (entries[1].name.as_str(), entries[1].size, entries[1].path.as_str()),
            ("notes final.txt", 1234, "/srv/notes final.txt")
        );
        assert_eq!(entries[2].kind, EntryKind::Symlink);
    }

    #[test]
    fn list_dos_and_mlsd() {
        let dos = parse_listing(&["10-19-20  03:19PM <DIR> pub".into(), "04-08-14  03:09PM 403   readme.txt".into()], false);
        assert_eq!((dos[0].is_directory(), dos[1].size()), (true, 403));
        let mlsd = parse_listing(
            &[
                "type=cdir;modify=20240101120000; .".into(),
                "type=dir;modify=20240101120000;unix.mode=0750; site".into(),
                "type=file;size=42;modify=20240101120000;unix.mode=0644; a b.txt".into(),
            ],
            true,
        );
        assert_eq!(mlsd.len(), 2);
        let e = to_entry(&mlsd[1], "/");
        assert_eq!((e.name.as_str(), e.size, e.mode, e.modified), ("a b.txt", 42, 0o644, Some(1704110400)));
        assert_eq!(to_entry(&mlsd[0], "/").mode, 0o750);
    }
}
