//! Connexion SSH : authentification, vérification de la clé d'hôte, exécution et shell.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle, Msg};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Méthode d'authentification choisie pour un serveur.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    Password {
        password: String,
    },
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
    /// Agent SSH du système : Pageant ou OpenSSH sous Windows, `SSH_AUTH_SOCK` ailleurs.
    /// Si `key_path` est indiqué, seule cette clé est présentée au serveur.
    Agent {
        #[serde(default)]
        key_path: Option<String>,
    },
}

/// Délai maximal par défaut d'une commande distante.
pub const DEFAULT_EXEC_LIMIT: Duration = Duration::from_secs(120);
/// Commandes ponctuelles simultanées par connexion : laisse de la place aux terminaux et à SFTP sous la limite `MaxSessions` (10 par défaut).
const MAX_PARALLEL_EXECS: usize = 4;
/// Nouvelles tentatives quand le serveur refuse un canal (200 ms, puis 400, 800, 1 600).
const OPEN_RETRIES: usize = 4;
/// Délai des opérations longues : installations, mises à jour, sauvegardes, pull d'images, certbot.
pub const LONG_EXEC_LIMIT: Duration = Duration::from_secs(30 * 60);
const AUTH_LIMIT: Duration = Duration::from_secs(60);

tokio::task_local! {
    static EXEC_LIMIT: Duration;
}

/// Exécute `f` en autorisant ses commandes distantes à durer jusqu'à [`LONG_EXEC_LIMIT`].
pub async fn long<F: std::future::Future>(f: F) -> F::Output {
    with_limit(LONG_EXEC_LIMIT, f).await
}

/// Exécute `f` avec un délai maximal choisi pour chacune de ses commandes distantes.
pub async fn with_limit<F: std::future::Future>(limit: Duration, f: F) -> F::Output {
    EXEC_LIMIT.scope(limit, f).await
}

/// Paramètres d'une connexion.
#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
    /// Empreinte SHA256 connue de la clé d'hôte ; `None` si le serveur n'a jamais été approuvé.
    pub known_fingerprint: Option<String>,
}

/// Résultat d'une commande exécutée à distance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u32,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.exit_code == 0
    }

    /// Convertit un code de sortie non nul en erreur, avec le stderr comme message.
    pub fn into_result(self) -> Result<Self> {
        if self.success() {
            Ok(self)
        } else {
            let msg = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
            Err(Error::Remote(format!("code {} : {}", self.exit_code, msg.trim())))
        }
    }
}

struct HostKeyCheck {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> std::result::Result<bool, Self::Error> {
        let fingerprint = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(cert) => keys::PublicKey::from(cert.public_key().clone()).fingerprint(HashAlg::Sha256),
        }
        .to_string();
        let trusted = self.expected.as_deref() == Some(fingerprint.as_str());
        *self.seen.lock().unwrap() = Some(fingerprint);
        Ok(trusted)
    }
}

/// Session SSH authentifiée. Clonable à moindre coût : les clones partagent la même connexion.
#[derive(Clone)]
pub struct Connection {
    handle: Arc<Handle<HostKeyCheck>>,
    /// Commandes ponctuelles simultanées : sshd n'accepte que `MaxSessions` canaux par connexion
    /// (10 par défaut), partagés avec les terminaux, SFTP et les flux de journaux.
    execs: Arc<tokio::sync::Semaphore>,
    pub fingerprint: String,
}

impl Connection {
    pub async fn connect(params: ConnectParams) -> Result<Self> {
        Self::connect_inner(params, None).await
    }

    /// Connexion à travers un serveur de rebond déjà connecté (équivalent de `ssh -J`) : le flux
    /// SSH passe dans un canal `direct-tcpip` du bastion. La clé d'hôte de la cible est vérifiée
    /// comme pour une connexion directe.
    pub async fn connect_via(jump: &Connection, params: ConnectParams) -> Result<Self> {
        Self::connect_inner(params, Some(jump)).await
    }

