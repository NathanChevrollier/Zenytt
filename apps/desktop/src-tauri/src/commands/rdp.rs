//! Bureaux à distance (RDP) : profils, et ouverture dans le client RDP du système (mstsc sous
//! Windows), directement ou à travers un tunnel SSH ouvert pour l'occasion.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zenytt_profiles::{DesktopProtocol, Identity, RemoteDesktop, TunnelDef};

use crate::commands::tunnels::Tunnels;
use crate::store::{secrets, Store};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopView {
    #[serde(flatten)]
    desktop: RemoteDesktop,
    has_password: bool,
}

#[tauri::command]
pub fn desktops_list(store: State<'_, Store>) -> Vec<DesktopView> {
    store
        .read(|d| d.desktops.clone())
        .into_iter()
        .map(|desktop| DesktopView { has_password: secrets::get(&RemoteDesktop::secret_owner(&desktop.id), "password").is_some(), desktop })
        .collect()
}

/// Hôte, utilisateur et domaine acceptables dans un fichier .rdp (une valeur par ligne).
fn clean(value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.chars().any(|c| c.is_control()) {
        return Err(format!("{what} invalide"));
    }
    Ok(v.to_string())
}

#[tauri::command]
pub fn desktop_save(store: State<'_, Store>, mut desktop: RemoteDesktop, password: Option<String>) -> Result<String, String> {
    desktop.host = clean(&desktop.host, "hôte")?;
    if desktop.host.is_empty() || desktop.host.contains(char::is_whitespace) {
        return Err("hôte invalide".into());
    }
    desktop.username = clean(&desktop.username, "utilisateur")?;
    desktop.domain = desktop.domain.as_deref().map(|d| clean(d, "domaine")).transpose()?.filter(|d| !d.is_empty());
    desktop.name = clean(&desktop.name, "nom")?;
    if desktop.name.is_empty() {
        desktop.name = desktop.host.clone();
    }
    desktop.identity_id = desktop.identity_id.filter(|i| !i.is_empty());
    desktop.via_server_id = desktop.via_server_id.filter(|i| !i.is_empty());
    if let Some(i) = &desktop.identity_id {
        store.identity(i)?;
    }
    if let Some(s) = &desktop.via_server_id {
        store.server(s)?;
    }
    if desktop.port == 0 {
        desktop.port = desktop.protocol.default_port();
    }
    if desktop.id.is_empty() {
        desktop.id = uuid::Uuid::new_v4().to_string();
    } else if !zenytt_profiles::valid_id(&desktop.id) {
        return Err("identifiant de bureau invalide".into());
    }
    let id = desktop.id.clone();
    if let Some(p) = password {
        secrets::set(&RemoteDesktop::secret_owner(&id), "password", &p)?;
    }
    store.write(|d| match d.desktops.iter_mut().find(|x| x.id == id) {
        Some(existing) => *existing = desktop,
        None => d.desktops.push(desktop),
    })?;
    Ok(id)
}

#[tauri::command]
pub fn desktop_delete(store: State<'_, Store>, tunnels: State<'_, Tunnels>, id: String) -> Result<(), String> {
    tunnels.stop(&tunnel_id(&id));
    store.write(|d| d.desktops.retain(|x| x.id != id))?;
    secrets::delete_all(&RemoteDesktop::secret_owner(&id));
    Ok(())
}

/// Bureau enregistré, revérifié avant usage : il a pu arriver par un import d'une version
/// antérieure, sans passer par [`desktop_save`] (voir [`RemoteDesktop::is_valid`]).
fn find_desktop(store: &Store, id: &str) -> Result<RemoteDesktop, String> {
    let d = store.read(|data| data.desktops.iter().find(|x| x.id == id).cloned()).ok_or("bureau à distance introuvable")?;
    if !d.is_valid() {
        return Err(
            "ce bureau à distance contient des valeurs invalides (identifiant, hôte ou utilisateur) : modifie-le ou supprime-le".into()
        );
    }
    Ok(d)
}

