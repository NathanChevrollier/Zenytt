//! Pare-feu : règles ufw (ou firewalld, en lecture), ports en écoute et ports publiés par Docker,
//! croisés pour dire ce qui est réellement exposé sur Internet.
//!
//! Piège classique signalé : un port publié par Docker sur 0.0.0.0 est ouvert même si ufw le
//! refuse, car Docker insère ses propres règles iptables avant celles d'ufw.

use serde::Serialize;

use crate::{Connection, Error, Result};

const STATE_SCRIPT: &str = r#"echo @@UFW; if command -v ufw >/dev/null 2>&1; then ufw status verbose 2>&1; echo @@NUMBERED; ufw status numbered 2>&1; else echo absent; fi
echo @@FIREWALLD; if command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --state 2>&1; firewall-cmd --list-all 2>&1; else echo absent; fi
echo @@LISTEN; ss -ltnupH 2>/dev/null
echo @@DOCKER; docker ps --format '{{.Names}}	{{.Ports}}' 2>/dev/null
echo @@SSHD; sshd -T 2>/dev/null | grep -i '^port '
"#;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub num: u32,
    pub to: String,
    pub action: String,
    pub from: String,
    pub v6: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Exposure {
    pub port: u16,
    pub proto: String,
    pub address: String,
    /// Processus ou conteneur qui écoute.
    pub owner: String,
    /// Écoute sur toutes les interfaces (et pas seulement en local).
    pub public: bool,
    pub docker: bool,
    /// `open` (joignable depuis Internet), `blocked` (refusé par le pare-feu), `local` (écoute locale uniquement).
    pub status: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// `ufw`, `firewalld` ou `none`.
    pub kind: String,
    pub active: bool,
    /// Politique par défaut (ufw : « deny (incoming), allow (outgoing)… »).
    pub defaults: Option<String>,
    pub rules: Vec<Rule>,
    /// Sortie brute de firewalld (lecture seule).
    pub raw: Option<String>,
    pub exposures: Vec<Exposure>,
    pub ssh_ports: Vec<u16>,
}

pub(crate) fn section<'a>(out: &'a str, name: &str) -> &'a str {
    let marker = format!("@@{name}\n");
    let Some(start) = out.find(&marker) else { return "" };
    let rest = &out[start + marker.len()..];
    match rest.find("\n@@") {
        Some(end) => &rest[..end],
        None => rest,
    }
}

/// `[ 3] 80/tcp (v6)   ALLOW IN    Anywhere (v6)`
pub fn parse_rule(line: &str) -> Option<Rule> {
    let rest = line.trim().strip_prefix('[')?;
    let (num, rest) = rest.split_once(']')?;
    let cols: Vec<&str> = rest.split("  ").map(str::trim).filter(|c| !c.is_empty()).collect();
    let (to, action, from) = (cols.first()?, cols.get(1)?, cols.get(2).copied().unwrap_or("Anywhere"));
    Some(Rule {
        num: num.trim().parse().ok()?,
        to: to.to_string(),
        action: action.to_string(),
        from: from.to_string(),
        v6: to.contains("(v6)"),
    })
}

struct Listener {
    port: u16,
    proto: String,
    address: String,
    process: String,
}

fn parse_listener(line: &str) -> Option<Listener> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    let proto = (*cols.first()?).to_string();
    let local = cols.get(4)?;
    let (addr, port) = local.rsplit_once(':')?;
    let process = line.split("((\"").nth(1).and_then(|p| p.split('"').next()).unwrap_or("").to_string();
    Some(Listener { port: port.parse().ok()?, proto, address: addr.trim_matches(['[', ']']).to_string(), process })
}

fn is_local(addr: &str) -> bool {
    let a = addr.split('%').next().unwrap_or(addr);
    a.starts_with("127.") || a == "::1" || addr.contains("%lo")
}

/// `web\t0.0.0.0:8082->80/tcp, [::]:8082->80/tcp` → (conteneur, ip, port hôte, proto)
fn parse_docker(line: &str) -> Vec<(String, String, u16, String)> {
    let Some((name, ports)) = line.split_once('\t') else { return vec![] };
    ports
        .split(", ")
        .filter_map(|p| {
            let (host, container) = p.split_once("->")?;
            let (ip, port) = host.rsplit_once(':')?;
            let proto = container.split('/').nth(1).unwrap_or("tcp").to_string();
            Some((name.to_string(), ip.trim_matches(['[', ']']).to_string(), port.parse().ok()?, proto))
        })
        .collect()
}

