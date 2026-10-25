//! Export et import des réglages de Zenytt (profils, clés d'hôte approuvées, snippets, tunnels),
//! pour changer de PC ou garder une copie de secours.
//!
//! Le fichier est chiffré (AES-256-GCM, clé dérivée du mot de passe par PBKDF2-SHA256) dès qu'un
//! mot de passe est fourni ; les secrets du coffre (mots de passe SSH, passphrases, sudo, restic)
//! ne peuvent être inclus que dans un fichier chiffré.

use std::collections::BTreeMap;
use std::num::NonZeroU32;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::{secrets, Identity, IgnoredFinding, Registry, RemoteDesktop, ServerProfile, Snippet, Store, TunnelDef};

const FORMAT: &str = "zenytt-export";

/// Format reconnu à la lecture : l'actuel ou celui des versions précédentes. Il sert aussi de
/// donnée authentifiée du chiffrement, d'où l'emploi du format lu pour déchiffrer.
fn known_format(format: &str) -> bool {
    format == FORMAT || format == crate::legacy::OLD_EXPORT_FORMAT
}
/// Version écrite des exports et du contenu synchronisé. La 2 ajoute `protocol` et `provider` aux
/// serveurs : une version qui ne lit que la 1 refuse le fichier au lieu de les perdre en silence
/// puis de les renvoyer effacés par la synchronisation.
const VERSION: u32 = 2;
const ITERATIONS: u32 = 600_000;
pub(crate) const SECRET_KINDS: &[&str] =
    &["password", "passphrase", "sudo", "restic", "token", "ovh-app-key", "ovh-app-secret", "ovh-consumer-key"];

/// Réglages transportés par un export ou une synchronisation. Les tables sont triées
/// (`BTreeMap`) : deux contenus identiques donnent le même JSON, donc la même empreinte.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Payload {
    pub servers: Vec<ServerProfile>,
    pub known_hosts: BTreeMap<String, String>,
    pub snippets: Vec<Snippet>,
    pub tunnels: Vec<TunnelDef>,
    /// Banque d'identifiants (absente des exports antérieurs).
    #[serde(default)]
    pub identities: Vec<Identity>,
    /// Bureaux à distance (absents des exports antérieurs).
    #[serde(default)]
    pub desktops: Vec<RemoteDesktop>,
    /// Registres privés. `None` signifie « contenu venu d'une version de Zenytt qui ne les connaît
    /// pas » — à distinguer d'une liste vide : sans cette nuance, un PC resté sur une ancienne
    /// version effacerait les registres de tous les autres à sa première synchronisation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registries: Option<Vec<Registry>>,
    /// Constats d'audit ignorés.
    #[serde(default)]
    pub ignored_findings: Vec<IgnoredFinding>,
    /// `id du serveur` (ou `identity-<id>`) → (`type de secret` → valeur). Vide si les secrets ne
    /// sont pas exportés.
    #[serde(default)]
    pub secrets: BTreeMap<String, BTreeMap<String, String>>,
}

/// Réglages actuels, avec les secrets du coffre si demandé.
pub(crate) fn snapshot(store: &Store, include_secrets: bool) -> Payload {
    let mut payload = store.read(|d| Payload {
        servers: d.servers.clone(),
        known_hosts: d.known_hosts.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        snippets: d.snippets.clone(),
        tunnels: d.tunnels.clone(),
        identities: d.identities.clone(),
        desktops: d.desktops.clone(),
        registries: Some(d.registries.clone()),
        ignored_findings: d.ignored_findings.clone(),
        secrets: BTreeMap::new(),
    });
    if include_secrets {
        let owners: Vec<String> = payload
            .servers
            .iter()
            .filter(|s| !is_reserved_owner(&s.id))
            .map(|s| s.id.clone())
            .chain(
                payload
                    .servers
                    .iter()
                    .filter(|s| !is_reserved_owner(&s.id) && s.provider.is_some())
                    .map(|s| ServerProfile::provider_owner(&s.id)),
            )
            .chain(payload.identities.iter().map(|i| Identity::secret_owner(&i.id)))
            .chain(payload.desktops.iter().map(|r| RemoteDesktop::secret_owner(&r.id)))
            .chain(payload.registries.iter().flatten().map(|r| Registry::secret_owner(&r.id)))
            .collect();
        for owner in owners {
            let found: BTreeMap<String, String> =
                SECRET_KINDS.iter().filter_map(|k| secrets::get(&owner, k).map(|v| (k.to_string(), v))).collect();
            if !found.is_empty() {
                payload.secrets.insert(owner, found);
            }
        }
    }
    payload
}

/// Un identifiant de serveur qui imiterait un propriétaire réservé (`sync`, `identity-…`) n'ouvre aucun droit.
/// `github` (jeton de la page GitHub) et `ai` (clé de l'assistant) sont propres à ce poste.
pub(crate) fn is_reserved_owner(id: &str) -> bool {
    [crate::sync::SECRET_OWNER, secrets::GITHUB_OWNER, "ai"].contains(&id)
        || ["provider-", "identity-", "rdp-", "registry-"].iter().any(|p| id.starts_with(p))
}

/// Propriétaires de secrets que ce contenu a le droit de renseigner : ses propres éléments.
/// Jamais `sync` ni un autre propriétaire réservé : un export piégé ne doit pas pouvoir remplacer
/// le jeton de synchronisation ni les secrets d'un élément absent du contenu.
fn own_owners(p: &Payload) -> Vec<String> {
    p.servers
        .iter()
        .filter(|s| !is_reserved_owner(&s.id))
        .flat_map(|s| [s.id.clone(), ServerProfile::provider_owner(&s.id)])
        .chain(p.identities.iter().map(|i| Identity::secret_owner(&i.id)))
        .chain(p.desktops.iter().map(|r| RemoteDesktop::secret_owner(&r.id)))
        .chain(p.registries.iter().flatten().map(|r| Registry::secret_owner(&r.id)))
        .collect()
}