fn tunnel_id(desktop: &str) -> String {
    format!("rdp-{desktop}")
}

/// Contenu du fichier .rdp (options courantes de mstsc).
fn rdp_file(d: &RemoteDesktop, address: &str, username: &str) -> String {
    let mut lines = vec![
        format!("full address:s:{address}"),
        format!("username:s:{username}"),
        format!("screen mode id:i:{}", if d.fullscreen { 2 } else { 1 }),
        format!("use multimon:i:{}", u8::from(d.multimon)),
        "redirectclipboard:i:1".to_string(),
        "authentication level:i:2".to_string(),
        "prompt for credentials:i:0".to_string(),
        "autoreconnection enabled:i:1".to_string(),
        "smart sizing:i:1".to_string(),
        "dynamic resolution:i:1".to_string(),
    ];
    if !d.fullscreen {
        lines.push(format!("desktopwidth:i:{}", d.width.unwrap_or(1600)));
        lines.push(format!("desktopheight:i:{}", d.height.unwrap_or(900)));
    }
    if d.redirect_drives {
        lines.push("drivestoredirect:s:*".to_string());
    }
    lines.join("\r\n") + "\r\n"
}

/// Utilisateur (avec domaine) et mot de passe du bureau : ceux de l'identifiant de la banque s'il y en a un.
fn credentials(store: &Store, d: &RemoteDesktop) -> Result<(String, Option<String>), String> {
    let (user, password) = match &d.identity_id {
        Some(i) => (store.identity(i)?.username, secrets::get(&Identity::secret_owner(i), "password")),
        None => (d.username.clone(), secrets::get(&RemoteDesktop::secret_owner(&d.id), "password")),
    };
    let user = match d.domain.as_deref() {
        Some(domain) if !user.contains('\\') && !user.contains('@') => format!("{domain}\\{user}"),
        _ => user,
    };
    // L'utilisateur peut venir d'un identifiant de la banque : une ligne de plus dans le .rdp
    // ajouterait ses propres options (partage des disques, programme au démarrage…).
    let user = clean(&user, "utilisateur")?;
    Ok((user, password))
}

/// Premier port local libre (sur 127.0.0.1) pour le tunnel.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

/// Ouvre le bureau à distance. Avec un serveur de rebond, un tunnel SSH local est ouvert et
/// refermé quand la fenêtre RDP se ferme (Windows).
#[tauri::command]
pub async fn desktop_launch(app: AppHandle, store: State<'_, Store>, tunnels: State<'_, Tunnels>, id: String) -> Result<String, String> {
    let d = find_desktop(&store, &id)?;
    if d.protocol == DesktopProtocol::Vnc {
        // Client du système pour un bureau VNC : remote-viewer (virt-viewer), comme pour SPICE.
        let (_, password) = credentials(&store, &d)?;
        let target = ViewerTarget {
            key: &d.id,
            via: d.via_server_id.as_deref(),
            label: &d.name,
            kind: "vnc",
            host: &d.host,
            port: d.port,
            password: password.as_deref(),
            fullscreen: d.fullscreen,
        };
        open_in_remote_viewer(&app, &tunnels, target).await?;
        return Ok("Bureau VNC ouvert dans remote-viewer".into());
    }
    if d.protocol == DesktopProtocol::Spice {
        return spice_launch(&app, &store, &tunnels, &d).await;
    }
    let (user, password) = credentials(&store, &d)?;
    let tid = tunnel_id(&d.id);
    let (host, port) = match &d.via_server_id {
        Some(server) => {
            tunnels.stop(&tid);
            let local_port = free_port()?;
            let def = TunnelDef {
                id: tid.clone(),
                server_id: server.clone(),
                name: format!("RDP {}", d.name),
                local_port,
                remote_host: d.host.clone(),
                remote_port: d.port,
                auto_start: false,
            };
            tunnels.start(&app, def).await?;
            ("127.0.0.1".to_string(), local_port)
        }
        None => (d.host.clone(), d.port),
    };
    let address = if port == 3389 { host.clone() } else { format!("{host}:{port}") };
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("rdp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.rdp", d.id));
    write_private(&file, rdp_file(&d, &address, &user).as_bytes())?;
    log::info!("bureau à distance « {} » ouvert ({address}{})", d.name, if d.via_server_id.is_some() { ", via un tunnel SSH" } else { "" });
    launch(&app, &file, &host, port, &user, password.as_deref(), d.via_server_id.as_ref().map(|_| tid))
}

