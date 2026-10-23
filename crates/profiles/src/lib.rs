//! Données locales de Zenytt, partagées par l'app desktop et le serveur MCP :
//! profils de serveurs, clés d'hôte approuvées, snippets, tunnels, état de l'interface,
//! secrets (dans le keyring de l'OS) et journal d'actions.

pub mod audit;
pub mod export;
pub mod legacy;
pub mod secrets;
pub mod ssh_config;
pub mod sync;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use zenytt_core::{Auth, ConnectParams};

/// Identifiant de l'app : nom du dossier de configuration et du service keyring.
pub const APP_ID: &str = "dev.zenytt.desktop";

/// Dossier de configuration de Zenytt (identique à `app_config_dir` de Tauri).
pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join(APP_ID)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Password,
    Key,
    Agent,
}

/// Protocole d'accès à un serveur. Seul `Ssh` ouvre un shell : les autres ne servent qu'aux fichiers.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    #[default]
    Ssh,
    /// Transport et authentification SSH, mais jamais de commande (`internal-sftp`, chroot).
    Sftp,
    Ftp,
    /// FTP avec TLS explicite.
    Ftps,
}

impl Protocol {
    /// Peut-on exécuter des commandes sur ce serveur ?
    pub fn has_shell(self) -> bool {
        self == Protocol::Ssh
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    /// Le serveur MCP (lecture seule) peut-il interroger ce serveur ? Désactivé par défaut.
    #[serde(default)]
    pub ai_access: bool,
    /// Serveur de rebond (bastion) par lequel passer pour joindre celui-ci (`ssh -J`).
    #[serde(default)]
    pub jump_id: Option<String>,
    /// Identifiant de la banque utilisé pour se connecter : il remplace alors l'utilisateur,
    /// le type d'authentification, la clé et les secrets du profil.
    #[serde(default)]
    pub identity_id: Option<String>,
    /// Se connecter automatiquement au démarrage de Zenytt (une fois déverrouillé).
    #[serde(default)]
    pub auto_connect: bool,
    /// Compte chez l'hébergeur, pour piloter l'alimentation par son API quand SSH ne répond plus.
    /// Les identifiants sont dans le keyring, sous [`ServerProfile::provider_owner`].
    #[serde(default)]
    pub provider: Option<zenytt_core::provider::ProviderLink>,
}

impl ServerProfile {
    /// Propriétaire des identifiants de l'hébergeur dans le keyring.
    pub fn provider_owner(id: &str) -> String {
        format!("provider-{id}")
    }
}

/// Identifiant réutilisable (banque de logins) : utilisateur + mot de passe ou clé, partagé
/// par plusieurs serveurs. Ses secrets sont dans le keyring, sous [`Identity::secret_owner`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub username: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub key_path: Option<String>,
}

impl Identity {
    /// Propriétaire des secrets de l'identifiant dans le keyring (à la place d'un id de serveur).
    pub fn secret_owner(id: &str) -> String {
        format!("identity-{id}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
}

/// Conteneur « ponctuel » : une tâche qui s'arrête normalement (migration, sauvegarde, cron…). Son
/// arrêt n'est signalé nulle part (accueil, compteurs des projets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OccasionalContainer {
    pub server_id: String,
    /// `projet/service` pour un conteneur compose (stable quand il est recréé), sinon son nom.
    pub key: String,
}

/// Réglage d'un point de montage pour la supervision : ignoré dans les alertes, ou taille réelle
/// saisie à la main (hébergement mutualisé : `df` voit un système de fichiers qui n'est pas le
/// vrai espace de l'abonnement).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskRule {
    pub server_id: String,
    pub mount: String,
    /// Ne compte pas dans l'alerte « Disque » ni dans les jauges.
    #[serde(default)]
    pub ignore: bool,
    /// Capacité réelle (octets), à la place de celle lue par `df`.
    #[serde(default)]
    pub total: Option<u64>,
    /// Espace réellement utilisé (octets), à la place de celui lu par `df`.
    #[serde(default)]
    pub used: Option<u64>,
}

/// Étiquette posée sur une adresse IP (fail2ban) : « mon bureau », « scanner connu »…
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IpLabel {
    pub ip: String,
    pub label: String,
    #[serde(default)]
    pub note: String,
}

