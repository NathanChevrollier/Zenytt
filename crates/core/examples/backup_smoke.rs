//! Test de fumée des sauvegardes et de fail2ban contre le VPS Debian du `testenv` (admin/admin,
//! sudo avec mot de passe). `ZENYTT_TEST_PORT=22999 cargo run -p zenytt-core --example backup_smoke`
//! (port 2223 par défaut).
//!
//! Vérifie : installation de restic par le bouton, sauvegarde dans un dossier du serveur, copie du
//! dépôt sur le PC puis mise à jour incrémentale ; bannissements de 30 jours et définitifs (date de
//! fin, une seule ligne par adresse) ; réglages fail2ban (écrits, relus, appliqués, rétablis).

use zenytt_core::backup::{self, BackupConfig, Destination};
use zenytt_core::fail2ban::{self, BanDuration, JailSettings, Rules, Settings};
use zenytt_core::{Auth, ConnectParams, Connection, Error};

const SUDO: Option<&str> = Some("admin");

async fn connect(port: u16, fp: Option<String>) -> Result<Connection, Error> {
    Connection::connect(ConnectParams {
        host: "127.0.0.1".into(),
        port,
        username: "admin".into(),
        auth: Auth::Password { password: "admin".into() },
        known_fingerprint: fp,
    })
    .await
}

fn check(ok: bool, what: &str) -> Result<(), Box<dyn std::error::Error>> {
    if ok {
        println!("ok  {what}");
        Ok(())
    } else {
        Err(format!("ÉCHEC : {what}").into())
    }
}