/// Tout ce qu'il faut au client RDP intégré pour ouvrir la session.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpSession {
    /// Adresse du pont local (WebSocket), jeton compris.
    pub proxy_url: String,
    pub token: String,
    /// Machine vue depuis le pont : l'hôte réel, ou l'entrée locale du tunnel SSH.
    pub destination: String,
    pub username: String,
    pub domain: Option<String>,
    pub password: String,
    pub width: u32,
    pub height: u32,
    /// Vrai quand la connexion passe par un tunnel SSH (affiché dans l'onglet).
    pub via_tunnel: bool,
}

/// Ouvre une session pour le client RDP intégré : tunnel si la machine passe par un serveur, puis
/// pont local. Le mot de passe ne quitte pas l'app (il va du coffre-fort au client, en mémoire).
#[tauri::command]
pub async fn desktop_session_open(
    app: AppHandle,
    store: State<'_, Store>,
    tunnels: State<'_, Tunnels>,
    bridges: State<'_, crate::rdp_bridge::Bridges>,
    id: String,
) -> Result<RdpSession, String> {
    let d = find_desktop(&store, &id)?;
    if d.protocol != DesktopProtocol::Rdp {
        return Err("ce bureau n'est pas en RDP : il ne s'ouvre pas dans le client RDP intégré".into());
    }
    let (user, password) = credentials(&store, &d)?;
    let password = password.ok_or("aucun mot de passe enregistré pour ce bureau à distance")?;
    // L'utilisateur est renvoyé sans le domaine : le client RDP les transmet séparément.
    let (username, domain) = match user.split_once('\\') {
        Some((dom, u)) => (u.to_string(), Some(dom.to_string())),
        None => (user, d.domain.clone()),
    };

    let tid = tunnel_id(&d.id);
    let (host, port) = match &d.via_server_id {
        Some(server) => {
            tunnels.stop(&tid);
            let local_port = free_port()?;
            let def = TunnelDef {
                id: tid.clone(),
                server_id: server.clone(),
                name: format!("RDP {}", d.name),
                local_port,
                remote_host: d.host.clone(),
                remote_port: d.port,
                auto_start: false,
            };
            tunnels.start(&app, def).await?;
            ("127.0.0.1".to_string(), local_port)
        }
        None => (d.host.clone(), d.port),
    };

    let bridge = crate::rdp_bridge::start(host.clone(), port).await?;
    let session = RdpSession {
        proxy_url: bridge.url.clone(),
        token: bridge.token.clone(),
        destination: format!("{host}:{port}"),
        username,
        domain,
        password,
        width: d.width.unwrap_or(1600),
        height: d.height.unwrap_or(900),
        via_tunnel: d.via_server_id.is_some(),
    };
    bridges.keep(&id, bridge);
    log::info!("bureau à distance « {} » ouvert dans Zenytt ({host}:{port})", d.name);
    Ok(session)
}

/// Écrit un fichier réservé à l'utilisateur (0600 dès sa création sous Unix ; sous Windows, le
/// dossier de cache de l'app est déjà propre au compte). Un fichier existant est remplacé.
fn write_private(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    // Supprimé puis recréé : les droits ci-dessous s'appliquent à la création. Si la suppression
    // échoue (fichier encore ouvert par le client sous Windows), il est réécrit en place.
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(|e| format!("{} : {e}", path.display()))?;
    f.write_all(content).map_err(|e| e.to_string())
}

