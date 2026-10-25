//! Journaux centralisés : plusieurs sources (conteneurs, services, fichiers) suivies en direct.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use zenytt_core::docker::{self, Access};
use zenytt_core::russh::client::Msg;
use zenytt_core::russh::{ChannelMsg, ChannelWriteHalf};
use zenytt_core::ssh::shell_quote;

use crate::commands::{admin, err};
use crate::sessions::Sessions;
use crate::store::Store;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// `docker`, `unit` ou `file`.
    pub kind: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    source: usize,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines { lines: Vec<LogLine> },
    Ended { source: usize, error: Option<String> },
}

struct Stream {
    tasks: Vec<JoinHandle<()>>,
    writers: Vec<ChannelWriteHalf<Msg>>,
}

#[derive(Default)]
pub struct LogStreams {
    streams: Mutex<HashMap<u64, Stream>>,
    next: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    containers: Vec<String>,
    units: Vec<String>,
    files: Vec<String>,
}

fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:".contains(c))
}

/// Seuls les fichiers de /var/log sont lisibles, sans remonter dans l'arborescence.
fn safe_log_file(p: &str) -> bool {
    p.starts_with("/var/log/") && !p.contains("..") && p.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
}

const FILES_COMMAND: &str = "ls -1 /var/log/nginx/*.log /var/log/syslog /var/log/auth.log /var/log/kern.log /var/log/messages /var/log/secure /var/log/fail2ban.log /var/log/zenytt-deploy.log 2>/dev/null";

#[tauri::command]
pub async fn logs_sources(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Sources, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let mut out = Sources { containers: vec![], units: vec![], files: vec![] };
    if let Ok((access, _)) = docker::access(&conn, sudo.as_deref()).await {
        if access != Access::Unavailable {
            out.containers = docker::containers(&conn, access, sudo.as_deref())
                .await
                .map(|l| l.into_iter().map(|c| c.name).collect())
                .unwrap_or_default();
        }
    }
    if let Ok(Some(units)) = zenytt_core::system::services(&conn).await {
        out.units = units.into_iter().filter(|u| u.active == "active" || u.active == "failed").map(|u| u.unit).collect();
    }
    let files = conn.exec(FILES_COMMAND, None).await.map_err(err)?;
    out.files = files.stdout.lines().filter(|l| safe_log_file(l)).map(str::to_string).collect();
    Ok(out)
}

#[tauri::command]
pub async fn logs_start(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    streams: State<'_, LogStreams>,
    server_id: String,
    sources: Vec<Source>,
    lines: u32,
    on_event: Channel<LogEvent>,
) -> Result<u64, String> {
    if sources.is_empty() || sources.len() > 12 {
        return Err("choisis entre 1 et 12 sources".into());
    }
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let tail = lines.clamp(0, 5000);
    let docker_access = if sources.iter().any(|s| s.kind == "docker") {
        docker::access(&conn, sudo.as_deref()).await.map_err(err)?.0
    } else {
        Access::Unavailable
    };

    // Sans sudo utilisable, journaux et fichiers se lisent avec les droits de l'utilisateur (ce qu'il peut voir).
    let can_root = sudo.is_some()
        || sources.iter().all(|s| s.kind == "docker")
        || conn.exec("[ \"$(id -u)\" = 0 ] || sudo -n true 2>/dev/null", None).await.map(|o| o.success()).unwrap_or(false);

    let mut stream = Stream { tasks: vec![], writers: vec![] };
    for (idx, src) in sources.iter().enumerate() {
        let (command, root) = match src.kind.as_str() {
            "docker" if safe_name(&src.name) => (
                format!("{}docker logs -f -t --tail {tail} {} 2>&1", docker::PODMAN_SHIM, shell_quote(&src.name)),
                docker_access == Access::Sudo,
            ),
            "unit" if safe_name(&src.name) => {
                (format!("journalctl -f -n {tail} -o short-iso --no-pager -u {}", shell_quote(&src.name)), can_root)
            }
            "file" if safe_log_file(&src.name) => (format!("tail -n {tail} -F {} 2>&1", shell_quote(&src.name)), can_root),
            _ => return Err(format!("source refusée : {} {}", src.kind, src.name)),
        };
        // La commande tourne en arrière-plan et s'arrête dès que stdin se ferme (fin du suivi côté app) :
        // aucun `tail -F` ou `journalctl -f` ne reste orphelin sur le serveur.
        let command = format!("{command} & p=$!; cat >/dev/null; kill $p 2>/dev/null");
        let channel =
            if root { conn.open_exec_sudo(&command, sudo.as_deref()).await } else { conn.open_exec(&command, None).await }.map_err(err)?;
        let (mut reader, writer) = channel.split();
        stream.writers.push(writer);
        let events = on_event.clone();
        stream.tasks.push(tauri::async_runtime::spawn(async move {
            let mut pending = String::new();
            let mut error = None;
            while let Some(msg) = reader.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        pending.push_str(&String::from_utf8_lossy(&data));
                        if let Some(cut) = pending.rfind('\n') {
                            let complete: String = pending.drain(..=cut).collect();
                            let lines: Vec<LogLine> = complete.lines().map(|l| LogLine { source: idx, text: l.to_string() }).collect();
                            if events.send(LogEvent::Lines { lines }).is_err() {
                                return;
                            }
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => error = Some(format!("code de sortie {exit_status}")),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = events.send(LogEvent::Ended { source: idx, error });
        }));
    }
    let id = streams.next.fetch_add(1, Ordering::Relaxed);
    streams.streams.lock().await.insert(id, stream);
    Ok(id)
}

/// Arrête un suivi : ferme les canaux (ce qui termine `tail -F`, `journalctl -f`… sur le serveur).
#[tauri::command]
pub async fn logs_stop(streams: State<'_, LogStreams>, id: u64) -> Result<(), String> {
    if let Some(s) = streams.streams.lock().await.remove(&id) {
        for w in s.writers {
            let _ = w.eof().await;
            let _ = w.close().await;
        }
        for t in s.tasks {
            t.abort();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_are_validated() {
        assert!(safe_log_file("/var/log/nginx/access.log"));
        assert!(!safe_log_file("/var/log/../../etc/shadow"));
        assert!(!safe_log_file("/etc/shadow"));
        assert!(safe_name("nginx.service"));
        assert!(!safe_name("x; rm -rf /"));
    }
}
