//! Reprise des installations faites sous l'ancien nom de l'application (versions ≤ 1.1.1) :
//! dossier de configuration, secrets du coffre de l'OS et anciens formats de synchronisation,
//! d'export et de partage.
//!
//! Avec `zenytt_core::legacy` (côté serveur), c'est le seul endroit qui connaît cet ancien nom.
//! Les deux modules pourront être supprimés quand plus aucune installation n'en dépendra.

use std::path::{Path, PathBuf};

const OLD_NAME: &str = "helm";
const OLD_APP_ID: &str = "dev.helm.desktop";
pub(crate) const OLD_SYNC_FORMAT: &str = "helm-sync";
pub(crate) const OLD_EXPORT_FORMAT: &str = "helm-export";
pub(crate) const OLD_SHARE_PREFIX: &str = "helm-share:";

/// Nom sous lequel l'ancienne application était installée (entrée de désinstallation Windows).
pub const OLD_PRODUCT_NAME: &str = "Helm";

fn old_config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join(OLD_APP_ID)
}

/// Nom du paquet .deb / .rpm de l'ancienne application.
pub const OLD_PACKAGE: &str = "helm-desktop";

/// Le nom de fichier (bundle macOS, AppImage) est-il celui de l'ancienne application ? Renvoie
/// alors le nom à lui donner.
pub fn renamed_file(name: &str, new_product: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let at = lower.find(OLD_NAME)?;
    let old = &name[at..at + OLD_NAME.len()];
    let new = if old.starts_with('H') { new_product.to_string() } else { new_product.to_lowercase() };
    Some(format!("{}{new}{}", &name[..at], &name[at + OLD_NAME.len()..]))
}

/// Données locales de l'ancienne application (cache de l'interface, journaux), sans valeur à reprendre.
pub fn old_leftover_dirs() -> Vec<PathBuf> {
    let mut dirs_ = vec![dirs::data_local_dir(), dirs::data_dir(), dirs::cache_dir()];
    if cfg!(target_os = "macos") {
        let lib = dirs::home_dir().map(|h| h.join("Library"));
        dirs_.push(lib.as_ref().map(|l| l.join("Logs")));
        dirs_.push(lib.as_ref().map(|l| l.join("WebKit")));
    }
    let mut out: Vec<PathBuf> = dirs_.into_iter().flatten().map(|d| d.join(OLD_APP_ID)).collect();
    if cfg!(target_os = "macos") {
        if let Some(h) = dirs::home_dir() {
            out.push(h.join("Library/Saved Application State").join(format!("{OLD_APP_ID}.savedState")));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Emplacements habituels d'un bundle macOS de l'ancienne application.
pub fn old_app_bundles() -> Vec<PathBuf> {
    let bundle = format!("{OLD_PRODUCT_NAME}.app");
    let mut out = vec![PathBuf::from("/Applications").join(&bundle)];
    out.extend(dirs::home_dir().map(|h| h.join("Applications").join(&bundle)));
    out
}

/// Bundle macOS de l'ancienne application (vérifié par son identifiant avant toute suppression).
pub fn is_old_bundle(bundle: &Path) -> bool {
    std::fs::read_to_string(bundle.join("Contents/Info.plist")).is_ok_and(|p| p.contains(&format!("<string>{OLD_APP_ID}</string>")))
}

/// Reprend l'ancien dossier de configuration dans `dir` quand `dir` n'a pas encore de profils :
/// chaque fichier est copié (`helm.json` devient `zenytt.json`), puis l'ancien dossier est
/// supprimé. Renvoie `Ok(true)` si une reprise a eu lieu.
pub fn migrate_config(dir: &Path) -> Result<bool, String> {
    migrate_config_from(&old_config_dir(), dir)
}

fn migrate_config_from(old: &Path, dir: &Path) -> Result<bool, String> {
    if dir.join("zenytt.json").exists() || !old.join(format!("{OLD_NAME}.json")).is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{} : {e}", dir.display()))?;
    let entries = std::fs::read_dir(old).map_err(|e| format!("{} : {e}", old.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let target = dir.join(entry.file_name().to_string_lossy().replace(OLD_NAME, "zenytt"));
        std::fs::copy(&path, &target).map_err(|e| format!("copie de {} : {e}", path.display()))?;
    }
    // Tout est copié : l'ancien dossier ne sert plus à rien.
    let _ = std::fs::remove_dir_all(old);
    Ok(true)
}

#[cfg(feature = "keyring")]
fn old_entry(server_id: &str, kind: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(OLD_APP_ID, &format!("{server_id}:{kind}")).ok()
}

/// Secret enregistré sous l'ancien nom, s'il existe encore.
#[cfg(feature = "keyring")]
pub(crate) fn secret(server_id: &str, kind: &str) -> Option<String> {
    old_entry(server_id, kind)?.get_password().ok()
}

/// Efface l'ancien secret, une fois recopié sous le nouveau nom.
#[cfg(feature = "keyring")]
pub(crate) fn forget_secret(server_id: &str, kind: &str) {
    if let Some(e) = old_entry(server_id, kind) {
        let _ = e.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reprend_l_ancien_dossier_une_seule_fois() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let dir = new.path().join("conf");
        std::fs::write(old.path().join("helm.json"), b"{\"servers\":[]}").unwrap();
        std::fs::write(old.path().join("helm.json.bak"), b"{}").unwrap();
        std::fs::write(old.path().join("audit.log"), b"x").unwrap();

        assert_eq!(migrate_config_from(old.path(), &dir), Ok(true));
        assert_eq!(std::fs::read(dir.join("zenytt.json")).unwrap(), b"{\"servers\":[]}");
        assert!(dir.join("zenytt.json.bak").is_file() && dir.join("audit.log").is_file());
        assert!(!old.path().exists(), "l'ancien dossier est supprimé après la copie");

        // Profils déjà présents : rien n'est écrasé.
        let again = tempfile::tempdir().unwrap();
        std::fs::write(again.path().join("helm.json"), b"ancien").unwrap();
        assert_eq!(migrate_config_from(again.path(), &dir), Ok(false));
        assert_eq!(std::fs::read(dir.join("zenytt.json")).unwrap(), b"{\"servers\":[]}");
    }

    #[test]
    fn renomme_les_fichiers_de_l_ancienne_application() {
        assert_eq!(renamed_file("Helm.app", "Zenytt").as_deref(), Some("Zenytt.app"));
        assert_eq!(renamed_file("Helm_1.1.1_amd64.AppImage", "Zenytt").as_deref(), Some("Zenytt_1.1.1_amd64.AppImage"));
        assert_eq!(renamed_file("helm-desktop.AppImage", "Zenytt").as_deref(), Some("zenytt-desktop.AppImage"));
        assert_eq!(renamed_file("Zenytt.app", "Zenytt"), None);
    }

    #[test]
    fn rien_a_reprendre_sans_ancien_dossier() {
        let new = tempfile::tempdir().unwrap();
        assert_eq!(migrate_config_from(&new.path().join("absent"), &new.path().join("conf")), Ok(false));
    }
}
