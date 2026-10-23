//! Synchronisation des réglages avec les autres PC : fichier partagé ou serveur `zenytt-sync`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use zenytt_core::sync_server;
use zenytt_profiles::sync::{self, HttpTransport, Outcome, SyncConfig, SyncMode, SyncTunnel, Transport, SECRET_OWNER};

use crate::commands::tunnels::Tunnels;
use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{secrets, AuditLog, Store, TunnelDef};

/// Serveur de synchronisation embarqué, installé sur les serveurs par l'app (vide en développement
/// tant que `pnpm build:agent` n'a pas été lancé).
const SYNC_X86_64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/zenytt-sync-x86_64"));
const SYNC_AARCH64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/zenytt-sync-aarch64"));

/// Identifiant du tunnel de la synchronisation privée (hors de la liste des tunnels de l'utilisateur).
const SYNC_TUNNEL: &str = "zenytt-sync";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncView {
    #[serde(flatten)]
    config: SyncConfig,
    has_passphrase: bool,
    has_token: bool,
}

/// Réglage de synchronisation, avec la présence (jamais la valeur) des secrets associés.
#[tauri::command]
pub fn sync_get(store: State<'_, Store>) -> SyncView {
    SyncView {
        config: store.read(|d| d.sync.clone()).unwrap_or_default(),
        has_passphrase: secrets::get(SECRET_OWNER, "passphrase").is_some(),
        has_token: secrets::get(SECRET_OWNER, "token").is_some(),
    }
}

/// Réglage modifiable depuis l'interface (l'état de la dernière synchronisation n'en fait pas partie).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    mode: SyncMode,
    path: Option<String>,
    url: Option<String>,
    /// Mode privé : serveur SSH et port de `zenytt-sync` (remplace `url`).
    #[serde(default)]
    tunnel: Option<SyncTunnel>,
    include_secrets: bool,
    /// `None` : inchangé ; `Some("")` : supprimé.
    passphrase: Option<String>,
    token: Option<String>,
}

#[tauri::command]
pub fn sync_set(store: State<'_, Store>, settings: SyncSettings) -> Result<(), String> {
    let url = settings.url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty());
    if settings.mode == SyncMode::Server && settings.tunnel.is_none() {
        let u = url.as_deref().ok_or("indique l'adresse du serveur de synchronisation")?;
        // Le jeton circule dans chaque requête : HTTPS obligatoire, sauf sur la machine elle-même.
        let local = ["http://127.0.0.1", "http://localhost", "http://[::1]"].iter().any(|p| u.starts_with(p));
        if !u.starts_with("https://") && !local {
            return Err("l'adresse doit commencer par https:// (le jeton ne doit pas circuler en clair)".into());
        }
    }
    let path = settings.path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if settings.mode == SyncMode::File && path.is_none() {
        return Err("choisis le fichier de synchronisation".into());
    }
    if let Some(p) = &settings.passphrase {
        if !p.is_empty() && p.chars().count() < 10 {
            return Err("phrase de passe trop courte (10 caractères minimum) : elle protège tous tes réglages".into());
        }
        secrets::set(SECRET_OWNER, "passphrase", p)?;
    }
    if let Some(t) = &settings.token {
        secrets::set(SECRET_OWNER, "token", t.trim())?;
    }
    store.write(|d| {
        let previous = d.sync.take().unwrap_or_default();
        // Autre destination : on repart de zéro (première synchronisation = fusion).
        let tunnel = settings.tunnel.filter(|_| settings.mode == SyncMode::Server);
        let url = if tunnel.is_some() { None } else { url };
        let same_target = previous.mode == settings.mode && previous.path == path && previous.url == url && previous.tunnel == tunnel;
        d.sync = Some(SyncConfig {
            mode: settings.mode,
            path,
            url,
            tunnel,
            include_secrets: settings.include_secrets,
            last_rev: if same_target { previous.last_rev } else { 0 },
            last_hash: if same_target && previous.include_secrets == settings.include_secrets { previous.last_hash } else { None },
            last_sync: if same_target { previous.last_sync } else { None },
            last_remote: if same_target { previous.last_remote } else { None },
        });
    })
}

/// Lance une synchronisation. Les serveurs et tunnels supprimés sur un autre PC sont fermés ici.
#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    tunnels: State<'_, Tunnels>,
) -> Result<Outcome, String> {
    let cfg = store.read(|d| d.sync.clone()).filter(|c| c.mode != SyncMode::Off).ok_or("synchronisation désactivée")?;
    let passphrase = secrets::get(SECRET_OWNER, "passphrase").ok_or("phrase de passe de synchronisation manquante")?;
    let transport: Box<dyn Transport + Send> = match cfg.mode {
        SyncMode::File => Box::new(sync::FileTransport { path: cfg.path.clone().ok_or("fichier de synchronisation non défini")?.into() }),
        SyncMode::Server => {
            let url = match &cfg.tunnel {
                Some(t) => format!("http://127.0.0.1:{}", private_tunnel(&app, &tunnels, t).await?),
                None => cfg.url.clone().ok_or("adresse du serveur non définie")?,
            };
            Box::new(HttpTransport::new(url, secrets::get(SECRET_OWNER, "token").ok_or("jeton du serveur de synchronisation manquant")?))
        }
        SyncMode::Off => unreachable!(),
    };
    // Le chiffrement (PBKDF2) et les entrées/sorties bloquent : hors du fil de l'interface.
    let store_ref: &Store = &store;
    let outcome = tokio::task::block_in_place(|| sync::run(store_ref, transport.as_ref(), &passphrase))?;
    for id in &outcome.removed_servers {
        sessions.disconnect(id).await;
    }
    for id in &outcome.removed_tunnels {
        tunnels.stop(id);
    }
    log::info!("synchronisation : {:?} (révision {})", outcome.action, outcome.rev);
    Ok(outcome)
}

