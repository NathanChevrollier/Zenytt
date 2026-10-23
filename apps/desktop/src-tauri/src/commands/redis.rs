//! Serveurs Redis / Valkey : découverte, exploration des clés et console.
//!
//! Comme pour les bases SQL, tout passe par le client en ligne de commande lancé sur le serveur
//! (`redis-cli`) : aucun port n'a besoin d'être ouvert. Les écritures (suppression, changement de
//! valeur ou de durée de vie) sont inscrites au journal d'actions.

use tauri::State;
use zenytt_core::docker::{self, Access};
use zenytt_core::redis::{self, KeyPage, KeyValue, Overview, Server};

use crate::commands::{admin, err, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

/// Serveurs trouvés : conteneurs Redis/Valkey/KeyDB en cours, puis le service installé.
#[tauri::command]
pub async fn redis_servers(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Server>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    let containers = async {
        let (access, _) = docker::access(&conn, pw.as_deref()).await?;
        if access == Access::Unavailable {
            return Ok(Vec::new());
        }
        docker::containers(&conn, access, pw.as_deref()).await
    };
    let (containers, local) = tokio::join!(containers, conn.exec(redis::LOCAL_PROBE, None));

    let mut out: Vec<Server> = containers
        .map_err(err)?
        .into_iter()
        .filter(|c| c.state == "running" && redis::is_redis_image(&c.image))
        .map(|c| Server {
            id: format!("container:{}", c.name),
            label: format!("{} ({})", c.name, c.image),
            container: Some(c.name),
            version: String::new(),
        })
        .collect();
    out.extend(redis::parse_local(&local.map_err(err)?.stdout));
    Ok(out)
}

/// Version, mémoire et nombre de clés par base. Demandé à part pour ne pas retarder la liste.
#[tauri::command]
pub async fn redis_overview(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    server: Server,
) -> Result<Overview, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    redis::overview(&conn, pw.as_deref(), &server).await.map_err(err)
}

/// Page de clés. `cursor` vaut « 0 » au premier appel, puis reprend celui de la page précédente.
#[tauri::command]
pub async fn redis_scan(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    server: Server,
    database: u8,
    cursor: String,
    pattern: String,
    count: Option<usize>,
) -> Result<KeyPage, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    redis::scan(&conn, pw.as_deref(), &server, database, &cursor, &pattern, count.unwrap_or(200)).await.map_err(err)
}

/// Contenu d'une clé : type, durée de vie et éléments (bornés).
#[tauri::command]
pub async fn redis_key(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    server: Server,
    database: u8,
    key: String,
) -> Result<KeyValue, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    redis::key_value(&conn, pw.as_deref(), &server, database, &key).await.map_err(err)
}

/// Supprime des clés. Renvoie le nombre réellement supprimé (une clé expirée entre-temps ne compte pas).
#[tauri::command]
pub async fn redis_delete(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    server: Server,
    database: u8,
    keys: Vec<String>,
) -> Result<i64, String> {
    let detail = format!(
        "{} · base {database} · {} clé(s) : {}",
        server.label,
        keys.len(),
        keys.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
    );
    let r: Result<i64, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        redis::delete(&conn, pw.as_deref(), &server, database, &keys).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "redis.delete", &detail, r)
}

/// Écrit une clé de type chaîne. Sans durée de vie précisée, celle de la clé est conservée.
#[tauri::command]
pub async fn redis_set(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    server: Server,
    database: u8,
    key: String,
    value: String,
    ttl: Option<i64>,
) -> Result<(), String> {
    let detail = format!("{} · base {database} · {key}", server.label);
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        redis::set_string(&conn, pw.as_deref(), &server, database, &key, &value, ttl).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "redis.set", &detail, r)
}

/// Change la durée de vie d'une clé ; `None` la rend éternelle.
#[tauri::command]
pub async fn redis_expire(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    server: Server,
    database: u8,
    key: String,
    ttl: Option<i64>,
) -> Result<(), String> {
    let detail = format!(
        "{} · base {database} · {key} → {}",
        server.label,
        ttl.map(|t| format!("{t} s")).unwrap_or_else(|| "sans expiration".into())
    );
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        redis::expire(&conn, pw.as_deref(), &server, database, &key, ttl).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "redis.expire", &detail, r)
}

/// Commande libre de la console. Les commandes qui bloquent le serveur ou effacent tout sont
/// refusées côté Rust (voir `zenytt_core::redis::BLOCKED`).
#[tauri::command]
pub async fn redis_command(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    server: Server,
    database: u8,
    command: String,
) -> Result<Vec<String>, String> {
    let read_only = matches!(
        command.split_whitespace().next().unwrap_or("").to_ascii_uppercase().as_str(),
        "GET"
            | "TYPE"
            | "TTL"
            | "EXISTS"
            | "SCAN"
            | "HGETALL"
            | "HGET"
            | "LRANGE"
            | "SMEMBERS"
            | "ZRANGE"
            | "INFO"
            | "DBSIZE"
            | "PING"
            | "STRLEN"
            | "LLEN"
            | "SCARD"
            | "ZCARD"
            | "HLEN"
    );
    let detail = format!("{} · base {database} : {}", server.label, command.chars().take(300).collect::<String>());
    let r: Result<Vec<String>, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        redis::command(&conn, pw.as_deref(), &server, database, &command).await.map_err(err)
    }
    .await;
    if read_only {
        return r;
    }
    track(&audit, &store, &server_id, "redis.command", &detail, r)
}

/// Commandes refusées, pour les afficher dans l'aide de la console.
#[tauri::command]
pub fn redis_blocked() -> Vec<String> {
    redis::BLOCKED
        .iter()
        .map(|s| s.to_string())
        .chain(redis::BLOCKED_SUBCOMMANDS.iter().flat_map(|(v, subs)| subs.iter().map(move |s| format!("{v} {s}"))))
        .collect()
}