/// Empreintes de clé d'hôte du contenu, limitées aux adresses (`hôte:port`) de ses propres serveurs :
/// un contenu reçu ne pré-approuve jamais la clé d'un hôte qu'il n'apporte pas.
pub(crate) fn own_host_keys(p: &Payload) -> BTreeMap<String, String> {
    let hosts: Vec<String> = p.servers.iter().map(|s| format!("{}:{}", s.host, s.port)).collect();
    p.known_hosts.iter().filter(|(k, _)| hosts.contains(k)).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Enregistre dans le coffre les secrets d'un export (types connus et propriétaires du contenu uniquement).
pub(crate) fn store_secrets(p: &Payload) -> Result<(), String> {
    store_owned_secrets(&p.secrets, &own_owners(p))
}

fn store_owned_secrets(from: &BTreeMap<String, BTreeMap<String, String>>, owners: &[String]) -> Result<(), String> {
    for (owner, kinds) in from.iter().filter(|(o, _)| owners.contains(o)) {
        for (kind, value) in kinds {
            if SECRET_KINDS.contains(&kind.as_str()) {
                secrets::set(owner, kind, value)?;
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format: String,
    version: u32,
    encrypted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    /// Contenu synchronisé (version 2) : révision pour laquelle il a été scellé, authentifiée avec
    /// lui (voir [`sync_aad`]) ; absente d'un export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rev: Option<u64>,
    /// JSON en clair, ou chiffré puis encodé en base64.
    data: serde_json::Value,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub servers: usize,
    pub identities: usize,
    pub snippets: usize,
    pub tunnels: usize,
    pub secrets: usize,
    /// Serveurs reçus avec l'identifiant d'un serveur existant mais une autre adresse : importés
    /// comme nouveaux serveurs plutôt que de rediriger l'existant (et ses secrets) ailleurs.
    pub duplicated: usize,
    /// Empreintes de clé d'hôte reçues qui contredisaient une empreinte déjà approuvée : ignorées.
    pub host_keys_kept: usize,
    /// Bureaux à distance et registres reçus avec l'identifiant d'un élément existant mais une
    /// autre adresse : ajoutés à côté, pour la même raison que `duplicated`.
    pub duplicated_other: usize,
    /// Liens vers un de tes identifiants (banque) retirés : le contenu reçu s'en servait sans en
    /// fournir le secret, donc avec ton mot de passe, vers une adresse que tu n'avais pas.
    pub identity_links_removed: usize,
    /// Bureaux à distance ou registres reçus invalides (identifiant, adresse…) : ignorés.
    pub rejected: usize,
}

fn key(password: &str, salt: &[u8], iterations: u32) -> Result<LessSafeKey, String> {
    let mut k = [0u8; 32];
    // Nombre lu dans l'enveloppe : borné, sinon un fichier piégé (`u32::MAX`) bloquerait l'app des heures.
    if !(ITERATIONS..=ITERATIONS * 8).contains(&iterations) {
        return Err("paramètres de chiffrement invalides".into());
    }
    let iterations = NonZeroU32::new(iterations).ok_or("paramètres de chiffrement invalides")?;
    ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, iterations, salt, password.as_bytes(), &mut k);
    Ok(LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &k).map_err(|_| "clé invalide")?))
}

/// Contenu du fichier d'export. `password` vide : export en clair, sans secrets.
pub fn export(store: &Store, password: &str, include_secrets: bool) -> Result<String, String> {
    if include_secrets && password.is_empty() {
        return Err("un mot de passe est obligatoire pour exporter les secrets".into());
    }
    seal(&snapshot(store, include_secrets), password)
}

/// Enveloppe d'export d'un contenu : chiffrée si `password` n'est pas vide.
pub(crate) fn seal(payload: &Payload, password: &str) -> Result<String, String> {
    seal_with(payload, password, None)
}

/// Donnée authentifiée d'un contenu synchronisé : le format et la révision. Rejouer un ancien
/// contenu sous une révision plus récente casse donc le déchiffrement.
fn sync_aad(format: &str, rev: u64) -> Vec<u8> {
    format!("{format}#rev={rev}").into_bytes()
}

/// Enveloppe d'un contenu synchronisé, toujours chiffrée et liée à la révision `rev` qu'il prendra.
pub(crate) fn seal_sync(payload: &Payload, password: &str, rev: u64) -> Result<String, String> {
    if password.is_empty() {
        return Err("phrase de passe de synchronisation manquante".into());
    }
    seal_with(payload, password, Some(rev))
}

fn seal_with(payload: &Payload, password: &str, rev: Option<u64>) -> Result<String, String> {
    let json = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let envelope = if password.is_empty() {
        Envelope {
            format: FORMAT.into(),
            version: VERSION,
            encrypted: false,
            iterations: None,
            salt: None,
            nonce: None,
            rev: None,
            data: serde_json::from_slice(&json).map_err(|e| e.to_string())?,
        }
    } else {
        let rng = SystemRandom::new();
        let (mut salt, mut nonce) = ([0u8; 16], [0u8; 12]);
        rng.fill(&mut salt).map_err(|_| "aléa indisponible")?;
        rng.fill(&mut nonce).map_err(|_| "aléa indisponible")?;
        let mut sealed = json;
        let aad = rev.map_or_else(|| FORMAT.as_bytes().to_vec(), |r| sync_aad(FORMAT, r));
        key(password, &salt, ITERATIONS)?
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut sealed)
            .map_err(|_| "chiffrement impossible")?;
        Envelope {
            format: FORMAT.into(),
            version: VERSION,
            encrypted: true,
            iterations: Some(ITERATIONS),
            salt: Some(B64.encode(salt)),
            nonce: Some(B64.encode(nonce)),
            rev,
            data: serde_json::Value::String(B64.encode(sealed)),
        }
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

/// Chiffre un contenu JSON quelconque avec un mot de passe : même enveloppe et même chiffrement
/// que l'export, sous un autre `format` (qui sert aussi de donnée authentifiée).
pub(crate) fn seal_value(value: &serde_json::Value, password: &str, format: &str) -> Result<String, String> {
    let rng = SystemRandom::new();
    let (mut salt, mut nonce) = ([0u8; 16], [0u8; 12]);
    rng.fill(&mut salt).map_err(|_| "aléa indisponible")?;
    rng.fill(&mut nonce).map_err(|_| "aléa indisponible")?;
    let mut sealed = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    key(password, &salt, ITERATIONS)?
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(format), &mut sealed)
        .map_err(|_| "chiffrement impossible")?;
    let envelope = Envelope {
        format: format.into(),
        version: 1,
        encrypted: true,
        iterations: Some(ITERATIONS),
        salt: Some(B64.encode(salt)),
        nonce: Some(B64.encode(nonce)),
        rev: None,
        data: serde_json::Value::String(B64.encode(sealed)),
    };
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

/// Inverse de [`seal_value`] ; refuse une enveloppe d'un autre format.
pub(crate) fn open_value(text: &str, password: &str, format: &str) -> Result<serde_json::Value, String> {
    let bad = || "contenu chiffré illisible".to_string();
    let e: Envelope = serde_json::from_str(text).map_err(|_| bad())?;
    if e.format != format || e.version != 1 || !e.encrypted {
        return Err(bad());
    }
    let salt = B64.decode(e.salt.ok_or_else(bad)?).map_err(|_| bad())?;
    let nonce: [u8; 12] = B64.decode(e.nonce.ok_or_else(bad)?).map_err(|_| bad())?.try_into().map_err(|_| bad())?;
    let mut data = B64.decode(e.data.as_str().ok_or_else(bad)?).map_err(|_| bad())?;
    let plain = key(password, &salt, e.iterations.unwrap_or(ITERATIONS))?
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(format), &mut data)
        .map_err(|_| "phrase de passe incorrecte (ou code modifié)".to_string())?;
    serde_json::from_slice(plain).map_err(|_| bad())
}

/// Préfixe d'un partage transmis sous forme de texte (à coller dans une conversation).
pub const SHARE_PREFIX: &str = "zenytt-share:";

/// Partage d'une sélection de serveurs : leurs identifiants de la banque, les clés d'hôte
/// approuvées correspondantes et, si demandé, leurs secrets. Toujours chiffré.
pub fn share(store: &Store, ids: &[String], password: &str, include_secrets: bool) -> Result<String, String> {
    if password.is_empty() {
        return Err("choisis un mot de passe : un partage est toujours chiffré".into());
    }
    let full = snapshot(store, include_secrets);
    // Les serveurs de rebond d'un serveur partagé le suivent, sinon il serait inutilisable.
    let mut wanted: Vec<String> = ids.to_vec();
    let mut i = 0;
    while i < wanted.len() {
        if let Ok(chain) = store.jump_chain(&wanted[i]) {
            for j in chain {
                if !wanted.contains(&j) {
                    wanted.push(j);
                }
            }
        }
        i += 1;
    }
    // Le compte chez l'hébergeur reste personnel : il n'est pas partagé.
    let servers: Vec<ServerProfile> =
        full.servers.into_iter().filter(|s| wanted.contains(&s.id)).map(|s| ServerProfile { provider: None, ..s }).collect();
    if servers.is_empty() {
        return Err("aucun serveur à partager".into());
    }
    let hosts: Vec<String> = servers.iter().map(|s| format!("{}:{}", s.host, s.port)).collect();
    let identity_ids: Vec<String> = servers.iter().filter_map(|s| s.identity_id.clone()).collect();
    let owners: Vec<String> = servers.iter().map(|s| s.id.clone()).chain(identity_ids.iter().map(|i| Identity::secret_owner(i))).collect();
    let payload = Payload {
        known_hosts: full.known_hosts.into_iter().filter(|(k, _)| hosts.contains(k)).collect(),
        identities: full.identities.into_iter().filter(|i| identity_ids.contains(&i.id)).collect(),
        secrets: full.secrets.into_iter().filter(|(owner, _)| owners.contains(owner)).collect(),
        servers,
        snippets: vec![],
        tunnels: vec![],
        desktops: vec![],
        registries: None,
        ignored_findings: vec![],
    };
    seal(&payload, password)
}

/// Partage sous forme de code d'une seule ligne, à coller dans une conversation.
pub fn to_code(text: &str) -> String {
    format!("{SHARE_PREFIX}{}", B64.encode(text.as_bytes()))
}

/// Texte d'un partage reçu : code d'une ligne ou contenu de fichier, indifféremment.
pub fn from_code(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let Some(code) = trimmed.strip_prefix(SHARE_PREFIX).or_else(|| trimmed.strip_prefix(crate::legacy::OLD_SHARE_PREFIX)) else {
        return Ok(trimmed.to_string());
    };
    let bytes = B64.decode(code.trim().as_bytes()).map_err(|_| "ce code de partage est incomplet ou abîmé".to_string())?;
    String::from_utf8(bytes).map_err(|_| "ce code de partage est illisible".into())
}

/// Le fichier est-il chiffré (faut-il demander un mot de passe) ?
pub fn is_encrypted(text: &str) -> Result<bool, String> {
    let e: Envelope = serde_json::from_str(text).map_err(|_| "ce fichier n'est pas un export de Zenytt")?;
    if !known_format(&e.format) {
        return Err("ce fichier n'est pas un export de Zenytt".into());
    }
    Ok(e.encrypted)
}

fn parse(text: &str) -> Result<Envelope, String> {
    let e: Envelope = serde_json::from_str(text).map_err(|_| "ce fichier n'est pas un export de Zenytt")?;
    if !known_format(&e.format) || !(1..=VERSION).contains(&e.version) {
        return Err("format d'export inconnu (fichier d'une version plus récente de Zenytt ?)".into());
    }
    Ok(e)
}

/// Export ou partage (fichier, code). L'export en clair reste accepté : il ne porte aucun secret et
/// passe par les garde-fous de [`import`], comme un export chiffré par quelqu'un d'autre.
pub(crate) fn open(text: &str, password: &str) -> Result<Payload, String> {
    let e = parse(text)?;
    if !e.encrypted {
        return serde_json::from_value(e.data).map_err(|err| format!("export illisible : {err}"));
    }
    let aad = e.format.clone().into_bytes();
    decrypt(e, password, &aad)
}

/// Contenu synchronisé reçu à la révision `rev`. Toujours chiffré : quiconque peut écrire dans le
/// fichier ou sur le serveur pourrait sinon y glisser des serveurs ou des clés d'hôte. Renvoie
/// aussi si la révision est authentifiée : un contenu de version 1 (écrit avant cette protection)
/// ne l'est pas, et ne doit qu'être fusionné, jamais appliqué tel quel.
pub(crate) fn open_sync(text: &str, password: &str, rev: u64) -> Result<(Payload, bool), String> {
    let e = parse(text)?;
    if !e.encrypted {
        return Err("contenu de synchronisation non chiffré : refusé (modifié par un tiers ?)".into());
    }
    if e.version == 1 {
        let aad = e.format.clone().into_bytes();
        return Ok((decrypt(e, password, &aad)?, false));
    }
    if e.rev != Some(rev) {
        return Err("révision du contenu de synchronisation incohérente : contenu rejoué ou modifié, refusé".into());
    }
    let aad = sync_aad(&e.format, rev);
    Ok((decrypt(e, password, &aad)?, true))
}

fn decrypt(e: Envelope, password: &str, aad: &[u8]) -> Result<Payload, String> {
    let bad = || "export chiffré illisible".to_string();
    let salt = B64.decode(e.salt.ok_or_else(bad)?).map_err(|_| bad())?;
    let nonce: [u8; 12] = B64.decode(e.nonce.ok_or_else(bad)?).map_err(|_| bad())?.try_into().map_err(|_| bad())?;
    let mut data = B64.decode(e.data.as_str().ok_or_else(bad)?).map_err(|_| bad())?;
    let plain = key(password, &salt, e.iterations.unwrap_or(ITERATIONS))?
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut data)
        .map_err(|_| "mot de passe incorrect (ou fichier modifié)".to_string())?;
    serde_json::from_slice(plain).map_err(|err| format!("export illisible : {err}"))
}