/// Fichier de connexion de remote-viewer (format `.vv` de virt-viewer), `kind` : `spice` ou `vnc`.
/// `delete-this-file=1` demande à remote-viewer d'effacer le fichier dès qu'il l'a lu : le mot de
/// passe ne reste pas sur le disque.
fn vv_file(kind: &str, title: &str, host: &str, port: u16, password: Option<&str>, fullscreen: bool) -> Result<String, String> {
    if !matches!(kind, "spice" | "vnc") {
        return Err("type d'écran inconnu".into());
    }
    let title = clean(title, "nom")?;
    let mut lines = vec![
        "[virt-viewer]".to_string(),
        format!("type={kind}"),
        format!("host={host}"),
        format!("port={port}"),
        format!("title={title}"),
        "delete-this-file=1".to_string(),
        format!("fullscreen={}", u8::from(fullscreen)),
        // Ni carte à puce ni USB redirigés : inutile pour une console, et autant de surface en moins.
        "enable-smartcard=0".to_string(),
        "enable-usbredir=0".to_string(),
    ];
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        // Une seule ligne par valeur : un retour à la ligne ajouterait ses propres clés.
        if pw.chars().any(char::is_control) {
            return Err("mot de passe de l'écran invalide".into());
        }
        lines.push(format!("password={pw}"));
    }
    Ok(lines.join("\n") + "\n")
}

/// Trouve remote-viewer : dans le PATH, puis (Windows) dans le dossier d'installation de virt-viewer.
fn remote_viewer() -> Result<std::path::PathBuf, String> {
    let exe = if cfg!(windows) { "remote-viewer.exe" } else { "remote-viewer" };
    if let Some(p) = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| p.is_file())) {
        return Ok(p);
    }
    #[cfg(windows)]
    {
        for base in ["C:\\Program Files", "C:\\Program Files (x86)"] {
            if let Ok(entries) = std::fs::read_dir(base) {
                for e in entries.flatten() {
                    let candidate = e.path().join("bin").join(exe);
                    if e.file_name().to_string_lossy().starts_with("VirtViewer") && candidate.is_file() {
                        return Ok(candidate);
                    }
                }
            }
        }
    }
    Err("remote-viewer (virt-viewer) n'est pas installé : https://virt-manager.org/download — sous macOS « brew install virt-viewer », sous Linux le paquet virt-viewer".into())
}

/// Écran à ouvrir dans remote-viewer : `host:port` vu depuis `via` (serveur SSH) s'il y en a un,
/// sinon depuis ce PC.
pub(crate) struct ViewerTarget<'a> {
    /// Identifiant de la session (tunnel `rdp-<key>`).
    pub key: &'a str,
    pub via: Option<&'a str>,
    pub label: &'a str,
    /// `spice` ou `vnc`.
    pub kind: &'a str,
    pub host: &'a str,
    pub port: u16,
    pub password: Option<&'a str>,
    pub fullscreen: bool,
}

