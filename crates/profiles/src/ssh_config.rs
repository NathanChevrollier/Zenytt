//! Lecture de `~/.ssh/config` (OpenSSH) pour importer ses serveurs dans Zenytt.
//!
//! Seuls les blocs `Host` nommés sont repris (les motifs `*`, `?`, `!` sont des règles, pas des
//! serveurs). `ProxyJump` est conservé sous la forme `alias:<nom>` : l'interface le relie au profil
//! importé du même nom.

use crate::{AuthKind, ServerProfile};

pub const JUMP_ALIAS_PREFIX: &str = "alias:";

#[derive(Default)]
struct Block {
    aliases: Vec<String>,
    host: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity: Option<String>,
    jump: Option<String>,
}

pub fn parse(text: &str) -> Vec<ServerProfile> {
    let mut blocks: Vec<Block> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => {
                (k.to_lowercase(), v.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim().trim_matches('"').to_string())
            }
            None => continue,
        };
        if key == "host" {
            blocks.push(Block { aliases: value.split_whitespace().map(str::to_string).collect(), ..Default::default() });
            continue;
        }
        if key == "match" {
            // Bloc conditionnel : ses réglages ne s'appliquent à aucun serveur précis.
            blocks.push(Block::default());
            continue;
        }
        let Some(b) = blocks.last_mut() else { continue };
        match key.as_str() {
            "hostname" => b.host = b.host.take().or(Some(value)),
            "user" => b.user = b.user.take().or(Some(value)),
            "port" => b.port = b.port.or(value.parse().ok()),
            "identityfile" => b.identity = b.identity.take().or(Some(value)),
            "proxyjump" if value != "none" => b.jump = b.jump.take().or(Some(value)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for b in blocks {
        for alias in b.aliases.iter().filter(|a| !a.contains(['*', '?', '!'])) {
            let jump = b.jump.as_ref().map(|j| {
                // Premier rebond d'une chaîne « a,b » ; « user@hôte:port » est gardé tel quel.
                let first = j.split(',').next().unwrap_or(j).trim();
                format!("{JUMP_ALIAS_PREFIX}{first}")
            });
            out.push(ServerProfile {
                id: String::new(),
                name: alias.clone(),
                host: b.host.clone().unwrap_or_else(|| alias.clone()).replace("%h", alias),
                port: b.port.unwrap_or(22),
                username: b.user.clone().unwrap_or_else(|| "root".into()),
                // Sans IdentityFile, OpenSSH utilise l'agent : même choix ici.
                auth_kind: if b.identity.is_some() { AuthKind::Key } else { AuthKind::Agent },
                key_path: b.identity.clone(),
                color: None,
                group: None,
                ai_access: false,
                jump_id: jump,
                identity_id: None,
                protocol: Default::default(),
                auto_connect: false,
                provider: None,
            });
        }
    }
    out
}

/// Serveurs de `~/.ssh/config`, s'il existe.
pub fn read_user_config() -> Vec<ServerProfile> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    std::fs::read_to_string(home.join(".ssh").join("config")).map(|t| parse(&t)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts() {
        let cfg = "# commentaire
Host *
  ServerAliveInterval 30

Host vps prod
  HostName 203.0.113.10
  User alice
  Port 2222
  IdentityFile ~/.ssh/vps_ed25519

Host interne
  HostName 10.0.0.5
  User=admin
  ProxyJump vps

Match host *.local
  User ignore
";
        let p = parse(cfg);
        assert_eq!(p.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["vps", "prod", "interne"]);
        assert_eq!((p[0].host.as_str(), p[0].port, p[0].username.as_str()), ("203.0.113.10", 2222, "alice"));
        assert_eq!(p[0].auth_kind, AuthKind::Key);
        assert_eq!(p[0].key_path.as_deref(), Some("~/.ssh/vps_ed25519"));
        assert_eq!(p[2].jump_id.as_deref(), Some("alias:vps"));
        assert_eq!(p[2].auth_kind, AuthKind::Agent);
        assert_eq!(p[2].username, "admin");
    }
}
