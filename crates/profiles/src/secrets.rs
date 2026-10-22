//! Secrets : coffre de l'OS (Windows Credential Manager, macOS Keychain, Secret Service), ou
//! fichier privé de l'app sur mobile (voir [`use_file`]).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[cfg(feature = "keyring")]
use crate::APP_ID;

/// Présence connue de chaque secret (`id:type` → présent ?). Lister les serveurs demande trois
/// lectures du coffre par serveur, à chaque actualisation ; le coffre (surtout Secret Service via
/// D-Bus) répond en plusieurs millisecondes. Le cache n'est tenu que pour les écritures faites par
/// ce processus, seul à écrire dans le coffre de Zenytt.
fn presence() -> &'static Mutex<HashMap<String, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn remember(server_id: &str, kind: &str, present: bool) {
    presence().lock().unwrap_or_else(|e| e.into_inner()).insert(format!("{server_id}:{kind}"), present);
}

/// Secrets dans un fichier JSON (`id:type` → valeur), pour les plateformes sans keyring.
struct FileSecrets {
    path: PathBuf,
    map: Mutex<HashMap<String, String>>,
}

impl FileSecrets {
    fn open(path: PathBuf) -> Self {
        let map = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, map: Mutex::new(map) }
    }

    fn get(&self, key: &str) -> Option<String> {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
    }

    /// Valeur vide : suppression. Écriture atomique (fichier temporaire + rename).
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if value.is_empty() {
            map.remove(key);
        } else {
            map.insert(key.to_string(), value.to_string());
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&*map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

static FILE: OnceLock<FileSecrets> = OnceLock::new();

/// Range les secrets dans ce fichier plutôt que dans le coffre de l'OS (app mobile, où le
/// coffre n'est pas disponible). À appeler une fois, au démarrage.
// shortcut: secrets in app-private storage, not Android Keystore/iOS Keychain; upgrade to a keystore plugin before store release
pub fn use_file(path: PathBuf) {
    let _ = FILE.set(FileSecrets::open(path));
}

#[cfg(feature = "keyring")]
fn entry(server_id: &str, kind: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(APP_ID, &format!("{server_id}:{kind}")).map_err(|e| e.to_string())
}

#[cfg(feature = "keyring")]
fn keyring_get(server_id: &str, kind: &str) -> Option<String> {
    let mut value = entry(server_id, kind).ok()?.get_password().ok();
    if value.is_none() {
        // Secret enregistré par une version précédente : recopié sous le nom actuel à la première lecture.
        value = crate::legacy::secret(server_id, kind);
        if let Some(v) = &value {
            if entry(server_id, kind).ok()?.set_password(v).is_ok() {
                crate::legacy::forget_secret(server_id, kind);
            }
        }
    }
    value
}

#[cfg(not(feature = "keyring"))]
fn keyring_get(_: &str, _: &str) -> Option<String> {
    None
}

#[cfg(feature = "keyring")]
fn keyring_set(server_id: &str, kind: &str, value: &str) -> Result<(), String> {
    let e = entry(server_id, kind)?;
    if value.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    } else {
        e.set_password(value).map_err(|e| e.to_string())
    }
}

#[cfg(not(feature = "keyring"))]
fn keyring_set(_: &str, _: &str, _: &str) -> Result<(), String> {
    Err("aucun coffre de secrets disponible".into())
}

pub fn get(server_id: &str, kind: &str) -> Option<String> {
    if let Some(f) = FILE.get() {
        return f.get(&format!("{server_id}:{kind}"));
    }
    let value = keyring_get(server_id, kind);
    remember(server_id, kind, value.is_some());
    value
}

/// Le secret existe-t-il ? Sans relire le coffre quand la réponse est déjà connue.
pub fn has(server_id: &str, kind: &str) -> bool {
    let known = presence().lock().unwrap_or_else(|e| e.into_inner()).get(&format!("{server_id}:{kind}")).copied();
    known.filter(|_| FILE.get().is_none()).unwrap_or_else(|| get(server_id, kind).is_some())
}

/// Enregistre le secret, ou le supprime si la valeur est vide.
pub fn set(server_id: &str, kind: &str, value: &str) -> Result<(), String> {
    if let Some(f) = FILE.get() {
        return f.set(&format!("{server_id}:{kind}"), value);
    }
    let result = keyring_set(server_id, kind, value);
    match &result {
        Ok(()) => remember(server_id, kind, !value.is_empty()),
        // État incertain : la prochaine question relira le coffre.
        Err(_) => {
            presence().lock().unwrap_or_else(|e| e.into_inner()).remove(&format!("{server_id}:{kind}"));
        }
    }
    result
}

pub fn delete_all(server_id: &str) {
    for kind in crate::export::SECRET_KINDS {
        let _ = set(server_id, kind, "");
    }
}

#[cfg(test)]
mod tests {
    use super::FileSecrets;

    #[test]
    fn fichier_de_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let s = FileSecrets::open(path.clone());
        assert_eq!(s.get("a:password"), None);
        s.set("a:password", "pw").unwrap();
        // Relu depuis le disque par une autre instance.
        assert_eq!(FileSecrets::open(path.clone()).get("a:password").as_deref(), Some("pw"));
        s.set("a:password", "").unwrap();
        assert_eq!(FileSecrets::open(path).get("a:password"), None);
    }
}