/// Ouvre un écran SPICE ou VNC dans remote-viewer, à travers un tunnel SSH si la machine passe par
/// un serveur (SPICE sans TLS et VNC font circuler l'écran en clair). Le tunnel vit aussi longtemps
/// que la fenêtre de remote-viewer.
pub(crate) async fn open_in_remote_viewer(app: &AppHandle, tunnels: &Tunnels, t: ViewerTarget<'_>) -> Result<(), String> {
    let viewer = remote_viewer()?;
    let tid = tunnel_id(t.key);
    let (host, port) = match t.via {
        Some(server) => {
            tunnels.stop(&tid);
            let local_port = free_port()?;
            let def = TunnelDef {
                id: tid.clone(),
                server_id: server.to_string(),
                name: format!("{} {}", t.kind.to_uppercase(), t.label),
                local_port,
                remote_host: t.host.to_string(),
                remote_port: t.port,
                auto_start: false,
            };
            tunnels.start(app, def).await?;
            ("127.0.0.1".to_string(), local_port)
        }
        None => (t.host.to_string(), t.port),
    };
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("spice");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.vv", t.key));
    // Le fichier peut contenir le mot de passe : créé d'emblée lisible par l'utilisateur seul (et
    // non restreint après coup, ce qui laissait un instant où il était lisible par tous), le temps
    // que remote-viewer le lise puis l'efface.
    write_private(&file, vv_file(t.kind, t.label, &host, port, t.password, t.fullscreen)?.as_bytes())?;
    let mut child = std::process::Command::new(&viewer).arg(&file).spawn().map_err(|e| format!("remote-viewer : {e}"))?;
    log::info!(
        "écran {} « {} » ouvert dans remote-viewer ({host}:{port}{})",
        t.kind,
        t.label,
        if t.via.is_some() { ", via un tunnel SSH" } else { "" }
    );
    let via = t.via.is_some();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = child.wait();
        // Filet de sécurité si remote-viewer n'a pas effacé le fichier (ancienne version, échec).
        let _ = std::fs::remove_file(&file);
        if via {
            app.state::<Tunnels>().stop(&tid);
        }
    });
    Ok(())
}

/// Ouvre une console SPICE enregistrée dans remote-viewer.
async fn spice_launch(app: &AppHandle, store: &Store, tunnels: &Tunnels, d: &RemoteDesktop) -> Result<String, String> {
    let (_, password) = credentials(store, d)?;
    let target = ViewerTarget {
        key: &d.id,
        via: d.via_server_id.as_deref(),
        label: &d.name,
        kind: "spice",
        host: &d.host,
        port: d.port,
        password: password.as_deref(),
        fullscreen: d.fullscreen,
    };
    open_in_remote_viewer(app, tunnels, target).await?;
    Ok("Console SPICE ouverte dans remote-viewer".into())
}

/// Tout ce qu'il faut au client VNC intégré (noVNC) pour ouvrir la session.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncSession {
    /// Adresse du pont local (WebSocket), jeton compris.
    pub url: String,
    /// Mot de passe VNC, ou vide si le serveur n'en demande pas. Il va du coffre au client, en
    /// mémoire : il n'est jamais écrit sur le disque ni placé dans l'adresse.
    pub password: String,
    /// Utilisateur, pour les serveurs qui en demandent un (macOS, VeNCrypt avec identifiant).
    pub username: String,
    pub destination: String,
    pub via_tunnel: bool,
}

/// Ouvre une session VNC dans Zenytt : tunnel SSH si la machine passe par un serveur, puis pont
/// local WebSocket ↔ TCP. Le port VNC n'a donc jamais besoin d'être exposé à Internet — c'est
/// d'autant plus important que VNC, sans chiffrement, fait circuler l'écran en clair.
#[tauri::command]
pub async fn vnc_session_open(
    app: AppHandle,
    store: State<'_, Store>,
    tunnels: State<'_, Tunnels>,
    bridges: State<'_, crate::rdp_bridge::Bridges>,
    id: String,
) -> Result<VncSession, String> {
    let d = find_desktop(&store, &id)?;
    if d.protocol != DesktopProtocol::Vnc {
        return Err("ce bureau n'est pas en VNC".into());
    }
    let (user, password) = credentials(&store, &d)?;
    // Le domaine n'a pas de sens en VNC : seul l'utilisateur est transmis.
    let username = user.rsplit('\\').next().unwrap_or(&user).to_string();
    let password = password.unwrap_or_default();
    if let Some(server) = &d.via_server_id {
        let session = open_vnc_via(&app, &tunnels, &bridges, &id, server, &d.name, &d.host, d.port, password, username).await?;
        log::info!("bureau VNC « {} » ouvert dans Zenytt ({}:{} par un tunnel SSH)", d.name, d.host, d.port);
        return Ok(session);
    }
    let (host, port) = (d.host.clone(), d.port);
    let bridge = crate::vnc_bridge::start(host.clone(), port).await?;
    let session = VncSession { url: bridge.url.clone(), password, username, destination: format!("{host}:{port}"), via_tunnel: false };
    bridges.keep(&id, bridge);
    log::info!("bureau VNC « {} » ouvert dans Zenytt ({host}:{port})", d.name);
    Ok(session)
}

