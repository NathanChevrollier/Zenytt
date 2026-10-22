//! Rejoindre la synchronisation chiffrée d'un PC (code d'appairage + phrase de passe) et la rejouer.

use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use zenytt_profiles::sync::{self, Outcome, PushResult, Remote, SyncConfig, SyncMode, SyncTunnel, Transport, SECRET_OWNER};
use zenytt_profiles::{secrets, Store};

use crate::sessions::Sessions;

/// Serveur `zenytt-sync` (HTTP), même protocole que sur le bureau.
struct HttpTransport {
    url: String,
    token: String,
    agent: ureq::Agent,
}

impl HttpTransport {
    fn new(url: String, token: String) -> Self {
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).http_status_as_error(false).build().into();
        Self { url, token, agent }
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

fn http_error(status: u16, body: &str) -> String {
    let detail =
        serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v["error"].as_str().map(str::to_string)).unwrap_or_default();
    match status {
        401 => "jeton de synchronisation refusé par le serveur".into(),
        413 => "réglages trop volumineux pour le serveur".into(),
        _ => format!("serveur de synchronisation : erreur {status} {detail}").trim().to_string(),
    }
}

impl Transport for HttpTransport {
    fn fetch(&self) -> Result<Option<Remote>, String> {
        let mut res = self
            .agent
            .get(format!("{}/v1/state", self.url))
            .header("Authorization", self.auth())
            .call()
            .map_err(|e| format!("serveur injoignable : {e}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
        match status {
            200 => {
                let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| "réponse du serveur illisible".to_string())?;
                let rev = v["rev"].as_u64().ok_or("réponse du serveur illisible")?;
                let data = v["data"].as_str().ok_or("réponse du serveur illisible")?.to_string();
                Ok(Some(Remote { rev, data }))
            }
            404 => Ok(None),
            s => Err(http_error(s, &body)),
        }
    }

    fn push(&self, base_rev: u64, data: &str) -> Result<PushResult, String> {
        let mut res = self
            .agent
            .put(format!("{}/v1/state", self.url))
            .header("Authorization", self.auth())
            .send_json(serde_json::json!({ "baseRev": base_rev, "data": data }))
            .map_err(|e| format!("serveur injoignable : {e}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
        match status {
            200 => serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["rev"].as_u64())
                .map(PushResult::Ok)
                .ok_or_else(|| "réponse du serveur illisible".to_string()),
            409 => Ok(PushResult::Conflict),
            s => Err(http_error(s, &body)),
        }
    }
}

/// Ouvre un port local (boucle locale, port libre) relayé vers `127.0.0.1:port` du serveur SSH :
/// le serveur de synchronisation privé n'écoute que là. Le relais s'arrête quand la tâche est abandonnée.
async fn open_tunnel(app: &AppHandle, t: &SyncTunnel) -> Result<(u16, tokio::task::JoinHandle<()>), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // La connexion SSH est établie ici (clé d'hôte inconnue : l'erreur remonte avant tout relais).
    app.state::<Sessions>().get(&app.state::<Store>(), &t.server_id).await?;
    let (app, t) = (app.clone(), t.clone());
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (app, t) = (app.clone(), t.clone());
            tokio::spawn(async move {
                let Ok(conn) = app.state::<Sessions>().get(&app.state::<Store>(), &t.server_id).await else { return };
                if let Ok(mut stream) = conn.open_direct_tcpip("127.0.0.1", t.port, local_port).await {
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                }
            });
        }
    });
    Ok((local_port, task))
}

/// Réglage de synchronisation de ce téléphone, s'il en a un.
#[tauri::command]
pub fn sync_get(store: State<'_, Store>) -> Option<SyncConfig> {
    store.read(|d| d.sync.clone())
}

/// Synchronise avec le serveur du réglage : récupère les serveurs du PC (et leurs secrets si le PC les partage).
#[tauri::command]
pub async fn sync_now(app: AppHandle, store: State<'_, Store>, sessions: State<'_, Sessions>) -> Result<Outcome, String> {
    let cfg = store
        .read(|d| d.sync.clone())
        .filter(|c| c.mode == SyncMode::Server)
        .ok_or("pas de synchronisation : rejoins-la avec le code du PC")?;
    let passphrase = secrets::get(SECRET_OWNER, "passphrase").ok_or("phrase de passe de synchronisation manquante")?;
    let token = secrets::get(SECRET_OWNER, "token").ok_or("jeton du serveur de synchronisation manquant")?;
    let tunnel = match &cfg.tunnel {
        Some(t) => Some(open_tunnel(&app, t).await?),
        None => None,
    };
    let url = match (&tunnel, &cfg.url) {
        (Some((port, _)), _) => format!("http://127.0.0.1:{port}"),
        (None, Some(url)) => url.clone(),
        (None, None) => return Err("adresse du serveur non définie".into()),
    };
    let transport = HttpTransport::new(url, token);
    // Le chiffrement (PBKDF2) et les entrées/sorties bloquent : hors du fil de l'interface.
    let store_ref: &Store = &store;
    let outcome = tokio::task::block_in_place(|| sync::run(store_ref, &transport, &passphrase));
    if let Some((_, task)) = tunnel {
        task.abort();
    }
    let outcome = outcome?;
    for id in &outcome.removed_servers {
        sessions.disconnect(id).await;
    }
    log::info!("synchronisation : {:?} (révision {})", outcome.action, outcome.rev);
    Ok(outcome)
}

/// Rejoint la synchronisation d'un PC avec son code d'appairage, puis lance la première synchronisation.
#[tauri::command]
pub async fn sync_join(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    code: String,
    passphrase: String,
) -> Result<Outcome, String> {
    let store_ref: &Store = &store;
    tokio::task::block_in_place(|| sync::join(store_ref, &code, &passphrase))?;
    sync_now(app.clone(), app.state::<Store>(), sessions).await
}