/// Copie le dépôt du serveur dans `dir` (comme la commande `backup_mirror` de l'app).
async fn mirror(c: &Connection, repo: &str, dir: &std::path::Path) -> Result<backup::MirrorPlan, Box<dyn std::error::Error>> {
    let remote = backup::repo_files(c, SUDO, repo).await?;
    let mut local = Vec::new();
    for e in walk(dir) {
        let rel = e.strip_prefix(dir)?.to_string_lossy().replace('\\', "/");
        if backup::valid_repo_path(&rel) {
            local.push(backup::RepoFile { path: rel, size: std::fs::metadata(&e)?.len() });
        }
    }
    let plan = backup::plan_mirror(&remote, &local);
    for f in &plan.download {
        backup::fetch_file_sudo(c, SUDO, &format!("{repo}/{}", f.path), f.size, &dir.join(&f.path), &|_| true).await?;
    }
    for p in &plan.delete {
        std::fs::remove_file(dir.join(p))?;
    }
    Ok(plan)
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            if e.path().is_dir() {
                stack.push(e.path());
            } else {
                out.push(e.path());
            }
        }
    }
    out
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("ZENYTT_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(2223);
    let fp = match connect(port, None).await {
        Err(Error::UnknownHostKey(fp)) => fp,
        other => return Err(format!("attendu UnknownHostKey, obtenu {:?}", other.err()).into()),
    };
    let c = connect(port, Some(fp)).await?;

    // ---- restic : installation, sauvegarde, copie sur le PC ----
    let log = backup::install_restic(&c, SUDO).await?;
    check(log.contains("restic "), "restic installé par le bouton")?;
    let repo = "/var/backups/zenytt/restic";
    let cfg =
        BackupConfig { destination: Destination::Local { path: repo.into() }, paths: vec!["/etc/fail2ban".into()], ..Default::default() };
    let env = backup::env_file(&cfg, "mot-de-passe-de-test-1234", None)?;
    backup::install(&c, SUDO, &cfg, &env).await?;
    c.exec_sudo(backup::SCRIPT_PATH, SUDO, None).await?.into_result()?;
    check(backup::snapshots(&c, SUDO).await?.len() == 1, "une sauvegarde dans le dossier du serveur")?;

    let dir = std::env::temp_dir().join(format!("zenytt-mirror-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let first = mirror(&c, repo, &dir).await?;
    check(
        first.download.iter().any(|f| f.path == "config") && first.download.iter().any(|f| f.path.starts_with("snapshots/")),
        "première copie complète",
    )?;
    let remote = backup::repo_files(&c, SUDO, repo).await?;
    let copied: u64 = walk(&dir).iter().map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum();
    check(copied == remote.iter().map(|f| f.size).sum::<u64>(), "taille de la copie égale au dépôt")?;
    check(mirror(&c, repo, &dir).await?.download.is_empty(), "rien à recopier quand c'est à jour")?;
    c.exec_sudo(backup::SCRIPT_PATH, SUDO, None).await?.into_result()?;
    let second = mirror(&c, repo, &dir).await?;
    check(!second.download.is_empty() && second.download.len() < first.download.len(), "seuls les nouveaux fichiers sont copiés")?;
    let _ = std::fs::remove_dir_all(&dir);

    // ---- fail2ban : bannissements longs (ticket #27) ----
    let ip = "203.0.113.77";
    fail2ban::ban(&c, SUDO, "sshd", ip, BanDuration::Jail).await?;
    fail2ban::ban(&c, SUDO, "", ip, BanDuration::Month).await?;
    let st = fail2ban::state(&c, SUDO).await?;
    let holding: Vec<&str> = st.jails.iter().filter(|j| j.banned.iter().any(|b| b == ip)).map(|j| j.name.as_str()).collect();
    check(holding == ["zenytt-30j"], &format!("30 jours : une seule ligne ({holding:?})"))?;
    let month = st.jails.iter().find(|j| j.name == "zenytt-30j").and_then(|j| j.bans.iter().find(|b| b.ip == ip)).cloned();
    check(month.as_ref().is_some_and(|b| b.until.is_some()), &format!("30 jours : date de fin connue ({month:?})"))?;
    fail2ban::ban(&c, SUDO, "", ip, BanDuration::Forever).await?;
    let st = fail2ban::state(&c, SUDO).await?;
    let holding: Vec<&str> = st.jails.iter().filter(|j| j.banned.iter().any(|b| b == ip)).map(|j| j.name.as_str()).collect();
    check(holding == ["zenytt-definitif"], &format!("définitif : remplace les 30 jours ({holding:?})"))?;
    let forever = st.jails.iter().find(|j| j.name == "zenytt-definitif").and_then(|j| j.bans.iter().find(|b| b.ip == ip));
    check(forever.is_some_and(|b| b.until.is_none()), "définitif : sans date de fin")?;
    fail2ban::unban(&c, SUDO, "zenytt-definitif", ip).await?;

    // ---- fail2ban : réglages (ticket #28) ----
    let wanted = Settings {
        defaults: Rules { bantime: Some(7200), findtime: Some(900), maxretry: Some(4) },
        increment: true,
        increment_max: Some(14 * 86400),
        jails: vec![
            JailSettings { name: "sshd".into(), enabled: None, rules: Rules { maxretry: Some(2), ..Default::default() } },
            JailSettings { name: "recidive".into(), enabled: Some(true), rules: Rules::default() },
        ],
    };
    fail2ban::set_settings(&c, SUDO, &wanted).await?;
    let view = fail2ban::settings(&c, SUDO).await?;
    check(view.settings == wanted, "réglages relus à l'identique")?;
    check(
        view.available.iter().any(|j| j == "nginx-http-auth") && !view.available.iter().any(|j| j.starts_with("zenytt-")),
        "jails disponibles listées",
    )?;
    let st = fail2ban::state(&c, SUDO).await?;
    let sshd = st.jails.iter().find(|j| j.name == "sshd").ok_or("sshd absent")?;
    check((sshd.bantime, sshd.maxretry, sshd.findtime) == (7200, 2, 900), "sshd : règle propre et règles par défaut appliquées")?;
    check(st.jails.iter().any(|j| j.name == "recidive"), "recidive activé")?;
    let refused = fail2ban::set_settings(
        &c,
        SUDO,
        &Settings {
            jails: vec![JailSettings { name: "zenytt-7j".into(), enabled: Some(false), rules: Rules::default() }],
            ..Default::default()
        },
    )
    .await;
    check(refused.is_err(), "jails de Zenytt protégées")?;
    fail2ban::set_settings(&c, SUDO, &Settings::default()).await?;
    let st = fail2ban::state(&c, SUDO).await?;
    check(!st.jails.iter().any(|j| j.name == "recidive"), "réglages du serveur rétablis")?;

    println!("\nTout est bon.");
    Ok(())
}
