//! Vue d'ensemble : un résumé léger par serveur (santé, alertes, conteneurs, certificats).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;
use zenytt_core::docker::{self, Access};
use zenytt_core::{agent, nginx};
use zenytt_protocol::proc::{parse_collect, COLLECT_SCRIPT};
use zenytt_protocol::{ActiveAlert, Metrics};

use crate::commands::monitoring::Monitor;
use crate::sessions::Sessions;
use crate::store::{secrets, Store};

/// Certificats mis en cache : leur lecture demande sudo et change rarement.
#[derive(Default)]
pub struct DashboardCache(Mutex<HashMap<String, (Instant, Vec<CertSummary>)>>);

const CERT_TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertSummary {
    domains: Vec<String>,
    not_after: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    connected: bool,
    /// Erreur de connexion ; `NEED_*` / `UNKNOWN_HOST_KEY` = une action de l'utilisateur est nécessaire.
    error: Option<String>,
    metrics: Option<Metrics>,
    agent: bool,
    alerts: Vec<ActiveAlert>,
    docker: bool,
    containers_running: usize,
    /// Arrêtés sans erreur (code 0, arrêt par signal, jamais démarrés), ni ponctuels ni arrêtés
    /// volontairement : à vérifier, sans urgence.
    containers_stopped: usize,
    stopped_names: Vec<String>,
    /// Clés stables (`projet/service` ou nom) de tous ces conteneurs arrêtés, pour les marquer
    /// « arrêtés volontairement » d'un clic.
    stopped_keys: Vec<String>,
    /// En panne : planté, tué faute de mémoire, redémarre en boucle, healthcheck en échec.
    failed: Vec<FailedContainer>,
    certificates: Vec<CertSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedContainer {
    name: String,
    condition: docker::Condition,
    status: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
pub async fn dashboard_summary(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    monitor: State<'_, Monitor>,
    cache: State<'_, DashboardCache>,
    server_id: String,
) -> Result<Summary, String> {
    let work = async {
        let conn = match sessions.get(&store, &server_id).await {
            Ok(c) => c,
            Err(e) => return Summary { error: Some(e), ..Default::default() },
        };
        let sudo = secrets::get(&server_id, "sudo");
        let sudo = sudo.as_deref();

        // Les trois relevés sont indépendants : ils partent en même temps sur la même connexion.
        let health = async {
            match agent::info(&conn).await {
                Ok(info) if info.running => {
                    let (latest, alerts) = info.status.map(|st| (st.latest, st.active_alerts)).unwrap_or_default();
                    (true, latest, alerts)
                }
                _ => {
                    // Sans agent : relevé direct (le CPU se calcule avec le relevé précédent).
                    let mut metrics = None;
                    if let Ok(text) = conn.run(COLLECT_SCRIPT).await {
                        let raw = parse_collect(&text, now_ms());
                        metrics = Some(monitor.prev.lock().await.entry(server_id.clone()).or_default().compute(raw));
                    }
                    (false, metrics, vec![])
                }
            }
        };
        let containers = async {
            match docker::access(&conn, sudo).await {
                Ok((access, _)) if access != Access::Unavailable => (true, docker::containers(&conn, access, sudo).await.ok()),
                _ => (false, None),
            }
        };
        let certificates = async {
            let cached = cache.0.lock().await.get(&server_id).filter(|(t, _)| t.elapsed() < CERT_TTL).map(|(_, c)| c.clone());
            match cached {
                Some(c) => c,
                None => {
                    let certs: Vec<CertSummary> = nginx::discover(&conn, sudo)
                        .await
                        .map(|st| st.certificates.into_iter().map(|c| CertSummary { domains: c.domains, not_after: c.not_after }).collect())
                        .unwrap_or_default();
                    cache.0.lock().await.insert(server_id.clone(), (Instant::now(), certs.clone()));
                    certs
                }
            }
        };
        let ((agent, metrics, alerts), (docker, list), certificates) = tokio::join!(health, containers, certificates);

        let mut metrics = metrics;
        if let Some(m) = metrics.as_mut() {
            crate::commands::monitoring::apply_disk_rules(&store, &server_id, m);
        }
        let mut out = Summary { connected: true, agent, metrics, alerts, docker, certificates, ..Default::default() };
        if let Some(list) = list {
            out.containers_running = list.iter().filter(|c| c.state == "running").count();
            let occasional = crate::commands::docker::occasional_keys(&store, &server_id);
            let on_purpose = crate::commands::docker::on_purpose_keys(&store, &server_id);
            // Une panne se signale toujours, même pour un conteneur ponctuel (une migration qui
            // échoue n'est pas « normale »), sauf s'il a été arrêté volontairement depuis Zenytt.
            out.failed = list
                .iter()
                .filter(|c| c.condition.is_failure() && !(c.state != "running" && on_purpose.contains(&c.key())))
                .map(|c| FailedContainer { name: c.name.clone(), condition: c.condition, status: c.status.clone() })
                .collect();
            let stopped: Vec<_> = list
                .iter()
                .filter(|c| c.state != "running" && !c.condition.is_failure())
                .filter(|c| !occasional.contains(&c.key()) && !on_purpose.contains(&c.key()))
                .collect();
            out.containers_stopped = stopped.len();
            out.stopped_names = stopped.iter().take(5).map(|c| c.name.clone()).collect();
            out.stopped_keys = stopped.iter().map(|c| c.key()).collect();
        }
        out
    };
    // Un serveur lent ou injoignable ne doit pas bloquer la vue d'ensemble.
    Ok(tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .unwrap_or_else(|_| Summary { error: Some("délai dépassé".into()), ..Default::default() }))
}
