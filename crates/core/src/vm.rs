//! Machines virtuelles KVM/QEMU via libvirt (`virsh` sur le serveur), avec repli sur sudo quand
//! l'utilisateur SSH n'appartient pas au groupe `libvirt`. Une VM est toujours désignée par son
//! UUID dans les commandes : son nom peut contenir n'importe quel caractère.

use serde::Serialize;

use crate::ssh::shell_quote;

use crate::{Connection, Error, ExecOutput, Result};

/// Préfixe de toutes les commandes : sortie en anglais stable et connexion système (la session
/// utilisateur `qemu:///session` montrerait d'autres VM).
const VIRSH: &str = "LC_ALL=C virsh -c qemu:///system";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Direct,
    Sudo,
    Unavailable,
}

pub async fn access(conn: &Connection, sudo: Option<&str>) -> Result<(Access, String)> {
    let probe = format!("{VIRSH} version --daemon 2>&1 | sed -n 's/^Running against daemon: //p'");
    let direct = conn.exec(&format!("{VIRSH} list --name >/dev/null && {probe}"), None).await?;
    if direct.success() {
        return Ok((Access::Direct, direct.stdout.trim().to_string()));
    }
    if !conn.exec("command -v virsh", None).await?.success() {
        return Ok((Access::Unavailable, "libvirt (virsh) n'est pas installé sur ce serveur".into()));
    }
    let via_sudo = match conn.exec_sudo(&format!("{VIRSH} list --name >/dev/null && {probe}"), sudo, None).await {
        Ok(o) => o,
        Err(Error::Other(reason)) => return Ok((Access::Unavailable, reason)),
        Err(e) => return Err(e),
    };
    if via_sudo.success() {
        return Ok((Access::Sudo, via_sudo.stdout.trim().to_string()));
    }
    Ok((Access::Unavailable, direct.stderr.trim().to_string()))
}

pub async fn run(conn: &Connection, access: Access, sudo: Option<&str>, args: &str) -> Result<ExecOutput> {
    let cmd = format!("{VIRSH} {args}");
    match access {
        Access::Direct => conn.exec(&cmd, None).await,
        Access::Sudo => conn.exec_sudo(&cmd, sudo, None).await,
        Access::Unavailable => Err(Error::Other("libvirt n'est pas accessible sur ce serveur".into())),
    }
}

pub fn valid_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VmState {
    Running,
    Paused,
    ShutOff,
    Shutdown,
    Crashed,
    Suspended,
    Other,
}