/// Port local du tunnel de la synchronisation privée, ouvert à la première synchronisation puis
/// gardé (la connexion SSH sous-jacente se rouvre d'elle-même à la demande).
async fn private_tunnel(app: &AppHandle, tunnels: &Tunnels, t: &SyncTunnel) -> Result<u16, String> {
    static OPEN: std::sync::Mutex<Option<(SyncTunnel, u16)>> = std::sync::Mutex::new(None);
    if let Some((open, port)) = OPEN.lock().unwrap().clone() {
        if &open == t && tunnels.is_running(SYNC_TUNNEL) {
            return Ok(port);
        }
    }
    tunnels.stop(SYNC_TUNNEL);
    let local_port = std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let def = TunnelDef {
        id: SYNC_TUNNEL.into(),
        server_id: t.server_id.clone(),
        name: "Synchronisation".into(),
        local_port,
        remote_host: "127.0.0.1".into(),
        remote_port: t.port,
        auto_start: false,
    };
    tunnels.start(app, def).await?;
    *OPEN.lock().unwrap() = Some((t.clone(), local_port));
    Ok(local_port)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncServerStatus {
    /// Déjà installé sur ce serveur (mise à jour possible sans changer de jeton).
    installed: bool,
    /// Port sur la boucle locale du serveur (celui de l'installation existante, sinon le premier libre).
    port: u16,
    healthy: bool,
    docker: bool,
}

/// État du serveur de synchronisation sur un serveur, avant installation.
#[tauri::command]
pub async fn sync_server_status(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<SyncServerStatus, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let docker = conn.exec("command -v docker", None).await.map_err(|e| e.to_string())?.success();
    let existing = sync_server::existing(&conn, sudo.as_deref()).await.map_err(|e| e.to_string())?;
    let port = match &existing {
        Some((port, _)) => *port,
        None => sync_server::free_port(&conn, sync_server::DEFAULT_PORT).await.map_err(|e| e.to_string())?,
    };
    let healthy = existing.is_some() && sync_server::healthy(&conn, port).await;
    Ok(SyncServerStatus { installed: existing.is_some(), port, healthy, docker })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncServerInstalled {
    port: u16,
    log: String,
}

/// Installe (ou met à jour) `zenytt-sync` sur le serveur, vérifie qu'il répond, puis règle ce PC
/// en mode privé (tunnel SSH). Une installation existante garde son jeton et son port : les autres
/// PC n'ont rien à refaire. La phrase de passe reste à choisir dans l'interface.
#[tauri::command]
pub async fn sync_server_install(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<SyncServerInstalled, String> {
    let r: Result<SyncServerInstalled, String> = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        let s = sudo.as_deref();
        let (port, token) = match sync_server::existing(&conn, s).await.map_err(|e| e.to_string())? {
            Some(found) => found,
            None => (
                sync_server::free_port(&conn, sync_server::DEFAULT_PORT).await.map_err(|e| e.to_string())?,
                sync_server::new_token().map_err(|e| e.to_string())?,
            ),
        };
        let binary_for = |arch: &str| -> Option<&'static [u8]> {
            match arch {
                "x86_64" => Some(SYNC_X86_64),
                "aarch64" => Some(SYNC_AARCH64),
                _ => None,
            }
        };
        let log = sync_server::install(&conn, s, binary_for, port, &token).await.map_err(|e| e.to_string())?;
        if !sync_server::wait_healthy(&conn, port).await {
            return Err(format!("le serveur de synchronisation est installé mais ne répond pas sur le port {port}. Journal :\n{log}"));
        }
        secrets::set(SECRET_OWNER, "token", &token)?;
        store.write(|d| {
            let previous = d.sync.take().unwrap_or_default();
            let tunnel = Some(SyncTunnel { server_id: server_id.clone(), port });
            let same = previous.mode == SyncMode::Server && previous.tunnel == tunnel;
            d.sync = Some(SyncConfig {
                mode: SyncMode::Server,
                url: None,
                tunnel,
                include_secrets: previous.include_secrets,
                path: previous.path,
                last_rev: if same { previous.last_rev } else { 0 },
                last_hash: if same { previous.last_hash } else { None },
                last_sync: if same { previous.last_sync } else { None },
                last_remote: if same { previous.last_remote } else { None },
            });
        })?;
        Ok(SyncServerInstalled { port, log })
    }
    .await;
    track(&audit, &store, &server_id, "sync.server_install", "zenytt-sync", r)
}

/// Code d'appairage à coller sur un autre PC (chiffré avec la phrase de passe).
#[tauri::command]
pub fn sync_pairing_code(store: State<'_, Store>) -> Result<String, String> {
    sync::pairing_code(&store)
}

/// Rejoint la synchronisation avec le code d'un autre PC. La première synchronisation est lancée
/// ensuite par l'interface.
#[tauri::command]
pub fn sync_join(store: State<'_, Store>, code: String, passphrase: String) -> Result<(), String> {
    sync::join(&store, &code, &passphrase)
}
