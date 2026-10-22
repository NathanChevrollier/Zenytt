//! Accès au keyring de l'OS (Windows Credential Manager, macOS Keychain, Secret Service).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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

fn entry(server_id: &str, kind: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(APP_ID, &format!("{server_id}:{kind}")).map_err(|e| e.to_string())
}

pub fn get(server_id: &str, kind: &str) -> Option<String> {
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
    remember(server_id, kind, value.is_some());
    value
}

/// Le secret existe-t-il ? Sans relire le coffre quand la réponse est déjà connue.
pub fn has(server_id: &str, kind: &str) -> bool {
    let known = presence().lock().unwrap_or_else(|e| e.into_inner()).get(&format!("{server_id}:{kind}")).copied();
    known.unwrap_or_else(|| get(server_id, kind).is_some())
}

/// Enregistre le secret, ou le supprime si la valeur est vide.
pub fn set(server_id: &str, kind: &str, value: &str) -> Result<(), String> {
    let e = entry(server_id, kind)?;
    let result = if value.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    } else {
        e.set_password(value).map_err(|e| e.to_string())
    };
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