/// Écran VNC d'une machine joignable depuis un serveur (bureau enregistré, écran d'une VM) :
/// tunnel SSH vers `remote_host:port` vu du serveur, puis pont local WebSocket. `key` identifie la
/// session pour la fermer (`desktop_session_close`). Rien n'est exposé sur Internet.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn open_vnc_via(
    app: &AppHandle,
    tunnels: &Tunnels,
    bridges: &crate::rdp_bridge::Bridges,
    key: &str,
    server_id: &str,
    label: &str,
    remote_host: &str,
    port: u16,
    password: String,
    username: String,
) -> Result<VncSession, String> {
    let tid = tunnel_id(key);
    tunnels.stop(&tid);
    let local_port = free_port()?;
    let def = TunnelDef {
        id: tid,
        server_id: server_id.to_string(),
        name: format!("VNC {label}"),
        local_port,
        remote_host: remote_host.to_string(),
        remote_port: port,
        auto_start: false,
    };
    tunnels.start(app, def).await?;
    let bridge = crate::vnc_bridge::start("127.0.0.1".to_string(), local_port).await?;
    let session =
        VncSession { url: bridge.url.clone(), password, username, destination: format!("{remote_host}:{port}"), via_tunnel: true };
    bridges.keep(key, bridge);
    Ok(session)
}

/// Ferme la session : pont local et tunnel éventuel.
#[tauri::command]
pub fn desktop_session_close(tunnels: State<'_, Tunnels>, bridges: State<'_, crate::rdp_bridge::Bridges>, id: String) {
    bridges.stop(&id);
    tunnels.stop(&tunnel_id(&id));
}

#[cfg(windows)]
fn launch(
    app: &AppHandle,
    file: &std::path::Path,
    host: &str,
    _port: u16,
    user: &str,
    password: Option<&str>,
    tunnel: Option<String>,
) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Identifiants lus par mstsc (TERMSRV/<hôte>) : enregistrés dans le Gestionnaire d'identification
    // de Windows, comme le fait « Mémoriser mes informations » de la connexion Bureau à distance.
    if let Some(pw) = password {
        let status = std::process::Command::new("cmdkey")
            .arg(format!("/generic:TERMSRV/{host}"))
            .arg(format!("/user:{user}"))
            .arg(format!("/pass:{pw}"))
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("cmdkey : {e}"))?;
        if !status.success() {
            log::warn!("cmdkey a échoué : le mot de passe sera demandé par mstsc");
        }
    }
    let mut child = std::process::Command::new("mstsc").arg(file).spawn().map_err(|e| format!("mstsc introuvable : {e}"))?;
    // Le tunnel vit aussi longtemps que la fenêtre RDP.
    if let Some(tid) = tunnel {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = child.wait();
            app.state::<Tunnels>().stop(&tid);
        });
    }
    Ok("Connexion Bureau à distance ouverte".into())
}