/// Fusionne un export dans la configuration : un élément de même identifiant est remplacé,
/// les autres sont ajoutés. Rien n'est supprimé.
///
/// Un fichier ou un code de partage vient potentiellement de quelqu'un d'autre, d'où deux règles :
/// - une empreinte de clé d'hôte déjà approuvée n'est jamais remplacée (sinon un partage piégé
///   ferait accepter la clé d'un serveur intercepté) ;
/// - un serveur reçu avec l'identifiant d'un serveur existant mais une autre adresse devient un
///   nouveau serveur : remplacer l'existant enverrait ses mots de passe (rangés par identifiant
///   dans le coffre) vers l'adresse reçue à la connexion suivante.
pub fn import(store: &Store, text: &str, password: &str) -> Result<ImportSummary, String> {
    let mut p = open(text, password)?;
    // Un serveur dont l'id imite un propriétaire réservé est écarté.
    p.servers.retain(|s| !is_reserved_owner(&s.id));
    let rejected = drop_invalid(&mut p);
    let duplicated = store.read(|d| rekey_conflicting_servers(&mut p, &d.servers));
    let duplicated_other = store.read(|d| rekey_conflicting_others(&mut p, &d.desktops, &d.registries));
    let identity_links_removed = store.read(|d| protect_identities(&mut p, d));
    p.known_hosts = own_host_keys(&p);
    let host_keys_kept = store.read(|d| p.known_hosts.iter().filter(|(k, v)| d.known_hosts.get(*k).is_some_and(|mine| mine != *v)).count());
    let summary = ImportSummary {
        servers: p.servers.len(),
        identities: p.identities.len(),
        snippets: p.snippets.len(),
        tunnels: p.tunnels.len(),
        secrets: p.secrets.values().map(BTreeMap::len).sum(),
        duplicated,
        host_keys_kept,
        duplicated_other,
        identity_links_removed,
        rejected,
    };
    let (owners, secrets) = (own_owners(&p), std::mem::take(&mut p.secrets));
    store.write(|d| {
        fn merge<T>(into: &mut Vec<T>, from: Vec<T>, id: impl Fn(&T) -> &str) {
            for item in from {
                match into.iter_mut().find(|x| id(x) == id(&item)) {
                    Some(existing) => *existing = item,
                    None => into.push(item),
                }
            }
        }
        merge(&mut d.servers, p.servers, |s| &s.id);
        merge(&mut d.snippets, p.snippets, |s| &s.id);
        merge(&mut d.tunnels, p.tunnels, |t| &t.id);
        merge(&mut d.identities, p.identities, |i| &i.id);
        merge(&mut d.desktops, p.desktops, |r| &r.id);
        merge(&mut d.registries, p.registries.unwrap_or_default(), |r| &r.id);
        for item in p.ignored_findings {
            if !d.ignored_findings.iter().any(|x| x.server_id == item.server_id && x.finding_id == item.finding_id) {
                d.ignored_findings.push(item);
            }
        }
        for (host, fingerprint) in p.known_hosts {
            d.known_hosts.entry(host).or_insert(fingerprint);
        }
    })?;
    store_owned_secrets(&secrets, &owners)?;
    Ok(summary)
}

