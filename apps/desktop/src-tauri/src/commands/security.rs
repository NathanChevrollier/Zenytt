//! Audit de sécurité et corrections guidées, avec vérification par une nouvelle connexion.

use std::time::Duration;

use tauri::State;
use zenytt_core::security::{self, FixOutcome, FixPlan, Report};
use zenytt_core::Connection;
use zenytt_core::{access, fail2ban, firewall};
use zenytt_profiles::AuthKind;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

/// Constats d'audit ignorés pour ce serveur (les plus récents d'abord).
#[tauri::command]
pub fn findings_ignored(store: State<'_, Store>, server_id: String) -> Vec<zenytt_profiles::IgnoredFinding> {
    let mut list: Vec<_> = store.read(|d| d.ignored_findings.iter().filter(|f| f.server_id == server_id).cloned().collect());
    list.sort_by_key(|f| std::cmp::Reverse(f.at));
    list
}

/// Met un constat de côté : il passe dans les constats ignorés, avec sa raison.
#[tauri::command]
pub fn finding_ignore(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    server_id: String,
    finding_id: String,
    title: String,
    reason: String,
) -> Result<(), String> {
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let entry = zenytt_profiles::IgnoredFinding { server_id: server_id.clone(), finding_id: finding_id.clone(), title, reason, at };
    let r = store.write(|d| {
        d.ignored_findings.retain(|f| !(f.server_id == entry.server_id && f.finding_id == entry.finding_id));
        d.ignored_findings.push(entry);
    });
    track(&audit, &store, &server_id, "security.ignore", &finding_id, r)
}

