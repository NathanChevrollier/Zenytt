//! Connexions SSH ouvertes et terminaux interactifs.

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
use zenytt_core::{ftp, Auth, Connection};
use zenytt_profiles::Protocol;

use crate::store::Store;

/// Événements envoyés à l'UI pour un terminal.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    /// Octets bruts encodés en base64 (xterm.js décode l'UTF-8 lui-même, même coupé entre deux paquets).
    Data {
        data: String,
    },
    Exit {
        code: Option<u32>,
    },
}

/// Accès aux fichiers d'un serveur : SFTP (sur une connexion SSH) ou client FTP, qui ne fait
/// qu'une chose à la fois (d'où le verrou).
pub enum Fs {
    Sftp(Arc<SftpSession>),
    Ftp(Arc<Mutex<ftp::Ftp>>),
}

pub struct Sessions {
    connections: Mutex<HashMap<String, Connection>>,
    sftp: Mutex<HashMap<String, (Connection, Arc<SftpSession>)>>,
    /// Un client FTP par serveur FTP/FTPS.
    ftp: Mutex<HashMap<String, Arc<Mutex<ftp::Ftp>>>>,
    terminals: Arc<Mutex<HashMap<u64, Arc<ChannelWriteHalf<Msg>>>>>,
    /// Copies de la sortie des terminaux partagés (`id du terminal` → destinataire).
    mirrors: Arc<Mutex<HashMap<u64, tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>>,
    /// Un verrou par serveur pendant l'établissement de la connexion : un serveur lent ou
    /// injoignable ne bloque pas les autres, et deux demandes simultanées partagent une tentative.
    connecting: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    next_term: AtomicU64,
    /// Noms d'utilisateurs et de groupes par serveur (uid/gid → nom), pour l'explorateur.
    id_names: Mutex<HashMap<String, Arc<IdNames>>>,
    /// Serveurs dont l'authentification a échoué : plus aucune tentative automatique tant que
    /// l'utilisateur n'a pas relancé la connexion lui-même (sinon fail2ban bannit son IP).
    auth_blocked: std::sync::Mutex<HashMap<String, String>>,
}

#[derive(Default)]
pub struct IdNames {
    pub users: HashMap<u32, String>,
    pub groups: HashMap<u32, String>,
}