/// Une règle ALLOW ufw couvre-t-elle ce port ? (`80`, `80/tcp`, `6000:6010/tcp`)
fn rule_allows(rule: &Rule, port: u16, proto: &str) -> bool {
    if !rule.action.starts_with("ALLOW") && !rule.action.starts_with("LIMIT") {
        return false;
    }
    let spec = rule.to.split_whitespace().next().unwrap_or("");
    let (ports, p) = spec.split_once('/').unwrap_or((spec, ""));
    if !p.is_empty() && p != proto {
        return false;
    }
    ports.split(',').any(|part| match part.split_once(':') {
        Some((a, b)) => a.parse::<u16>().is_ok_and(|a| a <= port) && b.parse::<u16>().is_ok_and(|b| port <= b),
        None => part.parse::<u16>() == Ok(port),
    })
}

pub fn parse_state(out: &str) -> State {
    let ufw = section(out, "UFW");
    let fwd = section(out, "FIREWALLD");
    let ssh_ports: Vec<u16> = section(out, "SSHD").lines().filter_map(|l| l.split_whitespace().nth(1)?.parse().ok()).collect();

    let (kind, active, defaults, rules, raw) = if !ufw.trim().starts_with("absent") && !ufw.is_empty() {
        let active = ufw.contains("Status: active");
        let defaults = ufw.lines().find_map(|l| l.strip_prefix("Default:")).map(|d| d.trim().to_string());
        let rules = section(out, "NUMBERED").lines().filter_map(parse_rule).collect();
        ("ufw", active, defaults, rules, None)
    } else if !fwd.trim().starts_with("absent") && !fwd.is_empty() {
        ("firewalld", fwd.lines().next().is_some_and(|l| l.trim() == "running"), None, vec![], Some(fwd.to_string()))
    } else {
        ("none", false, None, vec![], None)
    };

    let docker: Vec<(String, String, u16, String)> = section(out, "DOCKER").lines().flat_map(parse_docker).collect();
    let mut exposures: Vec<Exposure> = Vec::new();
    for l in section(out, "LISTEN").lines().filter_map(parse_listener) {
        let public = !is_local(&l.address);
        let published = docker.iter().find(|d| d.2 == l.port && d.3 == l.proto && !is_local(&d.1));
        let owner = match published {
            Some(d) => format!("conteneur {}", d.0),
            None if l.process == "docker-proxy" => "Docker".to_string(),
            None => l.process.clone(),
        };
        let docker_port = published.is_some() || l.process == "docker-proxy";
        let (status, note) = if !public {
            ("local", "écoute seulement sur la machine : inaccessible depuis Internet".to_string())
        } else if docker_port && kind == "ufw" && active {
            ("open", "publié par Docker : ouvert à Internet même si ufw le refuse (Docker contourne ufw). Publie-le sur 127.0.0.1 s'il ne doit pas être public.".to_string())
        } else if !active {
            ("open", "aucun pare-feu actif : ouvert à Internet".to_string())
        } else if kind == "ufw" {
            match rules.iter().find(|r| rule_allows(r, l.port, &l.proto)) {
                Some(r) => ("open", format!("autorisé par la règle {} ({})", r.num, r.to)),
                None => ("blocked", "refusé par ufw (aucune règle ne l'autorise)".to_string()),
            }
        } else {
            ("open", "vérifie les règles firewalld ci-dessous".to_string())
        };
        if exposures.iter().any(|e| e.port == l.port && e.proto == l.proto && e.public == public) {
            continue;
        }
        exposures.push(Exposure {
            port: l.port,
            proto: l.proto,
            address: l.address,
            owner,
            public,
            docker: docker_port,
            status: status.into(),
            note,
        });
    }
    exposures.sort_by_key(|e| (e.status != "open", !e.public, e.port));
    State { kind: kind.into(), active, defaults, rules, raw, exposures, ssh_ports }
}

pub async fn state(conn: &Connection, sudo: Option<&str>) -> Result<State> {
    let out = conn.exec_sudo(STATE_SCRIPT, sudo, None).await?.into_result()?;
    Ok(parse_state(&out.stdout))
}