    async fn connect_inner(params: ConnectParams, jump: Option<&Connection>) -> Result<Self> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 4,
            // Sans Nagle : chaque petite commande part tout de suite au lieu d'attendre un accusé de
            // réception (jusqu'à ~60 ms gagnées par commande sur une connexion à distance).
            nodelay: true,
            ..Default::default()
        });
        let seen = Arc::new(Mutex::new(None));
        let handler = HostKeyCheck { expected: params.known_fingerprint.clone(), seen: seen.clone() };

        let timeout = || Error::Connection(format!("délai dépassé en se connectant à {}:{}", params.host, params.port));
        let result = match jump {
            None => {
                let addr = (params.host.as_str(), params.port);
                tokio::time::timeout(Duration::from_secs(15), client::connect(config, addr, handler)).await.map_err(|_| timeout())?
            }
            Some(j) => {
                let channel =
                    j.handle.channel_open_direct_tcpip(params.host.as_str(), params.port as u32, "127.0.0.1", 0).await.map_err(|e| {
                        Error::Connection(format!("le serveur de rebond ne joint pas {}:{} ({e})", params.host, params.port))
                    })?;
                tokio::time::timeout(Duration::from_secs(15), client::connect_stream(config, channel.into_stream(), handler))
                    .await
                    .map_err(|_| timeout())?
            }
        };

        let seen_fp = seen.lock().unwrap().clone();
        let mut handle = match result {
            Ok(h) => h,
            Err(e) => {
                // La clé a été rejetée par notre handler : on distingue hôte inconnu et clé modifiée.
                if let Some(fp) = seen_fp {
                    if params.known_fingerprint.as_deref() != Some(fp.as_str()) {
                        return Err(match params.known_fingerprint {
                            None => Error::UnknownHostKey(fp),
                            Some(expected) => Error::HostKeyMismatch { expected, got: fp },
                        });
                    }
                }
                return Err(Error::Connection(e.to_string()));
            }
        };
        let fingerprint = seen_fp.unwrap_or_default();

        // Large, car un agent (1Password, Pageant avec confirmation) peut attendre une validation.
        tokio::time::timeout(AUTH_LIMIT, authenticate(&mut handle, &params.username, &params.auth))
            .await
            .map_err(|_| Error::Connection(format!("délai dépassé pendant l'authentification sur {}:{}", params.host, params.port)))??;
        Ok(Self { handle: Arc::new(handle), execs: Arc::new(tokio::sync::Semaphore::new(MAX_PARALLEL_EXECS)), fingerprint })
    }

    /// Ouvre un canal ; un refus du serveur (limite `MaxSessions` atteinte un instant) est
    /// réessayé quelques fois au lieu de remonter une erreur à l'interface.
    async fn open_session(&self) -> Result<Channel<Msg>> {
        let mut delay = Duration::from_millis(200);
        for _ in 0..OPEN_RETRIES {
            match self.handle.channel_open_session().await {
                Err(russh::Error::ChannelOpenFailure(_)) if !self.handle.is_closed() => {
                    tokio::time::sleep(delay).await;
                    delay *= 2;
                }
                other => return Ok(other?),
            }
        }
        Ok(self.handle.channel_open_session().await?)
    }

    /// Vrai si les deux valeurs désignent la même connexion SSH.
    pub fn same_as(&self, other: &Connection) -> bool {
        Arc::ptr_eq(&self.handle, &other.handle)
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn disconnect(&self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "fr").await;
    }

    /// Exécute une commande et attend sa fin. `stdin` est envoyé puis fermé s'il est fourni.
    /// Au-delà du délai maximal (voir [`long`]), le canal est fermé et une erreur est renvoyée :
    /// une commande bloquée (`df` sur un montage mort, dockerd figé…) ne fige pas l'interface.
    pub async fn exec(&self, command: &str, stdin: Option<&[u8]>) -> Result<ExecOutput> {
        let limit = EXEC_LIMIT.try_with(|l| *l).unwrap_or(DEFAULT_EXEC_LIMIT);
        let _slot = self.execs.acquire().await.map_err(|e| Error::Connection(e.to_string()))?;
        let mut channel = self.open_session().await?;
        channel.exec(true, with_admin_path(command)).await?;

        let run = async {
            if let Some(input) = stdin {
                channel.data(input).await?;
            }
            channel.eof().await?;
            let (mut stdout, mut stderr, mut exit_code) = (Vec::new(), Vec::new(), None);
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::ExitSignal { .. } => exit_code = exit_code.or(Some(255)),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok::<_, Error>(ExecOutput {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                exit_code: exit_code.unwrap_or(0),
            })
        };
        match tokio::time::timeout(limit, run).await {
            Ok(out) => out,
            Err(_) => {
                let _ = channel.close().await;
                Err(Error::Remote(format!("la commande ne répond plus après {} s, abandonnée", limit.as_secs())))
            }
        }
    }

    /// Exécute une commande, en échouant si son code de sortie est non nul.
    pub async fn run(&self, command: &str) -> Result<String> {
        Ok(self.exec(command, None).await?.into_result()?.stdout)
    }

    /// Exécute une commande en root : directement si l'utilisateur est root, sinon via sudo.
    /// Le mot de passe sudo est transmis sur stdin, jamais dans la ligne de commande.
    pub async fn exec_sudo(&self, command: &str, sudo_password: Option<&str>, stdin: Option<&[u8]>) -> Result<ExecOutput> {
        let q = shell_quote(command);
        let out = match sudo_password {
            Some(pw) => {
                let mut input = format!("{pw}\n").into_bytes();
                input.extend_from_slice(stdin.unwrap_or_default());
                // Le mot de passe occupe la première ligne de l'entrée. Quand sudo n'en a pas besoin
                // (root, règle NOPASSWD, autorisation encore en cache), il ne la lirait pas et elle
                // arriverait en tête des données de la commande (en tête d'un fichier écrit, par
                // exemple) : elle est alors consommée avant.
                let cmd = format!(
                    "if [ \"$(id -u)\" = 0 ]; then read -r _; sh -c {q}; elif sudo -n true 2>/dev/null; then read -r _; sudo -n sh -c {q}; else sudo -S -p '' sh -c {q}; fi"
                );
                self.exec(&cmd, Some(&input)).await?
            }
            None => {
                let cmd = format!("if [ \"$(id -u)\" = 0 ]; then sh -c {q}; else sudo -n sh -c {q}; fi");
                self.exec(&cmd, stdin).await?
            }
        };
        match (!out.success()).then(|| sudo_failure(&out.stderr)).flatten() {
            Some(reason) => Err(Error::Other(reason)),
            None => Ok(out),
        }
    }

    /// Lit un fichier en root (fichiers système non lisibles par l'utilisateur SSH).
    pub async fn read_file_sudo(&self, path: &str, sudo_password: Option<&str>) -> Result<String> {
        let out = self.exec_sudo(&format!("cat -- {}", shell_quote(path)), sudo_password, None).await?;
        let out = out.into_result()?;
        Ok(out.stdout)
    }

    /// Écrit un fichier en root. `cat >` conserve le propriétaire et les permissions du fichier existant.
    pub async fn write_file_sudo(&self, path: &str, content: &str, sudo_password: Option<&str>) -> Result<()> {
        self.exec_sudo(&format!("cat > {}", shell_quote(path)), sudo_password, Some(content.as_bytes())).await?.into_result()?;
        Ok(())
    }

    /// Ouvre un shell interactif avec pseudo-terminal.
    pub async fn open_shell(&self, cols: u32, rows: u32) -> Result<Channel<Msg>> {
        let channel = self.open_session().await?;
        channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        channel.request_shell(true).await?;
        Ok(channel)
    }

    /// Ouvre un canal qui exécute une commande en flux continu (`docker logs -f`, `docker exec -it`…).
    pub async fn open_exec(&self, command: &str, pty: Option<(u32, u32)>) -> Result<Channel<Msg>> {
        let channel = self.open_session().await?;
        if let Some((cols, rows)) = pty {
            channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        }
        channel.exec(true, with_admin_path(command)).await?;
        Ok(channel)
    }

    /// Comme [`open_exec`](Self::open_exec), mais en root (sudo) pour les commandes longues
    /// (`journalctl -f`, `tail -F` sur des logs protégés…). Le mot de passe passe par stdin.
    pub async fn open_exec_sudo(&self, command: &str, sudo_password: Option<&str>) -> Result<Channel<Msg>> {
        let q = shell_quote(command);
        match sudo_password {
            Some(pw) => {
                let cmd = format!("if [ \"$(id -u)\" = 0 ]; then read -r _; exec sh -c {q}; else exec sudo -S -p '' sh -c {q}; fi");
                let channel = self.open_exec(&cmd, None).await?;
                channel.data(format!("{pw}\n").as_bytes()).await?;
                Ok(channel)
            }
            None => {
                let cmd = format!("if [ \"$(id -u)\" = 0 ]; then exec sh -c {q}; else exec sudo -n sh -c {q}; fi");
                self.open_exec(&cmd, None).await
            }
        }
    }

    /// Ouvre un canal vers `host:port` vu depuis le serveur (tunnel local, équivalent de `ssh -L`).
    pub async fn open_direct_tcpip(&self, host: &str, port: u16, local_port: u16) -> Result<russh::ChannelStream<Msg>> {
        let channel = self.handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", local_port as u32).await?;
        Ok(channel.into_stream())
    }

    /// Ouvre une session SFTP.
    pub async fn sftp(&self) -> Result<russh_sftp::client::SftpSession> {
        let channel = self.open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        russh_sftp::client::SftpSession::new(channel.into_stream()).await.map_err(|e| Error::Sftp(e.to_string()))
    }
}

