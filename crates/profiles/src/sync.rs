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

use serde::{Deserialize, Serialize};

use crate::export::{self, Payload};
use crate::{secrets, Identity, Registry, RemoteDesktop, Store};

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
    let pairing = Pairing { url: cfg.url, tunnel: cfg.tunnel, token, include_secrets: cfg.include_secrets, server, server_secrets };
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
    let json = serde_json::to_vec(&p).unwrap_or_default();
    ring::digest::digest(&ring::digest::SHA256, &json).as_ref().iter().map(|b| format!("{b:02x}")).collect()
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
        d.servers = p.servers.clone();
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
        d.known_hosts.extend(p.known_hosts.clone());
        (rs, ri, rt, rd, rr)
    })?;
    for id in &removed_registries {
        secrets::delete_all(&Registry::secret_owner(id));
    }
    for id in &removed_desktops {
        secrets::delete_all(&RemoteDesktop::secret_owner(id));
    }
    for id in &removed_servers {
        secrets::delete_all(id);
    }
    for id in &removed_identities {
        secrets::delete_all(&Identity::secret_owner(id));
    }
    if include_secrets {
        export::store_secrets(&p.secrets)?;
    }
    Ok((removed_servers, removed_tunnels))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn save_state(store: &Store, rev: u64, hash: String) -> Result<(), String> {
    store.write(|d| {
        if let Some(c) = d.sync.as_mut() {
            c.last_rev = rev;
            c.last_hash = Some(hash);
            c.last_sync = Some(now_ms());
        }
    })
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
            // Premier envoi.
            match transport.push(0, &export::seal(&local, passphrase)?)? {
                PushResult::Ok(rev) => {
                    save_state(store, rev, local_hash)?;
                    return Ok(done(Action::Pushed, rev, removed_servers, removed_tunnels));
                }
                PushResult::Conflict => continue,
            }
        };
        let theirs = export::open(&remote.data, passphrase).map_err(|e| {
            if e.starts_with("mot de passe incorrect") {
                "phrase de passe de synchronisation incorrecte".into()
            } else {
                e
            }
        })?;
        let remote_changed = remote.rev != cfg.last_rev;

        match (remote_changed, local_changed) {
            (false, false) => {
                save_state(store, remote.rev, local_hash)?;
                return Ok(done(Action::UpToDate, remote.rev, removed_servers, removed_tunnels));
            }
            (false, true) => {
                let mut outgoing = local.clone();
                outgoing.secrets = carry_secrets(&theirs, &local.secrets);
                match transport.push(remote.rev, &export::seal(&outgoing, passphrase)?)? {
                    PushResult::Ok(rev) => {
                        save_state(store, rev, local_hash)?;
                        return Ok(done(Action::Pushed, rev, removed_servers, removed_tunnels));
                    }
                    PushResult::Conflict => continue,
                }
            }
            (true, false) => {
                let (rs, rt) = apply(store, &theirs, cfg.include_secrets)?;
                removed_servers.extend(rs);
                removed_tunnels.extend(rt);
                save_state(store, remote.rev, fingerprint(&export::snapshot(store, cfg.include_secrets)))?;
                return Ok(done(Action::Pulled, remote.rev, removed_servers, removed_tunnels));
            }
            (true, true) => {
                let merged = merge(&theirs, &local);
                let (rs, rt) = apply(store, &merged, cfg.include_secrets)?;
                removed_servers.extend(rs);
                removed_tunnels.extend(rt);
                let hash = fingerprint(&export::snapshot(store, cfg.include_secrets));
                match transport.push(remote.rev, &export::seal(&merged, passphrase)?)? {
                    PushResult::Ok(rev) => {
                        save_state(store, rev, hash)?;
                        return Ok(done(Action::Merged, rev, removed_servers, removed_tunnels));
                    }
                    PushResult::Conflict => continue,
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
    fn pairing_content_is_sealed_with_the_passphrase() {
        let pairing = Pairing {
            url: None,
            tunnel: Some(SyncTunnel { server_id: "vps".into(), port: 8091 }),
            token: "jeton-secret".into(),
            include_secrets: true,
            server: Some(server("vps")),
            server_secrets: BTreeMap::from([("password".into(), "mdp".into())]),
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
