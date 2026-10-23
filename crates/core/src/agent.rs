//! Installation et pilotage de l'agent `zenyttd` sur le serveur, via SSH.

use serde::Serialize;
use zenytt_protocol::{AgentConfig, AgentStatus, HistoryPoint, Request, Response, CONFIG_PATH};

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

/// Unité systemd durcie : utilisateur dédié, système de fichiers en lecture seule sauf l'historique.
pub const SYSTEMD_UNIT: &str = r#"[Unit]
Description=Zenytt monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/zenyttd run
User=zenyttd
Group=zenyttd
RuntimeDirectory=zenyttd
RuntimeDirectoryMode=0755
StateDirectory=zenyttd
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
PrivateDevices=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
MemoryMax=64M

[Install]
WantedBy=multi-user.target
"#;

/// Script d'installation exécuté en root. `$1` = binaire envoyé (dans un dossier privé créé par
/// `mktemp`), `$2` = son empreinte SHA-256 calculée sur le PC : le binaire n'est installé que s'il
/// n'a pas été modifié entre l'envoi et l'installation. Sans systemd (conteneur), l'agent est
/// lancé en arrière-plan avec `nohup`.
pub const INSTALL_SCRIPT: &str = r#"set -e
BIN="$1"
[ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$2" ] || { echo "binaire modifié depuis l'envoi : installation annulée" >&2; rm -rf "$(dirname "$BIN")"; exit 1; }
install -m 0755 "$BIN" /usr/local/bin/zenyttd
rm -rf "$(dirname "$BIN")"
id zenyttd >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin zenyttd 2>/dev/null || adduser -S -H -s /sbin/nologin zenyttd
install -d -m 0755 /etc/zenyttd
[ -f /etc/zenyttd/config.json ] || /usr/local/bin/zenyttd default-config > /etc/zenyttd/config.json
chown root:zenyttd /etc/zenyttd/config.json
chmod 0640 /etc/zenyttd/config.json
install -d -o zenyttd -g zenyttd -m 0750 /var/lib/zenyttd
if [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/zenyttd.service
  systemctl daemon-reload
  systemctl enable zenyttd >/dev/null 2>&1
  systemctl restart zenyttd
  echo "MODE=systemd"
else
  cat > /dev/null
  install -d -o zenyttd -g zenyttd -m 0755 /run/zenyttd
  pkill -x zenyttd 2>/dev/null || true
  su -s /bin/sh zenyttd -c 'nohup /usr/local/bin/zenyttd run >/var/lib/zenyttd/zenyttd.log 2>&1 &'
  echo "MODE=nohup"
fi
sleep 1
/usr/local/bin/zenyttd version
"#;

pub const UNINSTALL_SCRIPT: &str = r#"
if [ -d /run/systemd/system ]; then
  systemctl disable --now zenyttd 2>/dev/null || true
  rm -f /etc/systemd/system/zenyttd.service
  systemctl daemon-reload
else
  pkill -x zenyttd 2>/dev/null || true
fi
rm -f /usr/local/bin/zenyttd
rm -rf /var/lib/zenyttd /etc/zenyttd /run/zenyttd
userdel zenyttd 2>/dev/null || deluser zenyttd 2>/dev/null || true
echo OK
"#;

/// Cible Rust correspondant à la sortie de `uname -m`.
pub fn target_for_arch(uname_m: &str) -> Option<&'static str> {
    match uname_m.trim() {
        "x86_64" | "amd64" => Some("x86_64"),
        "aarch64" | "arm64" => Some("aarch64"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub installed: bool,
    pub running: bool,
    pub status: Option<AgentStatus>,
    pub error: Option<String>,
}

fn query_command(req: &Request) -> String {
    format!("zenyttd query {}", shell_quote(&serde_json::to_string(req).unwrap_or_default()))
}

async fn query(conn: &Connection, req: &Request) -> Result<Response> {
    let out = conn.exec(&format!("PATH=$PATH:/usr/local/bin; {}", query_command(req)), None).await?;
    if !out.success() {
        return Err(Error::Remote(out.stderr.trim().to_string()));
    }
    serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("réponse de l'agent illisible : {e}")))
}

/// Requête en root : seule façon d'obtenir les URL de notification et l'envoi de test.
async fn query_root(conn: &Connection, req: &Request, sudo: Option<&str>) -> Result<Response> {
    let out = conn.exec_sudo(&format!("PATH=$PATH:/usr/local/bin; {}", query_command(req)), sudo, None).await?;
    if !out.success() {
        return Err(Error::Remote(out.stderr.trim().to_string()));
    }
    serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("réponse de l'agent illisible : {e}")))
}

/// État de l'agent, URL de notification masquées (lecture sans privilège).
pub async fn info(conn: &Connection) -> Result<AgentInfo> {
    info_with(conn, None).await
}

/// État complet de l'agent, configuration comprise, lu en root. Repli sur [`info`] sans sudo.
pub async fn info_privileged(conn: &Connection, sudo: Option<&str>) -> Result<AgentInfo> {
    match info_with(conn, Some(sudo)).await {
        Ok(i) if i.status.is_some() => Ok(i),
        _ => info(conn).await,
    }
}

async fn info_with(conn: &Connection, root: Option<Option<&str>>) -> Result<AgentInfo> {
    let installed = conn.exec("test -x /usr/local/bin/zenyttd", None).await?.success();
    if !installed {
        return Ok(AgentInfo { installed, running: false, status: None, error: None });
    }
    let answer = match root {
        Some(sudo) => query_root(conn, &Request::Status, sudo).await,
        None => query(conn, &Request::Status).await,
    };
    Ok(match answer {
        Ok(Response::Status(s)) => AgentInfo { installed, running: true, status: Some(*s), error: None },
        Ok(other) => AgentInfo { installed, running: true, status: None, error: Some(format!("réponse inattendue : {other:?}")) },
        Err(e) => AgentInfo { installed, running: false, status: None, error: Some(e.to_string()) },
    })
}