async fn authenticate(handle: &mut Handle<HostKeyCheck>, user: &str, auth: &Auth) -> Result<()> {
    let ok = match auth {
        Auth::Password { password } => {
            let res = handle.authenticate_password(user, password).await?;
            // Beaucoup de serveurs n'acceptent le mot de passe qu'en keyboard-interactive.
            res.success() || keyboard_interactive(handle, user, password).await?
        }
        Auth::KeyFile { path, passphrase } => {
            let key = keys::load_secret_key(expand_home(path), passphrase.as_deref()).map_err(|e| {
                let raw = e.to_string();
                let lower = raw.to_lowercase();
                if lower.contains("mac") || lower.contains("decrypt") || lower.contains("encrypted") || lower.contains("passphrase") {
                    Error::Auth(format!("passphrase de la clé manquante ou incorrecte ({path})"))
                } else {
                    Error::Auth(format!("clé illisible ({path}) : {raw}"))
                }
            })?;
            // Certificat SSH signé par une autorité (`cle-cert.pub` à côté de la clé) : présenté s'il existe.
            let cert_path = format!("{}-cert.pub", expand_home(path).trim_end_matches(".ppk"));
            if let Ok(cert) = keys::Certificate::read_file(std::path::Path::new(&cert_path)) {
                handle.authenticate_openssh_cert(user, Arc::new(key), cert).await?.success()
            } else {
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await?.success()
            }
        }
        Auth::Agent { key_path } => {
            let wanted = match key_path.as_deref().filter(|p| !p.is_empty()) {
                Some(p) => {
                    Some(public_key_from_file(&expand_home(p)).ok_or_else(|| Error::Auth(format!("clé publique illisible dans {p}")))?)
                }
                None => None,
            };
            authenticate_with_agent(handle, user, wanted.as_ref()).await?
        }
    };
    if ok {
        Ok(())
    } else {
        Err(Error::Auth("identifiants refusés par le serveur".into()))
    }
}