/// Donne un nouvel identifiant à chaque serveur reçu qui porte celui d'un serveur existant avec
/// une autre adresse (hôte, port ou utilisateur), et reporte ce changement partout où l'identifiant
/// sert de référence dans le contenu reçu. Renvoie le nombre de serveurs concernés.
fn rekey_conflicting_servers(p: &mut Payload, existing: &[ServerProfile]) -> usize {
    let same_target =
        |a: &ServerProfile, b: &ServerProfile| a.host.eq_ignore_ascii_case(&b.host) && a.port == b.port && a.username == b.username;
    let mut renamed: Vec<(String, String)> = Vec::new();
    for s in &mut p.servers {
        if existing.iter().any(|e| e.id == s.id && !same_target(e, s)) {
            let new_id = fresh_id();
            renamed.push((std::mem::replace(&mut s.id, new_id.clone()), new_id));
        }
    }
    for (old, new) in &renamed {
        let swap = |r: &mut Option<String>| {
            if r.as_deref() == Some(old.as_str()) {
                *r = Some(new.clone());
            }
        };
        for s in &mut p.servers {
            swap(&mut s.jump_id);
        }
        for d in &mut p.desktops {
            swap(&mut d.via_server_id);
        }
        for t in p.tunnels.iter_mut().filter(|t| &t.server_id == old) {
            t.server_id = new.clone();
        }
        for f in p.ignored_findings.iter_mut().filter(|f| &f.server_id == old) {
            f.server_id = new.clone();
        }
        for (from, to) in [(old.clone(), new.clone()), (ServerProfile::provider_owner(old), ServerProfile::provider_owner(new))] {
            if let Some(secrets) = p.secrets.remove(&from) {
                p.secrets.insert(to, secrets);
            }
        }
    }
    renamed.len()
}

