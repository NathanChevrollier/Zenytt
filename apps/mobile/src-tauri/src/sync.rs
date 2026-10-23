//! Rejoindre la synchronisation chiffrée d'un PC (code d'appairage + phrase de passe) et la rejouer.

use tauri::{AppHandle, Manager, State};
use zenytt_profiles::sync::{self, HttpTransport, Outcome, SyncConfig, SyncMode, SyncTunnel, SECRET_OWNER};
use zenytt_profiles::{secrets, Store};

use crate::sessions::Sessions;

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
