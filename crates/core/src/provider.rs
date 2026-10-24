//! Alimentation d'un serveur via l'API de son hébergeur : fonctionne même quand SSH ne répond plus.
//!
//! Les requêtes sont construites par des fonctions pures ([`build`]) pour être testables sans réseau ;
//! l'envoi (bloquant, `ureq`) se fait hors du fil asynchrone. Aucun jeton n'est journalisé.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Hetzner,
    Scaleway,
    DigitalOcean,
    Ovh,
}

/// Lien d'un serveur avec son compte chez l'hébergeur (sans secret).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLink {
    pub kind: ProviderKind,
    /// Identifiant du serveur chez l'hébergeur (OVH : nom du service, ex. `vps-1234.vps.ovh.net`).
    pub server_ref: String,
    /// Scaleway : zone (`fr-par-1`). OVH : région de l'API (`ovh-eu`, `ovh-ca`, `ovh-us`).
    #[serde(default)]
    pub zone: Option<String>,
}

/// Identifiants. Hetzner, Scaleway, DigitalOcean : `token` seul. OVH : `token` = clé d'application.
#[derive(Clone, Default)]
pub struct Credentials {
    pub token: String,
    pub secret: String,
    pub consumer: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAction {
    Status,
    /// Redémarrage logiciel (ACPI).
    Reboot,
    /// Redémarrage forcé. Scaleway et OVH n'en proposent pas : c'est alors le même `reboot`.
    Reset,
    PowerOn,
    PowerOff,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PowerState {
    Running,
    Off,
    Starting,
    Stopping,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: PowerState,
    /// État tel que le renvoie l'hébergeur.
    pub raw: String,
    /// Nom du serveur chez l'hébergeur, quand la réponse le donne.
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

fn ovh_base(region: Option<&str>) -> Result<&'static str> {
    match region.unwrap_or("ovh-eu") {
        "ovh-eu" => Ok("https://eu.api.ovh.com/1.0"),
        "ovh-ca" => Ok("https://ca.api.ovh.com/1.0"),
        "ovh-us" => Ok("https://api.us.ovhcloud.com/1.0"),
        other => Err(Error::Other(format!("région OVH inconnue : {other}"))),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Signature OVH : `$1$` + SHA-1 hexadécimal de `secret+consumer+méthode+url+corps+horodatage`.
pub fn ovh_signature(secret: &str, consumer: &str, method: &str, url: &str, body: &str, timestamp: i64) -> String {
    let data = format!("{secret}+{consumer}+{method}+{url}+{body}+{timestamp}");
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, data.as_bytes());
    format!("$1${}", hex(digest.as_ref()))
}

/// Construit la requête d'une action. `now` (secondes Unix, `GET /auth/time` d'OVH) ne sert qu'à OVH.
pub fn build(link: &ProviderLink, cred: &Credentials, action: ProviderAction, now: i64) -> Result<Request> {
    let id = link.server_ref.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(Error::Other("identifiant du serveur invalide chez l'hébergeur".into()));
    }
    if cred.token.is_empty() {
        return Err(Error::Other("jeton de l'hébergeur manquant".into()));
    }
    use ProviderAction::*;
    let json = |s: &str| Some(s.to_string());
    let (method, url, body, mut headers): (&str, String, Option<String>, Vec<(String, String)>) = match link.kind {
        ProviderKind::Hetzner => {
            let base = format!("https://api.hetzner.cloud/v1/servers/{id}");
            let h = vec![("Authorization".into(), format!("Bearer {}", cred.token))];
            match action {
                Status => ("GET", base, None, h),
                Reboot => ("POST", format!("{base}/actions/reboot"), None, h),
                Reset => ("POST", format!("{base}/actions/reset"), None, h),
                PowerOn => ("POST", format!("{base}/actions/poweron"), None, h),
                PowerOff => ("POST", format!("{base}/actions/poweroff"), None, h),
            }
        }
        ProviderKind::Scaleway => {
            let zone = link.zone.as_deref().filter(|z| !z.is_empty()).unwrap_or("fr-par-1");
            if !zone.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(Error::Other("zone Scaleway invalide".into()));
            }
            let base = format!("https://api.scaleway.com/instance/v1/zones/{zone}/servers/{id}");
            let h = vec![("X-Auth-Token".into(), cred.token.clone())];
            let act = |a: &str| ("POST", format!("{base}/action"), json(&format!(r#"{{"action":"{a}"}}"#)), h.clone());
            match action {
                Status => ("GET", base.clone(), None, h.clone()),
                Reboot | Reset => act("reboot"),
                PowerOn => act("poweron"),
                PowerOff => act("poweroff"),
            }
        }
        ProviderKind::DigitalOcean => {
            let h = vec![("Authorization".into(), format!("Bearer {}", cred.token))];
            let act = |t: &str| {
                ("POST", format!("https://api.digitalocean.com/v2/droplets/{id}/actions"), json(&format!(r#"{{"type":"{t}"}}"#)), h.clone())
            };
            match action {
                Status => ("GET", format!("https://api.digitalocean.com/v2/droplets/{id}"), None, h.clone()),
                Reboot => act("reboot"),
                Reset => act("power_cycle"),
                PowerOn => act("power_on"),
                PowerOff => act("power_off"),
            }
        }
        ProviderKind::Ovh => {
            if cred.secret.is_empty() || cred.consumer.is_empty() {
                return Err(Error::Other("clé d'application, secret et clé de consommateur OVH requis".into()));
            }
            let base = format!("{}/vps/{id}", ovh_base(link.zone.as_deref())?);
            let (method, url) = match action {
                Status => ("GET", base),
                Reboot | Reset => ("POST", format!("{base}/reboot")),
                PowerOn => ("POST", format!("{base}/start")),
                PowerOff => ("POST", format!("{base}/stop")),
            };
            let sig = ovh_signature(&cred.secret, &cred.consumer, method, &url, "", now);
            let h = vec![
                ("X-Ovh-Application".into(), cred.token.clone()),
                ("X-Ovh-Consumer".into(), cred.consumer.clone()),
                ("X-Ovh-Timestamp".into(), now.to_string()),
                ("X-Ovh-Signature".into(), sig),
            ];
            (method, url, None, h)
        }
    };
    if method == "POST" {
        headers.push(("Content-Type".into(), "application/json".into()));
    }
    Ok(Request { method, url, headers, body })
}

/// Lit l'état d'alimentation dans la réponse d'un `GET` de statut.
pub fn parse_status(kind: ProviderKind, text: &str) -> Result<Status> {
    let v: Value = serde_json::from_str(text).map_err(|_| Error::Other("réponse illisible de l'hébergeur".into()))?;
    let (obj, key) = match kind {
        ProviderKind::Hetzner => (&v["server"], "status"),
        ProviderKind::Scaleway => (&v["server"], "state"),
        ProviderKind::DigitalOcean => (&v["droplet"], "status"),
        ProviderKind::Ovh => (&v, "state"),
    };
    // OVH : `displayName` est le nom choisi par le client, `name` celui du service.
    let name = ["displayName", "name"].iter().find_map(|k| obj[*k].as_str().filter(|n| !n.is_empty())).map(String::from);
    let raw = obj[key].as_str().ok_or_else(|| Error::Other("état absent de la réponse de l'hébergeur".into()))?;
    let state = match raw {
        "running" | "active" => PowerState::Running,
        "off" | "stopped" | "stopped in place" | "archive" => PowerState::Off,
        "initializing" | "starting" | "new" | "rebooting" => PowerState::Starting,
        "stopping" => PowerState::Stopping,
        _ => PowerState::Unknown,
    };
    Ok(Status { state, raw: raw.to_string(), name })
}

fn http_error(status: u16, body: &str) -> Error {
    let detail: String = body.chars().take(200).collect();
    Error::Other(match status {
        401 | 403 => "jeton refusé par l'hébergeur (401/403)".to_string(),
        404 => "serveur introuvable chez l'hébergeur (identifiant ou zone ?)".to_string(),
        429 => "trop de requêtes, réessaie dans un instant (429)".to_string(),
        s => format!("l'hébergeur a répondu {s} : {detail}"),
    })
}

fn send(agent: &ureq::Agent, req: &Request) -> Result<String> {
    let result = if req.method == "GET" {
        req.headers.iter().fold(agent.get(&req.url), |b, (k, v)| b.header(k, v)).call()
    } else {
        let b = req.headers.iter().fold(agent.post(&req.url), |b, (k, v)| b.header(k, v));
        match &req.body {
            Some(body) => b.send(body.as_str()),
            None => b.send_empty(),
        }
    };
    let mut resp = result.map_err(|e| Error::Other(format!("hébergeur injoignable : {e}")))?;
    let status = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().map_err(|e| Error::Other(e.to_string()))?;
    if status >= 400 {
        return Err(http_error(status, &text));
    }
    Ok(text)
}

fn run_blocking(link: &ProviderLink, cred: &Credentials, action: ProviderAction) -> Result<Status> {
    let agent: ureq::Agent =
        ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).http_status_as_error(false).build().into();
    let ovh_time = |agent: &ureq::Agent| -> Result<i64> {
        if link.kind != ProviderKind::Ovh {
            return Ok(0);
        }
        let url = format!("{}/auth/time", ovh_base(link.zone.as_deref())?);
        let text = send(agent, &Request { method: "GET", url, headers: vec![], body: None })?;
        text.trim().parse().map_err(|_| Error::Other("heure de l'API OVH illisible".into()))
    };
    if action != ProviderAction::Status {
        send(&agent, &build(link, cred, action, ovh_time(&agent)?)?)?;
    }
    let text = send(&agent, &build(link, cred, ProviderAction::Status, ovh_time(&agent)?)?)?;
    parse_status(link.kind, &text)
}

/// Exécute l'action puis renvoie l'état d'alimentation qui suit.
pub async fn run(link: &ProviderLink, cred: &Credentials, action: ProviderAction) -> Result<Status> {
    let (link, cred) = (link.clone(), cred.clone());
    tokio::task::spawn_blocking(move || run_blocking(&link, &cred, action)).await.map_err(|e| Error::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(kind: ProviderKind, zone: Option<&str>) -> ProviderLink {
        ProviderLink { kind, server_ref: "42".into(), zone: zone.map(Into::into) }
    }

    fn cred() -> Credentials {
        Credentials { token: "tok".into(), secret: "secret".into(), consumer: "consumer".into() }
    }

    #[test]
    fn ovh_signature_matches_sha1_vector() {
        // sha1("secret+consumer+POST+https://eu.api.ovh.com/1.0/vps/vps123.ovh.net/reboot++1366560945")
        let sig = ovh_signature("secret", "consumer", "POST", "https://eu.api.ovh.com/1.0/vps/vps123.ovh.net/reboot", "", 1366560945);
        assert_eq!(sig, "$1$49be607130a19a750f9613f4651882edfb3303a7");
    }

    #[test]
    fn hetzner_requests() {
        let r = build(&link(ProviderKind::Hetzner, None), &cred(), ProviderAction::Reset, 0).unwrap();
        assert_eq!((r.method, r.url.as_str()), ("POST", "https://api.hetzner.cloud/v1/servers/42/actions/reset"));
        assert!(r.headers.contains(&("Authorization".into(), "Bearer tok".into())));
        let r = build(&link(ProviderKind::Hetzner, None), &cred(), ProviderAction::Status, 0).unwrap();
        assert_eq!((r.method, r.url.as_str()), ("GET", "https://api.hetzner.cloud/v1/servers/42"));
    }

    #[test]
    fn scaleway_and_digitalocean_bodies() {
        let r = build(&link(ProviderKind::Scaleway, Some("nl-ams-1")), &cred(), ProviderAction::Reset, 0).unwrap();
        assert_eq!(r.url, "https://api.scaleway.com/instance/v1/zones/nl-ams-1/servers/42/action");
        assert_eq!(r.body.as_deref(), Some(r#"{"action":"reboot"}"#));
        assert!(r.headers.contains(&("X-Auth-Token".into(), "tok".into())));
        let r = build(&link(ProviderKind::DigitalOcean, None), &cred(), ProviderAction::Reset, 0).unwrap();
        assert_eq!(r.url, "https://api.digitalocean.com/v2/droplets/42/actions");
        assert_eq!(r.body.as_deref(), Some(r#"{"type":"power_cycle"}"#));
    }

    #[test]
    fn ovh_request_is_signed() {
        let r = build(&link(ProviderKind::Ovh, Some("ovh-ca")), &cred(), ProviderAction::PowerOff, 1366560945).unwrap();
        assert_eq!((r.method, r.url.as_str()), ("POST", "https://ca.api.ovh.com/1.0/vps/42/stop"));
        let sig = ovh_signature("secret", "consumer", "POST", &r.url, "", 1366560945);
        assert!(r.headers.contains(&("X-Ovh-Signature".into(), sig)));
        assert!(r.headers.contains(&("X-Ovh-Application".into(), "tok".into())));
    }

    #[test]
    fn rejects_injection_and_missing_credentials() {
        let mut l = link(ProviderKind::Hetzner, None);
        l.server_ref = "1/../../x".into();
        assert!(build(&l, &cred(), ProviderAction::Status, 0).is_err());
        assert!(build(&link(ProviderKind::Hetzner, None), &Credentials::default(), ProviderAction::Status, 0).is_err());
        assert!(build(&link(ProviderKind::Scaleway, Some("fr/../x")), &cred(), ProviderAction::Status, 0).is_err());
    }

    #[test]
    fn status_normalization() {
        let st = |k, t| parse_status(k, t).unwrap();
        assert_eq!(st(ProviderKind::Hetzner, r#"{"server":{"status":"running"}}"#).state, PowerState::Running);
        assert_eq!(st(ProviderKind::Hetzner, r#"{"server":{"status":"off"}}"#).state, PowerState::Off);
        assert_eq!(st(ProviderKind::Scaleway, r#"{"server":{"state":"stopped in place"}}"#).state, PowerState::Off);
        assert_eq!(st(ProviderKind::DigitalOcean, r#"{"droplet":{"status":"new"}}"#).state, PowerState::Starting);
        let s = st(ProviderKind::Ovh, r#"{"state":"rebooting","name":"x"}"#);
        assert_eq!((s.state, s.raw.as_str(), s.name.as_deref()), (PowerState::Starting, "rebooting", Some("x")));
        assert_eq!(st(ProviderKind::Hetzner, r#"{"server":{"status":"running","name":"web-01"}}"#).name.as_deref(), Some("web-01"));
        assert_eq!(st(ProviderKind::Hetzner, r#"{"server":{"status":"running"}}"#).name, None);
        assert_eq!(st(ProviderKind::Hetzner, r#"{"server":{"status":"migrating"}}"#).state, PowerState::Unknown);
        assert!(parse_status(ProviderKind::Ovh, "{}").is_err());
    }

    #[test]
    fn http_errors_are_french_and_leak_nothing() {
        assert!(http_error(401, "bad tok").to_string().contains("jeton refusé"));
        assert!(http_error(403, "").to_string().contains("jeton refusé"));
        assert!(!http_error(401, "bad tok").to_string().contains("bad tok"));
    }
}
