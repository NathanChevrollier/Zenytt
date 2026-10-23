//! Déploiement des projets compose : bouton « Déployer » et clés restreintes pour GitHub Actions.

use tauri::State;
use zenytt_core::deploy::{self, DeployKey};
use zenytt_core::docker::{self, Access, ComposeProject};
use zenytt_core::nginx;

use crate::commands::{admin, err, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

/// Domaine nginx qui sert ce projet (vhost dont le `proxy_pass` vise un port publié par ses conteneurs).
#[tauri::command]
pub async fn deploy_suggest_host(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    project: String,
) -> Result<Option<String>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let s = sudo.as_deref();
    let (access, _) = docker::access(&conn, s).await.map_err(err)?;
    if access == Access::Unavailable {
        return Ok(None);
    }
    let ports: Vec<u16> = docker::containers(&conn, access, s)
        .await
        .map_err(err)?
        .into_iter()
        .filter(|c| c.compose_project.as_deref() == Some(project.as_str()))
        .flat_map(|c| c.ports.into_iter().map(|p| p.host_port))
        .collect();
    let state = nginx::discover(&conn, s).await.map_err(err)?;
    Ok(state
        .files
        .iter()
        .flat_map(|f| f.servers.iter())
        .find(|b| b.upstream_ports.iter().any(|p| ports.contains(p)))
        .and_then(|b| b.server_names.iter().find(|n| nginx::valid_domain(n)).cloned()))
}

/// Installe/actualise le script et la configuration du projet, puis renvoie la commande à lancer
/// dans un terminal (sortie en direct, sudo demandé si nécessaire).
#[tauri::command]
pub async fn deploy_prepare(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    project: ComposeProject,
    check_host: Option<String>,
) -> Result<String, String> {
    let detail = project.name.clone();
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        deploy::configure(&conn, sudo.as_deref(), &project.name, &project.config_files, check_host.as_deref()).await.map_err(err)?;
        deploy::command(&conn, &project.name).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "deploy.run", &detail, r)
}

#[tauri::command]
pub async fn deploy_keys(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<String>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    deploy::keys(&conn).await.map_err(err)
}

/// Ce que la clé de déploiement changerait aux droits du compte SSH (voir [`deploy::SudoRisk`]).
#[tauri::command]
pub async fn deploy_sudo_risk(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    project: ComposeProject,
) -> Result<deploy::SudoRisk, String> {
    let conn = sessions.get(&store, &server_id).await?;
    deploy::sudo_risk(&conn, &project.config_files).await.map_err(err)
}

#[tauri::command]
pub async fn deploy_key_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    project: ComposeProject,
    check_host: Option<String>,
) -> Result<DeployKey, String> {
    let detail = project.name.clone();
    let r = async {
        let profile = store.server(&server_id)?;
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        deploy::configure(&conn, sudo.as_deref(), &project.name, &project.config_files, check_host.as_deref()).await.map_err(err)?;
        deploy::create_key(&conn, sudo.as_deref(), &project.name, &profile.host, profile.port).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "deploy.key_create", &detail, r)
}

#[tauri::command]
pub async fn deploy_key_revoke(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    project: String,
) -> Result<(), String> {
    let detail = project.clone();
    let r = async {
        let conn = sessions.get(&store, &server_id).await?;
        deploy::revoke_key(&conn, &project).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "deploy.key_revoke", &detail, r)
}