impl VmState {
    pub fn parse(s: &str) -> Self {
        match s.trim() {
            "running" | "idle" => Self::Running,
            "paused" => Self::Paused,
            "shut off" => Self::ShutOff,
            "in shutdown" => Self::Shutdown,
            "crashed" => Self::Crashed,
            "pmsuspended" => Self::Suspended,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vm {
    pub uuid: String,
    pub name: String,
    pub state: VmState,
    pub vcpus: u32,
    pub memory_kib: u64,
    pub autostart: bool,
    pub persistent: bool,
}

/// Une ligne `@@ <uuid>` puis la sortie de `virsh dominfo` pour chaque VM.
const INVENTORY: &str = "for u in $(VIRSH list --all --uuid); do echo \"@@ $u\"; VIRSH dominfo \"$u\"; done";

pub async fn list(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<Vm>> {
    let script = INVENTORY.replace("VIRSH", VIRSH);
    let out = match access {
        Access::Direct => conn.exec(&script, None).await?,
        Access::Sudo => conn.exec_sudo(&script, sudo, None).await?,
        Access::Unavailable => return Err(Error::Other("libvirt n'est pas accessible sur ce serveur".into())),
    };
    let mut vms = parse_inventory(&out.into_result()?.stdout);
    vms.sort_by(|a, b| (a.state != VmState::Running).cmp(&(b.state != VmState::Running)).then(a.name.cmp(&b.name)));
    Ok(vms)
}

pub(crate) fn parse_inventory(text: &str) -> Vec<Vm> {
    let mut vms = Vec::new();
    for block in text.split("@@ ").skip(1) {
        let mut lines = block.lines();
        let uuid = lines.next().unwrap_or("").trim().to_string();
        if !valid_uuid(&uuid) {
            continue;
        }
        let mut vm = Vm { uuid, name: String::new(), state: VmState::Other, vcpus: 0, memory_kib: 0, autostart: false, persistent: false };
        for line in lines {
            let Some((key, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            match key.trim() {
                "Name" => vm.name = value.to_string(),
                "State" => vm.state = VmState::parse(value),
                "CPU(s)" => vm.vcpus = value.parse().unwrap_or(0),
                "Max memory" => vm.memory_kib = value.trim_end_matches(" KiB").parse().unwrap_or(0),
                "Autostart" => vm.autostart = value == "enable",
                "Persistent" => vm.persistent = value == "yes",
                _ => {}
            }
        }
        vms.push(vm);
    }
    vms
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub target: String,
    /// `disk` ou `cdrom`.
    pub device: String,
    pub source: Option<String>,
    pub format: Option<String>,
    /// Disque en lecture seule ou partagé avec d'autres VM : jamais supprimé avec la VM.
    pub shared: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Nic {
    pub mac: String,
    /// Réseau libvirt ou pont auquel la carte est reliée.
    pub source: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Graphics {
    /// `port` est absent tant que la VM est éteinte (attribution automatique au démarrage).
    Vnc {
        port: Option<u16>,
        listen: String,
        public: bool,
        password: bool,
    },
    /// VNC sur un socket Unix (`<listen type='socket'>`) : rien à joindre par un tunnel TCP.
    VncSocket,
    /// Écran SPICE : non affiché dans Zenytt, mais ouvert dans remote-viewer par un tunnel.
    Spice {
        port: Option<u16>,
        listen: String,
        password: bool,
    },
    None,
}

/// Adresse à joindre, depuis le serveur, pour atteindre l'écran VNC d'une VM.
///
/// Une adresse joker (`0.0.0.0`, `::`) ou de boucle locale se joint par `127.0.0.1`. Une adresse
/// précise (ex. l'IP du réseau local) n'écoute pas sur la boucle locale : il faut viser celle-là.
pub fn vnc_connect_host(listen: &str) -> String {
    let l = listen.trim().trim_start_matches('[').trim_end_matches(']');
    match l {
        "" | "0.0.0.0" | "::" | "*" | "localhost" | "::1" => "127.0.0.1".into(),
        _ if l.starts_with("127.") => "127.0.0.1".into(),
        _ => l.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VmDetail {
    pub disks: Vec<Disk>,
    pub nics: Vec<Nic>,
    pub graphics: Graphics,
    pub os: String,
    pub machine: String,
    /// `bios` ou `uefi`.
    pub firmware: String,
    /// Adresses IP connues (baux DHCP de libvirt, ou agent invité). Remplies par `detail`.
    pub ips: Vec<String>,
}

/// Premier enfant d'un nœud XML portant ce nom.
fn child<'a, 'i>(n: roxmltree::Node<'a, 'i>, tag: &str) -> Option<roxmltree::Node<'a, 'i>> {
    n.children().find(|c| c.has_tag_name(tag))
}

pub(crate) fn parse_detail(xml: &str) -> Result<VmDetail> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| Error::Other(format!("description de la VM illisible : {e}")))?;
    let root = doc.root_element();
    let os = child(root, "os");
    let os_type = os.and_then(|o| child(o, "type"));
    let devices = child(root, "devices");
    let all = |tag: &'static str| devices.into_iter().flat_map(move |d| d.children().filter(move |c| c.has_tag_name(tag)));

    let disks = all("disk")
        .map(|d| Disk {
            target: child(d, "target").and_then(|t| t.attribute("dev")).unwrap_or("").to_string(),
            device: d.attribute("device").unwrap_or("disk").to_string(),
            source: child(d, "source")
                .and_then(|s| s.attribute("file").or(s.attribute("dev")).or(s.attribute("volume")))
                .map(str::to_string),
            format: child(d, "driver").and_then(|s| s.attribute("type")).map(str::to_string),
            shared: child(d, "readonly").is_some() || child(d, "shareable").is_some(),
        })
        .collect();
    let nics = all("interface")
        .map(|i| Nic {
            mac: child(i, "mac").and_then(|m| m.attribute("address")).unwrap_or("").to_string(),
            source: child(i, "source")
                .and_then(|s| s.attribute("network").or(s.attribute("bridge")).or(s.attribute("dev")))
                .unwrap_or("")
                .to_string(),
            model: child(i, "model").and_then(|m| m.attribute("type")).map(str::to_string),
        })
        .collect();
    let graphics = match all("graphics").next() {
        // Écran VNC sur un socket Unix : pas de port TCP à joindre par un tunnel.
        Some(g) if g.attribute("type") == Some("vnc") && child(g, "listen").and_then(|l| l.attribute("type")) == Some("socket") => {
            Graphics::VncSocket
        }
        Some(g) if g.attribute("type") == Some("vnc") => {
            let listen =
                child(g, "listen").and_then(|l| l.attribute("address")).or(g.attribute("listen")).unwrap_or("127.0.0.1").to_string();
            Graphics::Vnc {
                port: g.attribute("port").and_then(|p| p.parse().ok()).filter(|p: &u16| *p > 0),
                public: !(listen.starts_with("127.") || listen == "::1" || listen == "localhost"),
                password: g.attribute("passwd").is_some(),
                listen,
            }
        }
        Some(g) if g.attribute("type") == Some("spice") => {
            let listen =
                child(g, "listen").and_then(|l| l.attribute("address")).or(g.attribute("listen")).unwrap_or("127.0.0.1").to_string();
            Graphics::Spice {
                // Sans port TCP (socket Unix, éteinte) : rien à joindre par un tunnel.
                port: g.attribute("port").and_then(|p| p.parse().ok()).filter(|p: &u16| *p > 0),
                password: g.attribute("passwd").is_some(),
                listen,
            }
        }
        // Autres affichages (egl-headless, dbus…) : rien à ouvrir à distance.
        Some(_) | None => Graphics::None,
    };
    let firmware = if os.and_then(|o| o.attribute("firmware")) == Some("efi") || os.and_then(|o| child(o, "loader")).is_some() {
        "uefi"
    } else {
        "bios"
    };
    Ok(VmDetail {
        disks,
        nics,
        graphics,
        os: os_type.and_then(|t| t.text()).unwrap_or("hvm").to_string(),
        machine: os_type.and_then(|t| t.attribute("machine")).unwrap_or("").to_string(),
        firmware: firmware.to_string(),
        ips: Vec::new(),
    })
}

/// Mot de passe de l'écran `kind` (`vnc` ou `spice`) d'une VM, lu dans `dumpxml --security-info`
/// (absent du XML ordinaire).
pub(crate) fn display_password(xml: &str, kind: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    let devices = child(doc.root_element(), "devices")?;
    devices.children().find(|g| g.has_tag_name("graphics") && g.attribute("type") == Some(kind))?.attribute("passwd").map(str::to_string)
}

/// Mot de passe de l'écran VNC, s'il y en a un.
pub async fn vnc_password_of(conn: &Connection, access: Access, sudo: Option<&str>, uuid: &str) -> Result<Option<String>> {
    display_password_of(conn, access, sudo, uuid, "vnc").await
}

/// Mot de passe de l'écran `kind` (`vnc` ou `spice`), s'il y en a un.
pub async fn display_password_of(conn: &Connection, access: Access, sudo: Option<&str>, uuid: &str, kind: &str) -> Result<Option<String>> {
    if !valid_uuid(uuid) {
        return Err(Error::Other("identifiant de VM invalide".into()));
    }
    let xml = run(conn, access, sudo, &format!("dumpxml --security-info {}", shell_quote(uuid))).await?.into_result()?.stdout;
    Ok(display_password(&xml, kind))
}

fn xml_attr(value: &str) -> String {
    value.replace('&', "&amp;").replace('\'', "&apos;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Réécrit la définition d'une VM pour que son écran VNC n'écoute plus que sur 127.0.0.1.
///
/// Seul l'élément `<graphics type='vnc'>` est reconstruit (mêmes attributs et enfants, sauf
/// l'adresse d'écoute) : le reste du XML est repris octet pour octet.
pub fn restrict_vnc_xml(xml: &str) -> Result<String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| Error::Other(format!("définition de VM illisible : {e}")))?;
    let g = doc
        .descendants()
        .find(|n| n.has_tag_name("graphics") && n.attribute("type") == Some("vnc"))
        .ok_or_else(|| Error::Other("cette VM n'a pas d'écran VNC".into()))?;
    let mut out = String::from("<graphics");
    for a in g.attributes().filter(|a| a.name() != "listen") {
        out.push_str(&format!(" {}='{}'", a.name(), xml_attr(a.value())));
    }
    out.push_str(" listen='127.0.0.1'>\n      <listen type='address' address='127.0.0.1'/>");
    for c in g.children().filter(|c| c.is_element() && !c.has_tag_name("listen")) {
        out.push_str("\n      ");
        out.push_str(&xml[c.range()]);
    }
    out.push_str("\n    </graphics>");
    let r = g.range();
    Ok(format!("{}{}{}", &xml[..r.start], out, &xml[r.end..]))
}

/// Restreint l'écran VNC d'une VM à 127.0.0.1 (effectif au prochain démarrage de la VM).
pub async fn restrict_vnc(conn: &Connection, access: Access, sudo: Option<&str>, uuid: &str) -> Result<()> {
    if !valid_uuid(uuid) {
        return Err(Error::Other("identifiant de VM invalide".into()));
    }
    // Définition persistante (pas l'état en cours), avec le mot de passe VNC s'il y en a un.
    let xml = run(conn, access, sudo, &format!("dumpxml --inactive --security-info {}", shell_quote(uuid))).await?.into_result()?.stdout;
    let new = restrict_vnc_xml(&xml)?;
    let cmd = format!("{VIRSH} define /dev/stdin");
    let out = match access {
        Access::Direct => conn.exec(&cmd, Some(new.as_bytes())).await?,
        Access::Sudo => conn.exec_sudo(&cmd, sudo, Some(new.as_bytes())).await?,
        Access::Unavailable => return Err(Error::Other("libvirt n'est pas accessible sur ce serveur".into())),
    };
    out.into_result()?;
    Ok(())
}

pub async fn detail(conn: &Connection, access: Access, sudo: Option<&str>, uuid: &str) -> Result<VmDetail> {
    if !valid_uuid(uuid) {
        return Err(Error::Other("identifiant de VM invalide".into()));
    }
    let xml = run(conn, access, sudo, &format!("dumpxml {}", shell_quote(uuid))).await?.into_result()?.stdout;
    let mut d = parse_detail(&xml)?;
    // Adresses : baux DHCP de libvirt d'abord, agent invité ensuite ; une VM éteinte n'en a pas.
    for source in ["lease", "agent"] {
        let out = run(conn, access, sudo, &format!("domifaddr {} --source {source}", shell_quote(uuid))).await?;
        if out.success() {
            d.ips = parse_ifaddr(&out.stdout);
            if !d.ips.is_empty() {
                break;
            }
        }
    }
    Ok(d)
}

/// Adresses de `virsh domifaddr` (colonne « Address », sans le préfixe réseau ni la boucle locale).
pub(crate) fn parse_ifaddr(text: &str) -> Vec<String> {
    text.lines()
        .skip(2)
        .filter_map(|l| l.split_whitespace().nth(3))
        .map(|a| a.split('/').next().unwrap_or(a).to_string())
        .filter(|a| !a.starts_with("127.") && a != "::1")
        .collect()
}

/// `domstats` désigne les VM par leur nom : la couche Tauri (tâche 5) le convertit en UUID.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VmStats {
    pub name: String,
    pub cpu_percent: f64,
    pub memory_used_kib: Option<u64>,
}

pub(crate) fn cpu_percent(before_ns: u64, after_ns: u64, elapsed_ms: u64, vcpus: u32) -> f64 {
    if after_ns < before_ns || elapsed_ms == 0 || vcpus == 0 {
        return 0.0;
    }
    let pct = (after_ns - before_ns) as f64 / (elapsed_ms as f64 * 1_000_000.0 * vcpus as f64) * 100.0;
    (pct * 10.0).round().min(1000.0) / 10.0
}

/// Deux relevés à une seconde d'intervalle des VM en marche.
const STATS: &str = "VIRSH domstats --raw --list-running --cpu-total --vcpu --balloon; echo @@SEP; sleep 1; VIRSH domstats --raw --list-running --cpu-total";

pub async fn stats(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<VmStats>> {
    let script = STATS.replace("VIRSH", VIRSH);
    let out = match access {
        Access::Direct => conn.exec(&script, None).await?,
        Access::Sudo => conn.exec_sudo(&script, sudo, None).await?,
        Access::Unavailable => return Ok(Vec::new()),
    };
    let text = out.into_result()?.stdout;
    let (first, second) = text.split_once("@@SEP").unwrap_or((&text, ""));
    let (a, b) = (parse_domstats(first), parse_domstats(second));
    Ok(a.iter()
        .map(|(name, s)| {
            let after = b.get(name).and_then(|x| x.get("cpu.time")).copied().unwrap_or(0);
            let vcpus = s.get("vcpu.current").copied().unwrap_or(1) as u32;
            VmStats {
                name: name.clone(),
                cpu_percent: cpu_percent(s.get("cpu.time").copied().unwrap_or(0), after, 1000, vcpus),
                memory_used_kib: s.get("balloon.rss").copied(),
            }
        })
        .collect())
}

/// `Domain: 'nom'` puis des lignes `clé=valeur` ; seules les valeurs numériques sont gardées.
pub(crate) fn parse_domstats(text: &str) -> std::collections::HashMap<String, std::collections::HashMap<String, u64>> {
    let mut out = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("Domain: ") {
            let name = name.trim().trim_matches('\'').to_string();
            out.entry(name.clone()).or_insert_with(std::collections::HashMap::new);
            current = Some(name);
        } else if let (Some(name), Some((k, v))) = (&current, line.trim().split_once('=')) {
            if let Ok(v) = v.parse() {
                out.get_mut(name).unwrap().insert(k.to_string(), v);
            }
        }
    }
    out
}

#[derive(Debug, Clone, Copy, serde::Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VmAction {
    Start,
    /// Arrêt propre (ACPI) : le système invité s'éteint lui-même.
    Shutdown,
    Reboot,
    /// Équivalent d'une coupure de courant : confirmation obligatoire côté interface.
    ForceOff,
    Suspend,
    Resume,
    AutostartOn,
    AutostartOff,
}

pub fn action_args(action: VmAction, uuid: &str) -> String {
    let u = shell_quote(uuid);
    match action {
        VmAction::Start => format!("start {u}"),
        VmAction::Shutdown => format!("shutdown {u} --mode acpi"),
        VmAction::Reboot => format!("reboot {u} --mode acpi"),
        VmAction::ForceOff => format!("destroy {u} --graceful"),
        VmAction::Suspend => format!("suspend {u}"),
        VmAction::Resume => format!("resume {u}"),
        VmAction::AutostartOn => format!("autostart {u}"),
        VmAction::AutostartOff => format!("autostart {u} --disable"),
    }
}

pub async fn act(conn: &Connection, access: Access, sudo: Option<&str>, uuid: &str, action: VmAction) -> Result<()> {
    if !valid_uuid(uuid) {
        return Err(Error::Other("identifiant de VM invalide".into()));
    }
    run(conn, access, sudo, &action_args(action, uuid)).await?.into_result()?;
    Ok(())
}

/// Disques propres à la VM, supprimables avec elle : ni lecteur CD (une ISO sert souvent à
/// plusieurs VM), ni disque en lecture seule ou partagé.
pub fn removable_disks(d: &VmDetail) -> Vec<String> {
    d.disks.iter().filter(|x| x.device == "disk" && !x.shared && !x.target.is_empty()).map(|x| x.target.clone()).collect()
}

fn valid_disk_target(t: &str) -> bool {
    t.starts_with(|c: char| c.is_ascii_lowercase()) && t.len() <= 16 && t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// `storage` : disques à supprimer (cibles `vda`…), désignés un par un plutôt que
/// `--remove-all-storage`, qui prendrait aussi les ISO et les disques partagés.
pub fn delete_args(uuid: &str, storage: &[String], uefi: bool) -> Result<String> {
    let mut args = format!("undefine {} --managed-save --snapshots-metadata", shell_quote(uuid));
    if uefi {
        args.push_str(" --nvram");
    }
    if !storage.is_empty() {
        // Les cibles viennent du XML de la VM : seules celles qui ressemblent à `vda`/`sda` passent.
        let ok: Vec<&str> = storage.iter().map(String::as_str).filter(|t| valid_disk_target(t)).collect();
        // Aucune cible valide : mieux vaut refuser que retirer la VM en laissant ses disques.
        if ok.is_empty() {
            return Err(Error::Other("aucun disque valide à supprimer : suppression annulée".into()));
        }
        args.push_str(&format!(" --storage {}", shell_quote(&ok.join(","))));
    }
    Ok(args)
}

/// Fichiers que virsh n'a pas pu supprimer (hors d'un pool libvirt) : il le signale, sans échouer.
pub fn leftover_files(output: &str) -> Vec<String> {
    output
        .lines()
        .filter(|l| l.contains("is not managed by libvirt"))
        .filter_map(|l| {
            let start = l.find("'(")? + 2;
            let end = start + l[start..].find(')')?;
            Some(l[start..end].to_string())
        })
        .collect()
}

/// Supprime la définition de la VM (arrêtée d'abord si besoin) et les disques demandés. Renvoie
/// les fichiers restés sur le serveur (à supprimer à la main).
pub async fn delete(
    conn: &Connection,
    access: Access,
    sudo: Option<&str>,
    uuid: &str,
    storage: &[String],
    uefi: bool,
) -> Result<Vec<String>> {
    if !valid_uuid(uuid) {
        return Err(Error::Other("identifiant de VM invalide".into()));
    }
    let _ = run(conn, access, sudo, &format!("destroy {}", shell_quote(uuid))).await;
    let out = run(conn, access, sudo, &delete_args(uuid, storage, uefi)?).await?.into_result()?;
    Ok(leftover_files(&format!(
        "{}
{}",
        out.stderr, out.stdout
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOMINFO: &str = include_str!("vm/fixtures/dominfo.txt");

    #[test]
    fn uuid_validation() {
        assert!(valid_uuid("11111111-2222-3333-4444-555555555555"));
        assert!(!valid_uuid("cirros-test"));
        assert!(!valid_uuid("11111111-2222-3333-4444-555555555555; reboot"));
    }

    #[test]
    fn inventory_includes_shut_off_vm() {
        let vms = parse_inventory(DOMINFO);
        let cirros = vms.iter().find(|v| v.name == "cirros-test").expect("cirros-test listée");
        assert_eq!(cirros.state, VmState::ShutOff);
        assert_eq!(cirros.vcpus, 1);
        assert_eq!(cirros.memory_kib, 131072);
        assert!(cirros.persistent);
    }

    #[test]
    fn vm_names_with_quotes() {
        let vms = parse_inventory(DOMINFO);
        let odd = vms.iter().find(|v| v.uuid == "11111111-2222-3333-4444-555555555555").unwrap();
        assert_eq!(odd.name, "l'été 2 \"test\"");
        assert!(odd.autostart);
        assert_eq!(odd.vcpus, 2);
    }

    #[test]
    fn states() {
        assert_eq!(VmState::parse("running"), VmState::Running);
        assert_eq!(VmState::parse("shut off"), VmState::ShutOff);
        assert_eq!(VmState::parse("paused"), VmState::Paused);
        assert_eq!(VmState::parse("in shutdown"), VmState::Shutdown);
        assert_eq!(VmState::parse("pmsuspended"), VmState::Suspended);
        assert_eq!(VmState::parse("crashed"), VmState::Crashed);
        assert_eq!(VmState::parse("???"), VmState::Other);
    }

    #[test]
    fn detail_of_running_vm() {
        let d = parse_detail(include_str!("vm/fixtures/cirros.xml")).unwrap();
        assert_eq!(d.disks.len(), 1);
        assert_eq!(d.disks[0].target, "vda");
        assert!(d.disks[0].source.as_deref().unwrap().ends_with("cirros-test.qcow2"));
        assert_eq!(d.nics.len(), 1);
        assert_eq!(d.nics[0].source, "default");
        match d.graphics {
            Graphics::Vnc { port, public, .. } => {
                assert!(port.unwrap() >= 5900, "port attribué au démarrage");
                assert!(!public);
            }
            other => panic!("VNC attendu, reçu {other:?}"),
        }
    }

    #[test]
    fn graphics_spice_and_none() {
        let d = parse_detail(include_str!("vm/fixtures/spice.xml")).unwrap();
        // Éteinte (autoport) : pas encore de port ; l'écoute est lue pour le tunnel.
        assert_eq!(d.graphics, Graphics::Spice { port: None, listen: "127.0.0.1".into(), password: false });
        let running = "<domain><os><type>hvm</type></os><devices><graphics type='spice' port='5901' passwd='x'><listen type='address' address='0.0.0.0'/></graphics></devices></domain>";
        assert_eq!(parse_detail(running).unwrap().graphics, Graphics::Spice { port: Some(5901), listen: "0.0.0.0".into(), password: true });
        assert_eq!(display_password(running, "spice").as_deref(), Some("x"));
        assert_eq!(display_password(running, "vnc"), None);
        let bare = "<domain><os><type>hvm</type></os><devices/></domain>";
        assert_eq!(parse_detail(bare).unwrap().graphics, Graphics::None);
    }

    #[test]
    fn graphics_listen_public() {
        let d = parse_detail(include_str!("vm/fixtures/public-vnc.xml")).unwrap();
        assert!(matches!(d.graphics, Graphics::Vnc { public: true, .. }));
    }

    #[test]
    fn vnc_host_follows_listen_address() {
        assert_eq!(vnc_connect_host("0.0.0.0"), "127.0.0.1");
        assert_eq!(vnc_connect_host("::"), "127.0.0.1");
        assert_eq!(vnc_connect_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(vnc_connect_host(""), "127.0.0.1");
        // Écoute sur une IP précise : la boucle locale ne répond pas, il faut viser cette IP.
        assert_eq!(vnc_connect_host("192.168.1.20"), "192.168.1.20");
        assert_eq!(vnc_connect_host("[fd00::5]"), "fd00::5");
    }

    #[test]
    fn restrict_vnc_rewrites_only_graphics() {
        let xml = include_str!("vm/fixtures/public-vnc.xml");
        let new = restrict_vnc_xml(xml).unwrap();
        let d = parse_detail(&new).unwrap();
        match &d.graphics {
            Graphics::Vnc { listen, public, .. } => {
                assert_eq!(listen, "127.0.0.1");
                assert!(!public);
            }
            other => panic!("VNC attendu, reçu {other:?}"),
        }
        assert!(!new.contains("0.0.0.0"), "plus aucune écoute publique");
        // Le reste de la définition est intact.
        let before = parse_detail(xml).unwrap();
        assert_eq!((d.disks.len(), d.nics.len(), d.firmware), (before.disks.len(), before.nics.len(), before.firmware));
        // Idempotent.
        assert_eq!(parse_detail(&restrict_vnc_xml(&new).unwrap()).unwrap().graphics, d.graphics);
    }

    #[test]
    fn graphics_vnc_socket() {
        let xml = "<domain type='kvm'><name>s</name><uuid>2f1c8a3e-0b7d-4c55-9a61-3e2b1f0d9c11</uuid><devices><graphics type='vnc' socket='/run/x.sock'><listen type='socket' socket='/run/x.sock'/></graphics></devices></domain>";
        assert_eq!(parse_detail(xml).unwrap().graphics, Graphics::VncSocket);
    }

    #[test]
    fn cpu_percent_is_bounded() {
        // 2 vCPU pleinement occupés pendant 1 s = 2 s de temps CPU = 100 %.
        assert_eq!(cpu_percent(0, 2_000_000_000, 1000, 2), 100.0);
        assert_eq!(cpu_percent(0, 500_000_000, 1000, 1), 50.0);
        assert_eq!(cpu_percent(10, 5, 1000, 1), 0.0, "compteur remis à zéro (VM redémarrée)");
        assert_eq!(cpu_percent(0, 1, 0, 1), 0.0, "durée nulle");
    }
    #[test]
    fn domstats_and_ifaddr() {
        let s = parse_domstats(include_str!("vm/fixtures/domstats.txt"));
        let cirros = &s["cirros-test"];
        assert!(cirros["cpu.time"] > 0);
        assert_eq!(cirros["vcpu.current"], 1);
        let ips = parse_ifaddr(" Name       MAC address          Protocol     Address\n-------------------------------------------------------------------------------\n vnet0      52:54:00:ab:cd:ef    ipv4         192.168.122.45/24\n");
        assert_eq!(ips, vec!["192.168.122.45"]);
    }

    #[test]
    fn action_commands() {
        let u = "11111111-2222-3333-4444-555555555555";
        assert_eq!(action_args(VmAction::Start, u), format!("start '{u}'"));
        assert_eq!(action_args(VmAction::Shutdown, u), format!("shutdown '{u}' --mode acpi"));
        assert_eq!(action_args(VmAction::ForceOff, u), format!("destroy '{u}' --graceful"));
        assert_eq!(action_args(VmAction::AutostartOff, u), format!("autostart '{u}' --disable"));
        assert!(delete_args(u, &["vda;id".into(), "-x".into()], false).is_err());
        assert_eq!(delete_args(u, &[], false).unwrap(), format!("undefine '{u}' --managed-save --snapshots-metadata"));
        // Disques désignés un par un : jamais --remove-all-storage (il prendrait aussi une ISO partagée).
        assert_eq!(
            delete_args(u, &["vda".into(), "vdb".into()], true).unwrap(),
            format!("undefine '{u}' --managed-save --snapshots-metadata --nvram --storage 'vda,vdb'")
        );
    }

    #[test]
    fn vnc_password_is_read_from_security_info() {
        let xml = include_str!("vm/fixtures/vnc-password.xml");
        assert_eq!(display_password(xml, "vnc").as_deref(), Some("s3cret"));
        assert!(matches!(parse_detail(xml).unwrap().graphics, Graphics::Vnc { password: true, .. }));
        assert_eq!(display_password(include_str!("vm/fixtures/cirros.xml"), "vnc"), None);
    }

    #[test]
    fn stats_filter_running_vms_with_a_real_option() {
        // `--state-running` n'existe pas (virsh refuse la commande) : le filtre est `--list-running`.
        assert!(!STATS.contains("--state-running"));
        assert_eq!(STATS.matches("--list-running").count(), 2);
    }

    #[test]
    fn only_the_vm_own_disks_are_removed() {
        let d = parse_detail(include_str!("vm/fixtures/cirros.xml")).unwrap();
        assert_eq!(removable_disks(&d), vec!["vda".to_string()]);
        let xml = "<domain><os><type>hvm</type></os><devices>            <disk type='file' device='disk'><source file='/v/own.qcow2'/><target dev='vda'/></disk>            <disk type='file' device='cdrom'><source file='/iso/debian.iso'/><target dev='sda'/><readonly/></disk>            <disk type='file' device='disk'><source file='/v/shared.img'/><target dev='vdb'/><shareable/></disk>            <disk type='file' device='disk'><source file='/v/ro.img'/><target dev='vdc'/><readonly/></disk>            </devices></domain>";
        assert_eq!(removable_disks(&parse_detail(xml).unwrap()), vec!["vda".to_string()]);
    }

    #[test]
    fn disks_left_behind_are_reported() {
        let stderr = "error: Storage volume 'vda'(/var/lib/libvirt/images/jetable.qcow2) is not managed by libvirt. Remove it manually.
";
        assert_eq!(leftover_files(stderr), vec!["/var/lib/libvirt/images/jetable.qcow2".to_string()]);
        assert!(leftover_files(
            "Domain 'x' has been undefined
"
        )
        .is_empty());
    }
}
