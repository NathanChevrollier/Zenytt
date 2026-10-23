//! Inventaire des versions : composants installés sur le serveur et fraîcheur des images des conteneurs.

use std::collections::HashMap;

use serde::Serialize;

use crate::docker::{self, Access, Container};
use crate::security::section;
use crate::ssh::shell_quote;
use crate::system::{self, Update};
use crate::{Connection, Result};

/// (id, libellé, commande de version, paquets apt/dnf correspondants ; `*` = joker).
/// Un composant n'apparaît que si sa commande réussit.
const COMPONENTS: &[(&str, &str, &str, &[&str])] = &[
    ("docker", "Docker", "docker --version", &["docker-ce", "docker.io", "docker"]),
    ("compose", "Docker Compose", "docker compose version --short", &["docker-compose-plugin", "docker-compose-v2"]),
    ("containerd", "containerd", "containerd --version", &["containerd.io", "containerd"]),
    ("nginx", "nginx", "nginx -v 2>&1", &["nginx", "nginx-core", "nginx-full", "nginx-light"]),
    ("apache", "Apache", "apache2 -v 2>&1 || httpd -v 2>&1", &["apache2", "httpd"]),
    ("caddy", "Caddy", "caddy version", &["caddy"]),
    ("php", "PHP", "php -v", &["php*"]),
    ("php-fpm", "PHP-FPM", "php-fpm -v 2>&1 || $(ls /usr/sbin/php-fpm* 2>/dev/null | head -n 1) -v 2>&1", &["php*-fpm", "php-fpm"]),
    ("node", "Node.js", "node --version", &["nodejs"]),
    ("npm", "npm", "npm --version", &["npm"]),
    ("python", "Python 3", "python3 --version", &["python3", "python3-minimal"]),
    (
        "mysql",
        "MySQL / MariaDB",
        "mysqld --version 2>&1 || mariadbd --version 2>&1",
        &["mysql-server*", "mariadb-server*", "mysql-community-server", "mariadb-server"],
    ),
    ("postgres", "PostgreSQL", "psql --version || postgres --version", &["postgresql*"]),
    ("redis", "Redis", "redis-server --version", &["redis", "redis-server"]),
    ("certbot", "Certbot", "certbot --version 2>&1", &["certbot"]),
    ("fail2ban", "Fail2ban", "fail2ban-client --version", &["fail2ban"]),
    ("ufw", "UFW", "ufw version", &["ufw"]),
    ("ssh", "OpenSSH", "ssh -V 2>&1", &["openssh-server", "openssh-client", "openssh-clients"]),
    ("git", "Git", "git --version", &["git"]),
    ("restic", "restic", "restic version", &["restic"]),
    ("wireguard", "WireGuard", "wg --version", &["wireguard-tools"]),
    ("zenyttd", "Agent zenyttd", "zenyttd version", &[]),
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub label: String,
    pub version: String,
    /// Version candidate quand une mise à jour du paquet est disponible.
    pub update: Option<String>,
    /// Faux quand aucun paquet n'est associé (système, noyau, agent) : pas de verdict possible.
    pub trackable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub components: Vec<Component>,
    /// Faux sans apt ni dnf (ou liste illisible) : les mises à jour sont alors « inconnues ».
    pub updates_known: bool,
}

fn script() -> String {
    let mut s = String::from("echo @@os; . /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\"\necho @@kernel; uname -r\n");
    for (id, _, cmd, _) in COMPONENTS {
        s += &format!("o=$({cmd}) && [ -n \"$o\" ] && {{ echo @@{id}; printf '%s\\n' \"$o\" | head -n 1; }}\n");
    }
    // Sans `zenyttd`, la dernière commande échouerait (127) : on force un statut de succès.
    s += "true
";
    s
}

/// Premier mot ressemblant à un numéro de version (« Docker version 27.1.1, build x » → `27.1.1`).
pub fn version_of(line: &str) -> String {
    let line = line.trim();
    line.split(|c: char| c.is_whitespace() || "_/=,()".contains(c))
        .find_map(|t| {
            let t = t.strip_prefix('v').filter(|r| r.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(t);
            t.starts_with(|c: char| c.is_ascii_digit()).then(|| t.to_string())
        })
        .unwrap_or_else(|| line.to_string())
}

fn strip_arch(name: &str) -> &str {
    name.rsplit_once('.').filter(|(_, a)| ["x86_64", "aarch64", "noarch", "i686"].contains(a)).map_or(name, |(n, _)| n)
}

fn matches(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        Some((pre, post)) => name.len() >= pre.len() + post.len() && name.starts_with(pre) && name.ends_with(post),
        None => pattern == name,
    }
}

