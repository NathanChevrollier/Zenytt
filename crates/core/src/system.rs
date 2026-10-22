//! Processus, services systemd, journaux, alimentation et réglages système, via des commandes standard.

use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    /// Mémoire résidente en octets.
    pub rss: u64,
    /// Durée d'exécution en secondes.
    pub elapsed: u64,
    pub name: String,
    pub command: String,
}

pub const PS_COMMAND: &str = "ps -eo pid=,user=,pcpu=,pmem=,rss=,etimes=,comm=,args= --sort=-pcpu | head -n 150";

pub fn parse_ps(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let user = it.next()?.to_string();
            let cpu = it.next()?.parse().ok()?;
            let mem = it.next()?.parse().ok()?;
            let rss = it.next()?.parse::<u64>().ok()? * 1024;
            let elapsed = it.next()?.parse().ok()?;
            let name = it.next()?.to_string();
            let command = it.collect::<Vec<_>>().join(" ");
            Some(Process { pid, user, cpu, mem, rss, elapsed, name, command })
        })
        .collect()
}

pub async fn processes(conn: &Connection) -> Result<Vec<Process>> {
    Ok(parse_ps(&conn.run(PS_COMMAND).await?))
}

/// Envoie un signal à un processus (TERM ou KILL), en root si nécessaire.
pub async fn kill(conn: &Connection, pid: u32, force: bool, sudo: Option<&str>) -> Result<()> {
    let sig = if force { "KILL" } else { "TERM" };
    let cmd = format!("kill -{sig} {pid}");
    let out = conn.exec(&cmd, None).await?;
    if out.success() {
        return Ok(());
    }
    conn.exec_sudo(&cmd, sudo, None).await?.into_result()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub unit: String,
    pub load: String,
    /// active, inactive, failed…
    pub active: String,
    /// running, exited, dead…
    pub sub: String,
    pub description: String,
    /// enabled, disabled, static… (vide si inconnu)
    pub enabled: String,
}

/// L'état d'activation est demandé à systemd pour les seules unités listées : `list-unit-files`
/// parcourt tous les fichiers d'unités du disque et coûte environ trois fois plus cher.
pub const SERVICES_COMMAND: &str = "command -v systemctl >/dev/null && [ -d /run/systemd/system ] || { echo NO_SYSTEMD; exit 0; }; \
u=$(systemctl list-units --type=service --all --no-legend --plain --no-pager); printf '%s\\n' \"$u\"; echo @@files; \
n=$(printf '%s\\n' \"$u\" | awk '{for(i=1;i<=NF;i++) if($i ~ /\\.service$/){print $i; break}}'); \
[ -n \"$n\" ] && systemctl show -p Id,UnitFileState -- $n";

pub fn parse_services(text: &str) -> Option<Vec<Service>> {
    if text.trim() == "NO_SYSTEMD" {
        return None;
    }
    let (units, files) = text.split_once("@@files").unwrap_or((text, ""));
    // Blocs `Id=…` puis `UnitFileState=…`, séparés par une ligne vide.
    let mut enabled = std::collections::HashMap::new();
    let mut id = "";
    for l in files.lines() {
        if let Some(v) = l.strip_prefix("Id=") {
            id = v.trim();
        } else if let Some(v) = l.strip_prefix("UnitFileState=") {
            enabled.insert(id, v.trim());
        }
    }
    Some(
        units
            .lines()
            .filter_map(|line| {
                let line = line.trim_start_matches(['●', '*', ' ']);
                let mut it = line.split_whitespace();
                let unit = it.next()?;
                if !unit.ends_with(".service") {
                    return None;
                }
                let (load, active, sub) = (it.next()?, it.next()?, it.next()?);
                Some(Service {
                    unit: unit.to_string(),
                    load: load.to_string(),
                    active: active.to_string(),
                    sub: sub.to_string(),
                    description: it.collect::<Vec<_>>().join(" "),
                    enabled: enabled.get(unit).copied().unwrap_or("").to_string(),
                })
            })
            .collect(),
    )
}

/// `None` si le serveur n'utilise pas systemd.
pub async fn services(conn: &Connection) -> Result<Option<Vec<Service>>> {
    Ok(parse_services(&conn.run(SERVICES_COMMAND).await?))
}

fn valid_unit(unit: &str) -> Result<()> {
    let ok = !unit.is_empty() && unit.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:".contains(c));
    if ok {
        Ok(())
    } else {
        Err(Error::Other(format!("nom de service invalide : {unit}")))
    }
}