/// Écarte les bureaux à distance et registres reçus qui ne passeraient pas le formulaire de l'app
/// (voir [`RemoteDesktop::is_valid`]), avec leurs secrets. Renvoie le nombre d'éléments écartés.
fn drop_invalid(p: &mut Payload) -> usize {
    let mut dropped: Vec<String> = p.desktops.iter().filter(|r| !r.is_valid()).map(|r| RemoteDesktop::secret_owner(&r.id)).collect();
    p.desktops.retain(RemoteDesktop::is_valid);
    if let Some(list) = p.registries.as_mut() {
        dropped.extend(list.iter().filter(|r| !r.is_valid()).map(|r| Registry::secret_owner(&r.id)));
        list.retain(Registry::is_valid);
    }
    for owner in &dropped {
        p.secrets.remove(owner);
    }
    dropped.len()
}

/// Même règle que [`rekey_conflicting_servers`] pour les bureaux à distance et les registres : leur
/// mot de passe ou jeton est rangé sous leur identifiant, et remplacer l'existant l'enverrait vers
/// l'adresse reçue à la prochaine ouverture (ou au prochain `docker login`).
fn rekey_conflicting_others(p: &mut Payload, desktops: &[RemoteDesktop], registries: &[Registry]) -> usize {
    let mut count = 0;
    for r in &mut p.desktops {
        let moved = desktops
            .iter()
            .any(|e| e.id == r.id && !(e.host.eq_ignore_ascii_case(&r.host) && e.port == r.port && e.username == r.username));
        if moved {
            let new_id = fresh_id();
            if let Some(s) = p.secrets.remove(&RemoteDesktop::secret_owner(&r.id)) {
                p.secrets.insert(RemoteDesktop::secret_owner(&new_id), s);
            }
            r.id = new_id;
            count += 1;
        }
    }
    for r in p.registries.iter_mut().flatten() {
        let moved = registries.iter().any(|e| e.id == r.id && !(e.server.eq_ignore_ascii_case(&r.server) && e.username == r.username));
        if moved {
            let new_id = fresh_id();
            if let Some(s) = p.secrets.remove(&Registry::secret_owner(&r.id)) {
                p.secrets.insert(Registry::secret_owner(&new_id), s);
            }
            r.id = new_id;
            count += 1;
        }
    }
    count
}

/// Un identifiant de la banque porte un utilisateur et un mot de passe, sans adresse : ce sont
/// les serveurs et bureaux qui le référencent qui décident où ce mot de passe part. Un contenu
/// reçu qui référence un de TES identifiants sans en fournir le secret utiliserait donc ton mot de
/// passe vers ses adresses à lui. Dans ce cas :
/// - l'identifiant local n'est pas modifié (le reçu est ignoré) ;
/// - le lien est retiré, sauf s'il existait déjà à l'identique chez toi (réimport du même serveur).
///
/// Renvoie le nombre de liens retirés.
fn protect_identities(p: &mut Payload, d: &crate::Data) -> usize {
    let carried = |id: &str, p: &Payload| p.secrets.contains_key(&Identity::secret_owner(id));
    let borrowed: Vec<String> = d.identities.iter().map(|i| i.id.clone()).filter(|id| !carried(id, p)).collect();
    p.identities.retain(|i| !borrowed.contains(&i.id));

    let mut removed = 0;
    for s in &mut p.servers {
        let Some(id) = s.identity_id.clone().filter(|id| borrowed.contains(id)) else { continue };
        let known = d.servers.iter().any(|e| {
            e.id == s.id && e.identity_id.as_deref() == Some(id.as_str()) && e.host.eq_ignore_ascii_case(&s.host) && e.port == s.port
        });
        if !known {
            s.identity_id = None;
            removed += 1;
        }
    }
    for r in &mut p.desktops {
        let Some(id) = r.identity_id.clone().filter(|id| borrowed.contains(id)) else { continue };
        let known = d.desktops.iter().any(|e| {
            e.id == r.id && e.identity_id.as_deref() == Some(id.as_str()) && e.host.eq_ignore_ascii_case(&r.host) && e.port == r.port
        });
        if !known {
            r.identity_id = None;
            removed += 1;
        }
    }
    removed
}