pub fn parse_inventory(out: &str, updates: Option<&[Update]>) -> Inventory {
    let one = |id: &str| section(out, id).lines().next().unwrap_or("").trim();
    let mut components = Vec::new();
    for (id, label) in [("os", "Système"), ("kernel", "Noyau")] {
        if !one(id).is_empty() {
            let version = if id == "os" { one(id).to_string() } else { version_of(one(id)) };
            components.push(Component { id: id.into(), label: label.into(), version, update: None, trackable: false });
        }
    }
    for (id, label, _, pkgs) in COMPONENTS {
        let line = one(id);
        if line.is_empty() {
            continue;
        }
        let update =
            updates.and_then(|u| u.iter().find(|u| pkgs.iter().any(|p| matches(p, strip_arch(&u.name)))).map(|u| u.candidate.clone()));
        components.push(Component {
            id: (*id).into(),
            label: (*label).into(),
            version: version_of(line),
            update,
            trackable: !pkgs.is_empty(),
        });
    }
    Inventory { components, updates_known: updates.is_some() }
}

/// Versions installées, croisées avec la liste des mises à jour déjà connue du gestionnaire de paquets.
pub async fn inventory(conn: &Connection) -> Result<Inventory> {
    let out = conn.run(&script()).await?;
    let updates = system::updates(conn, false, None).await.ok();
    Ok(parse_inventory(&out, updates.as_deref()))
}

// ---- Images des conteneurs ----

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImageState {
    /// Registre non interrogé (ou image locale / registre injoignable).
    Unknown,
    UpToDate,
    UpdateAvailable,
    /// Référence figée par son empreinte (`image@sha256:…`).
    Pinned,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerImage {
    pub container: String,
    pub project: Option<String>,
    pub service: Option<String>,
    pub image: String,
    pub name: String,
    pub tag: String,
    /// `latest` ou pas de tag : l'image change sans que la référence bouge.
    pub floating: bool,
    pub state: ImageState,
    /// Empreinte locale (RepoDigest), vide pour une image construite en local.
    pub digest: String,
}

/// `registry:5000/app:1.2@sha256:…` → (`registry:5000/app`, `1.2`) ; tag vide si absent.
pub fn split_ref(image: &str) -> (String, String) {
    let base = image.split('@').next().unwrap_or(image);
    match base.rsplit_once(':') {
        Some((n, t)) if !t.contains('/') => (n.into(), t.into()),
        _ => (base.into(), String::new()),
    }
}

type Check = (Vec<String>, String);

/// Lignes `référence <TAB> empreintes locales <TAB> empreinte du registre` → (locales, registre) par référence.
pub fn parse_checks(out: &str) -> HashMap<String, Check> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split('\t');
            let image = it.next()?.trim();
            let local = it.next()?.split_whitespace().map(str::to_string).collect();
            let remote = it.next().unwrap_or("").trim().to_string();
            (!image.is_empty()).then(|| (image.to_string(), (local, remote)))
        })
        .collect()
}

pub fn image_state(image: &str, check: Option<&Check>) -> ImageState {
    if image.contains("@sha256:") {
        return ImageState::Pinned;
    }
    match check {
        Some((local, remote)) if !local.is_empty() && remote.starts_with("sha256:") => {
            if local.iter().any(|d| d.ends_with(&format!("@{remote}"))) {
                ImageState::UpToDate
            } else {
                ImageState::UpdateAvailable
            }
        }
        _ => ImageState::Unknown,
    }
}

pub fn container_images(containers: &[Container], checks: &HashMap<String, Check>) -> Vec<ContainerImage> {
    containers
        .iter()
        .filter(|c| c.state == "running")
        .map(|c| {
            let (name, tag) = split_ref(&c.image);
            let check = checks.get(&c.image);
            ContainerImage {
                container: c.name.clone(),
                project: c.compose_project.clone(),
                service: c.compose_service.clone(),
                image: c.image.clone(),
                floating: !c.image.contains('@') && (tag.is_empty() || tag == "latest"),
                state: image_state(&c.image, check),
                digest: check.and_then(|(l, _)| l.first()).cloned().unwrap_or_default(),
                name,
                tag,
            }
        })
        .collect()
}

/// Au plus ce nombre d'images est interrogé (en parallèle) ; les autres restent « inconnu ».
const MAX_CHECKED: usize = 20;