#[cfg(target_os = "macos")]
fn launch(
    _app: &AppHandle,
    file: &std::path::Path,
    _host: &str,
    _port: u16,
    _user: &str,
    _password: Option<&str>,
    tunnel: Option<String>,
) -> Result<String, String> {
    // Windows App (ex-Microsoft Remote Desktop) ouvre les fichiers .rdp et demande le mot de passe.
    std::process::Command::new("open").arg(file).status().map_err(|e| e.to_string())?;
    Ok(if tunnel.is_some() {
        "Fichier .rdp ouvert (le tunnel SSH reste actif jusqu'à la fermeture de Zenytt)".into()
    } else {
        "Fichier .rdp ouvert dans Windows App".into()
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launch(
    app: &AppHandle,
    _file: &std::path::Path,
    host: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    tunnel: Option<String>,
) -> Result<String, String> {
    use std::io::Write;
    // FreeRDP : le mot de passe passe par l'entrée standard, jamais par la ligne de commande.
    let bin = ["xfreerdp3", "xfreerdp", "wlfreerdp"]
        .into_iter()
        .find(|b| {
            std::process::Command::new("sh").arg("-c").arg(format!("command -v {b}")).output().map(|o| o.status.success()).unwrap_or(false)
        })
        .ok_or("FreeRDP n'est pas installé (paquet freerdp3-x11 ou freerdp2-x11)")?;
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("/v:{host}:{port}")).arg(format!("/u:{user}")).arg("+clipboard").arg("/dynamic-resolution");
    if password.is_some() {
        cmd.arg("/from-stdin:force").stdin(std::process::Stdio::piped());
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let (Some(pw), Some(mut stdin)) = (password, child.stdin.take()) {
        let _ = writeln!(stdin, "{pw}");
    }
    if let Some(tid) = tunnel {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = child.wait();
            app.state::<Tunnels>().stop(&tid);
        });
    }
    Ok("Connexion Bureau à distance ouverte".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desktop() -> RemoteDesktop {
        RemoteDesktop {
            id: "a".into(),
            name: "PC".into(),
            protocol: DesktopProtocol::Rdp,
            host: "pc.lan".into(),
            port: 3389,
            username: "alice".into(),
            domain: Some("MAISON".into()),
            identity_id: None,
            via_server_id: None,
            fullscreen: false,
            width: None,
            height: None,
            multimon: true,
            redirect_drives: true,
            color: None,
            group: None,
        }
    }

    #[test]
    fn rdp_file_content() {
        let f = rdp_file(&desktop(), "127.0.0.1:50000", "MAISON\\alice");
        assert!(f.contains("full address:s:127.0.0.1:50000\r\n"));
        assert!(f.contains("username:s:MAISON\\alice\r\n"));
        assert!(f.contains("screen mode id:i:1") && f.contains("desktopwidth:i:1600"));
        assert!(f.contains("use multimon:i:1") && f.contains("drivestoredirect:s:*"));
        let full = rdp_file(&RemoteDesktop { fullscreen: true, redirect_drives: false, ..desktop() }, "h", "u");
        assert!(full.contains("screen mode id:i:2") && !full.contains("desktopwidth") && !full.contains("drivestoredirect"));
    }

    #[test]
    fn spice_file_forgets_its_password() {
        let vv = vv_file("spice", "VM de test", "127.0.0.1", 61000, Some("s3cret"), false).unwrap();
        assert!(vv.starts_with("[virt-viewer]\ntype=spice\n"));
        assert!(vv.contains("host=127.0.0.1\nport=61000\n"));
        assert!(vv.contains("delete-this-file=1"), "remote-viewer doit effacer le fichier après lecture");
        assert!(vv.contains("password=s3cret\n"));
        assert!(!vv_file("spice", "VM", "h", 1, None, true).unwrap().contains("password="));
        // Un retour à la ligne dans une valeur ajouterait ses propres clés au fichier.
        assert!(vv_file("spice", "VM\nhost=evil", "h", 1, None, false).is_err());
        assert!(vv_file("spice", "VM", "h", 1, Some("a\nhost=evil"), false).is_err());
        // Écran VNC d'une VM ouvert dans le client du système (tiroir Machines).
        assert!(vv_file("vnc", "VM", "h", 5900, None, false).unwrap().starts_with("[virt-viewer]\ntype=vnc\n"));
        assert!(vv_file("rdp\nhost=evil", "VM", "h", 1, None, false).is_err());
    }

    #[test]
    fn values_are_single_line() {
        assert!(clean("pc.lan\r\nusername:s:x", "hôte").is_err());
        assert_eq!(clean("  pc.lan ", "hôte").unwrap(), "pc.lan");
    }
}
