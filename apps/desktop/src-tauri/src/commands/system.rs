//! Page Système : alimentation, nom d'hôte, fuseau, mises à jour, et pilotage par l'API de l'hébergeur.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use zenytt_core::provider::{self, Credentials, ProviderAction, ProviderKind, ProviderLink, Status};
use zenytt_core::system::{self, PowerAction, SystemInfo, Update};
use zenytt_profiles::ServerProfile;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{secrets, AuditLog, Store};

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn system_info(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<SystemInfo, String> {
    let conn = sessions.get(&store, &server_id).await?;
    system::info(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn system_power(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    action: String,
    delay_minutes: u32,
) -> Result<(), String> {
    let (power, label) = match action.as_str() {
        "reboot" => (PowerAction::Reboot, "system.reboot"),
        "poweroff" => (PowerAction::Poweroff, "system.poweroff"),
        other => return Err(format!("action inconnue : {other}")),
    };
    let detail = if delay_minutes > 0 { format!("dans {delay_minutes} min") } else { "immédiat".into() };
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::power(&conn, power, delay_minutes, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, label, &detail, r)
}

#[tauri::command]
pub async fn system_cancel_power(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<(), String> {
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::cancel_scheduled(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "system.cancel_power", "", r)
}

/// Après un redémarrage : coupe la session en cache puis tente de se reconnecter toutes les 5 s.
/// Renvoie le temps écoulé en secondes. Une authentification refusée arrête l'attente.
#[tauri::command]
pub async fn system_wait_online(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    timeout_secs: u64,
) -> Result<u64, String> {
    let start = Instant::now();
    sessions.disconnect(&server_id).await;
    // Laisse au serveur le temps de s'arrêter vraiment (l'ordre est différé de 2 s).
    tokio::time::sleep(Duration::from_secs(8)).await;
    loop {
        match sessions.get(&store, &server_id).await {
            Ok(_) => return Ok(start.elapsed().as_secs()),
            Err(e) if e.starts_with("AUTH_BLOCKED") || e.starts_with("Authentification échouée") => return Err(e),
            Err(_) if start.elapsed() < Duration::from_secs(timeout_secs) => tokio::time::sleep(Duration::from_secs(5)).await,
            Err(e) => return Err(format!("le serveur n'est pas revenu après {timeout_secs} s ({e})")),
        }
    }
}

#[tauri::command]
pub async fn system_set_hostname(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    name: String,
) -> Result<(), String> {
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::set_hostname(&conn, &name, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "system.hostname", &name, r)
}

#[tauri::command]
pub async fn system_timezones(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<String>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    system::timezones(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn system_set_timezone(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    timezone: String,
) -> Result<(), String> {
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::set_timezone(&conn, &timezone, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "system.timezone", &timezone, r)
}

#[tauri::command]
pub async fn system_updates(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    refresh: bool,
) -> Result<Vec<Update>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    system::updates(&conn, refresh, pw.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn system_apply_updates(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let r: Result<String, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::apply_updates(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "system.updates", "", r)
}

// ---- Hébergeur ----

/// Secrets de l'hébergeur par type : OVH en réclame trois, les autres un jeton.
fn kinds(kind: ProviderKind) -> [&'static str; 3] {
    match kind {
        ProviderKind::Ovh => ["ovh-app-key", "ovh-app-secret", "ovh-consumer-key"],
        _ => ["token", "", ""],
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    link: Option<ProviderLink>,
    has_token: bool,
    has_secret: bool,
    has_consumer: bool,
}

#[tauri::command]
pub fn provider_get(store: State<'_, Store>, server_id: String) -> Result<ProviderView, String> {
    let link = store.server(&server_id)?.provider;
    let owner = ServerProfile::provider_owner(&server_id);
    let has = |k: &str| !k.is_empty() && secrets::has(&owner, k);
    let [a, b, c] = link.as_ref().map(|l| kinds(l.kind)).unwrap_or_default();
    Ok(ProviderView { has_token: has(a), has_secret: has(b), has_consumer: has(c), link })
}

/// `None` laisse un secret inchangé, `Some("")` le supprime. Sans `link`, le compte est délié.
#[tauri::command]
pub fn provider_set(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    server_id: String,
    link: Option<ProviderLink>,
    token: Option<String>,
    secret: Option<String>,
    consumer: Option<String>,
) -> Result<(), String> {
    let owner = ServerProfile::provider_owner(&server_id);
    let r: Result<(), String> = (|| {
        store.server(&server_id)?;
        match &link {
            Some(l) => {
                // Changer d'hébergeur ne doit pas laisser les identifiants du précédent.
                if store.server(&server_id)?.provider.is_some_and(|old| old.kind != l.kind) {
                    secrets::delete_all(&owner);
                }
                for (k, v) in kinds(l.kind).into_iter().zip([&token, &secret, &consumer]) {
                    if let (false, Some(v)) = (k.is_empty(), v) {
                        secrets::set(&owner, k, v.trim())?;
                    }
                }
            }
            None => secrets::delete_all(&owner),
        }
        store.write(|d| {
            if let Some(s) = d.servers.iter_mut().find(|s| s.id == server_id) {
                s.provider = link.clone();
            }
        })
    })();
    track(&audit, &store, &server_id, "provider.set", link.as_ref().map(|l| format!("{:?}", l.kind)).as_deref().unwrap_or("délié"), r)
}

fn credentials(store: &Store, server_id: &str) -> Result<(ProviderLink, Credentials), String> {
    let link = store.server(server_id)?.provider.ok_or("aucun hébergeur configuré pour ce serveur")?;
    let owner = ServerProfile::provider_owner(server_id);
    let [a, b, c] = kinds(link.kind);
    let get = |k: &str| if k.is_empty() { String::new() } else { secrets::get(&owner, k).unwrap_or_default() };
    let cred = Credentials { token: get(a), secret: get(b), consumer: get(c) };
    Ok((link, cred))
}

#[tauri::command]
pub async fn provider_test(store: State<'_, Store>, server_id: String) -> Result<Status, String> {
    let (link, cred) = credentials(&store, &server_id)?;
    provider::run(&link, &cred, ProviderAction::Status).await.map_err(err)
}

#[tauri::command]
pub async fn provider_action(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    server_id: String,
    action: ProviderAction,
) -> Result<Status, String> {
    let r = async {
        let (link, cred) = credentials(&store, &server_id)?;
        provider::run(&link, &cred, action).await.map_err(err)
    }
    .await;
    if action == ProviderAction::Status {
        return r;
    }
    track(&audit, &store, &server_id, "provider.power", &format!("{action:?}"), r)
}