async fn keyboard_interactive(handle: &mut Handle<HostKeyCheck>, user: &str, password: &str) -> Result<bool> {
    use russh::client::KeyboardInteractiveAuthResponse as R;
    let mut resp = handle.authenticate_keyboard_interactive_start(user, None::<String>).await?;
    for _ in 0..5 {
        match resp {
            R::Success => return Ok(true),
            R::Failure { .. } => return Ok(false),
            R::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

/// Sans clé ciblée, au plus 3 clés de l'agent sont présentées : chaque refus est un échec
/// d'authentification aux yeux du serveur (et de fail2ban).
const MAX_AGENT_KEYS: usize = 3;

async fn authenticate_with_agent(handle: &mut Handle<HostKeyCheck>, user: &str, wanted: Option<&keys::PublicKey>) -> Result<bool> {
    use keys::agent::client::AgentClient;
    let mut budget = MAX_AGENT_KEYS;
    let mut agent_found = false;
    #[cfg(windows)]
    {
        // OpenSSH pour Windows d'abord, puis Pageant (l'agent de PuTTY).
        if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            agent_found = true;
            if try_agent(handle, user, agent, wanted, &mut budget).await? {
                return Ok(true);
            }
        }
        if let Ok(agent) = AgentClient::connect_pageant().await {
            agent_found = true;
            if try_agent(handle, user, agent, wanted, &mut budget).await? {
                return Ok(true);
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(agent) = AgentClient::connect_env().await {
            agent_found = true;
            if try_agent(handle, user, agent, wanted, &mut budget).await? {
                return Ok(true);
            }
        }
    }
    if !agent_found {
        return Err(Error::Auth(
            "aucun agent SSH trouvé : lance Pageant (ou l'agent OpenSSH) et ajoutes-y ta clé, ou choisis « Clé privée » dans le profil"
                .into(),
        ));
    }
    if wanted.is_some() && budget == MAX_AGENT_KEYS {
        // Rien n'a été envoyé au serveur : aucun échec comptabilisé par fail2ban.
        return Err(Error::Auth("la clé du profil n'est chargée ni dans Pageant ni dans l'agent OpenSSH : ajoute-la à l'agent, ou choisis « Clé privée » dans le profil".into()));
    }
    Ok(false)
}

/// Présente les clés de l'agent (seulement `wanted` si indiquée), dans la limite de `budget` tentatives.
async fn try_agent<S>(
    handle: &mut Handle<HostKeyCheck>,
    user: &str,
    mut agent: keys::agent::client::AgentClient<S>,
    wanted: Option<&keys::PublicKey>,
    budget: &mut usize,
) -> Result<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await.map_err(|e| Error::Auth(e.to_string()))?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else { continue };
        if wanted.is_some_and(|w| w.key_data() != key.key_data()) {
            continue;
        }
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        if let Ok(res) = handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if res.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Partie publique d'une clé : `.ppk` (lisible sans passphrase), fichier `.pub` voisin, ou clé non chiffrée.
pub fn public_key_from_file(path: &str) -> Option<keys::PublicKey> {
    use base64::Engine;
    let text = std::fs::read_to_string(path).ok()?;
    if text.starts_with("PuTTY-User-Key-File") {
        let mut lines = text.lines();
        let count: usize = lines.by_ref().find_map(|l| l.strip_prefix("Public-Lines:"))?.trim().parse().ok()?;
        let b64: String = lines.take(count).collect();
        let blob = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
        return keys::PublicKey::from_bytes(&blob).ok();
    }
    // Le chemin peut être directement un `.pub` (export 1Password) ou la clé privée avec son `.pub` voisin.
    if let Ok(k) = keys::parse_public_key_base64(text.split_whitespace().nth(1).unwrap_or(""))
        .or_else(|_| keys::load_public_key(format!("{path}.pub")))
    {
        return Some(k);
    }
    keys::decode_secret_key(&text, None).ok().map(|k| k.public_key().clone())
}

pub fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => {
            let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
            format!("{home}/{rest}")
        }
        None => path.to_string(),
    }
}

/// Entoure une chaîne de quotes simples pour un shell POSIX.
/// Ajoute les dossiers `sbin` au PATH : sur Debian, nginx, ufw ou sshd y sont installés et
/// restent invisibles pour un utilisateur non root, qui conclurait à tort qu'ils sont absents.
fn with_admin_path(command: &str) -> String {
    format!(
        "PATH=\"$PATH:/usr/local/sbin:/usr/sbin:/sbin\"; export PATH
{command}"
    )
}

/// Refus de sudo lui-même (et non échec de la commande), traduit en explication utile.
pub fn sudo_failure(stderr: &str) -> Option<String> {
    let e = stderr.to_lowercase();
    if e.contains("must have a tty") || e.contains("a terminal is required") {
        Some("sudo exige un terminal sur ce serveur (option « requiretty ») : ajoute « Defaults:TON_UTILISATEUR !requiretty » avec visudo pour que Zenytt puisse administrer ce serveur.".into())
    } else if e.contains("incorrect password") || e.contains("sorry, try again") {
        Some("mot de passe sudo incorrect : corrige-le dans le profil du serveur.".into())
    } else if e.contains("a password is required") {
        Some("sudo demande un mot de passe : renseigne « Mot de passe sudo » dans le profil du serveur.".into())
    } else if e.contains("not in the sudoers") || e.contains("is not allowed to") || e.contains("may not run sudo") {
        Some("ton utilisateur n'a pas les droits sudo sur ce serveur (il doit faire partie du groupe sudo ou wheel).".into())
    } else {
        None
    }
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sudo_failures() {
        assert!(sudo_failure("sudo: sorry, you must have a tty to run sudo").unwrap().contains("requiretty"));
        assert!(sudo_failure(
            "Sorry, try again.
sudo: 3 incorrect password attempts"
        )
        .unwrap()
        .contains("incorrect"));
        assert!(sudo_failure("sudo: a password is required").is_some());
        assert!(sudo_failure("admin is not in the sudoers file.").unwrap().contains("droits sudo"));
        assert!(sudo_failure("cat: /x: No such file or directory").is_none());
    }

    #[test]
    fn public_key_from_pub_file() {
        let path = std::env::temp_dir().join("zenytt-test-1password.pub");
        std::fs::write(&path, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl 1password\n").unwrap();
        assert!(public_key_from_file(path.to_str().unwrap()).is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn quote_escapes_single_quotes() {
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("a b"), "'a b'");
    }
}