/// Réseau privé WireGuard entre serveurs (section Réseau privé). Propre à ce PC : la vérité est
/// sur les serveurs (`/etc/wireguard/zenytt.conf`), ceci sert à les orchestrer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshNetwork {
    pub id: String,
    pub name: String,
    /// Sous-réseau privé, par exemple `10.77.0.0/24`.
    pub cidr: String,
    pub members: Vec<MeshMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshMember {
    pub server_id: String,
    /// Adresse privée, sans masque.
    pub address: String,
    pub public_key: String,
    /// IP ou nom public ; absent : serveur derrière un NAT.
    #[serde(default)]
    pub endpoint: Option<String>,
    pub port: u16,
}

/// Constat d'audit de sécurité mis de côté : il n'apparaît plus dans la liste des problèmes,
/// mais reste consultable dans les constats ignorés.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredFinding {
    /// Serveur concerné.
    pub server_id: String,
    /// Identifiant du constat (`ssh.root_login`…).
    pub finding_id: String,
    /// Titre au moment où il a été ignoré, pour l'afficher même si l'audit ne le remonte plus.
    #[serde(default)]
    pub title: String,
    /// Raison saisie par l'utilisateur.
    #[serde(default)]
    pub reason: String,
    /// Horodatage (ms).
    pub at: i64,
}

/// Protocole d'un bureau à distance.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopProtocol {
    /// Windows, ou Linux avec xrdp.
    #[default]
    Rdp,
    /// Bureaux Linux (GNOME, KDE, XFCE), Raspberry Pi, macOS (Partage d'écran), consoles de VM.
    Vnc,
    /// Consoles de machines virtuelles QEMU/KVM (libvirt, Proxmox), ouvertes dans remote-viewer.
    Spice,
}

impl DesktopProtocol {
    pub fn default_port(self) -> u16 {
        match self {
            DesktopProtocol::Rdp => 3389,
            DesktopProtocol::Vnc | DesktopProtocol::Spice => 5900,
        }
    }
}

/// Bureau à distance (RDP ou VNC) : ouvert dans Zenytt, ou dans le client RDP du système (mstsc
/// sous Windows), directement ou à travers un tunnel SSH par un serveur de Zenytt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktop {
    pub id: String,
    pub name: String,
    /// Absent des profils créés avant l'arrivée de VNC : ce sont des bureaux RDP.
    #[serde(default)]
    pub protocol: DesktopProtocol,
    pub host: String,
    #[serde(default = "default_rdp_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// Domaine Windows (`DOMAINE\utilisateur`), optionnel.
    #[serde(default)]
    pub domain: Option<String>,
    /// Identifiant de la banque (utilisateur + mot de passe) à utiliser.
    #[serde(default)]
    pub identity_id: Option<String>,
    /// Serveur SSH de Zenytt par lequel passer (le port RDP n'est alors jamais exposé à Internet).
    #[serde(default)]
    pub via_server_id: Option<String>,
    #[serde(default)]
    pub fullscreen: bool,
    /// Taille de la fenêtre (hors plein écran), par ex. 1600×900.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub multimon: bool,
    /// Partage des disques du PC avec la session distante.
    #[serde(default)]
    pub redirect_drives: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
}

fn default_rdp_port() -> u16 {
    3389
}

impl RemoteDesktop {
    /// Propriétaire du mot de passe dans le keyring.
    pub fn secret_owner(id: &str) -> String {
        format!("rdp-{id}")
    }

    /// Bureau utilisable tel quel. Un bureau peut venir d'un fichier de partage, donc de quelqu'un
    /// d'autre, sans passer par le formulaire : l'identifiant sert de nom de fichier (`<id>.rdp`)
    /// et chaque champ devient une ligne du fichier `.rdp` ou `.vv`. Un séparateur de chemin ou un
    /// retour à la ligne y écrirait ailleurs ou ajouterait ses propres options.
    pub fn is_valid(&self) -> bool {
        let text = |s: &str| !s.chars().any(char::is_control);
        valid_id(&self.id)
            && !self.host.is_empty()
            && !self.host.contains(char::is_whitespace)
            && text(&self.host)
            && text(&self.username)
            && text(&self.name)
            && self.domain.as_deref().is_none_or(text)
    }
}

/// Identifiant d'élément tel que l'app les crée (UUID) : ni séparateur de chemin ni caractère spécial.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Registre d'images privé (Docker Hub, GitHub Packages, GitLab, AWS ECR…). Le jeton est dans
/// le keyring, sous [`Registry::secret_owner`] ; ici ne figurent que l'adresse et l'utilisateur.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub id: String,
    pub name: String,
    pub kind: zenytt_core::registry::Kind,
    /// Adresse du registre (`ghcr.io`, `registry.exemple.fr:5000`…).
    pub server: String,
    /// Utilisateur, ou identifiant de clé d'accès AWS pour ECR.
    pub username: String,
}