pub async fn service_action(conn: &Connection, unit: &str, action: &str, sudo: Option<&str>) -> Result<()> {
    valid_unit(unit)?;
    if !["start", "stop", "restart", "reload", "enable", "disable"].contains(&action) {
        return Err(Error::Other(format!("action inconnue : {action}")));
    }
    conn.exec_sudo(&format!("systemctl {action} {unit}"), sudo, None).await?.into_result()?;
    Ok(())
}

/// Dernières lignes du journal d'un service (en root si possible, pour voir tous les messages).
pub async fn service_logs(conn: &Connection, unit: &str, lines: u32, sudo: Option<&str>) -> Result<String> {
    valid_unit(unit)?;
    let cmd = format!("journalctl -u {} -n {} --no-pager -o short-iso", shell_quote(unit), lines.min(5000));
    let out = conn.exec_sudo(&cmd, sudo, None).await?;
    if out.success() {
        return Ok(out.stdout);
    }
    Ok(conn.exec(&cmd, None).await?.into_result()?.stdout)
}

// ---- Alimentation, réglages système et mises à jour ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerAction {
    Reboot,
    Poweroff,
}

/// Redémarre ou éteint le serveur. Sans délai, l'ordre est détaché et différé de 2 s pour que la
/// commande se termine avant la coupure de la connexion ; sinon `shutdown` planifie l'arrêt.
pub async fn power(conn: &Connection, action: PowerAction, delay_minutes: u32, sudo_password: Option<&str>) -> Result<()> {
    let (flag, verb) = match action {
        PowerAction::Reboot => ("-r", "reboot"),
        PowerAction::Poweroff => ("-h", "poweroff"),
    };
    let script = if delay_minutes > 0 {
        format!("shutdown {flag} +{delay_minutes}")
    } else {
        format!(
            "if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null; then systemd-run --quiet --on-active=2 systemctl {verb}; \
             else nohup sh -c 'sleep 2; shutdown {flag} now' </dev/null >/dev/null 2>&1 & fi"
        )
    };
    match conn.exec_sudo(&script, sudo_password, None).await {
        Ok(out) => out.into_result().map(|_| ()),
        // Le serveur a pu couper la connexion avant de répondre : l'ordre est parti.
        Err(Error::Ssh(_)) if delay_minutes == 0 => Ok(()),
        Err(e) => Err(e),
    }
}

/// Annule un arrêt ou redémarrage planifié.
pub async fn cancel_scheduled(conn: &Connection, sudo_password: Option<&str>) -> Result<()> {
    conn.exec_sudo("shutdown -c", sudo_password, None).await?.into_result()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledShutdown {
    /// Secondes Unix.
    pub at: u64,
    /// `reboot`, `poweroff`…
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub uptime_secs: u64,
    /// Secondes Unix.
    pub boot_time: u64,
    pub timezone: String,
    pub reboot_required: bool,
    pub scheduled: Option<ScheduledShutdown>,
    /// apt, dnf, yum, apk ou pacman.
    pub package_manager: Option<String>,
    pub cpu_model: String,
    pub cpu_count: u32,
    /// Octets.
    pub memory_total: u64,
}

const INFO_SCRIPT: &str = r#"echo @@host; hostname
echo @@os; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
echo @@kernel; uname -r
echo @@uptime; cut -d' ' -f1 /proc/uptime
echo @@boot; awk '/^btime/{print $2}' /proc/stat
echo @@tz; timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime | sed 's|.*zoneinfo/||'
echo @@reboot; if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi
echo @@sched; cat /run/systemd/shutdown/scheduled 2>/dev/null
echo @@pm; for p in apt-get dnf yum apk pacman; do if command -v "$p" >/dev/null; then echo "${p%-get}"; break; fi; done
echo @@cpu; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2; grep -c '^processor' /proc/cpuinfo
echo @@mem; awk '/^MemTotal/{print $2}' /proc/meminfo
"#;

pub fn parse_info(out: &str) -> SystemInfo {
    use crate::security::section;
    let one = |name: &str| section(out, name).lines().next().unwrap_or("").trim().to_string();
    let num = |name: &str| one(name).split('.').next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
    let sched = section(out, "sched");
    let field = |key: &str| sched.lines().find_map(|l| l.strip_prefix(key)).map(|v| v.trim().to_string());
    let scheduled = field("USEC=")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|usec| ScheduledShutdown { at: usec / 1_000_000, mode: field("MODE=").unwrap_or_default() });
    let mut cpu = section(out, "cpu").lines();
    SystemInfo {
        hostname: one("host"),
        os: one("os"),
        kernel: one("kernel"),
        uptime_secs: num("uptime"),
        boot_time: num("boot"),
        timezone: one("tz"),
        reboot_required: one("reboot") == "yes",
        scheduled,
        package_manager: Some(one("pm")).filter(|p| !p.is_empty()),
        cpu_model: cpu.next().unwrap_or("").trim().to_string(),
        cpu_count: cpu.next().and_then(|n| n.trim().parse().ok()).unwrap_or(0),
        memory_total: num("mem") * 1024,
    }
}