/// Remet un constat ignoré dans la liste des problèmes.
#[tauri::command]
pub fn finding_unignore(store: State<'_, Store>, server_id: String, finding_id: String) -> Result<(), String> {
    store.write(|d| d.ignored_findings.retain(|f| !(f.server_id == server_id && f.finding_id == finding_id)))
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn security_audit(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Report, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    security::audit(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub fn security_fix_plan(id: String) -> Result<FixPlan, String> {
    security::fix_plan(&id).map_err(err)
}

/// Refuse d'avance les corrections qui couperaient l'accès de Zenytt lui-même.
fn guard(store: &Store, server_id: &str, fix: &str) -> Result<(), String> {
    let p = store.server(server_id)?;
    let by_password = p.auth_kind == AuthKind::Password;
    if fix == "disable-password-auth" && by_password {
        return Err(
            "Zenytt se connecte à ce serveur par mot de passe : configure d'abord une clé SSH dans le profil, sinon tu serais bloqué dehors."
                .into(),
        );
    }
    if fix == "root-prohibit-password" && by_password && p.username == "root" {
        return Err(
            "Tu te connectes en root par mot de passe : configure d'abord une clé SSH dans le profil, sinon tu serais bloqué dehors."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn security_fix_apply(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    id: String,
) -> Result<FixOutcome, String> {
    let r: Result<FixOutcome, String> = async {
        guard(&store, &server_id, &id)?;
        let plan = security::fix_plan(&id).map_err(err)?;
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        let mut outcome = security::apply_fix(&conn, sudo.as_deref(), &id).await.map_err(err)?;
        if !outcome.ok || !plan.needs_verification {
            return Ok(outcome);
        }
        // Connexion de contrôle, entièrement nouvelle, pendant que la connexion d'origine reste ouverte.
        let params = store.connect_params(&server_id)?;
        let check = tokio::time::timeout(Duration::from_secs(20), async {
            let c = Connection::connect(params).await.map_err(err)?;
            c.run("true").await.map_err(err)?;
            c.disconnect().await;
            Ok::<_, String>(())
        })
        .await
        .unwrap_or_else(|_| Err("délai dépassé".into()));
        if let Err(e) = check {
            let undo = match &outcome.rollback {
                Some(token) => security::rollback(&conn, sudo.as_deref(), token).await.map_err(err)?,
                None => String::new(),
            };
            outcome.ok = false;
            outcome.output = format!(
                "{}\n\nLa connexion de contrôle a échoué ({e}) : la modification a été annulée automatiquement.\n{undo}",
                outcome.output
            );
        } else {
            outcome.output.push_str("\n\nConnexion de contrôle réussie : la modification est conservée.");
        }
        Ok(outcome)
    }
    .await;
    let r = match r {
        Ok(o) if !o.ok => {
            // Journalisé comme échec, mais renvoyé tel quel pour afficher la sortie.
            let name = store.server(&server_id).map(|s| s.name).unwrap_or_default();
            audit.record(&server_id, &name, "security.fix", &id, Err("échec ou annulé"));
            return Ok(o);
        }
        other => other,
    };
    track(&audit, &store, &server_id, "security.fix", &id, r)
}

// ---------- fail2ban ----------

#[tauri::command]
pub async fn f2b_state(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<fail2ban::State, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    fail2ban::state(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn f2b_unban(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    jail: String,
    ip: String,
) -> Result<(), String> {
    let detail = format!("{jail} {ip}");
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        fail2ban::unban(&conn, sudo.as_deref(), &jail, &ip).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "fail2ban.unban", &detail, r)
}

#[tauri::command]
pub async fn f2b_set_ignore(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    addresses: Vec<String>,
) -> Result<String, String> {
    let detail = addresses.join(" ");
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        fail2ban::set_ignore(&conn, sudo.as_deref(), &addresses).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "fail2ban.ignoreip", &detail, r)
}

/// Bannit une adresse, pour la durée du jail choisi ou pour 7 jours, 30 jours ou toujours.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn f2b_ban(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    jail: String,
    ip: String,
    duration: fail2ban::BanDuration,
) -> Result<(), String> {
    let detail = format!("{jail} {ip} {duration:?}");
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        fail2ban::ban(&conn, sudo.as_deref(), &jail, &ip, duration).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "fail2ban.ban", &detail, r)
}

/// Réglages fail2ban écrits par Zenytt, et jails que fail2ban connaît.
#[tauri::command]
pub async fn f2b_settings(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<fail2ban::SettingsView, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    fail2ban::settings(&conn, sudo.as_deref()).await.map_err(err)
}

/// Règles par défaut, jails activées et durées : testées par fail2ban avant d'être appliquées.
#[tauri::command]
pub async fn f2b_settings_set(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    settings: fail2ban::Settings,
) -> Result<String, String> {
    let detail = serde_json::to_string(&settings).unwrap_or_default();
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        fail2ban::set_settings(&conn, sudo.as_deref(), &settings).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "fail2ban.settings", &detail, r)
}

/// Derniers événements du journal de fail2ban (tous, ou ceux d'une adresse).
#[tauri::command]
pub async fn f2b_events(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    ip: Option<String>,
    limit: usize,
) -> Result<Vec<fail2ban::Event>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    fail2ban::events(&conn, sudo.as_deref(), ip.as_deref(), limit).await.map_err(err)
}

/// Lignes des journaux du service (SSH…) où apparaît l'adresse : ses tentatives.
#[tauri::command]
pub async fn f2b_attempts(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    ip: String,
) -> Result<Vec<String>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    fail2ban::attempts(&conn, sudo.as_deref(), &ip, 200).await.map_err(err)
}

/// Étiquettes posées sur des adresses IP (communes à tous les serveurs).
#[tauri::command]
pub fn ip_labels_list(store: State<'_, Store>) -> Vec<zenytt_profiles::IpLabel> {
    store.read(|d| d.ip_labels.clone())
}

/// Pose, modifie ou (étiquette vide) retire l'étiquette d'une adresse.
#[tauri::command]
pub fn ip_label_set(store: State<'_, Store>, ip: String, label: String, note: String) -> Result<(), String> {
    if !fail2ban::valid_address(ip.trim()) {
        return Err("adresse IP invalide".into());
    }
    let ip = ip.trim().to_string();
    let label: String = label.trim().chars().take(60).collect();
    let note: String = note.trim().chars().take(500).collect();
    store.write(|d| {
        d.ip_labels.retain(|l| l.ip != ip);
        if !label.is_empty() || !note.is_empty() {
            d.ip_labels.push(zenytt_profiles::IpLabel { ip, label, note });
        }
    })
}

/// IP publique du PC (pour « Ajouter mon IP »).
#[tauri::command]
pub async fn my_public_ip() -> Option<String> {
    zenytt_core::diagnose::public_ip().await
}

// ---------- Pare-feu ----------

#[tauri::command]
pub async fn fw_state(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<firewall::State, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    firewall::state(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn fw_allow(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    port: u16,
    proto: String,
) -> Result<String, String> {
    let detail = format!("{port}/{proto}");
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        firewall::allow(&conn, sudo.as_deref(), port, &proto).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "firewall.allow", &detail, r)
}

#[tauri::command]
pub async fn fw_delete(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    num: u32,
) -> Result<String, String> {
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        firewall::delete(&conn, sudo.as_deref(), num).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "firewall.delete", &num.to_string(), r)
}

// ---------- Accès (comptes et clés SSH) ----------

/// Empreinte de la clé avec laquelle Zenytt se connecte à ce serveur, si elle est connue.
fn current_key(store: &Store, server_id: &str) -> Option<String> {
    let p = store.server(server_id).ok()?;
    if p.auth_kind == AuthKind::Password {
        return None;
    }
    let path = p.key_path.filter(|k| !k.is_empty())?;
    zenytt_core::ssh::public_key_from_file(&zenytt_core::ssh::expand_home(&path))
        .map(|k| k.fingerprint(zenytt_core::russh::keys::HashAlg::Sha256).to_string())
}

#[tauri::command]
pub async fn access_users(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<access::User>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    access::users(&conn, sudo.as_deref(), current_key(&store, &server_id).as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn access_add_key(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    user: String,
    key: String,
) -> Result<(), String> {
    let detail = format!("{user} {}", key.split_whitespace().nth(2).unwrap_or(""));
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        access::add_key(&conn, sudo.as_deref(), &user, &key).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "ssh.key.add", &detail, r)
}

#[tauri::command]
pub async fn access_remove_key(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    user: String,
    line: String,
) -> Result<(), String> {
    let detail = format!("{user} {}", line.split_whitespace().last().unwrap_or(""));
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        access::remove_key(&conn, sudo.as_deref(), &user, &line, current_key(&store, &server_id).as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "ssh.key.remove", &detail, r)
}