impl Sessions {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            sftp: Mutex::new(HashMap::new()),
            ftp: Mutex::new(HashMap::new()),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            mirrors: Arc::new(Mutex::new(HashMap::new())),
            connecting: std::sync::Mutex::new(HashMap::new()),
            next_term: AtomicU64::new(1),
            id_names: Mutex::new(HashMap::new()),
            auth_blocked: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Table uid/gid → nom du serveur, lue une fois via `getent`.
    pub async fn id_names(&self, store: &Store, conn: &Connection, server_id: &str) -> Arc<IdNames> {
        if let Some(n) = self.id_names.lock().await.get(server_id) {
            return n.clone();
        }
        let mut names = IdNames::default();
        // Compte SFTP seul : aucune commande n'est permise, les identifiants restent numériques.
        let shell = store.server(server_id).is_ok_and(|s| s.protocol.has_shell());
        if let Some(out) = if shell { conn.exec("getent passwd; echo ---; getent group", None).await.ok() } else { None } {
            let mut in_groups = false;
            for line in out.stdout.lines() {
                if line == "---" {
                    in_groups = true;
                    continue;
                }
                let mut parts = line.split(':');
                let (Some(name), _, Some(id)) = (parts.next(), parts.next(), parts.next()) else { continue };
                let Ok(id) = id.parse() else { continue };
                let map = if in_groups { &mut names.groups } else { &mut names.users };
                map.insert(id, name.to_string());
            }
        }
        let names = Arc::new(names);
        self.id_names.lock().await.insert(server_id.to_string(), names.clone());
        names
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

    /// Accès aux fichiers du serveur, quel que soit son protocole.
    pub async fn fs(&self, store: &Store, server_id: &str) -> Result<Fs, String> {
        let protocol = store.server(server_id)?.protocol;
        if matches!(protocol, Protocol::Ssh | Protocol::Sftp) {
            return Ok(Fs::Sftp(self.sftp(store, server_id).await?));
        }
        let gate = self.connecting.lock().unwrap().entry(server_id.to_string()).or_default().clone();
        let _guard = gate.lock().await;
        let cached = self.ftp.lock().await.get(server_id).cloned();
        if let Some(c) = cached {
            // Le serveur coupe les connexions inactives : un `NOOP` dit si elle vit encore.
            if c.lock().await.noop().await.is_ok() {
                return Ok(Fs::Ftp(c));
            }
            self.ftp.lock().await.remove(server_id);
        }
        if let Some(reason) = self.auth_blocked.lock().unwrap().get(server_id) {
            return Err(format!("AUTH_BLOCKED: {reason} — reconnexion automatique suspendue, clique « Connecter » pour réessayer"));
        }
        let params = store.connect_params(server_id)?;
        let Auth::Password { password } = params.auth else { return Err("FTP : un mot de passe est requis".into()) };
        let target = format!("{}@{}:{}", params.username, params.host, params.port);
        let client = match ftp::connect(
            &params.host,
            params.port,
            &params.username,
            &password,
            protocol == Protocol::Ftps,
            params.known_fingerprint.as_deref(),
        )
        .await
        {
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
        let client = Arc::new(Mutex::new(client));
        self.ftp.lock().await.insert(server_id.to_string(), client.clone());
        Ok(Fs::Ftp(client))
    }

    /// Renvoie la connexion du serveur, en la (re)créant si elle n'existe pas ou a été coupée.
    pub async fn get(&self, store: &Store, server_id: &str) -> Result<Connection, String> {
        let protocol = store.server(server_id)?.protocol;
        if matches!(protocol, Protocol::Ftp | Protocol::Ftps) {
            return Err("Ce serveur est en FTP : pas de commandes".into());
        }
        if let Some(c) = self.live(server_id).await {
            return Ok(c);
        }
        let gate = self.connecting.lock().unwrap().entry(server_id.to_string()).or_default().clone();
        let _guard = gate.lock().await;
        // Une autre demande a peut-être connecté le serveur pendant l'attente.
        if let Some(c) = self.live(server_id).await {
            return Ok(c);
        }
        if let Some(reason) = self.auth_blocked.lock().unwrap().get(server_id) {
            return Err(format!("AUTH_BLOCKED: {reason} — reconnexion automatique suspendue, clique « Connecter » pour réessayer"));
        }
        let params = store.connect_params(server_id)?;
        let target = format!("{}@{}:{}", params.username, params.host, params.port);
        let result = match store.jump_chain(server_id)?.first() {
            None => Connection::connect(params).await,
            Some(jump) => {
                // Le bastion est connecté (ou réutilisé) d'abord ; la cible passe par un de ses canaux.
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
        // Nouvelle connexion : les noms d'utilisateurs ont pu changer depuis la précédente.
        self.id_names.lock().await.remove(server_id);
        self.connections.lock().await.insert(server_id.to_string(), conn.clone());
        if protocol.has_shell() {
            crate::legacy::on_connect(server_id, &conn);
        }
        Ok(conn)
    }

    async fn live(&self, server_id: &str) -> Option<Connection> {
        self.connections.lock().await.get(server_id).filter(|c| !c.is_closed()).cloned()
    }

    /// Autorise de nouveau les tentatives (action explicite de l'utilisateur, ou profil modifié).
    pub fn unblock(&self, server_id: &str) {
        self.auth_blocked.lock().unwrap().remove(server_id);
    }

    pub async fn is_connected(&self, server_id: &str) -> bool {
        self.connections.lock().await.get(server_id).is_some_and(|c| !c.is_closed()) || self.ftp.lock().await.contains_key(server_id)
    }

    pub async fn disconnect(&self, server_id: &str) {
        self.sftp.lock().await.remove(server_id);
        self.ftp.lock().await.remove(server_id);
        if let Some(c) = self.connections.lock().await.remove(server_id) {
            c.disconnect().await;
        }
    }

    /// Ouvre un terminal : un shell, ou une commande interactive (`docker exec -it …`) si fournie.
    pub async fn open_terminal(
        &self,
        conn: &Connection,
        cols: u32,
        rows: u32,
        command: Option<String>,
        events: Channel<TermEvent>,
    ) -> Result<u64, String> {
        let channel = match command {
            Some(cmd) => conn.open_exec(&cmd, Some((cols, rows))).await,
            None => conn.open_shell(cols, rows).await,
        }
        .map_err(|e| e.to_string())?;

        let id = self.next_term.fetch_add(1, Ordering::Relaxed);
        let (mut reader, writer) = channel.split();
        self.terminals.lock().await.insert(id, Arc::new(writer));

        let terminals = self.terminals.clone();
        let mirrors = self.mirrors.clone();
        tauri::async_runtime::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            let mut code = None;
            let mut next = None;
            loop {
                let msg = match next.take() {
                    Some(m) => m,
                    None => match reader.wait().await {
                        Some(m) => m,
                        None => break,
                    },
                };
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        // Sortie abondante (cat, logs) : les paquets déjà arrivés partent en un seul
                        // message vers l'interface au lieu d'un par paquet SSH. Rien n'est attendu :
                        // la frappe interactive garde la même latence.
                        let mut buf = data.to_vec();
                        while buf.len() < 512 * 1024 {
                            match tokio::time::timeout(std::time::Duration::ZERO, reader.wait()).await {
                                Ok(Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. })) => buf.extend_from_slice(&data),
                                Ok(Some(other)) => {
                                    next = Some(other);
                                    break;
                                }
                                Ok(None) | Err(_) => break,
                            }
                        }
                        // Terminal partagé : la même sortie part vers les invités.
                        if let Some(mirror) = mirrors.lock().await.get(&id) {
                            let _ = mirror.send(buf.clone());
                        }
                        if events.send(TermEvent::Data { data: b64.encode(&buf) }).is_err() {
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
            mirrors.lock().await.remove(&id);
        });
        Ok(id)
    }

    /// Le verrou n'est tenu que le temps de copier la référence : un terminal saturé
    /// (sortie énorme, réseau lent) ne bloque pas la saisie dans les autres.
    async fn writer(&self, id: u64) -> Result<Arc<ChannelWriteHalf<Msg>>, String> {
        self.terminals.lock().await.get(&id).cloned().ok_or_else(|| "terminal fermé".to_string())
    }

    /// Duplique la sortie d'un terminal vers un partage (un seul partage par terminal).
    pub async fn mirror(&self, id: u64) -> tokio::sync::mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.mirrors.lock().await.insert(id, tx);
        rx
    }

    pub async fn stop_mirror(&self, id: u64) {
        self.mirrors.lock().await.remove(&id);
    }

    pub async fn is_open(&self, id: u64) -> bool {
        self.terminals.lock().await.contains_key(&id)
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
