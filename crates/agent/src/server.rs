//! Socket unix : une requête JSON par connexion, une réponse JSON en retour.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use zenytt_protocol::{Request, Response};

use crate::collector::now_ms;
use crate::state::{self, Shared};

pub fn serve(path: &Path, state: Shared) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    // Métriques lisibles par tout utilisateur local (Zenytt s'y connecte sans sudo). Les URL de
    // notification et l'envoi de test sont réservés à root, vérifié sur l'identité du client.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        // Un client local ne peut pas épuiser les threads de l'agent.
        if active.load(Ordering::Relaxed) >= MAX_CLIENTS {
            continue;
        }
        active.fetch_add(1, Ordering::Relaxed);
        let (s, a) = (state.clone(), active.clone());
        std::thread::spawn(move || {
            handle(stream, s);
            a.fetch_sub(1, Ordering::Relaxed);
        });
    }
    Ok(())
}

const MAX_CLIENTS: usize = 16;

/// UID du processus client, lu sur le socket (SO_PEERCRED).
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred { pid: 0, uid: u32::MAX, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY : `cred` et `len` sont valides et dimensionnés pour SO_PEERCRED.
    let rc = unsafe {
        libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len)
    };
    (rc == 0).then_some(cred.uid)
}

/// Budget total pour recevoir la requête : un client qui envoie un octet à la fois ne garde pas
/// un des emplacements plus longtemps.
const REQUEST_BUDGET: Duration = Duration::from_secs(10);

/// Lit une ligne (64 Ko au plus) avant l'échéance globale.
fn read_request(stream: &UnixStream) -> Option<String> {
    let end = Instant::now() + REQUEST_BUDGET;
    let (mut buf, mut chunk, mut r) = (Vec::new(), [0u8; 1024], stream);
    while !buf.contains(&b'
') {
        let left = end.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())?;
        stream.set_read_timeout(Some(left)).ok()?;
        let n = r.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 64 * 1024 {
            return None;
        }
    }
    String::from_utf8(buf).ok()
}

/// URL sans identifiants (`user:pass@`), requête ni fragment : ce sont souvent des jetons.
fn redact_url(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").map_or(("", url), |(s, r)| (s, r));
    let sep = if scheme.is_empty() { "" } else { "://" };
    let (auth, tail) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    let host = auth.rsplit('@').next().unwrap_or(auth);
    format!("{scheme}{sep}{host}{}", tail.split(['?', '#']).next().unwrap_or(""))
}

fn handle(stream: UnixStream, state: Shared) {
    let privileged = peer_uid(&stream) == Some(0);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let Some(line) = read_request(&stream) else { return };
    let response = match serde_json::from_str::<Request>(line.trim()) {
        Ok(req) => answer(req, &state, privileged),
        Err(e) => Response::Error { message: format!("requête invalide : {e}") },
    };
    let mut out = serde_json::to_vec(&response).unwrap_or_default();
    out.push(b'\n');
    let _ = (&stream).write_all(&out);
}

fn answer(req: Request, state: &Shared, privileged: bool) -> Response {
    match req {
        Request::Status => {
            let mut status = state.lock().unwrap().status();
            if !privileged {
                status.config.notifiers = status.config.notifiers.redacted();
                for c in &mut status.config.http_checks {
                    c.url = redact_url(&c.url);
                }
            }
            Response::Status(Box::new(status))
        }
        Request::Live { count } => {
            let s = state.lock().unwrap();
            let skip = s.history.live.len().saturating_sub(count);
            Response::Live { metrics: s.history.live.iter().skip(skip).cloned().collect() }
        }
        Request::History { range_secs, points } => {
            let s = state.lock().unwrap();
            Response::History { points: s.history.range(now_ms(), range_secs, points.clamp(10, 2000)) }
        }
        Request::TestNotify if !privileged => Response::Error { message: "envoi de test réservé à root (sudo)".into() },
        Request::TestNotify => match state::test_notify(state) {
            Ok(message) => Response::Ok { message },
            Err(message) => Response::Error { message },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_lose_credentials_and_query() {
        assert_eq!(redact_url("https://u:p@example.com:8080/health?token=abc#x"), "https://example.com:8080/health");
        assert_eq!(redact_url("http://example.com?k=v"), "http://example.com");
        assert_eq!(redact_url("example.com/a"), "example.com/a");
    }
}