pub async fn info(conn: &Connection) -> Result<SystemInfo> {
    Ok(parse_info(&conn.run(INFO_SCRIPT).await?))
}

/// Libellé RFC 1123 : lettres, chiffres et tirets, 63 caractères au plus, sans tiret en bord.
pub fn valid_hostname(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

pub async fn set_hostname(conn: &Connection, name: &str, sudo_password: Option<&str>) -> Result<()> {
    if !valid_hostname(name) {
        return Err(Error::Other("nom d'hôte invalide : lettres, chiffres et tirets seulement (63 caractères au plus)".into()));
    }
    // Le nom est validé : il peut figurer tel quel dans le script, y compris dans l'expression sed.
    let script = format!(
        "hostnamectl set-hostname {name} 2>/dev/null || {{ echo {name} > /etc/hostname && hostname {name}; }}; \
         sed -i 's/^\\(127\\.0\\.1\\.1[[:space:]]\\+\\).*/\\1{name}/' /etc/hosts"
    );
    conn.exec_sudo(&script, sudo_password, None).await?.into_result()?;
    Ok(())
}

pub async fn timezones(conn: &Connection) -> Result<Vec<String>> {
    Ok(conn.run("timedatectl list-timezones --no-pager").await?.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

pub fn valid_timezone(tz: &str) -> bool {
    !tz.is_empty() && !tz.contains("..") && tz.chars().all(|c| c.is_ascii_alphanumeric() || "_+-/".contains(c))
}

pub async fn set_timezone(conn: &Connection, tz: &str, sudo_password: Option<&str>) -> Result<()> {
    if !valid_timezone(tz) {
        return Err(Error::Other(format!("fuseau horaire invalide : {tz}")));
    }
    conn.exec_sudo(&format!("timedatectl set-timezone {}", shell_quote(tz)), sudo_password, None).await?.into_result()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub name: String,
    /// Vide quand le gestionnaire ne l'indique pas (dnf).
    pub current: String,
    pub candidate: String,
}

/// La première ligne de la sortie nomme le gestionnaire (`apt`, `dnf` ou `none`).
fn updates_script(refresh: bool) -> String {
    let apt_refresh = if refresh { "apt-get update -qq >/dev/null 2>&1; " } else { "" };
    let dnf_refresh = if refresh { "--refresh " } else { "" };
    format!(
        "if command -v apt-get >/dev/null; then echo apt; {apt_refresh}apt list --upgradable 2>/dev/null; \
         elif command -v dnf >/dev/null; then echo dnf; dnf -q {dnf_refresh}check-update 2>/dev/null; true; \
         else echo none; fi"
    )
}

pub fn parse_updates(text: &str) -> Result<Vec<Update>> {
    let (pm, rest) = text.split_once('\n').unwrap_or((text, ""));
    match pm.trim() {
        "apt" => Ok(rest
            .lines()
            .filter_map(|l| {
                // `nginx/stable 1.24.0-2 amd64 [upgradable from: 1.22.1-1]`
                let (name, tail) = l.split_once('/')?;
                let candidate = tail.split_whitespace().nth(1)?;
                let current = l.split_once("upgradable from: ").map(|(_, c)| c.trim_end_matches(']').trim()).unwrap_or("");
                Some(Update { name: name.into(), current: current.into(), candidate: candidate.into() })
            })
            .collect()),
        "dnf" => Ok(rest
            .lines()
            // dnf4 précède la liste d'une ligne vide.
            .skip_while(|l| l.trim().is_empty())
            .take_while(|l| !l.trim().is_empty() && !l.starts_with("Obsolete"))
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                let (name, candidate, _repo) = (it.next()?, it.next()?, it.next()?);
                Some(Update { name: name.into(), current: String::new(), candidate: candidate.into() })
            })
            .collect()),
        _ => Err(Error::Other("mises à jour prises en charge sur apt et dnf uniquement".into())),
    }
}

/// Liste les paquets à mettre à jour ; `refresh` actualise d'abord les index (root).
pub async fn updates(conn: &Connection, refresh: bool, sudo_password: Option<&str>) -> Result<Vec<Update>> {
    let script = updates_script(refresh);
    let out = if refresh { conn.exec_sudo(&script, sudo_password, None).await? } else { conn.exec(&script, None).await? };
    parse_updates(&out.into_result()?.stdout)
}

/// Applique toutes les mises à jour sans interaction et renvoie la sortie du gestionnaire.
pub async fn apply_updates(conn: &Connection, sudo_password: Option<&str>) -> Result<String> {
    let script = "if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold upgrade 2>&1; \
                  elif command -v dnf >/dev/null; then dnf -y upgrade 2>&1; \
                  else echo 'gestionnaire de paquets non pris en charge' >&2; exit 1; fi";
    let out = crate::ssh::long(conn.exec_sudo(script, sudo_password, None)).await?.into_result()?;
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps() {
        let p = parse_ps("  42 root      12.5  1.0  2048   3600 nginx nginx: master process /usr/sbin/nginx -g daemon off;\n  7 www-data 0.0 0.1 100 10 php-fpm php-fpm: pool www\n");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].pid, 42);
        assert_eq!(p[0].rss, 2048 * 1024);
        assert_eq!(p[0].command, "nginx: master process /usr/sbin/nginx -g daemon off;");
    }

    #[test]
    fn services_merge_enabled_state() {
        let text = "nginx.service loaded active running A high performance web server\n● foo.service loaded failed failed Foo\nsys-fs.mount loaded active mounted x\n@@files\nId=nginx.service\nUnitFileState=enabled\n\nId=foo.service\nUnitFileState=disabled\n";
        let s = parse_services(text).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].description, "A high performance web server");
        assert_eq!(s[0].enabled, "enabled");
        assert_eq!(s[1].active, "failed");
        assert!(parse_services("NO_SYSTEMD\n").is_none());
    }

    #[test]
    fn unit_names_are_validated() {
        assert!(valid_unit("nginx.service").is_ok());
        assert!(valid_unit("getty@tty1.service").is_ok());
        assert!(valid_unit("x; rm -rf /").is_err());
    }

    #[test]
    fn info_is_parsed() {
        let out = "@@host\nvps1\n@@os\nDebian GNU/Linux 12 (bookworm)\n@@kernel\n6.1.0-18-amd64\n@@uptime\n12345.67\n@@boot\n1700000000\n@@tz\nEurope/Paris\n@@reboot\nyes\n@@sched\nUSEC=1700003600000000\nWARN_WALL=1\nMODE=reboot\n@@pm\napt\n@@cpu\n Intel Xeon\n4\n@@mem\n8000000\n";
        let i = parse_info(out);
        assert_eq!((i.hostname.as_str(), i.uptime_secs, i.boot_time, i.cpu_count), ("vps1", 12345, 1700000000, 4));
        assert_eq!(i.cpu_model, "Intel Xeon");
        assert!(i.reboot_required);
        assert_eq!(i.scheduled, Some(ScheduledShutdown { at: 1700003600, mode: "reboot".into() }));
        assert_eq!(i.package_manager.as_deref(), Some("apt"));
        assert_eq!(i.memory_total, 8_000_000 * 1024);
        let bare = parse_info("@@host\nx\n@@reboot\nno\n@@sched\n@@pm\n@@cpu\n@@mem\n");
        assert!(bare.scheduled.is_none() && bare.package_manager.is_none() && !bare.reboot_required);
    }

    #[test]
    fn hostname_and_timezone_are_validated() {
        assert!(valid_hostname("web-01"));
        for bad in ["", "-a", "a-", "a b", "a;rm -rf /", "a.b", "é", &"a".repeat(64)] {
            assert!(!valid_hostname(bad), "{bad}");
        }
        assert!(valid_timezone("Europe/Paris") && valid_timezone("Etc/GMT+1") && valid_timezone("America/Port-au-Prince"));
        for bad in ["", "a b", "Europe/Paris; reboot", "../etc/passwd", "$(id)"] {
            assert!(!valid_timezone(bad), "{bad}");
        }
    }

    #[test]
    fn updates_apt_and_dnf() {
        let apt = "apt\nListing...\nnginx/stable 1.24.0-2 amd64 [upgradable from: 1.22.1-1]\nlibc6/stable-security 2.36-9+deb12u4 amd64 [upgradable from: 2.36-9+deb12u3]\n";
        let u = parse_updates(apt).unwrap();
        assert_eq!(u.len(), 2);
        assert_eq!(u[0], Update { name: "nginx".into(), current: "1.22.1-1".into(), candidate: "1.24.0-2".into() });
        assert_eq!(u[1].current, "2.36-9+deb12u3");
        let dnf = "dnf\n\nkernel.x86_64   5.14.0-362.el9   baseos\ncurl.x86_64 7.76.1-26 baseos\n\nObsolete Packages\nold.x86_64 1 x\n";
        let u = parse_updates(dnf).unwrap();
        assert_eq!(u.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["kernel.x86_64", "curl.x86_64"]);
        assert!(parse_updates("none\n").is_err());
    }
}
