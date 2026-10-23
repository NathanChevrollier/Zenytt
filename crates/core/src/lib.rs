//! Logique métier de Zenytt, indépendante de l'interface.

pub mod access;
pub mod agent;
pub mod apache;
pub mod archive;
pub mod backup;
pub mod catalog;
pub mod db;
pub mod db_admin;
pub mod db_schema;
pub mod deploy;
pub mod diagnose;
pub mod docker;
pub mod domains;
pub mod fail2ban;
pub mod firewall;
pub mod ftp;
pub mod github;
pub mod inventory;
pub mod legacy;
pub mod mesh;
pub mod nginx;
pub mod provider;
pub mod redis;
pub mod registry;
pub mod schedule;
pub mod search;
pub mod security;
pub mod sftp;
pub mod shell_history;
pub mod ssh;
pub mod sync_server;
pub mod system;
pub mod tmux;
pub mod vm;

pub use russh;
pub use russh_sftp;

pub use ssh::{Auth, ConnectParams, Connection, ExecOutput};

/// Erreurs remontées à l'interface. Le préfixe de certains messages sert de code côté UI.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("UNKNOWN_HOST_KEY:{0}")]
    UnknownHostKey(String),
    #[error("HOST_KEY_MISMATCH:{expected}|{got}")]
    HostKeyMismatch { expected: String, got: String },
    #[error("Connexion impossible : {0}")]
    Connection(String),
    #[error("Authentification échouée : {0}")]
    Auth(String),
    #[error("Erreur SSH : {0}")]
    Ssh(#[from] russh::Error),
    #[error("Erreur SFTP : {0}")]
    Sftp(String),
    #[error("Erreur FTP : {0}")]
    Ftp(String),
    #[error("Commande distante en échec : {0}")]
    Remote(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