impl Registry {
    /// Propriétaire du jeton dans le keyring.
    pub fn secret_owner(id: &str) -> String {
        format!("registry-{id}")
    }

    /// Mêmes règles que le formulaire d'enregistrement (adresse et utilisateur).
    pub fn is_valid(&self) -> bool {
        valid_id(&self.id) && zenytt_core::registry::valid_server(&self.server) && zenytt_core::registry::valid_word(&self.username)
    }
}

/// Tunnel SSH local : 127.0.0.1:`local_port` sur le PC → `remote_host`:`remote_port` vu du serveur.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDef {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    #[serde(default)]
    pub servers: Vec<ServerProfile>,
    /// `host:port` → empreinte SHA256 de la clé d'hôte approuvée.
    #[serde(default)]
    pub known_hosts: HashMap<String, String>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub tunnels: Vec<TunnelDef>,
    /// Banque d'identifiants (logins réutilisables).
    #[serde(default)]
    pub identities: Vec<Identity>,
    /// Bureaux à distance (RDP).
    #[serde(default)]
    pub desktops: Vec<RemoteDesktop>,
    /// Registres d'images privés.
    #[serde(default)]
    pub registries: Vec<Registry>,
    /// Constats d'audit ignorés (archivés).
    #[serde(default)]
    pub ignored_findings: Vec<IgnoredFinding>,
    #[serde(default)]
    pub occasional_containers: Vec<OccasionalContainer>,
    /// Conteneurs arrêtés volontairement (depuis Zenytt, ou marqués comme tels) : leur arrêt n'est
    /// pas une panne. Retirés dès que le conteneur est relancé.
    #[serde(default)]
    pub stopped_on_purpose: Vec<OccasionalContainer>,
    /// Réglages des points de montage (supervision).
    #[serde(default)]
    pub disk_rules: Vec<DiskRule>,
    /// Étiquettes des adresses IP (fail2ban), communes à tous les serveurs.
    #[serde(default)]
    pub ip_labels: Vec<IpLabel>,
    /// Réseaux privés entre serveurs.
    #[serde(default)]
    pub meshes: Vec<MeshNetwork>,
    /// Réglages de l'assistant IA (fournisseur, modèle, autorisations), sans la clé d'API.
    #[serde(default)]
    pub ai: Option<serde_json::Value>,
    /// Synchronisation avec les autres PC (propre à ce PC).
    #[serde(default)]
    pub sync: Option<sync::SyncConfig>,
    /// État de l'interface (onglets, dossiers ouverts…), opaque côté Rust.
    #[serde(default)]
    pub ui_state: serde_json::Value,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
    /// Problème rencontré au chargement (fichier illisible), à signaler à l'utilisateur.
    warning: Option<String>,
}