/// Identifiant aléatoire au format UUID v4, comme ceux créés par l'app.
fn fresh_id() -> String {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut b).expect("générateur aléatoire du système indisponible");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AuthKind, Data};

    /// Un export chiffré par une version précédente (autre format, donc autre donnée authentifiée)
    /// reste lisible, qu'il vienne d'un fichier, d'un code de partage ou de la synchronisation.
    #[test]
    fn export_d_une_version_precedente() {
        let old = crate::legacy::OLD_EXPORT_FORMAT;
        let payload = serde_json::to_vec(&Payload::default()).unwrap();
        let (salt, nonce) = ([7u8; 16], [9u8; 12]);
        let mut sealed = payload;
        key("secret", &salt, ITERATIONS)
            .unwrap()
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(old), &mut sealed)
            .unwrap();
        let text = serde_json::to_string(&Envelope {
            format: old.into(),
            version: 1,
            encrypted: true,
            iterations: Some(ITERATIONS),
            salt: Some(B64.encode(salt)),
            nonce: Some(B64.encode(nonce)),
            rev: None,
            data: serde_json::Value::String(B64.encode(sealed)),
        })
        .unwrap();
        assert_eq!(is_encrypted(&text), Ok(true));
        assert!(open(&text, "secret").is_ok());
        assert!(open(&text, "autre").is_err());
        let code = format!("{}{}", crate::legacy::OLD_SHARE_PREFIX, B64.encode(text.as_bytes()));
        assert_eq!(from_code(&code).unwrap(), text);
    }

    fn store_with_server(dir: &std::path::Path) -> Store {
        let s = Store::open(dir);
        s.write(|d| {
            d.servers.push(ServerProfile {
                id: "a".into(),
                name: "VPS".into(),
                host: "h".into(),
                port: 22,
                username: "u".into(),
                auth_kind: AuthKind::Key,
                key_path: Some("C:/cle.ppk".into()),
                color: None,
                group: None,
                ai_access: false,
                jump_id: None,
                identity_id: None,
                protocol: Default::default(),
                auto_connect: false,
                provider: None,
            });
            d.known_hosts.insert("h:22".into(), "SHA256:x".into());
        })
        .unwrap();
        s
    }

    #[test]
    fn encrypted_round_trip() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let text = export(&store_with_server(a.path()), "mot de passe", false).unwrap();
        assert!(is_encrypted(&text).unwrap());
        assert!(!text.contains("VPS") && !text.contains("cle.ppk"), "rien n'est lisible en clair");
        assert!(import(&Store::open(b.path()), &text, "mauvais").is_err());
        let target = Store::open(b.path());
        assert_eq!(import(&target, &text, "mot de passe").unwrap().servers, 1);
        assert_eq!(target.read(|d| d.known_hosts.get("h:22").cloned()), Some("SHA256:x".into()));
    }

    #[test]
    fn share_selection_and_code() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = store_with_server(a.path());
        source
            .write(|d| {
                let mut other = d.servers[0].clone();
                other.id = "b".into();
                other.name = "Autre".into();
                other.host = "autre".into();
                d.servers.push(other);
                d.snippets.push(Snippet { id: "s".into(), name: "n".into(), command: "ls".into() });
            })
            .unwrap();
        assert!(share(&source, &[], "mot de passe long", false).is_err(), "sélection vide");
        assert!(share(&source, &["a".into()], "", false).is_err(), "mot de passe obligatoire");
        let code = to_code(&share(&source, &["a".into()], "mot de passe long", false).unwrap());
        assert!(code.starts_with(SHARE_PREFIX) && !code.contains('\n'), "une seule ligne à coller");

        let target = Store::open(b.path());
        let summary = import(&target, &from_code(&code).unwrap(), "mot de passe long").unwrap();
        assert_eq!((summary.servers, summary.snippets), (1, 0), "seul le serveur choisi est partagé");
        assert_eq!(target.read(|d| d.servers[0].name.clone()), "VPS");
        assert_eq!(target.read(|d| d.known_hosts.len()), 1);
        assert!(from_code("zenytt-share:pas du base64 !").is_err());
    }

    #[test]
    fn plain_export_and_merge() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let text = export(&store_with_server(a.path()), "", false).unwrap();
        assert!(!is_encrypted(&text).unwrap());
        assert!(export(&store_with_server(a.path()), "", true).is_err(), "secrets interdits en clair");
        let target = store_with_server(b.path());
        import(&target, &text, "").unwrap();
        assert_eq!(target.read(|d| d.servers.len()), 1, "même identifiant : remplacé, pas dupliqué");
        assert!(is_encrypted("{}").is_err());
    }

    #[test]
    fn import_never_replaces_a_pinned_host_key() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = store_with_server(a.path());
        source.write(|d| d.known_hosts.insert("h:22".into(), "SHA256:piege".into())).unwrap();
        let text = export(&source, "", false).unwrap();
        let target = store_with_server(b.path());
        let summary = import(&target, &text, "").unwrap();
        assert_eq!(summary.host_keys_kept, 1);
        assert_eq!(target.read(|d| d.known_hosts.get("h:22").cloned()), Some("SHA256:x".into()), "l'empreinte approuvée reste");
    }

    #[test]
    fn import_does_not_redirect_an_existing_server() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = store_with_server(a.path());
        source
            .write(|d| {
                d.servers[0].host = "attaquant.example".into();
                d.tunnels.push(TunnelDef {
                    id: "t".into(),
                    server_id: "a".into(),
                    name: "db".into(),
                    local_port: 15432,
                    remote_host: "127.0.0.1".into(),
                    remote_port: 5432,
                    auto_start: false,
                });
            })
            .unwrap();
        let text = export(&source, "", false).unwrap();
        let target = store_with_server(b.path());
        let summary = import(&target, &text, "").unwrap();
        assert_eq!(summary.duplicated, 1);
        let (hosts, tunnel_owner) =
            target.read(|d| (d.servers.iter().map(|s| (s.id.clone(), s.host.clone())).collect::<Vec<_>>(), d.tunnels[0].server_id.clone()));
        assert_eq!(hosts.len(), 2, "importé à côté, pas à la place");
        assert!(hosts.contains(&("a".into(), "h".into())), "le serveur existant garde son adresse");
        let copy = hosts.iter().find(|(_, h)| h == "attaquant.example").unwrap();
        assert_ne!(copy.0, "a");
        assert_eq!(tunnel_owner, copy.0, "les références suivent le nouvel identifiant");
    }

    fn desktop(id: &str, host: &str, username: &str) -> RemoteDesktop {
        serde_json::from_value(serde_json::json!({ "id": id, "name": "Bureau", "host": host, "username": username })).unwrap()
    }

    fn registry(id: &str, server: &str) -> Registry {
        serde_json::from_value(serde_json::json!({ "id": id, "name": "Registre", "kind": "custom", "server": server, "username": "bob" }))
            .unwrap()
    }

    /// Contenu reçu, en clair (sans secrets) : ce que produirait un partage piégé.
    fn received(fill: impl FnOnce(&mut Data)) -> String {
        let dir = tempfile::tempdir().unwrap();
        let source = Store::open(dir.path());
        source.write(fill).unwrap();
        export(&source, "", false).unwrap()
    }

    #[test]
    fn desktop_folder_survives_an_encrypted_export() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = Store::open(a.path());
        source.write(|d| d.desktops.push(RemoteDesktop { group: Some("Maison".into()), ..desktop("d1", "pc.lan", "bob") })).unwrap();
        let text = export(&source, "secret", false).unwrap();
        let target = Store::open(b.path());
        import(&target, &text, "secret").unwrap();
        assert_eq!(target.read(|d| d.desktops[0].group.clone()), Some("Maison".into()));
        // Un client plus ancien ignore les champs qu'il ne connaît pas au lieu de refuser le bureau.
        let newer = r#"{"id":"d2","name":"PC","host":"h","username":"u","group":"Maison","champFutur":true}"#;
        assert!(serde_json::from_str::<RemoteDesktop>(newer).is_ok());
    }

    #[test]
    fn import_does_not_redirect_a_desktop_or_registry() {
        let b = tempfile::tempdir().unwrap();
        let target = Store::open(b.path());
        target
            .write(|d| {
                d.desktops.push(desktop("d1", "bureau.lan", "alice"));
                d.registries.push(registry("r1", "registry.exemple.fr"));
            })
            .unwrap();
        let text = received(|d| {
            d.desktops.push(desktop("d1", "attaquant.example", "alice"));
            d.registries.push(registry("r1", "attaquant.example"));
        });
        let summary = import(&target, &text, "").unwrap();
        assert_eq!(summary.duplicated_other, 2);
        target.read(|d| {
            assert!(d.desktops.iter().any(|r| r.id == "d1" && r.host == "bureau.lan"), "le bureau existant garde son adresse");
            assert!(d.desktops.iter().any(|r| r.id != "d1" && r.host == "attaquant.example"));
            assert!(d.registries.iter().any(|r| r.id == "r1" && r.server == "registry.exemple.fr"), "le registre existant aussi");
            assert!(d.registries.iter().any(|r| r.id != "r1" && r.server == "attaquant.example"));
        });
    }

    #[test]
    fn import_does_not_lend_my_identity() {
        let b = tempfile::tempdir().unwrap();
        let target = store_with_server(b.path());
        let mine = Identity {
            id: "moi".into(),
            name: "root du VPS".into(),
            username: "root".into(),
            auth_kind: AuthKind::Password,
            key_path: None,
        };
        target.write(|d| d.identities.push(mine.clone())).unwrap();
        // Un serveur de l'attaquant qui se sert de mon identifiant, et une copie modifiée de celui-ci.
        let text = received(|d| {
            d.identities.push(Identity { username: "autre".into(), ..mine.clone() });
            d.servers.push(ServerProfile {
                id: "x".into(),
                name: "piège".into(),
                host: "attaquant.example".into(),
                port: 22,
                username: "root".into(),
                auth_kind: AuthKind::Password,
                key_path: None,
                color: None,
                group: None,
                ai_access: false,
                jump_id: None,
                identity_id: Some("moi".into()),
                protocol: Default::default(),
                auto_connect: false,
                provider: None,
            });
        });
        let summary = import(&target, &text, "").unwrap();
        assert_eq!(summary.identity_links_removed, 1);
        target.read(|d| {
            assert_eq!(d.servers.iter().find(|s| s.id == "x").unwrap().identity_id, None, "le lien vers mon identifiant est retiré");
            assert_eq!(d.identities.iter().find(|i| i.id == "moi").unwrap().username, "root", "mon identifiant n'est pas modifié");
        });
    }

    #[test]
    fn import_keeps_my_own_identity_link_on_reimport() {
        let b = tempfile::tempdir().unwrap();
        let target = store_with_server(b.path());
        let mine =
            Identity { id: "moi".into(), name: "root".into(), username: "root".into(), auth_kind: AuthKind::Password, key_path: None };
        target
            .write(|d| {
                d.identities.push(mine.clone());
                d.servers[0].identity_id = Some("moi".into());
            })
            .unwrap();
        let text = export(&target, "", false).unwrap();
        let summary = import(&target, &text, "").unwrap();
        assert_eq!(summary.identity_links_removed, 0);
        assert_eq!(target.read(|d| d.servers[0].identity_id.clone()), Some("moi".into()));
    }

    #[test]
    fn import_rejects_desktops_that_would_escape_or_inject() {
        let b = tempfile::tempdir().unwrap();
        let target = Store::open(b.path());
        let text = received(|d| {
            d.desktops.push(desktop(r"..\..\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x", "h", "u"));
            d.desktops.push(desktop("d2", "h", "u\r\ndrivestoredirect:s:*"));
            d.desktops.push(desktop("d3", "bureau.lan", "alice"));
            d.registries.push(registry("r2", "x; rm -rf /"));
        });
        let summary = import(&target, &text, "").unwrap();
        assert_eq!(summary.rejected, 3);
        assert_eq!(target.read(|d| d.desktops.iter().map(|r| r.id.clone()).collect::<Vec<_>>()), vec!["d3".to_string()]);
    }

    #[test]
    fn rekey_deplace_aussi_les_identifiants_de_l_hebergeur() {
        let dir = tempfile::tempdir().unwrap();
        let existing = store_with_server(dir.path()).read(|d| d.servers.clone());
        let mut other = existing[0].clone();
        other.host = "ailleurs".into();
        let mut p = Payload { servers: vec![other], ..Default::default() };
        p.secrets.insert("a".into(), BTreeMap::from([("password".into(), "x".into())]));
        p.secrets.insert("provider-a".into(), BTreeMap::from([("token".into(), "t".into())]));
        assert_eq!(rekey_conflicting_servers(&mut p, &existing), 1);
        let new = p.servers[0].id.clone();
        assert_ne!(new, "a");
        assert!(p.secrets.contains_key(&new) && p.secrets.contains_key(&ServerProfile::provider_owner(&new)));
        assert!(!p.secrets.contains_key("a") && !p.secrets.contains_key("provider-a"), "rien ne reste sous l'ancien identifiant");
    }

    #[test]
    fn un_contenu_ne_renseigne_que_ses_propres_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let p = Payload { servers: store_with_server(dir.path()).read(|d| d.servers.clone()), ..Default::default() };
        let owners = own_owners(&p);
        assert!(owners.contains(&"a".to_string()) && owners.contains(&"provider-a".to_string()));
        assert!(!owners.iter().any(|o| o == "sync" || o == "b"), "ni le jeton de synchronisation ni un autre serveur");
        for reserved in ["sync", "github", "ai"] {
            let mut sneaky = p.servers[0].clone();
            sneaky.id = reserved.into();
            assert!(!own_owners(&Payload { servers: vec![sneaky], ..Default::default() }).iter().any(|o| o == reserved), "{reserved}");
        }
    }

    #[test]
    fn un_serveur_a_id_reserve_est_ecarte_a_l_import() {
        let dir = tempfile::tempdir().unwrap();
        let target = Store::open(dir.path());
        let model = store_with_server(tempfile::tempdir().unwrap().path()).read(|d| d.servers[0].clone());
        let text = received(|d| {
            for id in ["github", "sync", "identity-x"] {
                d.servers.push(ServerProfile { id: id.into(), ..model.clone() });
            }
        });
        import(&target, &text, "").unwrap();
        assert!(target.read(|d| d.servers.is_empty()));
        assert!(is_reserved_owner("github") && !is_reserved_owner("a"));
    }

    #[test]
    fn l_import_n_approuve_que_les_cles_de_ses_propres_serveurs() {
        let b = tempfile::tempdir().unwrap();
        let target = Store::open(b.path());
        let text = received(|d| {
            d.servers.push(store_with_server(tempfile::tempdir().unwrap().path()).read(|x| x.servers[0].clone()));
            d.known_hosts.insert("h:22".into(), "SHA256:x".into());
            // Clé pré-approuvée pour un hôte que le partage n'apporte pas : ignorée.
            d.known_hosts.insert("banque.example:22".into(), "SHA256:piege".into());
        });
        import(&target, &text, "").unwrap();
        target.read(|d| {
            assert_eq!(d.known_hosts.get("h:22").map(String::as_str), Some("SHA256:x"));
            assert!(!d.known_hosts.contains_key("banque.example:22"));
        });
    }

    #[test]
    fn un_nombre_d_iterations_demesure_est_refuse() {
        assert!(key("x", &[0; 16], u32::MAX).is_err());
        assert!(key("x", &[0; 16], ITERATIONS - 1).is_err());
        let text = seal(&Payload::default(), "secret").unwrap().replace("\"iterations\": 600000", "\"iterations\": 4294967295");
        assert!(text.contains("4294967295"));
        let t = std::time::Instant::now();
        assert!(open(&text, "secret").is_err());
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "refusé sans dériver la clé");
    }

    #[test]
    fn la_synchronisation_exige_le_chiffrement_et_la_bonne_revision() {
        let p = Payload { snippets: vec![Snippet { id: "s".into(), name: "n".into(), command: "ls".into() }], ..Default::default() };
        assert!(open_sync(&seal(&p, "").unwrap(), "secret", 1).unwrap_err().contains("non chiffré"));
        assert!(seal_sync(&p, "", 1).is_err());
        let sealed = seal_sync(&p, "secret", 5).unwrap();
        assert_eq!(open_sync(&sealed, "secret", 5).unwrap(), (p.clone(), true));
        assert!(open_sync(&sealed, "secret", 6).unwrap_err().contains("rejoué"), "ancien contenu servi sous une autre révision");
        // Révision réécrite dans l'enveloppe : elle est authentifiée, le déchiffrement échoue.
        assert!(open_sync(&sealed.replace("\"rev\": 5", "\"rev\": 6"), "secret", 6).is_err());
        // Un export chiffré (sans révision) n'est pas un contenu synchronisé de version 2.
        assert!(open_sync(&seal(&p, "secret").unwrap(), "secret", 1).is_err());
        assert!(open(&sealed, "secret").is_err(), "et l'inverse : un contenu synchronisé ne s'importe pas");
        // Version 1 (écrite avant cette protection) : lisible, mais signalée non authentifiée.
        let v1 = seal(&p, "secret").unwrap().replace("\"version\": 2", "\"version\": 1");
        assert_eq!(open_sync(&v1, "secret", 9).unwrap(), (p, false));
    }

    #[test]
    fn la_version_ecrite_est_la_2_et_la_1_reste_lisible() {
        let text = seal(&Payload::default(), "").unwrap();
        assert!(text.contains("\"version\": 2"), "{text}");
        assert!(open(&text, "").is_ok());
        assert!(open(&text.replace("\"version\": 2", "\"version\": 1"), "").is_ok());
        assert!(open(&text.replace("\"version\": 2", "\"version\": 3"), "").is_err());
    }
}
