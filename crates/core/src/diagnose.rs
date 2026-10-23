//! Diagnostic de connexion, lancé depuis le PC : résolution DNS, port SSH, bannière SSH, ports web.
//!
//! Aucune authentification n'est tentée : le diagnostic ne peut pas aggraver un bannissement
//! fail2ban. Il distingue un serveur éteint, un service SSH arrêté, une IP bloquée et un refus
//! d'identifiants.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;

const STEP_LIMIT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Probe {
    Open,
    Refused,
    Timeout,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub checks: Vec<Check>,
    /// Conclusion principale, en une phrase.
    pub verdict: String,
    /// Que faire ensuite.
    pub advice: Vec<String>,
    /// Un bannissement fail2ban est la cause la plus probable.
    pub probably_banned: bool,
    /// IP publique du PC, pour la débloquer ou l'ajouter à `ignoreip`.
    pub public_ip: Option<String>,
}

async fn probe(addr: SocketAddr) -> (Probe, Option<TcpStream>, Duration) {
    let start = Instant::now();
    match tokio::time::timeout(STEP_LIMIT, TcpStream::connect(addr)).await {
        Ok(Ok(s)) => (Probe::Open, Some(s), start.elapsed()),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => (Probe::Refused, None, start.elapsed()),
        Ok(Err(_)) => (Probe::Error, None, start.elapsed()),
        Err(_) => (Probe::Timeout, None, start.elapsed()),
    }
}

fn describe(p: Probe, took: Duration) -> String {
    match p {
        Probe::Open => format!("ouvert ({} ms)", took.as_millis()),
        Probe::Refused => "refusé (rien n'écoute sur ce port)".into(),
        Probe::Timeout => format!("aucune réponse en {} s", STEP_LIMIT.as_secs()),
        Probe::Error => "injoignable (réseau)".into(),
    }
}

/// IP publique du PC, demandée en HTTPS : une réponse falsifiée sur un réseau non sûr pourrait
/// sinon faire ajouter une mauvaise adresse aux exceptions fail2ban.
pub async fn public_ip() -> Option<String> {
    let work = tokio::task::spawn_blocking(|| {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(STEP_LIMIT)).build().into();
        let body = agent.get("https://api.ipify.org").call().ok()?.body_mut().read_to_string().ok()?;
        let ip = body.trim().to_string();
        ip.parse::<std::net::IpAddr>().ok().map(|_| ip)
    });
    work.await.ok().flatten()
}

