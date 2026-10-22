pub mod assistant;
pub mod backups;
pub mod dashboard;
pub mod databases;
pub mod deploy;
pub mod docker;
pub mod files;
pub mod geo;
pub mod identities;
pub mod logs;
pub mod mesh;
pub mod monitoring;
pub mod rdp;
pub mod redis;
pub mod security;
pub mod servers;
pub mod share;
pub mod sites;
pub mod system;
pub mod sync;
pub mod terminal;
pub mod tunnels;
pub mod vms;
pub mod workspace;

use zenytt_core::Connection;

use crate::sessions::Sessions;
use crate::store::{secrets, Store};

/// Connexion + mot de passe sudo éventuel, pour les actions d'administration.
pub async fn admin(store: &Store, sessions: &Sessions, server_id: &str) -> Result<(Connection, Option<String>), String> {
    let conn = sessions.get(store, server_id).await?;
    Ok((conn, secrets::get(server_id, "sudo")))
}

use crate::store::AuditLog;

/// Inscrit le résultat d'une action dans le journal puis le renvoie tel quel.
pub fn track<T>(audit: &AuditLog, store: &Store, server_id: &str, action: &str, detail: &str, r: Result<T, String>) -> Result<T, String> {
    let name = store.server(server_id).map(|s| s.name).unwrap_or_default();
    match &r {
        Ok(_) => log::info!("[{name}] {action} {detail}"),
        Err(e) => log::warn!("[{name}] {action} {detail} : échec ({e})"),
    }
    audit.record(server_id, &name, action, detail, r.as_ref().map(|_| ()).map_err(|e| e.as_str()));
    r
}