/// Ouvre un port dans ufw.
pub async fn allow(conn: &Connection, sudo: Option<&str>, port: u16, proto: &str) -> Result<String> {
    if port == 0 || !["tcp", "udp"].contains(&proto) {
        return Err(Error::Other("port ou protocole invalide".into()));
    }
    Ok(conn.exec_sudo(&format!("ufw allow {port}/{proto} 2>&1"), sudo, None).await?.into_result()?.stdout)
}

/// Supprime une règle ufw par son numéro. Refuse de toucher aux règles du port SSH : une erreur
/// couperait l'accès au serveur (il faut alors passer par la console de l'hébergeur).
pub async fn delete(conn: &Connection, sudo: Option<&str>, num: u32) -> Result<String> {
    let st = state(conn, sudo).await?;
    let rule =
        st.rules.iter().find(|r| r.num == num).ok_or_else(|| Error::Other("règle introuvable (liste modifiée entre-temps ?)".into()))?;
    let ssh = if st.ssh_ports.is_empty() { vec![22] } else { st.ssh_ports.clone() };
    if ssh.iter().any(|p| rule_allows(rule, *p, "tcp")) || rule.to.to_lowercase().contains("ssh") {
        return Err(Error::Other(format!(
            "la règle {num} ({}) autorise l'accès SSH : Zenytt refuse de la supprimer pour ne pas te couper l'accès.",
            rule.to
        )));
    }
    Ok(conn.exec_sudo(&format!("ufw --force delete {num} 2>&1"), sudo, None).await?.into_result()?.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@@UFW
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip
@@NUMBERED
Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 6666/tcp                   ALLOW IN    Anywhere
[ 2] 80,443/tcp                 ALLOW IN    Anywhere
[ 3] 6666/tcp (v6)              ALLOW IN    Anywhere (v6)
@@FIREWALLD
absent
@@LISTEN
tcp   LISTEN 0      128          0.0.0.0:6666      0.0.0.0:*    users:((\"sshd\",pid=10,fd=3))
tcp   LISTEN 0      511          0.0.0.0:443       0.0.0.0:*    users:((\"nginx\",pid=11,fd=6))
tcp   LISTEN 0      4096         0.0.0.0:3306      0.0.0.0:*    users:((\"docker-proxy\",pid=12,fd=4))
tcp   LISTEN 0      4096       127.0.0.1:8081      0.0.0.0:*    users:((\"docker-proxy\",pid=13,fd=4))
tcp   LISTEN 0      80           0.0.0.0:9000      0.0.0.0:*    users:((\"node\",pid=14,fd=4))
@@DOCKER
mysql\t0.0.0.0:3306->3306/tcp, [::]:3306->3306/tcp
site\t127.0.0.1:8081->80/tcp
@@SSHD
port 6666
";

    #[test]
    fn exposures() {
        let s = parse_state(SAMPLE);
        assert_eq!((s.kind.as_str(), s.active, s.rules.len(), s.ssh_ports.clone()), ("ufw", true, 3, vec![6666]));
        assert_eq!(s.defaults.as_deref(), Some("deny (incoming), allow (outgoing), disabled (routed)"));
        let by = |p: u16| s.exposures.iter().find(|e| e.port == p).unwrap();
        assert_eq!(by(443).status, "open");
        assert_eq!(by(3306).status, "open");
        assert!(by(3306).docker && by(3306).owner == "conteneur mysql" && by(3306).note.contains("contourne"));
        assert_eq!(by(8081).status, "local");
        assert_eq!(by(9000).status, "blocked");
    }

    #[test]
    fn rules() {
        let r = parse_rule("[ 2] 80,443/tcp                 ALLOW IN    Anywhere").unwrap();
        assert!(rule_allows(&r, 443, "tcp") && !rule_allows(&r, 443, "udp") && !rule_allows(&r, 22, "tcp"));
        let range = parse_rule("[ 5] 6000:6010/tcp   ALLOW IN   Anywhere").unwrap();
        assert!(rule_allows(&range, 6005, "tcp"));
        let deny = parse_rule("[ 6] 25   DENY IN   Anywhere").unwrap();
        assert!(!rule_allows(&deny, 25, "tcp"));
    }
}