pub async fn diagnose(host: &str, port: u16) -> Diagnosis {
    let mut checks = Vec::new();

    // 1. DNS
    let addrs: Vec<SocketAddr> = match tokio::net::lookup_host((host, port)).await {
        Ok(a) => a.collect(),
        Err(e) => {
            checks.push(Check { label: format!("Résolution de {host}"), ok: false, detail: e.to_string() });
            let public_ip = public_ip().await;
            return Diagnosis {
                checks,
                verdict: format!("Le nom {host} est introuvable."),
                advice: vec!["Vérifie l'orthographe de l'hôte dans le profil, ou utilise directement l'adresse IP du serveur.".into()],
                probably_banned: false,
                public_ip,
            };
        }
    };
    // IPv4 d'abord : c'est généralement elle que filtre fail2ban.
    let Some(addr) = addrs.iter().find(|a| a.is_ipv4()).or(addrs.first()).copied() else {
        checks.push(Check { label: format!("Résolution de {host}"), ok: false, detail: "aucune adresse".into() });
        let public_ip = public_ip().await;
        return Diagnosis {
            checks,
            verdict: format!("Le nom {host} ne pointe vers aucune adresse."),
            advice: vec![],
            probably_banned: false,
            public_ip,
        };
    };
    checks.push(Check { label: format!("Résolution de {host}"), ok: true, detail: addr.ip().to_string() });

    // Tous les tests en parallèle : le diagnostic dure au plus le délai d'un test (plus la bannière).
    let (public_ip, (ssh, stream, took), web443, web80) =
        tokio::join!(public_ip(), probe(addr), probe(SocketAddr::new(addr.ip(), 443)), probe(SocketAddr::new(addr.ip(), 80)));

    // 2. Port SSH, puis bannière
    checks.push(Check { label: format!("Port SSH {port}"), ok: ssh == Probe::Open, detail: describe(ssh, took) });
    let mut banner = None;
    if let Some(s) = stream {
        let mut line = String::new();
        let read = tokio::time::timeout(STEP_LIMIT, BufReader::new(s).read_line(&mut line)).await;
        let ok = matches!(read, Ok(Ok(n)) if n > 0) && line.starts_with("SSH-");
        checks.push(Check {
            label: "Bannière SSH".into(),
            ok,
            detail: if ok {
                line.trim().to_string()
            } else {
                "le port répond, mais pas un serveur SSH (ou connexion coupée aussitôt)".into()
            },
        });
        banner = ok.then_some(line);
    }

    // 3. Ports web : le serveur est-il en ligne ?
    let mut web_up = false;
    for (p, (r, _, took)) in [(443u16, web443), (80, web80)] {
        web_up |= r == Probe::Open;
        checks.push(Check { label: format!("Port web {p}"), ok: r == Probe::Open, detail: describe(r, took) });
    }

    let ip = public_ip.clone().unwrap_or_else(|| "TON_IP".into());
    let unban = vec![
        format!("Depuis un autre réseau (partage 4G) ou la console de ton hébergeur : sudo fail2ban-client status sshd, puis sudo fail2ban-client set sshd unbanip {ip}."),
        format!("Pour éviter que ça se reproduise, ajoute {ip} à ignoreip dans /etc/fail2ban/jail.local (Zenytt peut le faire dans Sécurité → fail2ban une fois connecté)."),
    ];
    let (verdict, advice, banned) = match (ssh, banner.is_some(), web_up) {
        (Probe::Open, true, _) => (
            "Le serveur SSH répond normalement : si la connexion échoue, c'est l'authentification (utilisateur, clé ou mot de passe).".to_string(),
            vec![
                "Vérifie l'utilisateur et la méthode d'authentification du profil (clé .ppk, agent, mot de passe).".into(),
                "Attention : chaque échec compte pour fail2ban. Corrige le profil avant de réessayer.".into(),
            ],
            false,
        ),
        (Probe::Open, false, _) => (
            "Le port répond mais la connexion est coupée avant la bannière SSH : IP bloquée (fail2ban, TCP wrappers) ou service saturé.".to_string(),
            unban,
            true,
        ),
        (Probe::Refused, _, _) => (
            format!("Le serveur est joignable mais rien n'écoute sur le port {port} : sshd est arrêté, ou le port du profil est faux."),
            vec![
                format!("Vérifie le port SSH du profil ({port})."),
                "Redémarre sshd depuis la console de ton hébergeur : sudo systemctl restart ssh (ou sshd).".into(),
            ],
            false,
        ),
        (Probe::Timeout | Probe::Error, _, true) => (
            format!("Le serveur est en ligne (ses sites répondent) mais le port SSH {port} ne répond pas depuis ton IP : très probablement un bannissement fail2ban, sinon une règle de pare-feu."),
            unban,
            true,
        ),
        (Probe::Timeout | Probe::Error, _, false) => (
            "Le serveur ne répond sur aucun port : il est éteint, injoignable, ou ton IP est bloquée sur tous les ports (fail2ban peut bloquer tous les ports).".to_string(),
            [vec![
                "Vérifie l'état du serveur dans l'espace client de ton hébergeur (et redémarre-le si besoin).".into(),
                "Teste depuis un autre réseau (partage 4G) : si ça passe, c'est ton IP qui est bloquée.".into(),
            ], unban]
            .concat(),
            false,
        ),
    };
    Diagnosis { checks, verdict, advice, probably_banned: banned, public_ip }
}
