//! Synchronisation des réglages entre plusieurs PC (profils, identifiants, clés d'hôte approuvées,
//! snippets, tunnels et, au choix, secrets), via un fichier partagé (dossier OneDrive, Dropbox,
//! partage réseau…) ou un petit serveur auto-hébergé (`zenytt-sync`, dans Docker).
//!
//! Le contenu est chiffré de bout en bout avec la phrase de passe de synchronisation (même format
//! que l'export) : ni le fichier ni le serveur ne voient les réglages en clair. Chaque envoi porte
//! un numéro de révision ; en cas de modifications des deux côtés, les deux versions sont
//! fusionnées (la version locale l'emporte sur un même élément).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::export::{self, Payload};
use crate::{secrets, Identity, Registry, RemoteDesktop, ServerProfile, Store};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SyncMode {
    #[default]
    Off,
    File,
    Server,
}

/// Réglage de la synchronisation (propre à ce PC, jamais synchronisé lui-même). La phrase de
/// passe et le jeton du serveur sont dans le keyring.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub mode: SyncMode,
    /// Fichier partagé (mode fichier).
    #[serde(default)]
    pub path: Option<String>,
    /// Adresse du serveur `zenytt-sync` (mode serveur), par ex. `https://sync.exemple.fr`.
    #[serde(default)]
    pub url: Option<String>,
    /// Mode privé : le serveur n'écoute que sur la boucle locale d'un de tes serveurs, joint par un
    /// tunnel SSH (pas de port ouvert, pas de nom de domaine). Remplace alors `url`.
    #[serde(default)]
    pub tunnel: Option<SyncTunnel>,
    /// Synchroniser aussi les mots de passe, passphrases et mots de passe sudo.
    #[serde(default)]
    pub include_secrets: bool,
    /// Révision distante lors de la dernière synchronisation réussie.
    #[serde(default)]
    pub last_rev: u64,
    /// Empreinte des réglages locaux juste après cette synchronisation.
    #[serde(default)]
    pub last_hash: Option<String>,
    /// Horodatage (ms) de la dernière synchronisation réussie.
    #[serde(default)]
    pub last_sync: Option<i64>,
    /// Empreinte du contenu distant (chiffré) à `last_rev` : un autre contenu sous la même
    /// révision est refusé.
    #[serde(default)]
    pub last_remote: Option<String>,
}

/// Serveur SSH qui héberge `zenytt-sync` et port sur lequel il écoute (sur 127.0.0.1 côté serveur).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTunnel {
    pub server_id: String,
    pub port: u16,
}

/// Propriétaire, dans le keyring, de la phrase de passe et du jeton de synchronisation.
pub const SECRET_OWNER: &str = "sync";

/// Préfixe d'un code d'appairage (à coller sur un autre PC pour rejoindre la synchronisation).
pub const PAIRING_PREFIX: &str = "zenytt-pair:";
const PAIRING_FORMAT: &str = "zenytt-pair";
/// Secrets d'un serveur transmis avec le code en mode privé : de quoi s'y connecter en SSH.
const SERVER_SECRETS: [&str; 3] = ["password", "passphrase", "sudo"];

/// Contenu d'un code d'appairage, chiffré avec la phrase de passe de synchronisation.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Pairing {
    url: Option<String>,
    tunnel: Option<SyncTunnel>,
    token: String,
    include_secrets: bool,
    /// Mode privé : le serveur qui héberge la synchronisation, pour que l'autre PC puisse s'y
    /// connecter avant même sa première synchronisation.
    server: Option<crate::ServerProfile>,
    #[serde(default)]
    server_secrets: BTreeMap<String, String>,
    /// Empreinte de clé d'hôte approuvée de ce serveur : sans elle, l'autre PC devrait accepter
    /// à l'aveugle la clé présentée à sa première connexion.
    #[serde(default)]
    server_host_key: Option<String>,
}