/// Conteneurs en marche avec leur image ; avec `check`, interroge aussi le registre (sans rien télécharger).
pub async fn images(conn: &Connection, access: Access, sudo: Option<&str>, check: bool) -> Result<Vec<ContainerImage>> {
    let containers = docker::containers(conn, access, sudo).await?;
    let mut checks = HashMap::new();
    if check {
        let mut refs: Vec<&str> =
            containers.iter().filter(|c| c.state == "running" && !c.image.contains('@')).map(|c| c.image.as_str()).collect();
        refs.sort_unstable();
        refs.dedup();
        let list: Vec<String> = refs.into_iter().take(MAX_CHECKED).map(shell_quote).collect();
        // `buildx imagetools inspect` lit l'empreinte du registre sans télécharger l'image ; absent → « inconnu ».
        let body = format!(
            "T=; command -v timeout >/dev/null && T='timeout 20'; \
             chk() {{ l=$(docker image inspect --format '{{{{range .RepoDigests}}}}{{{{.}}}} {{{{end}}}}' \"$1\" 2>/dev/null); \
             r=$($T docker buildx imagetools inspect \"$1\" --format '{{{{.Manifest.Digest}}}}' 2>/dev/null); printf '%s\\t%s\\t%s\\n' \"$1\" \"$l\" \"$r\"; }}; \
             for i in {}; do chk \"$i\" & done; wait",
            list.join(" ")
        );
        let cmd = format!("{}{body}", docker::PODMAN_SHIM);
        let out = match access {
            Access::Sudo => conn.exec_sudo(&cmd, sudo, None).await?,
            _ => conn.exec(&cmd, None).await?,
        };
        checks = parse_checks(&out.stdout);
    }
    Ok(container_images(&containers, &checks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_script_finit_par_un_succes_garanti() {
        assert!(script().trim_end().ends_with(
            "
true"
        ));
    }

    #[test]
    fn versions() {
        for (line, v) in [
            ("Docker version 27.1.1, build 6312585", "27.1.1"),
            ("nginx version: nginx/1.24.0", "1.24.0"),
            ("OpenSSH_9.2p1 Debian-2+deb12u3, OpenSSL 3.0.15", "9.2p1"),
            ("Redis server v=7.0.15 sha=00000000:0 malloc=jemalloc", "7.0.15"),
            ("Fail2Ban v1.0.2", "1.0.2"),
            ("psql (PostgreSQL) 16.2 (Debian 16.2-1)", "16.2"),
            ("containerd github.com/containerd/containerd v1.7.2 abc", "1.7.2"),
            ("mysqld  Ver 8.0.36 for Linux on x86_64", "8.0.36"),
            ("rien", "rien"),
        ] {
            assert_eq!(version_of(line), v, "{line}");
        }
    }

    #[test]
    fn inventory_matches_updates() {
        let out = "@@os\nDebian GNU/Linux 12\n@@kernel\n6.1.0-18-amd64\n@@docker\nDocker version 27.1.1, build x\n@@nginx\nnginx version: nginx/1.22.1\n@@php\nPHP 8.2.7 (cli)\n@@python\nPython 3.11.2\n@@zenyttd\nzenyttd 1.2.0\n";
        let up = [
            Update { name: "nginx".into(), current: "1.22.1-1".into(), candidate: "1.24.0-2".into() },
            Update { name: "php8.2-cli".into(), current: "".into(), candidate: "8.2.8".into() },
            Update { name: "python3-pip".into(), current: "".into(), candidate: "1".into() },
        ];
        let inv = parse_inventory(out, Some(&up));
        let by = |id: &str| inv.components.iter().find(|c| c.id == id).unwrap();
        assert_eq!(inv.components.len(), 7);
        assert!(inv.updates_known);
        assert_eq!(by("nginx").update.as_deref(), Some("1.24.0-2"));
        assert_eq!(by("php").update.as_deref(), Some("8.2.8"));
        assert_eq!(by("docker").update, None);
        assert_eq!(by("python").update, None);
        assert!(!by("zenyttd").trackable && !by("os").trackable && by("nginx").trackable);
        assert_eq!(by("kernel").version, "6.1.0-18-amd64");
        assert!(!parse_inventory(out, None).updates_known);
        assert_eq!(strip_arch("curl.x86_64"), "curl");
        assert_eq!(strip_arch("python3.11"), "python3.11");
    }

    #[test]
    fn image_refs_and_states() {
        assert_eq!(split_ref("nginx"), ("nginx".into(), "".into()));
        assert_eq!(split_ref("nginx:1.25"), ("nginx".into(), "1.25".into()));
        assert_eq!(split_ref("reg:5000/app"), ("reg:5000/app".into(), "".into()));
        assert_eq!(split_ref("reg:5000/app:2@sha256:abc"), ("reg:5000/app".into(), "2".into()));
        let c = parse_checks(
            "nginx:1.25\tnginx@sha256:aaa \tsha256:aaa\nredis:7\tredis@sha256:bbb \tsha256:ccc\nmine:1\t\t\nold:1\told@sha256:d \t\n",
        );
        assert_eq!(image_state("nginx:1.25", c.get("nginx:1.25")), ImageState::UpToDate);
        assert_eq!(image_state("redis:7", c.get("redis:7")), ImageState::UpdateAvailable);
        assert_eq!(image_state("mine:1", c.get("mine:1")), ImageState::Unknown);
        assert_eq!(image_state("old:1", c.get("old:1")), ImageState::Unknown);
        assert_eq!(image_state("x", None), ImageState::Unknown);
        assert_eq!(image_state("x@sha256:1", None), ImageState::Pinned);
    }
}