impl Store {
    /// Lecture seule, sans jamais toucher au fichier (serveur MCP).
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("zenytt.json");
        let data = read_json(&path).unwrap_or_default();
        Self { path, data: Mutex::new(data), warning: None }
    }

    /// Chargement par l'app. Un fichier illisible n'est jamais écrasé : il est mis de côté et
    /// la copie de secours (`zenytt.json.bak`, version précédente) est utilisée si elle est valide.
    pub fn open(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join("zenytt.json");
        let Ok(bytes) = std::fs::read(&path) else {
            return Self { path, data: Mutex::default(), warning: None };
        };
        if let Ok(data) = serde_json::from_slice(&bytes) {
            return Self { path, data: Mutex::new(data), warning: None };
        }
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let aside = dir.join(format!("zenytt.json.corrompu-{stamp}"));
        let moved = std::fs::rename(&path, &aside).is_ok();
        let kept = if moved { format!("Il a été conservé sous {}.", aside.display()) } else { String::new() };
        let (data, warning) = match read_json::<Data>(&path.with_extension("json.bak")) {
            Some(d) => {
                (d, format!("Le fichier de configuration de Zenytt était illisible : la version précédente a été restaurée. {kept}"))
            }
            None => (
                Data::default(),
                format!("Le fichier de configuration de Zenytt était illisible et aucune copie de secours n'est valide. {kept}"),
            ),
        };
        Self { path, data: Mutex::new(data), warning: Some(warning) }
    }

    pub fn warning(&self) -> Option<String> {
        self.warning.clone()
    }

    /// Relit le fichier (le serveur MCP tourne dans un autre processus que l'app).
    pub fn reload(&self) {
        if let Some(d) = read_json(&self.path) {
            *self.data.lock().unwrap() = d;
        }
    }

    pub fn read<T>(&self, f: impl FnOnce(&Data) -> T) -> T {
        f(&self.data.lock().unwrap())
    }

    /// Modifie les données puis les écrit sur disque de façon atomique (fichier temporaire + rename).
    pub fn write<T>(&self, f: impl FnOnce(&mut Data) -> T) -> Result<T, String> {
        let mut data = self.data.lock().unwrap();
        let out = f(&mut data);
        let json = serde_json::to_vec_pretty(&*data).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(&json).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        // La version précédente, valide, sert de copie de secours.
        if read_json::<Data>(&self.path).is_some() {
            let _ = std::fs::copy(&self.path, self.path.with_extension("json.bak"));
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn server(&self, id: &str) -> Result<ServerProfile, String> {
        self.read(|d| d.servers.iter().find(|s| s.id == id).cloned()).ok_or_else(|| "serveur introuvable".to_string())
    }

    /// Chaîne des serveurs de rebond de `id` (le premier est celui à joindre d'abord). Refuse une
    /// boucle (A passe par B qui passe par A) ou un rebond vers un serveur supprimé.
    pub fn jump_chain(&self, id: &str) -> Result<Vec<String>, String> {
        let mut chain: Vec<String> = Vec::new();
        let mut current = self.server(id)?.jump_id.filter(|j| !j.is_empty());
        while let Some(j) = current {
            if j == id || chain.contains(&j) {
                return Err("les serveurs de rebond forment une boucle : corrige le profil".into());
            }
            let next = self.server(&j).map_err(|_| "le serveur de rebond de ce profil n'existe plus".to_string())?;
            chain.push(j);
            current = next.jump_id.filter(|j| !j.is_empty());
        }
        Ok(chain)
    }

    pub fn identity(&self, id: &str) -> Result<Identity, String> {
        self.read(|d| d.identities.iter().find(|i| i.id == id).cloned()).ok_or_else(|| "identifiant introuvable dans la banque".to_string())
    }

    /// Paramètres de connexion SSH d'un serveur, secrets lus dans le keyring. Un serveur lié à
    /// un identifiant de la banque utilise l'utilisateur, la clé et les secrets de celui-ci.
    pub fn connect_params(&self, server_id: &str) -> Result<ConnectParams, String> {
        let profile = self.server(server_id)?;
        let (username, auth_kind, key_path, owner, what) = match profile.identity_id.as_deref().filter(|i| !i.is_empty()) {
            Some(id) => {
                let ident = self.identity(id)?;
                (ident.username, ident.auth_kind, ident.key_path, Identity::secret_owner(id), "cet identifiant")
            }
            None => (profile.username, profile.auth_kind, profile.key_path, server_id.to_string(), "ce serveur"),
        };
        // Mobile : la clé collée sur le téléphone prime (son chemin n'est jamais dans le profil
        // synchronisé), et un mot de passe saisi ici vaut mieux qu'une clé du PC absente du téléphone.
        let phone_key = secrets::is_file().then(|| secrets::get(server_id, secrets::MOBILE_KEY)).flatten();
        let phone_password = secrets::is_file() && auth_kind != AuthKind::Password && secrets::get(&owner, "password").is_some();
        let auth_kind = if phone_key.is_some() {
            AuthKind::Key
        } else if phone_password {
            AuthKind::Password
        } else {
            auth_kind
        };
        let key_path = phone_key.or(key_path);
        let auth = match auth_kind {
            AuthKind::Password => Auth::Password {
                password: secrets::get(&owner, "password").ok_or(format!("NEED_PASSWORD: aucun mot de passe enregistré pour {what}"))?,
            },
            AuthKind::Key => {
                Auth::KeyFile { path: key_path.ok_or("aucune clé privée configurée")?, passphrase: secrets::get(&owner, "passphrase") }
            }
            AuthKind::Agent => Auth::Agent { key_path },
        };
        let host_key = format!("{}:{}", profile.host, profile.port);
        Ok(ConnectParams {
            host: profile.host,
            port: profile.port,
            username,
            auth,
            known_fingerprint: self.read(|d| d.known_hosts.get(&host_key).cloned()),
        })
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_files_without_meshes_still_load() {
        let d: Data = serde_json::from_str(r#"{"servers":[]}"#).unwrap();
        assert!(d.meshes.is_empty());
        let net = MeshNetwork {
            id: "n1".into(),
            name: "Prod".into(),
            cidr: "10.77.0.0/24".into(),
            members: vec![MeshMember {
                server_id: "s1".into(),
                address: "10.77.0.1".into(),
                public_key: "K=".into(),
                endpoint: None,
                port: 51820,
            }],
        };
        let json = serde_json::to_string(&net).unwrap();
        assert!(json.contains("\"serverId\":\"s1\""), "{json}");
        assert_eq!(serde_json::from_str::<MeshNetwork>(&json).unwrap(), net);
    }

    #[test]
    fn old_files_still_load() {
        // Fichier de la v1 : sans tunnels, ui_state ni ai_access.
        let v1 = r#"{"servers":[{"id":"a","name":"VPS","host":"h","port":22,"username":"root","authKind":"password"}],"knownHosts":{},"snippets":[]}"#;
        let d: Data = serde_json::from_str(v1).unwrap();
        assert!(!d.servers[0].ai_access);
        assert_eq!(d.servers[0].protocol, Protocol::Ssh);
        assert_eq!(serde_json::to_string(&Protocol::Ftps).unwrap(), "\"ftps\"");
        assert!(d.tunnels.is_empty());
    }

    #[test]
    fn corrupt_file_is_kept_and_backup_restored() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        s.write(|d| d.snippets.push(Snippet { id: "1".into(), name: "a".into(), command: "ls".into() })).unwrap();
        s.write(|d| d.snippets.push(Snippet { id: "2".into(), name: "b".into(), command: "ls".into() })).unwrap();
        std::fs::write(dir.path().join("zenytt.json"), b"{ tronqu").unwrap();

        let s = Store::open(dir.path());
        assert!(s.warning().is_some());
        assert_eq!(s.read(|d| d.snippets.len()), 1, "la version précédente est restaurée");
        let aside =
            std::fs::read_dir(dir.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("zenytt.json.corrompu-"));
        assert!(aside, "le fichier illisible est conservé");
    }

    #[test]
    fn jump_chains() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        let p = |id: &str, jump: Option<&str>| ServerProfile {
            id: id.into(),
            name: id.into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth_kind: AuthKind::Agent,
            key_path: None,
            color: None,
            group: None,
            ai_access: false,
            jump_id: jump.map(str::to_string),
            identity_id: None,
            protocol: Default::default(),
            auto_connect: false,
            provider: None,
        };
        s.write(|d| d.servers.extend([p("a", Some("b")), p("b", Some("c")), p("c", None), p("x", Some("y")), p("y", Some("x"))])).unwrap();
        assert_eq!(s.jump_chain("a").unwrap(), vec!["b", "c"]);
        assert!(s.jump_chain("c").unwrap().is_empty());
        assert!(s.jump_chain("x").is_err(), "boucle détectée");
    }

    #[test]
    fn identity_overrides_profile_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        s.write(|d| {
            d.identities.push(Identity {
                id: "i".into(),
                name: "Perso".into(),
                username: "alice".into(),
                auth_kind: AuthKind::Agent,
                key_path: Some("k".into()),
            });
            d.servers.push(ServerProfile {
                id: "a".into(),
                name: "VPS".into(),
                host: "h".into(),
                port: 22,
                username: "root".into(),
                auth_kind: AuthKind::Password,
                key_path: None,
                color: None,
                group: None,
                ai_access: false,
                jump_id: None,
                identity_id: Some("i".into()),
                protocol: Default::default(),
                auto_connect: false,
                provider: None,
            });
        })
        .unwrap();
        let p = s.connect_params("a").unwrap();
        assert_eq!(p.username, "alice");
        assert!(matches!(p.auth, Auth::Agent { key_path: Some(ref k) } if k == "k"), "authentification de l'identifiant");
        s.write(|d| d.identities.clear()).unwrap();
        assert!(s.connect_params("a").is_err(), "identifiant supprimé : erreur explicite");
    }

    #[test]
    fn write_then_reload() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::load(dir.path());
        s.write(|d| d.snippets.push(Snippet { id: "1".into(), name: "n".into(), command: "ls".into() })).unwrap();
        let other = Store::load(dir.path());
        assert_eq!(other.read(|d| d.snippets.len()), 1);
    }
}