pub async fn history(conn: &Connection, range_secs: u64, points: usize) -> Result<Vec<HistoryPoint>> {
    match query(conn, &Request::History { range_secs, points }).await? {
        Response::History { points } => Ok(points),
        Response::Error { message } => Err(Error::Remote(message)),
        other => Err(Error::Other(format!("réponse inattendue : {other:?}"))),
    }
}

pub async fn test_notify(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    match query_root(conn, &Request::TestNotify, sudo).await? {
        Response::Ok { message } => Ok(message),
        Response::Error { message } => Err(Error::Remote(message)),
        other => Err(Error::Other(format!("réponse inattendue : {other:?}"))),
    }
}

/// Écrit la configuration ; l'agent la recharge tout seul au relevé suivant.
pub async fn save_config(conn: &Connection, cfg: &AgentConfig, sudo: Option<&str>) -> Result<()> {
    // Une URL affichée masquée (lecture sans sudo) conserve sa valeur actuelle.
    let mut cfg = cfg.clone();
    let n = &mut cfg.notifiers;
    if [&n.discord_webhook, &n.ntfy_url, &n.webhook_url].iter().any(|v| v.as_deref() == Some(zenytt_protocol::REDACTED)) {
        let current: AgentConfig = serde_json::from_str(&conn.read_file_sudo(CONFIG_PATH, sudo).await?).unwrap_or_default();
        let keep = |v: &mut Option<String>, old: &Option<String>| {
            if v.as_deref() == Some(zenytt_protocol::REDACTED) {
                v.clone_from(old);
            }
        };
        keep(&mut n.discord_webhook, &current.notifiers.discord_webhook);
        keep(&mut n.ntfy_url, &current.notifiers.ntfy_url);
        keep(&mut n.webhook_url, &current.notifiers.webhook_url);
    }
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| Error::Other(e.to_string()))?;
    conn.write_file_sudo(CONFIG_PATH, &json, sudo).await
}

/// Envoie le binaire adapté à l'architecture du serveur et l'installe comme service.
/// `binary_for` renvoie le binaire (embarqué dans l'app) pour une architecture (`x86_64`,
/// `aarch64`). Il n'est jamais écrit sur le disque du PC : l'empreinte vérifiée par le serveur est
/// calculée sur les octets mêmes qui partent, sans fenêtre où un fichier local pourrait être
/// remplacé par un autre programme (puis installé en root).
pub async fn install(conn: &Connection, sudo: Option<&str>, binary_for: impl Fn(&str) -> Option<&'static [u8]>) -> Result<String> {
    // Conditions de l'agent : Linux, processeur x86_64 ou ARM 64 bits (sans systemd, il tourne en arrière-plan).
    let env = conn.run("uname -s; uname -m").await?;
    let mut lines = env.lines().map(str::trim);
    let (os, arch) = (lines.next().unwrap_or(""), lines.next().unwrap_or(""));
    if os != "Linux" {
        return Err(Error::Other(format!(
            "l'agent zenyttd ne fonctionne que sous Linux (ce serveur : {os}). Le monitoring direct reste disponible."
        )));
    }
    let target = target_for_arch(arch).ok_or_else(|| {
        Error::Other(format!(
            "processeur {arch} non pris en charge par l'agent (x86_64 et ARM 64 bits seulement). Le monitoring direct reste disponible."
        ))
    })?;
    let bytes =
        binary_for(target).filter(|b| !b.is_empty()).ok_or_else(|| Error::Other(format!("binaire zenyttd introuvable pour {target}")))?;
    let sha256: String = ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let remote = upload_binary(conn, bytes).await?;
    // Le script lit l'unité systemd sur stdin.
    let cmd = format!("sh -c {} zenyttd-install {} {sha256}", shell_quote(INSTALL_SCRIPT), shell_quote(&remote));
    let out = conn.exec_sudo(&cmd, sudo, Some(SYSTEMD_UNIT.as_bytes())).await?.into_result()?;
    Ok(out.stdout)
}

/// Envoie le binaire dans un dossier temporaire privé (0700, nom imprévisible) : aucun autre
/// compte du serveur ne peut le créer à l'avance ni le remplacer avant son installation.
pub(crate) async fn upload_binary(conn: &Connection, bytes: &[u8]) -> Result<String> {
    let private = conn.run("mktemp -d /tmp/zenyttd-upload.XXXXXXXXXX").await?.trim().to_string();
    if !private.starts_with("/tmp/zenyttd-upload.") || !private[5..].chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err(Error::Other(format!("dossier temporaire inattendu : {private}")));
    }
    let sftp = conn.sftp().await?;
    let remote = format!("{private}/zenyttd");
    crate::sftp::write_bytes(&sftp, &remote, bytes).await?;
    Ok(remote)
}

pub async fn uninstall(conn: &Connection, sudo: Option<&str>) -> Result<()> {
    conn.exec_sudo(UNINSTALL_SCRIPT, sudo, None).await?.into_result()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arch_mapping() {
        assert_eq!(target_for_arch("x86_64\n"), Some("x86_64"));
        assert_eq!(target_for_arch("aarch64"), Some("aarch64"));
        assert_eq!(target_for_arch("armv7l"), None);
    }

    #[test]
    fn query_is_quoted() {
        assert_eq!(query_command(&Request::Status), r#"zenyttd query '{"type":"status"}'"#);
    }
}
