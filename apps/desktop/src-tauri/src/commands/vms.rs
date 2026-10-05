//! Machines virtuelles (libvirt) : inventaire, détail, activité, actions et suppression.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;
use zenytt_core::vm::{self, Access, Vm, VmAction, VmDetail};
use zenytt_core::Connection;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

/// Mode d'accès à libvirt mémorisé par serveur.
#[derive(Default)]
pub struct VmAccess(Mutex<HashMap<String, Access>>);

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub(crate) fn unavailable_message(reason: &str) -> String {
    if reason.contains("n'est pas installé") {
        return format!("{reason}. Le guide « Machines virtuelles » explique comment l'installer.");
    }
    format!("libvirt ne répond pas à ton utilisateur ({reason}). Ajoute-le au groupe libvirt (sudo usermod -aG libvirt $USER, puis reconnecte-toi) ou renseigne le mot de passe sudo dans le profil du serveur.")
}

struct Ctx {
    conn: Connection,
    sudo: Option<String>,
    access: Access,
}

async fn ctx(store: &Store, sessions: &Sessions, cache: &VmAccess, server_id: &str) -> Result<Ctx, String> {
    let (conn, sudo) = admin(store, sessions, server_id).await?;
    let known = cache.0.lock().await.get(server_id).copied().filter(|a| *a != Access::Unavailable);
    let access = match known {
        Some(a) => a,
        None => {
            let (a, reason) = vm::access(&conn, sudo.as_deref()).await.map_err(err)?;
            if a == Access::Unavailable {
                return Err(unavailable_message(&reason));
            }
            cache.0.lock().await.insert(server_id.to_string(), a);
            a
        }
    };
    Ok(Ctx { conn, sudo, access })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmOverview {
    access: Access,
    version: String,
    /// Explication quand libvirt est inaccessible (la section l'affiche à la place de la liste).
    reason: Option<String>,
    vms: Vec<Vm>,
}

#[tauri::command]
pub async fn vm_overview(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
) -> Result<VmOverview, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let (access, version) = vm::access(&conn, sudo.as_deref()).await.map_err(err)?;
    cache.0.lock().await.insert(server_id.clone(), access);
    if access == Access::Unavailable {
        return Ok(VmOverview { access, version: String::new(), reason: Some(unavailable_message(&version)), vms: Vec::new() });
    }
    let vms = vm::list(&conn, access, sudo.as_deref()).await.map_err(err)?;
    Ok(VmOverview { access, version, reason: None, vms })
}

