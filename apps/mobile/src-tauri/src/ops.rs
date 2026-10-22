//! Tableau de bord, conteneurs Docker et fail2ban d'un serveur.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;
use zenytt_core::docker::{self, Access, Container};
use zenytt_core::{agent, fail2ban, system};
use zenytt_profiles::{secrets, Store};
use zenytt_protocol::proc::{parse_collect, COLLECT_SCRIPT};
use zenytt_protocol::{ActiveAlert, Metrics, RawSample};

use crate::sessions::Sessions;

/// Relevé précédent de chaque serveur, pour calculer le CPU et le débit entre deux relevés.
#[derive(Default)]
pub struct Monitor(Mutex<HashMap<String, RawSample>>);

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    connected: bool,
    /// Erreur de connexion ; `UNKNOWN_HOST_KEY:` / `HOST_KEY_MISMATCH:` / `AUTH_BLOCKED:` / `NEED_PASSWORD:` demandent une action.
    error: Option<String>,
    metrics: Option<Metrics>,
    /// L'agent zenyttd est installé et répond.
    agent: bool,
    alerts: Vec<ActiveAlert>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
pub async fn dashboard_summary(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    monitor: State<'_, Monitor>,
    server_id: String,
) -> Result<Summary, String> {
    let work = async {
        let conn = match sessions.get(&store, &server_id).await {
            Ok(c) => c,
            Err(e) => return Summary { error: Some(e), ..Default::default() },
        };
        match agent::info(&conn).await {
            Ok(info) if info.running => {
                let (metrics, alerts) = info.status.map(|st| (st.latest, st.active_alerts)).unwrap_or_default();
                Summary { connected: true, metrics, agent: true, alerts, ..Default::default() }
            }
            _ => {
                // Sans agent : relevé direct (le CPU se calcule avec le relevé précédent).
                let mut metrics = None;
                if let Ok(text) = conn.run(COLLECT_SCRIPT).await {
                    let raw = parse_collect(&text, now_ms());
                    let mut prev = monitor.0.lock().await;
                    metrics = Some(zenytt_protocol::compute(prev.get(&server_id), &raw));
                    prev.insert(server_id.clone(), raw);
                }
                Summary { connected: true, metrics, ..Default::default() }
            }
        }
    };
    // Un serveur lent ou injoignable ne doit pas bloquer l'écran.
    Ok(tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .unwrap_or_else(|_| Summary { error: Some("délai dépassé".into()), ..Default::default() }))
}

#[derive(Serialize)]
pub struct ContainerList {
    available: bool,
    containers: Vec<Container>,
}

#[tauri::command]
pub async fn docker_list(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<ContainerList, String> {
    let conn = sessions.get(&store, &server_id).await?;
    let sudo = secrets::get(&server_id, "sudo");
    let (access, _) = docker::access(&conn, sudo.as_deref()).await.map_err(|e| e.to_string())?;
    if access == Access::Unavailable {
        return Ok(ContainerList { available: false, containers: vec![] });
    }
    let containers = docker::containers(&conn, access, sudo.as_deref()).await.map_err(|e| e.to_string())?;
    Ok(ContainerList { available: true, containers })
}

/// Démarrer, arrêter ou redémarrer un conteneur (rien d'autre depuis le téléphone).
#[tauri::command]
pub async fn docker_action(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    container: String,
    action: String,
) -> Result<(), String> {
    if !["start", "stop", "restart"].contains(&action.as_str()) {
        return Err(format!("action non autorisée : {action}"));
    }
    let conn = sessions.get(&store, &server_id).await?;
    let sudo = secrets::get(&server_id, "sudo");
    let (access, _) = docker::access(&conn, sudo.as_deref()).await.map_err(|e| e.to_string())?;
    docker::container_action(&conn, access, sudo.as_deref(), &container, &action).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docker_logs(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    container: String,
    tail: u32,
) -> Result<String, String> {
    let conn = sessions.get(&store, &server_id).await?;
    let sudo = secrets::get(&server_id, "sudo");
    let (access, _) = docker::access(&conn, sudo.as_deref()).await.map_err(|e| e.to_string())?;
    docker::logs(&conn, access, sudo.as_deref(), &container, tail).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn f2b_state(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<fail2ban::State, String> {
    let conn = sessions.get(&store, &server_id).await?;
    fail2ban::state(&conn, secrets::get(&server_id, "sudo").as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn f2b_unban(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    jail: String,
    ip: String,
) -> Result<(), String> {
    let conn = sessions.get(&store, &server_id).await?;
    fail2ban::unban(&conn, secrets::get(&server_id, "sudo").as_deref(), &jail, &ip).await.map_err(|e| e.to_string())
}

/// Redémarre le serveur tout de suite ; la connexion tombe ensuite, les écrans se reconnectent seuls.
#[tauri::command]
pub async fn server_reboot(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<(), String> {
    let conn = sessions.get(&store, &server_id).await?;
    system::power(&conn, system::PowerAction::Reboot, 0, secrets::get(&server_id, "sudo").as_deref()).await.map_err(|e| e.to_string())?;
    sessions.disconnect(&server_id).await;
    Ok(())
}

#[tauri::command]
pub async fn term_open(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    cols: u32,
    rows: u32,
    on_event: tauri::ipc::Channel<crate::sessions::TermEvent>,
) -> Result<u64, String> {
    let conn = sessions.get(&store, &server_id).await?;
    sessions.open_terminal(&conn, cols, rows, on_event).await
}

#[tauri::command]
pub async fn term_write(sessions: State<'_, Sessions>, id: u64, data: String) -> Result<(), String> {
    sessions.write_terminal(id, data.as_bytes()).await
}

#[tauri::command]
pub async fn term_resize(sessions: State<'_, Sessions>, id: u64, cols: u32, rows: u32) -> Result<(), String> {
    sessions.resize_terminal(id, cols, rows).await
}

#[tauri::command]
pub async fn term_close(sessions: State<'_, Sessions>, id: u64) -> Result<(), String> {
    sessions.close_terminal(id).await;
    Ok(())
}
