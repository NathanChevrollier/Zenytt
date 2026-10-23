//! Monitoring : métriques en direct (sans agent), processus, services, et pilotage de l'agent zenyttd.

use std::collections::HashMap;

use tauri::State;
use tokio::sync::Mutex;
use zenytt_core::agent::{self, AgentInfo};
use zenytt_core::schedule;
use zenytt_core::system::{self, Process, Service};
use zenytt_core::Connection;
use zenytt_protocol::proc::{parse_collect, COLLECT_SCRIPT};
use zenytt_protocol::{AgentConfig, HistoryPoint, Metrics, RawSample};

use crate::commands::{admin, err, track};
use crate::sessions::Sessions;
use crate::store::AuditLog;
use crate::store::Store;
use zenytt_profiles::DiskRule;

/// Binaires de l'agent embarqués à la compilation (vides s'ils n'ont pas été construits).
const AGENT_X86_64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/zenyttd-x86_64"));
const AGENT_AARCH64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/zenyttd-aarch64"));

/// Dernier relevé brut par serveur, pour calculer CPU % et débits.
#[derive(Default)]
pub struct Monitor {
    pub prev: Mutex<HashMap<String, RawSample>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Réglages des points de montage d'un serveur : ignorés, ou taille réelle saisie à la main.
pub(crate) fn apply_disk_rules(store: &Store, server_id: &str, metrics: &mut Metrics) {
    let rules: Vec<DiskRule> = store.read(|d| d.disk_rules.iter().filter(|r| r.server_id == server_id).cloned().collect());
    for disk in metrics.disks.iter_mut() {
        let Some(rule) = rules.iter().find(|r| r.mount == disk.mount) else { continue };
        disk.ignored = rule.ignore;
        if let Some(total) = rule.total.filter(|t| *t > 0) {
            disk.total = total;
            // Taille saisie à la main : c'est le vrai espace de l'abonnement, il compte.
            disk.read_only = false;
        }
        if let Some(used) = rule.used {
            disk.used = used.min(disk.total);
        }
    }
}

#[tauri::command]
pub async fn mon_metrics(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    monitor: State<'_, Monitor>,
    server_id: String,
) -> Result<Metrics, String> {
    let conn = sessions.get(&store, &server_id).await?;
    let out = conn.run(COLLECT_SCRIPT).await.map_err(err)?;
    let raw = parse_collect(&out, now_ms());
    let mut prev = monitor.prev.lock().await;
    let mut metrics = zenytt_protocol::compute(prev.get(&server_id), &raw);
    prev.insert(server_id.clone(), raw);
    apply_disk_rules(&store, &server_id, &mut metrics);
    Ok(metrics)
}

#[tauri::command]
pub fn disk_rules_list(store: State<'_, Store>, server_id: String) -> Vec<DiskRule> {
    store.read(|d| d.disk_rules.iter().filter(|r| r.server_id == server_id).cloned().collect())
}

/// Enregistre le réglage d'un point de montage. Si l'agent tourne, sa liste de montages ignorés
/// suit : l'alerte « Disque » est levée sur le serveur même quand Zenytt est fermé.
/// Renvoie `true` si la configuration de l'agent a été mise à jour.
#[tauri::command]
pub async fn disk_rule_save(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    rule: DiskRule,
) -> Result<bool, String> {
    let server_id = rule.server_id.clone();
    let detail = format!("{}{}", rule.mount, if rule.ignore { " (ignoré)" } else { "" });
    let empty = !rule.ignore && rule.total.is_none() && rule.used.is_none();
    store.write(|d| {
        d.disk_rules.retain(|r| !(r.server_id == rule.server_id && r.mount == rule.mount));
        if !empty {
            d.disk_rules.push(rule);
        }
    })?;
    let ignored: Vec<String> =
        store.read(|d| d.disk_rules.iter().filter(|r| r.server_id == server_id && r.ignore).map(|r| r.mount.clone()).collect());
    let r: Result<bool, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        let info = agent::info_privileged(&conn, pw.as_deref()).await.map_err(err)?;
        let Some(mut config) = info.status.filter(|_| info.running).map(|s| s.config) else { return Ok(false) };
        if config.disk_ignore == ignored {
            return Ok(false);
        }
        config.disk_ignore = ignored;
        agent::save_config(&conn, &config, pw.as_deref()).await.map_err(err)?;
        Ok(true)
    }
    .await;
    track(&audit, &store, &server_id, "monitoring.disk_rule", &detail, r)
}

#[tauri::command]
pub async fn mon_processes(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Process>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    system::processes(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn mon_kill(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    pid: u32,
    force: bool,
) -> Result<(), String> {
    let detail = format!("pid {pid}{}", if force { " (KILL)" } else { "" });
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::kill(&conn, pid, force, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "process.kill", &detail, r)
}

#[tauri::command]
pub async fn mon_services(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<Option<Vec<Service>>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    system::services(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn mon_service_action(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    unit: String,
    action: String,
) -> Result<(), String> {
    let detail = format!("{action} {unit}");
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::service_action(&conn, &unit, &action, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "service.action", &detail, r)
}

#[tauri::command]
pub async fn mon_service_logs(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    unit: String,
    lines: u32,
) -> Result<String, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    system::service_logs(&conn, &unit, lines, pw.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn agent_info(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<AgentInfo, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let mut info = agent::info_privileged(&conn, sudo.as_deref()).await.map_err(err)?;
    if let Some(m) = info.status.as_mut().and_then(|s| s.latest.as_mut()) {
        apply_disk_rules(&store, &server_id, m);
    }
    Ok(info)
}

#[tauri::command]
pub async fn agent_history(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    range_secs: u64,
    points: usize,
) -> Result<Vec<HistoryPoint>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    agent::history(&conn, range_secs, points).await.map_err(err)
}

#[tauri::command]
pub async fn agent_install(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let detail = String::new();
    let r: Result<String, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        install_agent(&conn, pw.as_deref()).await
    }
    .await;
    track(&audit, &store, &server_id, "agent.install", &detail, r)
}

/// Installe (ou réinstalle) l'agent embarqué dans l'application, pour l'architecture du serveur.
pub(crate) async fn install_agent(conn: &Connection, sudo: Option<&str>) -> Result<String, String> {
    let binary_for = |arch: &str| -> Option<&'static [u8]> {
        match arch {
            "x86_64" => Some(AGENT_X86_64),
            "aarch64" => Some(AGENT_AARCH64),
            _ => None,
        }
    };
    agent::install(conn, sudo, binary_for).await.map_err(err)
}

#[tauri::command]
pub async fn agent_uninstall(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<(), String> {
    let detail = String::new();
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        agent::uninstall(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "agent.uninstall", &detail, r)
}

#[tauri::command]
pub async fn agent_save_config(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    config: AgentConfig,
) -> Result<(), String> {
    let detail = String::new();
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        agent::save_config(&conn, &config, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "agent.config", &detail, r)
}

#[tauri::command]
pub async fn agent_test_notify(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<String, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    agent::test_notify(&conn, sudo.as_deref()).await.map_err(err)
}

// ---------- Tâches planifiées ----------

#[tauri::command]
pub async fn schedule_list(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<schedule::Schedule, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    schedule::list(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn crontab_save(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    user: String,
    content: String,
) -> Result<(), String> {
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        schedule::save_crontab(&conn, sudo.as_deref(), &user, &content).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "crontab.save", &user, r)
}

#[tauri::command]
pub async fn timer_run(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    service: String,
) -> Result<(), String> {
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        schedule::run_timer_now(&conn, sudo.as_deref(), &service).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "timer.run", &service, r)
}
