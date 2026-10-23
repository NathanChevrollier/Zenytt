//! Connexions SSH ouvertes et terminaux interactifs (version réduite de celle du bureau).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use zenytt_core::russh::client::Msg;
use zenytt_core::russh::{ChannelMsg, ChannelWriteHalf};
use zenytt_core::russh_sftp::client::SftpSession;
use zenytt_core::Connection;
use zenytt_profiles::Store;

/// Événements envoyés à l'UI pour un terminal.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    /// Octets bruts en base64 (xterm.js décode l'UTF-8 lui-même, même coupé entre deux paquets).
    Data {
        data: String,
    },
    Exit {
        code: Option<u32>,
    },
}

#[derive(Default)]
pub struct Sessions {
    connections: Mutex<HashMap<String, Connection>>,
    sftp: Mutex<HashMap<String, (Connection, Arc<SftpSession>)>>,
    terminals: Arc<Mutex<HashMap<u64, Arc<ChannelWriteHalf<Msg>>>>>,
    /// Un verrou par serveur pendant la connexion : deux demandes simultanées partagent une tentative.
    connecting: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    next_term: AtomicU64,
    /// Serveurs dont l'authentification a échoué : plus aucune tentative automatique tant que
    /// l'utilisateur n'a pas relancé la connexion lui-même (sinon fail2ban bannit son IP).
    auth_blocked: std::sync::Mutex<HashMap<String, String>>,
}

impl Sessions {
    /// Renvoie la connexion du serveur, en la (re)créant si elle n'existe pas ou a été coupée
    /// (iOS coupe les sockets de l'app en arrière-plan : on se reconnecte au retour).
    pub async fn get(&self, store: &Store, server_id: &str) -> Result<Connection, String> {
        if let Some(c) = self.live(server_id).await {
            return Ok(c);
        }
        let gate = self.connecting.lock().unwrap().entry(server_id.to_string()).or_default().clone();
        let _guard = gate.lock().await;
        if let Some(c) = self.live(server_id).await {
            return Ok(c);
        }
        if let Some(reason) = self.auth_blocked.lock().unwrap().get(server_id) {
            return Err(format!("AUTH_BLOCKED: {reason} — reconnexion automatique suspendue, touche « Réessayer »"));
        }
        let params = store.connect_params(server_id)?;
        let target = format!("{}:{}", params.host, params.port);
        let result = match store.jump_chain(server_id)?.first() {
            None => Connection::connect(params).await,
            Some(jump) => {
                let name = store.server(jump).map(|s| s.name).unwrap_or_default();
                let bastion = Box::pin(self.get(store, jump)).await.map_err(|e| format!("JUMP: serveur de rebond « {name} » : {e}"))?;
                Connection::connect_via(&bastion, params).await
            }
        };
        let conn = match result {
            Ok(c) => c,
            Err(zenytt_core::Error::Auth(reason)) => {
                log::warn!("{target} : authentification refusée ({reason}), reconnexions automatiques suspendues");
                self.auth_blocked.lock().unwrap().insert(server_id.to_string(), reason.clone());
                return Err(format!("Authentification échouée : {reason}"));
            }
            Err(e) => {
                log::warn!("{target} : connexion impossible ({e})");
                return Err(e.to_string());
            }
        };
        log::info!("{target} : connecté");
        self.connections.lock().await.insert(server_id.to_string(), conn.clone());
        Ok(conn)
    }

    async fn live(&self, server_id: &str) -> Option<Connection> {
        self.connections.lock().await.get(server_id).filter(|c| !c.is_closed()).cloned()
    }

    /// Autorise de nouveau les tentatives (action explicite de l'utilisateur, ou profil modifié).
    pub fn unblock(&self, server_id: &str) {
        self.auth_blocked.lock().unwrap().remove(server_id);
    }

    pub async fn disconnect(&self, server_id: &str) {
        self.sftp.lock().await.remove(server_id);
        if let Some(c) = self.connections.lock().await.remove(server_id) {
            c.disconnect().await;
        }
    }

    /// Session SFTP du serveur, réutilisée tant que la connexion SSH sous-jacente est vivante.
    pub async fn sftp(&self, store: &Store, server_id: &str) -> Result<Arc<SftpSession>, String> {
        let conn = self.get(store, server_id).await?;
        let mut cache = self.sftp.lock().await;
        if let Some((owner, s)) = cache.get(server_id) {
            if owner.same_as(&conn) {
                return Ok(s.clone());
            }
        }
        let session = Arc::new(conn.sftp().await.map_err(|e| e.to_string())?);
        cache.insert(server_id.to_string(), (conn, session.clone()));
        Ok(session)
    }

    /// Ouvre un shell interactif et relaie sa sortie vers `events`.
    pub async fn open_terminal(&self, conn: &Connection, cols: u32, rows: u32, events: Channel<TermEvent>) -> Result<u64, String> {
        let channel = conn.open_shell(cols, rows).await.map_err(|e| e.to_string())?;
        let id = self.next_term.fetch_add(1, Ordering::Relaxed);
        let (mut reader, writer) = channel.split();
        self.terminals.lock().await.insert(id, Arc::new(writer));

        let terminals = self.terminals.clone();
        tauri::async_runtime::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            let mut code = None;
            while let Some(msg) = reader.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        if events.send(TermEvent::Data { data: b64.encode(&data) }).is_err() {
                            break;
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = events.send(TermEvent::Exit { code });
            terminals.lock().await.remove(&id);
        });
        Ok(id)
    }

    async fn writer(&self, id: u64) -> Result<Arc<ChannelWriteHalf<Msg>>, String> {
        self.terminals.lock().await.get(&id).cloned().ok_or_else(|| "terminal fermé".to_string())
    }

    pub async fn write_terminal(&self, id: u64, data: &[u8]) -> Result<(), String> {
        self.writer(id).await?.data(data).await.map_err(|e| e.to_string())
    }

    pub async fn resize_terminal(&self, id: u64, cols: u32, rows: u32) -> Result<(), String> {
        self.writer(id).await?.window_change(cols, rows, 0, 0).await.map_err(|e| e.to_string())
    }

    pub async fn close_terminal(&self, id: u64) {
        if let Some(writer) = self.terminals.lock().await.remove(&id) {
            let _ = writer.eof().await;
            let _ = writer.close().await;
        }
    }
}