/// Code d'appairage de ce PC : adresse ou serveur privé, jeton et, en mode privé, le profil SSH du
/// serveur. Chiffré avec la phrase de passe : sans elle, le code ne révèle rien.
pub fn pairing_code(store: &Store) -> Result<String, String> {
    use base64::Engine;
    let cfg = store
        .read(|d| d.sync.clone())
        .filter(|c| c.mode == SyncMode::Server)
        .ok_or("la synchronisation par serveur n'est pas configurée")?;
    let passphrase = secrets::get(SECRET_OWNER, "passphrase").ok_or("phrase de passe de synchronisation manquante")?;
    let token = secrets::get(SECRET_OWNER, "token").ok_or("jeton du serveur de synchronisation manquant")?;
    let server = cfg.tunnel.as_ref().and_then(|t| store.server(&t.server_id).ok());
    let server_secrets = server
        .as_ref()
        .map(|s| SERVER_SECRETS.iter().filter_map(|k| secrets::get(&s.id, k).map(|v| (k.to_string(), v))).collect())
        .unwrap_or_default();
    let server_host_key = server.as_ref().and_then(|s| store.read(|d| d.known_hosts.get(&format!("{}:{}", s.host, s.port)).cloned()));
    let pairing =
        Pairing { url: cfg.url, tunnel: cfg.tunnel, token, include_secrets: cfg.include_secrets, server, server_secrets, server_host_key };
    let sealed = export::seal_value(&serde_json::to_value(&pairing).map_err(|e| e.to_string())?, &passphrase, PAIRING_FORMAT)?;
    Ok(format!("{PAIRING_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(sealed)))
}

/// Rejoint la synchronisation avec le code d'un autre PC : ajoute au besoin le serveur privé,
/// enregistre jeton et phrase de passe, et règle ce PC comme l'autre. La première synchronisation
/// (fusion) reste à lancer.
pub fn join(store: &Store, code: &str, passphrase: &str) -> Result<(), String> {
    use base64::Engine;
    let raw = code.trim().strip_prefix(PAIRING_PREFIX).ok_or("ce n'est pas un code d'appairage Zenytt (il commence par zenytt-pair:)")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(raw.trim()).map_err(|_| "code d'appairage incomplet ou abîmé")?;
    let text = String::from_utf8(bytes).map_err(|_| "code d'appairage illisible")?;
    let pairing: Pairing =
        serde_json::from_value(export::open_value(&text, passphrase, PAIRING_FORMAT)?).map_err(|_| "code d'appairage illisible")?;
    if let Some(server) = &pairing.server {
        if store.server(&server.id).is_err() {
            store.write(|d| d.servers.push(server.clone()))?;
            for (kind, value) in &pairing.server_secrets {
                if SERVER_SECRETS.contains(&kind.as_str()) {
                    secrets::set(&server.id, kind, value)?;
                }
            }
        }
        if let Some(fp) = &pairing.server_host_key {
            // Une empreinte déjà approuvée sur ce PC n'est jamais remplacée.
            store.write(|d| {
                d.known_hosts.entry(format!("{}:{}", server.host, server.port)).or_insert_with(|| fp.clone());
            })?;
        }
    }
    secrets::set(SECRET_OWNER, "token", &pairing.token)?;
    secrets::set(SECRET_OWNER, "passphrase", passphrase)?;
    store.write(|d| {
        d.sync = Some(SyncConfig {
            mode: SyncMode::Server,
            url: pairing.url,
            tunnel: pairing.tunnel,
            include_secrets: pairing.include_secrets,
            ..Default::default()
        })
    })
}

/// Contenu distant : numéro de révision et enveloppe chiffrée.
#[derive(Debug, Clone)]
pub struct Remote {
    pub rev: u64,
    pub data: String,
}

pub enum PushResult {
    /// Accepté : nouvelle révision.
    Ok(u64),
    /// Refusé : quelqu'un d'autre a envoyé entre-temps.
    Conflict,
}

/// Transport du contenu chiffré (fichier ou serveur HTTP).
pub trait Transport {
    fn fetch(&self) -> Result<Option<Remote>, String>;
    /// Remplace le contenu si la révision distante est toujours `base_rev` (0 : aucun contenu).
    fn push(&self, base_rev: u64, data: &str) -> Result<PushResult, String>;
}

/// Serveur `zenytt-sync` (HTTP), commun au bureau et au mobile.
pub struct HttpTransport {
    url: String,
    token: String,
    agent: ureq::Agent,
}

impl HttpTransport {
    pub fn new(url: String, token: String) -> Self {
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    UpToDate,
    Pushed,
    Pulled,
    Merged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub action: Action,
    pub rev: u64,
    /// Serveurs et tunnels supprimés par la synchronisation (à fermer côté app).
    pub removed_servers: Vec<String>,
    pub removed_tunnels: Vec<String>,
}

/// Empreinte d'un contenu, indépendante de l'ordre des éléments.
pub(crate) fn fingerprint(p: &Payload) -> String {
    let mut p = p.clone();
    p.servers.sort_by(|a, b| a.id.cmp(&b.id));
    p.snippets.sort_by(|a, b| a.id.cmp(&b.id));
    p.tunnels.sort_by(|a, b| a.id.cmp(&b.id));
    p.identities.sort_by(|a, b| a.id.cmp(&b.id));
    p.desktops.sort_by(|a, b| a.id.cmp(&b.id));
    if let Some(r) = p.registries.as_mut() {
        r.sort_by(|a, b| a.id.cmp(&b.id));
    }
    p.ignored_findings.sort_by(|a, b| (&a.server_id, &a.finding_id).cmp(&(&b.server_id, &b.finding_id)));
    digest(&serde_json::to_vec(&p).unwrap_or_default())
}

fn digest(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Union des deux versions : un élément présent des deux côtés garde sa version locale.
pub(crate) fn merge(remote: &Payload, local: &Payload) -> Payload {
    fn union<T: Clone>(remote: &[T], local: &[T], id: impl Fn(&T) -> &str) -> Vec<T> {
        let mut out = local.to_vec();
        for r in remote {
            if !local.iter().any(|l| id(l) == id(r)) {
                out.push(r.clone());
            }
        }
        out
    }
    let mut known_hosts = remote.known_hosts.clone();
    known_hosts.extend(local.known_hosts.clone());
    Payload {
        servers: union(&remote.servers, &local.servers, |s| &s.id),
        known_hosts,
        snippets: union(&remote.snippets, &local.snippets, |s| &s.id),
        tunnels: union(&remote.tunnels, &local.tunnels, |t| &t.id),
        identities: union(&remote.identities, &local.identities, |i| &i.id),
        desktops: union(&remote.desktops, &local.desktops, |r| &r.id),
        // Un côté qui ne connaît pas les registres (`None`) ne retire rien à l'autre.
        registries: match (&remote.registries, &local.registries) {
            (None, None) => None,
            (r, l) => Some(union(r.as_deref().unwrap_or_default(), l.as_deref().unwrap_or_default(), |x| &x.id)),
        },
        ignored_findings: {
            let mut all = local.ignored_findings.clone();
            for r in &remote.ignored_findings {
                if !all.iter().any(|l| l.server_id == r.server_id && l.finding_id == r.finding_id) {
                    all.push(r.clone());
                }
            }
            all
        },
        secrets: carry_secrets(remote, &local.secrets),
    }
}

/// Secrets à envoyer : ceux de ce PC, complétés par ceux déjà présents à distance (un PC qui ne
/// synchronise pas les secrets ne doit pas effacer ceux envoyés par les autres).
fn carry_secrets(remote: &Payload, local: &BTreeMap<String, BTreeMap<String, String>>) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut out = remote.secrets.clone();
    for (owner, kinds) in local {
        out.entry(owner.clone()).or_default().extend(kinds.clone());
    }
    out
}

/// Remplace les réglages synchronisés par `p` (suppressions comprises) ; l'état de l'interface et
/// le réglage de synchronisation ne bougent pas.
fn apply(store: &Store, p: &Payload, include_secrets: bool) -> Result<(Vec<String>, Vec<String>), String> {
    let (removed_servers, removed_identities, removed_tunnels, removed_desktops, removed_registries) = store.write(|d| {
        let gone = |ids: Vec<String>, keep: &dyn Fn(&str) -> bool| ids.into_iter().filter(|id| !keep(id)).collect::<Vec<_>>();
        let rs = gone(d.servers.iter().map(|s| s.id.clone()).collect(), &|id| p.servers.iter().any(|s| s.id == id));
        let ri = gone(d.identities.iter().map(|i| i.id.clone()).collect(), &|id| p.identities.iter().any(|i| i.id == id));
        let rt = gone(d.tunnels.iter().map(|t| t.id.clone()).collect(), &|id| p.tunnels.iter().any(|t| t.id == id));
        let rd = gone(d.desktops.iter().map(|r| r.id.clone()).collect(), &|id| p.desktops.iter().any(|r| r.id == id));
        // Jamais de serveur à identifiant réservé (il viserait le jeton GitHub, la clé IA…).
        d.servers = p.servers.iter().filter(|s| !export::is_reserved_owner(&s.id)).cloned().collect();
        d.snippets = p.snippets.clone();
        d.tunnels = p.tunnels.clone();
        d.identities = p.identities.clone();
        d.desktops = p.desktops.clone();
        // Contenu d'une version qui ignore les registres : on garde ceux de ce PC tels quels.
        let rr = match &p.registries {
            Some(list) => {
                let gone_ids = gone(d.registries.iter().map(|r| r.id.clone()).collect(), &|id| list.iter().any(|r| r.id == id));
                d.registries = list.clone();
                gone_ids
            }
            None => Vec::new(),
        };
        d.ignored_findings = p.ignored_findings.clone();
        // Seulement les clés des serveurs du contenu, comme à l'import.
        d.known_hosts.extend(export::own_host_keys(p));
        (rs, ri, rt, rd, rr)
    })?;
    for id in &removed_registries {
        secrets::delete_all(&Registry::secret_owner(id));
    }
    for id in &removed_desktops {
        secrets::delete_all(&RemoteDesktop::secret_owner(id));
    }
    for id in removed_servers.iter().filter(|id| !export::is_reserved_owner(id)) {
        secrets::delete_all(id);
        secrets::delete_all(&ServerProfile::provider_owner(id));
    }
    for id in &removed_identities {
        secrets::delete_all(&Identity::secret_owner(id));
    }
    if include_secrets {
        export::store_secrets(p)?;
    }
    Ok((removed_servers, removed_tunnels))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn save_state(store: &Store, rev: u64, hash: String, remote: &str) -> Result<(), String> {
    store.write(|d| {
        if let Some(c) = d.sync.as_mut() {
            c.last_rev = rev;
            c.last_hash = Some(hash);
            c.last_sync = Some(now_ms());
            c.last_remote = Some(digest(remote.as_bytes()));
        }
    })
}

/// Envoie `p` scellé pour la révision `base + 1`, la seule que le transport peut lui donner.
/// `None` : conflit (quelqu'un d'autre a envoyé entre-temps).
fn push_sealed(transport: &dyn Transport, base: u64, p: &Payload, passphrase: &str) -> Result<Option<(u64, String)>, String> {
    let data = export::seal_sync(p, passphrase, base + 1)?;
    match transport.push(base, &data)? {
        PushResult::Ok(rev) if rev == base + 1 => Ok(Some((rev, data))),
        PushResult::Ok(rev) => Err(format!("révision inattendue renvoyée par la synchronisation ({rev} au lieu de {})", base + 1)),
        PushResult::Conflict => Ok(None),
    }
}

/// Synchronise les réglages avec le contenu distant.
pub fn run(store: &Store, transport: &dyn Transport, passphrase: &str) -> Result<Outcome, String> {
    if passphrase.is_empty() {
        return Err("phrase de passe de synchronisation manquante".into());
    }
    let mut removed_servers = Vec::new();
    let mut removed_tunnels = Vec::new();
    // Quelques tentatives : un autre PC peut envoyer entre notre lecture et notre envoi.
    for _ in 0..3 {
        let cfg = store.read(|d| d.sync.clone()).ok_or("synchronisation non configurée")?;
        let local = export::snapshot(store, cfg.include_secrets);
        let local_hash = fingerprint(&local);
        let local_changed = cfg.last_hash.as_deref() != Some(local_hash.as_str());
        let done = |action, rev, rs: Vec<String>, rt: Vec<String>| Outcome { action, rev, removed_servers: rs, removed_tunnels: rt };

        let Some(remote) = transport.fetch()? else {
            // Contenu disparu après une synchronisation : sinon un tiers qui vide le fichier ou le
            // serveur remettrait les révisions à zéro, puis rejouerait d'anciens contenus.
            if cfg.last_rev > 0 {
                return Err(format!(
                    "le contenu de synchronisation a disparu (révision {} attendue) : s'il a été effacé volontairement, désactive puis réactive la synchronisation",
                    cfg.last_rev
                ));
            }
            // Premier envoi.
            match push_sealed(transport, 0, &local, passphrase)? {
                Some((rev, data)) => {
                    save_state(store, rev, local_hash, &data)?;
                    return Ok(done(Action::Pushed, rev, removed_servers, removed_tunnels));
                }
                None => continue,
            }
        };
        let replayed = remote.rev < cfg.last_rev
            || (remote.rev == cfg.last_rev && cfg.last_remote.as_deref().is_some_and(|h| h != digest(remote.data.as_bytes())));
        if replayed {
            return Err("contenu de synchronisation plus ancien que celui déjà reçu (rejoué ?) : refusé".into());
        }
        let (theirs, bound) = export::open_sync(&remote.data, passphrase, remote.rev).map_err(|e| {
            if e.starts_with("mot de passe incorrect") {
                "phrase de passe de synchronisation incorrecte".into()
            } else {
                e
            }
        })?;
        // Un appareil qui a déjà reçu du contenu de version 2 ne revient jamais à la version 1 :
        // sinon un ancien contenu rejoué serait fusionné puis renvoyé comme authentifié.
        if !bound && cfg.last_remote.is_some() {
            return Err(
                "contenu de synchronisation de version 1 refusé : cet appareil a déjà reçu du contenu authentifié (contenu rejoué ?)"
                    .into(),
            );
        }
        let remote_changed = remote.rev != cfg.last_rev;

        // Contenu de version 1 (révision non authentifiée) : fusionné puis renvoyé en version 2,
        // jamais appliqué tel quel (il pourrait être un ancien contenu rejoué).
        match (remote_changed, local_changed || !bound) {
            (false, false) => {
                save_state(store, remote.rev, local_hash, &remote.data)?;
                return Ok(done(Action::UpToDate, remote.rev, removed_servers, removed_tunnels));
            }
            (false, true) => {
                let mut outgoing = local.clone();
                outgoing.secrets = carry_secrets(&theirs, &local.secrets);
                match push_sealed(transport, remote.rev, &outgoing, passphrase)? {
                    Some((rev, data)) => {
                        save_state(store, rev, local_hash, &data)?;
                        return Ok(done(Action::Pushed, rev, removed_servers, removed_tunnels));
                    }
                    None => continue,
                }
            }
            (true, false) => {
                let (rs, rt) = apply(store, &theirs, cfg.include_secrets)?;
                removed_servers.extend(rs);
                removed_tunnels.extend(rt);
                save_state(store, remote.rev, fingerprint(&export::snapshot(store, cfg.include_secrets)), &remote.data)?;
                return Ok(done(Action::Pulled, remote.rev, removed_servers, removed_tunnels));
            }
            (true, true) => {
                let merged = merge(&theirs, &local);
                let (rs, rt) = apply(store, &merged, cfg.include_secrets)?;
                removed_servers.extend(rs);
                removed_tunnels.extend(rt);
                let hash = fingerprint(&export::snapshot(store, cfg.include_secrets));
                match push_sealed(transport, remote.rev, &merged, passphrase)? {
                    Some((rev, data)) => {
                        save_state(store, rev, hash, &data)?;
                        return Ok(done(Action::Merged, rev, removed_servers, removed_tunnels));
                    }
                    None => continue,
                }
            }
        }
    }
    Err("la synchronisation n'a pas abouti : le contenu distant change sans cesse, réessaie dans un instant".into())
}

/// Contenu d'un fichier de synchronisation.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncFile {
    format: String,
    rev: u64,
    updated: i64,
    /// Enveloppe d'export chiffrée.
    data: String,
}

const FILE_FORMAT: &str = "zenytt-sync";

/// Synchronisation par fichier partagé (dossier synchronisé par OneDrive, Dropbox, Syncthing…).
pub struct FileTransport {
    pub path: PathBuf,
}

impl Transport for FileTransport {
    fn fetch(&self) -> Result<Option<Remote>, String> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("lecture de {} : {e}", self.path.display())),
        };
        let f: SyncFile =
            serde_json::from_str(&text).map_err(|_| format!("{} n'est pas un fichier de synchronisation Zenytt", self.path.display()))?;
        if f.format != FILE_FORMAT && f.format != crate::legacy::OLD_SYNC_FORMAT {
            return Err(format!("{} n'est pas un fichier de synchronisation Zenytt", self.path.display()));
        }
        Ok(Some(Remote { rev: f.rev, data: f.data }))
    }

    fn push(&self, base_rev: u64, data: &str) -> Result<PushResult, String> {
        let current = self.fetch()?.map(|r| r.rev).unwrap_or(0);
        if current != base_rev {
            return Ok(PushResult::Conflict);
        }
        let rev = base_rev + 1;
        let json = serde_json::to_string_pretty(&SyncFile { format: FILE_FORMAT.into(), rev, updated: now_ms(), data: data.to_string() })
            .map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| format!("dossier {} : {e}", dir.display()))?;
        }
        // Écriture atomique : le client de synchronisation du dossier ne voit jamais un fichier à moitié écrit.
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("écriture de {} : {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("écriture de {} : {e}", self.path.display()))?;
        Ok(PushResult::Ok(rev))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AuthKind, ServerProfile, Snippet};

    fn server(id: &str) -> ServerProfile {
        ServerProfile {
            id: id.into(),
            name: id.into(),
            host: format!("{id}.exemple"),
            port: 22,
            username: "u".into(),
            auth_kind: AuthKind::Agent,
            key_path: None,
            color: None,
            group: None,
            ai_access: false,
            jump_id: None,
            identity_id: None,
            protocol: Default::default(),
            auto_connect: false,
            provider: None,
        }
    }

    fn store(dir: &std::path::Path) -> Store {
        let s = Store::open(dir);
        s.write(|d| d.sync = Some(SyncConfig { mode: SyncMode::File, ..Default::default() })).unwrap();
        s
    }

    #[test]
    fn two_pcs_converge() {
        let (a_dir, b_dir, shared) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = FileTransport { path: shared.path().join("zenytt-sync.json") };
        let (a, b) = (store(a_dir.path()), store(b_dir.path()));
        let pass = "phrase de passe";

        a.write(|d| d.servers.push(server("vps"))).unwrap();
        assert_eq!(run(&a, &t, pass).unwrap().action, Action::Pushed);
        assert!(!std::fs::read_to_string(&t.path).unwrap().contains("vps.exemple"), "chiffré de bout en bout");

        // B avait déjà ses propres réglages : fusion.
        b.write(|d| d.snippets.push(Snippet { id: "s".into(), name: "ps".into(), command: "ps".into() })).unwrap();
        assert_eq!(run(&b, &t, pass).unwrap().action, Action::Merged);
        assert_eq!(b.read(|d| d.servers.len()), 1);

        // A récupère le snippet de B.
        assert_eq!(run(&a, &t, pass).unwrap().action, Action::Pulled);
        assert_eq!(a.read(|d| d.snippets.len()), 1);
        assert_eq!(run(&a, &t, pass).unwrap().action, Action::UpToDate);

        // Une suppression sur A se propage à B.
        a.write(|d| d.servers.clear()).unwrap();
        assert_eq!(run(&a, &t, pass).unwrap().action, Action::Pushed);
        let out = run(&b, &t, pass).unwrap();
        assert_eq!(out.action, Action::Pulled);
        assert_eq!(out.removed_servers, vec!["vps".to_string()]);
        assert!(b.read(|d| d.servers.is_empty()));

        assert!(run(&b, &t, "mauvaise").unwrap_err().contains("incorrecte"));
    }

    #[test]
    fn apply_ignore_les_serveurs_a_id_reserve() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.write(|d| d.servers.push(server("github"))).unwrap();
        let p = Payload { servers: vec![server("github"), server("vps")], ..Default::default() };
        apply(&s, &p, false).unwrap();
        assert_eq!(s.read(|d| d.servers.iter().map(|x| x.id.clone()).collect::<Vec<_>>()), vec!["vps".to_string()]);
    }

    #[test]
    fn pairing_content_is_sealed_with_the_passphrase() {
        let pairing = Pairing {
            url: None,
            tunnel: Some(SyncTunnel { server_id: "vps".into(), port: 8091 }),
            token: "jeton-secret".into(),
            include_secrets: true,
            server: Some(server("vps")),
            server_secrets: BTreeMap::from([("password".into(), "mdp".into())]),
            server_host_key: Some("SHA256:vps".into()),
        };
        let sealed = export::seal_value(&serde_json::to_value(&pairing).unwrap(), "phrase de passe", PAIRING_FORMAT).unwrap();
        assert!(!sealed.contains("jeton-secret") && !sealed.contains("vps.exemple"), "rien en clair");
        let back: Pairing = serde_json::from_value(export::open_value(&sealed, "phrase de passe", PAIRING_FORMAT).unwrap()).unwrap();
        assert_eq!(back, pairing);
        assert!(export::open_value(&sealed, "autre", PAIRING_FORMAT).unwrap_err().contains("incorrecte"));
        assert!(export::open_value(&sealed, "phrase de passe", "zenytt-export").is_err(), "un autre format est refusé");
        assert!(join(&store(tempfile::tempdir().unwrap().path()), "zenytt-share:abc", "x").unwrap_err().contains("zenytt-pair:"));
    }

    #[test]
    fn stale_push_is_refused() {
        let shared = tempfile::tempdir().unwrap();
        let t = FileTransport { path: shared.path().join("s.json") };
        assert!(matches!(t.push(0, "x").unwrap(), PushResult::Ok(1)));
        assert!(matches!(t.push(0, "y").unwrap(), PushResult::Conflict));
        assert_eq!(t.fetch().unwrap().unwrap().data, "x");
    }

    #[test]
    fn merge_keeps_local_version_and_remote_secrets() {
        let mut remote = Payload { servers: vec![server("a"), server("b")], ..Default::default() };
        remote.secrets.insert("a".into(), BTreeMap::from([("password".into(), "distant".into())]));
        let mut mine = server("a");
        mine.name = "local".into();
        let local = Payload { servers: vec![mine], ..Default::default() };
        let m = merge(&remote, &local);
        assert_eq!(m.servers.len(), 2);
        assert_eq!(m.servers.iter().find(|s| s.id == "a").unwrap().name, "local");
        assert_eq!(m.secrets["a"]["password"], "distant");
        assert_eq!(fingerprint(&m), fingerprint(&Payload { servers: m.servers.iter().rev().cloned().collect(), ..m.clone() }));
    }

    fn write_remote(path: &std::path::Path, rev: u64, data: &str) {
        let f = SyncFile { format: FILE_FORMAT.into(), rev, updated: 0, data: data.into() };
        std::fs::write(path, serde_json::to_string(&f).unwrap()).unwrap();
    }

    #[test]
    fn un_contenu_rejoue_ou_en_clair_est_refuse() {
        let (a_dir, b_dir, shared) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = FileTransport { path: shared.path().join("s.json") };
        let (a, b) = (store(a_dir.path()), store(b_dir.path()));
        let pass = "phrase de passe";
        a.write(|d| d.servers.push(server("ancien"))).unwrap();
        run(&a, &t, pass).unwrap();
        let old = t.fetch().unwrap().unwrap();
        a.write(|d| d.servers = vec![server("nouveau")]).unwrap();
        run(&a, &t, pass).unwrap();
        // Première synchronisation de B : fusion, renvoyée en révision 3.
        assert_eq!(run(&b, &t, pass).unwrap().rev, 3);

        // Ancien contenu (révision 1) servi comme révision 4 : refusé, rien n'est supprimé.
        write_remote(&t.path, 4, &old.data);
        assert!(run(&b, &t, pass).unwrap_err().contains("rejoué"));
        // Ancien contenu sous sa propre révision, plus ancienne que la dernière reçue : refusé.
        write_remote(&t.path, 1, &old.data);
        assert!(run(&b, &t, pass).unwrap_err().contains("rejoué"));
        // Contenu en clair glissé par un tiers : refusé.
        let plain = export::seal(&Payload { servers: vec![server("pirate")], ..Default::default() }, "").unwrap();
        write_remote(&t.path, 4, &plain);
        assert!(run(&b, &t, pass).unwrap_err().contains("non chiffré"));
        // Fichier vidé : pas de remise à zéro silencieuse des révisions.
        std::fs::remove_file(&t.path).unwrap();
        assert!(run(&b, &t, pass).unwrap_err().contains("disparu"));
        assert_eq!(b.read(|d| d.servers.iter().map(|s| s.id.clone()).collect::<Vec<_>>()), vec!["nouveau".to_string()]);
    }

    #[test]
    fn un_contenu_de_version_1_est_fusionne_jamais_applique() {
        let (b_dir, shared) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = FileTransport { path: shared.path().join("s.json") };
        let b = store(b_dir.path());
        let pass = "phrase de passe";
        b.write(|d| d.servers.push(server("mien"))).unwrap();
        // Appareil neuf : n'a jamais reçu de version 2, il peut lire la version 1 une fois.
        // Contenu de version 1 (révision non authentifiée) sans le serveur de B.
        let v1 = export::seal(&Payload { servers: vec![server("autre")], ..Default::default() }, pass)
            .unwrap()
            .replace("\"version\": 2", "\"version\": 1");
        write_remote(&t.path, 1, &v1);
        assert_eq!(run(&b, &t, pass).unwrap().action, Action::Merged);
        assert_eq!(b.read(|d| d.servers.len()), 2, "le serveur local n'est pas supprimé");
        // Renvoyé en version 2 : lié à sa révision.
        let now = t.fetch().unwrap().unwrap();
        assert!(export::open_sync(&now.data, pass, now.rev).unwrap().1);
    }

    #[test]
    fn un_contenu_de_version_1_rejoue_apres_la_version_2_est_refuse() {
        let (b_dir, shared) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = FileTransport { path: shared.path().join("s.json") };
        let b = store(b_dir.path());
        let pass = "phrase de passe";
        b.write(|d| d.servers.push(server("mien"))).unwrap();
        run(&b, &t, pass).unwrap();
        let v1 = export::seal(&Payload { servers: vec![server("ancien")], ..Default::default() }, pass)
            .unwrap()
            .replace("\"version\": 2", "\"version\": 1");
        write_remote(&t.path, 2, &v1);
        assert!(run(&b, &t, pass).unwrap_err().contains("version 1 refusé"));
        assert_eq!(b.read(|d| d.servers.len()), 1);
    }

    #[test]
    fn la_synchronisation_n_approuve_que_les_cles_de_ses_serveurs() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut p = Payload { servers: vec![server("vps")], ..Default::default() };
        p.known_hosts.insert("vps.exemple:22".into(), "SHA256:vps".into());
        p.known_hosts.insert("banque.example:22".into(), "SHA256:piege".into());
        apply(&s, &p, false).unwrap();
        s.read(|d| {
            assert_eq!(d.known_hosts.get("vps.exemple:22").map(String::as_str), Some("SHA256:vps"));
            assert!(!d.known_hosts.contains_key("banque.example:22"));
        });
    }

    #[test]
    fn rejoindre_reprend_la_cle_d_hote_du_serveur_prive() {
        use base64::Engine;
        // Secrets dans un fichier temporaire plutôt que dans le coffre de l'OS.
        let secrets_dir = tempfile::tempdir().unwrap().keep();
        secrets::use_file(secrets_dir.join("secrets.json"));
        let pairing = Pairing {
            url: None,
            tunnel: Some(SyncTunnel { server_id: "vps".into(), port: 8091 }),
            token: "jeton".into(),
            include_secrets: false,
            server: Some(server("vps")),
            server_secrets: BTreeMap::new(),
            server_host_key: Some("SHA256:vps".into()),
        };
        let sealed = export::seal_value(&serde_json::to_value(&pairing).unwrap(), "phrase de passe", PAIRING_FORMAT).unwrap();
        let code = format!("{PAIRING_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(sealed));
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        join(&s, &code, "phrase de passe").unwrap();
        assert_eq!(s.read(|d| d.known_hosts.get("vps.exemple:22").cloned()), Some("SHA256:vps".into()));
    }

    fn registry(id: &str) -> crate::Registry {
        crate::Registry {
            id: id.into(),
            name: id.into(),
            kind: zenytt_core::registry::Kind::Ghcr,
            server: "ghcr.io".into(),
            username: "alice".into(),
        }
    }

    #[test]
    fn an_old_version_never_erases_registries() {
        // Un PC resté sur une version qui ignore les registres envoie un contenu sans ce champ.
        let old = Payload { servers: vec![server("a")], registries: None, ..Default::default() };
        let mine = Payload { registries: Some(vec![registry("r1")]), ..Default::default() };
        let m = merge(&old, &mine);
        assert_eq!(m.registries.as_deref().map(<[_]>::len), Some(1), "la fusion garde les registres locaux");

        // Et l'application d'un tel contenu ne touche pas aux registres déjà enregistrés.
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.write(|d| d.registries.push(registry("r1"))).unwrap();
        apply(&s, &old, false).unwrap();
        assert_eq!(s.read(|d| d.registries.len()), 1, "un contenu sans registres n'efface rien");

        // En revanche, une liste explicitement vide venue d'une version récente est une suppression.
        apply(&s, &Payload { registries: Some(vec![]), ..Default::default() }, false).unwrap();
        assert!(s.read(|d| d.registries.is_empty()));
    }
}