#[tauri::command]
pub async fn vm_detail(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
) -> Result<VmDetail, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    vm::detail(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmStatsView {
    uuid: String,
    cpu_percent: f64,
    memory_used_kib: Option<u64>,
}

#[tauri::command]
pub async fn vm_stats(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
) -> Result<Vec<VmStatsView>, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    let s = c.sudo.as_deref();
    let (vms, stats) = tokio::try_join!(vm::list(&c.conn, c.access, s), vm::stats(&c.conn, c.access, s)).map_err(err)?;
    // `domstats` désigne les VM par leur nom : retour à l'UUID par l'inventaire.
    let by_name: HashMap<&str, &str> = vms.iter().map(|v| (v.name.as_str(), v.uuid.as_str())).collect();
    Ok(stats
        .into_iter()
        .filter_map(|st| {
            by_name.get(st.name.as_str()).map(|u| VmStatsView {
                uuid: u.to_string(),
                cpu_percent: st.cpu_percent,
                memory_used_kib: st.memory_used_kib,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn vm_action(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
    name: String,
    action: VmAction,
) -> Result<(), String> {
    let r = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        vm::act(&c.conn, c.access, c.sudo.as_deref(), &uuid, action).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, &format!("vm.{}", serde_json::to_value(action).unwrap().as_str().unwrap_or("action")), &name, r)
}

/// Restreint l'écran VNC de la VM à 127.0.0.1 (pris en compte au prochain démarrage de la VM).
#[tauri::command]
pub async fn vm_vnc_restrict(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
    name: String,
) -> Result<(), String> {
    let r = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        vm::restrict_vnc(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "vm.vnc_restrict", &name, r)
}

/// Supprime la VM ; avec `with_storage`, ses propres disques seulement (ni ISO ni disque partagé).
/// Renvoie les fichiers restés sur le serveur, que libvirt ne gère pas (hors d'un pool).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn vm_delete(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
    name: String,
    with_storage: bool,
) -> Result<Vec<String>, String> {
    let r = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        let d = vm::detail(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)?;
        let storage = if with_storage { vm::removable_disks(&d) } else { Vec::new() };
        vm::delete(&c.conn, c.access, c.sudo.as_deref(), &uuid, &storage, d.firmware == "uefi").await.map_err(err)
    }
    .await;
    let detail = if with_storage { format!("{name} (avec ses disques)") } else { name };
    track(&audit, &store, &server_id, "vm.delete", &detail, r)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmConsole {
    session: crate::commands::rdp::VncSession,
    /// Écran de la VM écouté sur le réseau : fonctionne par le tunnel, mais à corriger.
    warning: Option<String>,
}

/// Écran de la VM dans Zenytt : tunnel SSH vers son port VNC (écouté par QEMU sur le serveur),
/// puis le client VNC intégré. Fermé par `desktop_session_close("vm-<uuid>")`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn vm_console_open(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    tunnels: State<'_, crate::commands::tunnels::Tunnels>,
    bridges: State<'_, crate::rdp_bridge::Bridges>,
    server_id: String,
    uuid: String,
    name: String,
) -> Result<VmConsole, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    let d = vm::detail(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)?;
    let (port, listen, public, has_password) = match d.graphics {
        vm::Graphics::Vnc { port: Some(p), listen, public, password } => (p, listen, public, password),
        vm::Graphics::Vnc { port: None, .. } => return Err("la VM est éteinte : démarre-la pour voir son écran".into()),
        vm::Graphics::Spice { .. } => {
            return Err("cette VM affiche son écran en SPICE, que Zenytt n'affiche pas : ouvre-le dans le client du système (remote-viewer), ou utilise la console série".into())
        }
        vm::Graphics::None => return Err("cette VM n'a pas d'écran : utilise la console série".into()),
        vm::Graphics::VncSocket => {
            return Err("l'écran de cette VM passe par un socket Unix, pas par un port : utilise la console série, ou fais-le écouter sur 127.0.0.1 (virsh edit, balise <graphics>)".into())
        }
    };
    let password = if has_password {
        vm::vnc_password_of(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)?.unwrap_or_default()
    } else {
        String::new()
    };
    // L'écran est joint depuis le serveur : sur sa boucle locale s'il écoute partout (0.0.0.0),
    // sinon sur l'adresse précise choisie pour QEMU (une IP du réseau local ne répond pas sur 127.0.0.1).
    let host = vm::vnc_connect_host(&listen);
    let session = crate::commands::rdp::open_vnc_via(
        &app,
        &tunnels,
        &bridges,
        &format!("vm-{uuid}"),
        &server_id,
        &name,
        &host,
        port,
        password,
        String::new(),
    )
    .await?;
    let warning = public.then(|| {
        "L'écran de cette VM est accessible depuis le réseau (VNC écouté sur toutes les adresses). Zenytt passe par un tunnel, mais d'autres peuvent s'y connecter : restreins l'écoute à 127.0.0.1."
            .to_string()
    });
    Ok(VmConsole { session, warning })
}

/// Écran de la VM dans le client du système (remote-viewer de virt-viewer), en VNC comme en SPICE,
/// par un tunnel SSH refermé avec la fenêtre. Le mot de passe éventuel passe par un fichier .vv
/// effacé dès sa lecture.
#[tauri::command]
pub async fn vm_console_external(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    tunnels: State<'_, crate::commands::tunnels::Tunnels>,
    server_id: String,
    uuid: String,
    name: String,
) -> Result<String, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    let d = vm::detail(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)?;
    let (kind, port, listen, has_password) = match d.graphics {
        vm::Graphics::Vnc { port: Some(p), listen, password, .. } => ("vnc", p, listen, password),
        vm::Graphics::Spice { port: Some(p), listen, password } => ("spice", p, listen, password),
        vm::Graphics::Vnc { port: None, .. } | vm::Graphics::Spice { port: None, .. } => {
            return Err("la VM est éteinte : démarre-la pour voir son écran".into())
        }
        vm::Graphics::VncSocket => {
            return Err("l'écran de cette VM passe par un socket Unix, pas par un port : utilise la console série".into())
        }
        vm::Graphics::None => return Err("cette VM n'a pas d'écran : utilise la console série".into()),
    };
    let password =
        if has_password { vm::display_password_of(&c.conn, c.access, c.sudo.as_deref(), &uuid, kind).await.map_err(err)? } else { None };
    let key = format!("vm-ext-{uuid}");
    let target = crate::commands::rdp::ViewerTarget {
        key: &key,
        via: Some(&server_id),
        label: &name,
        kind,
        host: &vm::vnc_connect_host(&listen),
        port,
        password: password.as_deref(),
        fullscreen: false,
    };
    crate::commands::rdp::open_in_remote_viewer(&app, &tunnels, target).await?;
    Ok(format!("Écran de « {name} » ouvert dans remote-viewer"))
}

/// Commande à lancer dans un onglet terminal pour la console série de la VM.
#[tauri::command]
pub async fn vm_serial_command(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
) -> Result<String, String> {
    if !vm::valid_uuid(&uuid) {
        return Err("identifiant de VM invalide".into());
    }
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    let base = format!("virsh -c qemu:///system console {}", zenytt_core::ssh::shell_quote(&uuid));
    // En sudo, le mot de passe est demandé dans le terminal lui-même.
    Ok(if c.access == Access::Sudo { format!("sudo {base}") } else { base })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_unavailable_message() {
        let m = unavailable_message("libvirt (virsh) n'est pas installé sur ce serveur");
        assert!(m.contains("n'est pas installé"), "raison reprise telle quelle");
        let m = unavailable_message("error: failed to connect to the hypervisor");
        assert!(m.contains("groupe libvirt") && m.contains("mot de passe sudo"), "dit quoi faire : {m}");
    }
}
