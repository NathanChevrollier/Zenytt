//! Sauvegardes planifiées avec restic (chiffrées, dédupliquées) : dumps cohérents des bases dans
//! les conteneurs, volumes Docker et dossiers, vers un dossier du serveur ou un stockage S3.
//!
//! Fichiers sur le serveur (root uniquement) :
//! - `/etc/zenytt-backup/config.json` (0600) : configuration sans secret, relue par l'app ;
//! - `/etc/zenytt-backup/env` (0600) : dépôt, mot de passe restic, clés S3 ;
//! - `/etc/zenytt-backup/run.sh` (0700) : script généré ;
//! - `/var/lib/zenytt-backup/last.json` (0644) : résultat de la dernière sauvegarde (sans secret),
//!   lu par l'agent zenyttd pour alerter en cas d'échec.

use serde::{Deserialize, Serialize};

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub const CONFIG_PATH: &str = "/etc/zenytt-backup/config.json";
pub const ENV_PATH: &str = "/etc/zenytt-backup/env";
pub const SCRIPT_PATH: &str = "/etc/zenytt-backup/run.sh";
pub const LAST_PATH: &str = "/var/lib/zenytt-backup/last.json";
pub const RESTORE_ROOT: &str = "/var/lib/zenytt-backup/restore";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Destination {
    /// Dossier sur le serveur lui-même (protège des erreurs, pas d'une perte du serveur).
    Local { path: String },
    /// Stockage compatible S3 (Backblaze B2, Scaleway, OVH, AWS…).
    S3 { endpoint: String, bucket: String, prefix: String, access_key_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbSource {
    pub container: String,
    /// `mysql` (MySQL/MariaDB) ou `postgres`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    pub destination: Destination,
    /// Heure quotidienne `HH:MM`.
    pub schedule: String,
    pub keep_daily: u32,
    pub keep_weekly: u32,
    pub keep_monthly: u32,
    pub paths: Vec<String>,
    pub volumes: Vec<String>,
    pub databases: Vec<DbSource>,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            destination: Destination::Local { path: "/var/backups/zenytt/restic".into() },
            schedule: "03:00".into(),
            keep_daily: 7,
            keep_weekly: 4,
            keep_monthly: 6,
            paths: vec!["/etc/nginx".into(), "/opt/sites".into(), "/etc/letsencrypt".into()],
            volumes: vec![],
            databases: vec![],
        }
    }
}

fn safe_path(p: &str) -> bool {
    p.starts_with('/') && !p.contains("..") && p.len() < 400 && p.chars().all(|c| c.is_ascii_alphanumeric() || "/._-@".contains(c))
}

fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn safe_value(s: &str) -> bool {
    !s.is_empty() && !s.contains(['\n', '\r', '\'', '\0'])
}

impl BackupConfig {
    pub fn validate(&self) -> Result<()> {
        let bad = |m: String| Err(Error::Other(m));
        let (h, m) = self.schedule.split_once(':').unwrap_or(("x", "x"));
        if !matches!((h.parse::<u32>(), m.parse::<u32>()), (Ok(h), Ok(m)) if h < 24 && m < 60) {
            return bad(format!("heure invalide : {}", self.schedule));
        }
        if let Some(p) = self.paths.iter().find(|p| !safe_path(p)) {
            return bad(format!("chemin refusé : {p}"));
        }
        if let Some(v) = self.volumes.iter().find(|v| !safe_name(v)) {
            return bad(format!("volume invalide : {v}"));
        }
        if let Some(d) = self.databases.iter().find(|d| !safe_name(&d.container) || !matches!(d.kind.as_str(), "mysql" | "postgres")) {
            return bad(format!("base invalide : {} ({})", d.container, d.kind));
        }
        match &self.destination {
            Destination::Local { path } if !safe_path(path) => bad(format!("dossier de destination refusé : {path}")),
            Destination::S3 { endpoint, bucket, prefix, access_key_id } => {
                if !endpoint.starts_with("https://") || !safe_value(endpoint) || endpoint.contains(' ') {
                    return bad("l'endpoint S3 doit commencer par https://".into());
                }
                if !safe_name(bucket) || !(prefix.is_empty() || safe_path(&format!("/{prefix}"))) || !safe_value(access_key_id) {
                    return bad("bucket, préfixe ou identifiant d'accès invalide".into());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Valeur de `RESTIC_REPOSITORY`.
    pub fn repository(&self) -> String {
        match &self.destination {
            Destination::Local { path } => path.clone(),
            Destination::S3 { endpoint, bucket, prefix, .. } => {
                let base = format!("s3:{}/{}", endpoint.trim_end_matches('/'), bucket);
                if prefix.is_empty() {
                    base
                } else {
                    format!("{base}/{}", prefix.trim_matches('/'))
                }
            }
        }
    }
}

/// Contenu du fichier d'environnement (secrets). `s3_secret` n'est utilisé que pour S3.
pub fn env_file(cfg: &BackupConfig, restic_password: &str, s3_secret: Option<&str>) -> Result<String> {
    if !safe_value(restic_password) {
        return Err(Error::Other("mot de passe restic invalide".into()));
    }
    let mut env = format!("RESTIC_REPOSITORY='{}'\nRESTIC_PASSWORD='{}'\n", cfg.repository(), restic_password);
    if let Destination::S3 { access_key_id, .. } = &cfg.destination {
        let secret = s3_secret.filter(|s| safe_value(s)).ok_or_else(|| Error::Other("clé secrète S3 manquante".into()))?;
        env.push_str(&format!("AWS_ACCESS_KEY_ID='{access_key_id}'\nAWS_SECRET_ACCESS_KEY='{secret}'\n"));
    }
    Ok(env)
}

/// Script de sauvegarde généré à partir de la configuration (toutes les valeurs sont validées).
pub fn run_script(cfg: &BackupConfig) -> String {
    let mut s = String::from(
        r#"#!/bin/bash
# Généré par Zenytt : ne pas modifier à la main (régénéré à chaque enregistrement).
set -uo pipefail
command -v docker >/dev/null 2>&1 || docker() { podman "$@"; }
set -a; . /etc/zenytt-backup/env; set +a
STATE=/var/lib/zenytt-backup; STAGE=$STATE/stage
mkdir -p "$STATE"; chmod 755 "$STATE"
START=$(date +%s)
finish() {
  local msg; msg=$(printf '%s' "$2" | tr '\n\r' '  ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"startedAt":%s,"finishedAt":%s,"ok":%s,"message":"%s"}\n' "$START" "$(date +%s)" "$1" "$msg" > "$STATE/last.json"
  chmod 644 "$STATE/last.json"
}
fail() { finish false "$1"; echo "ÉCHEC : $1" >&2; rm -rf "$STAGE"; exit 1; }
trap 'fail "sauvegarde interrompue"' INT TERM
rm -rf "$STAGE"; mkdir -p "$STAGE/db"; chmod 700 "$STAGE"
PATHS=("$STAGE")
echo "Sauvegarde Zenytt — $(date)"
"#,
    );
    for db in &cfg.databases {
        let c = &db.container;
        if db.kind == "mysql" {
            s.push_str(&format!(
                "echo \"Dump MySQL/MariaDB : {c}\"\ndocker exec {c} sh -c 'D=$(command -v mysqldump || command -v mariadb-dump); export MYSQL_PWD=\"${{MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}}\"; exec \"$D\" --all-databases --single-transaction --routines --events -uroot' > \"$STAGE/db/{c}.sql\" || fail \"dump de {c}\"\n"
            ));
        } else {
            s.push_str(&format!(
                "echo \"Dump PostgreSQL : {c}\"\ndocker exec {c} sh -c 'exec pg_dumpall -U \"${{POSTGRES_USER:-postgres}}\"' > \"$STAGE/db/{c}.sql\" || fail \"dump de {c}\"\n"
            ));
        }
    }
    for v in &cfg.volumes {
        s.push_str(&format!(
            "VP=$(docker volume inspect -f '{{{{.Mountpoint}}}}' {v}) || fail \"volume {v} introuvable\"\nPATHS+=(\"$VP\")\n"
        ));
    }
    for p in &cfg.paths {
        s.push_str(&format!("[ -e {p} ] && PATHS+=({p})\n"));
    }
    s.push_str(&format!(
        r#"restic cat config >/dev/null 2>&1 || restic init >/dev/null || fail "initialisation du dépôt impossible"
restic backup --tag zenytt --host "$(hostname)" "${{PATHS[@]}}" 2>&1 | tee "$STATE/last-output.txt" | tail -n 5
RC=${{PIPESTATUS[0]}}
# 3 = sauvegarde faite mais quelques fichiers illisibles : ce n'est pas un échec.
[ "$RC" = 0 ] || [ "$RC" = 3 ] || fail "$(tail -n 3 "$STATE/last-output.txt")"
restic forget --tag zenytt --prune --keep-daily {} --keep-weekly {} --keep-monthly {} >/dev/null 2>&1 || fail "rétention (forget/prune) impossible"
if [ "$(date +%u)" = 7 ]; then restic check --read-data-subset=5% >/dev/null 2>&1 || fail "vérification du dépôt en échec"; fi
rm -rf "$STAGE"
finish true "$(grep -m1 '^snapshot' "$STATE/last-output.txt")"
echo "Terminé."
"#,
        cfg.keep_daily.max(1),
        cfg.keep_weekly,
        cfg.keep_monthly
    ));
    s
}

fn systemd_units(schedule: &str) -> (String, String) {
    let service = format!("[Unit]\nDescription=Sauvegarde Zenytt (restic)\nAfter=network-online.target docker.service\n\n[Service]\nType=oneshot\nExecStart={SCRIPT_PATH}\nNice=10\nIOSchedulingClass=idle\n");
    let timer = format!("[Unit]\nDescription=Sauvegarde Zenytt quotidienne\n\n[Timer]\nOnCalendar=*-*-* {schedule}:00\nPersistent=true\nRandomizedDelaySec=10m\n\n[Install]\nWantedBy=timers.target\n");
    (service, timer)
}

/// Installe restic s'il manque : paquet de la distribution (apt, dnf/yum avec EPEL, apk, pacman,
/// zypper), sinon binaire officiel publié sur GitHub, vérifié avec le fichier SHA256SUMS de la même
/// version avant d'être installé dans /usr/local/bin. Affiche la version installée à la fin.
pub const INSTALL_RESTIC: &str = r#"set -u
if command -v restic >/dev/null 2>&1; then echo "restic déjà installé"; restic version; exit 0; fi
pkg() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y restic || { apt-get update && apt-get install -y restic; }
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y restic || { dnf install -y epel-release && dnf install -y restic; }
  elif command -v yum >/dev/null 2>&1; then
    yum install -y restic || { yum install -y epel-release && yum install -y restic; }
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache restic
  elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm restic
  elif command -v zypper >/dev/null 2>&1; then zypper -n install restic
  else return 1; fi
}
echo "Installation de restic avec le gestionnaire de paquets…"
PKGLOG=$(mktemp) || exit 1
pkg >"$PKGLOG" 2>&1 || true
if ! command -v restic >/dev/null 2>&1; then
  tail -n 5 "$PKGLOG" 2>/dev/null
  echo "Paquet indisponible : téléchargement du binaire officiel (github.com/restic/restic)…"
  case "$(uname -m)" in
    x86_64|amd64) A=amd64 ;; aarch64|arm64) A=arm64 ;; armv7l|armv6l) A=arm ;; i386|i686) A=386 ;;
    *) echo "architecture non prise en charge : $(uname -m)" >&2; exit 1 ;;
  esac
  if command -v curl >/dev/null 2>&1; then get() { curl -fsSL "$1" -o "$2"; }; last() { curl -fsSLI -o /dev/null -w '%{url_effective}' "$1"; }
  elif command -v wget >/dev/null 2>&1; then get() { wget -qO "$2" "$1"; }; last() { wget -S --spider "$1" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tail -n1; }
  else echo "ni curl ni wget : impossible de télécharger restic" >&2; exit 1; fi
  command -v bunzip2 >/dev/null 2>&1 || { echo "bunzip2 manquant (paquet bzip2)" >&2; exit 1; }
  V=$(last https://github.com/restic/restic/releases/latest | sed -n 's#.*/tag/v\([0-9][0-9.]*\).*#\1#p')
  [ -n "$V" ] || { echo "version de restic introuvable sur GitHub" >&2; exit 1; }
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  F="restic_${V}_linux_${A}.bz2"
  get "https://github.com/restic/restic/releases/download/v$V/$F" "$T/$F" || { echo "téléchargement de $F impossible" >&2; exit 1; }
  get "https://github.com/restic/restic/releases/download/v$V/SHA256SUMS" "$T/SHA256SUMS" || { echo "SHA256SUMS introuvable" >&2; exit 1; }
  (cd "$T" && grep " $F\$" SHA256SUMS | sha256sum -c -) || { echo "empreinte SHA-256 invalide : binaire refusé" >&2; exit 1; }
  bunzip2 "$T/$F" && install -m 755 "$T/restic_${V}_linux_${A}" /usr/local/bin/restic
fi
command -v restic >/dev/null 2>&1 || { echo "restic n'a pas pu être installé" >&2; exit 1; }
restic version
"#;

/// Installe restic (bouton « Installer restic », et avant la première configuration).
pub async fn install_restic(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    crate::ssh::long(async move {
        let out = conn.exec_sudo(&format!("sh -c {}", shell_quote(INSTALL_RESTIC)), sudo, None).await?;
        if !out.success() {
            return Err(Error::Remote(format!("installation de restic impossible :\n{}{}", out.stdout, out.stderr).trim().to_string()));
        }
        Ok(out.stdout)
    })
    .await
}

/// Installe restic si besoin puis écrit la configuration, les secrets, le script et la planification.
pub async fn install(conn: &Connection, sudo: Option<&str>, cfg: &BackupConfig, env: &str) -> Result<String> {
    crate::ssh::long(async move {
        cfg.validate()?;
        let mut log = install_restic(conn, sudo).await?;
        let prep = "set -e\ninstall -d -m 700 /etc/zenytt-backup\ninstall -d -m 755 /var/lib/zenytt-backup\ninstall -d -m 700 /var/lib/zenytt-backup/restore";
        log.push_str(&conn.exec_sudo(prep, sudo, None).await?.into_result()?.stdout);
        if let Destination::Local { path } = &cfg.destination {
            conn.exec_sudo(&format!("install -d -m 700 {}", shell_quote(path)), sudo, None).await?.into_result()?;
        }
        let write = |path: &'static str, mode: &'static str, content: String| async move {
            conn.write_file_sudo(path, &content, sudo).await?;
            conn.exec_sudo(&format!("chmod {mode} {path} && chown root:root {path}"), sudo, None).await?.into_result()?;
            Ok::<_, Error>(())
        };
        // Le fichier est créé vide en 0600 AVANT d'y écrire les secrets.
        conn.exec_sudo(&format!("install -m 600 /dev/null {ENV_PATH}.new"), sudo, None).await?.into_result()?;
        conn.write_file_sudo(&format!("{ENV_PATH}.new"), env, sudo).await?;
        conn.exec_sudo(&format!("mv -f {ENV_PATH}.new {ENV_PATH} && chmod 600 {ENV_PATH}"), sudo, None).await?.into_result()?;
        write(CONFIG_PATH, "600", serde_json::to_string_pretty(cfg).map_err(|e| Error::Other(e.to_string()))?).await?;
        write(SCRIPT_PATH, "700", run_script(cfg)).await?;

        let (service, timer) = systemd_units(&cfg.schedule);
        let systemd = conn.exec("test -d /run/systemd/system", None).await?.success();
        if systemd {
            write("/etc/systemd/system/zenytt-backup.service", "644", service).await?;
            write("/etc/systemd/system/zenytt-backup.timer", "644", timer).await?;
            conn.exec_sudo("systemctl daemon-reload && systemctl enable --now zenytt-backup.timer", sudo, None).await?.into_result()?;
            log.push_str("Planification : timer systemd zenytt-backup.timer\n");
        } else {
            let (h, m) = cfg.schedule.split_once(':').unwrap_or(("3", "0"));
            let cron = format!(
                "{} {} * * * root {SCRIPT_PATH} >/var/log/zenytt-backup.log 2>&1\n",
                m.trim_start_matches('0').parse::<u32>().unwrap_or(0),
                h.trim_start_matches('0').parse::<u32>().unwrap_or(0)
            );
            write("/etc/cron.d/zenytt-backup", "644", cron).await?;
            log.push_str("Planification : /etc/cron.d/zenytt-backup (pas de systemd)\n");
        }
        // Vérifie que le dépôt est accessible (et l'initialise au besoin).
        let check =
            conn.exec_sudo(&format!("set -a; . {ENV_PATH}; set +a; restic cat config >/dev/null 2>&1 || restic init 2>&1"), sudo, None).await?;
        if !check.success() {
            return Err(Error::Remote(format!("dépôt restic inaccessible : {}{}", check.stdout, check.stderr)));
        }
        log.push_str("Dépôt restic prêt.\n");
        Ok(log)
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub started_at: i64,
    pub finished_at: i64,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub restic: Option<String>,
    pub config: Option<BackupConfig>,
    pub last: Option<LastRun>,
    pub next_run: Option<String>,
}

pub async fn status(conn: &Connection, sudo: Option<&str>) -> Result<Status> {
    let restic = conn.exec("restic version 2>/dev/null | head -n1", None).await?;
    let config = conn.exec_sudo(&format!("cat {CONFIG_PATH} 2>/dev/null"), sudo, None).await?;
    let last = conn.exec(&format!("cat {LAST_PATH} 2>/dev/null"), None).await?;
    let next =
        conn.exec("systemctl list-timers zenytt-backup.timer --no-legend 2>/dev/null | awk '{print $1\" \"$2\" \"$3}'", None).await?;
    Ok(Status {
        restic: Some(restic.stdout.trim().to_string()).filter(|s| !s.is_empty()),
        config: serde_json::from_str(config.stdout.trim()).ok(),
        last: serde_json::from_str(last.stdout.trim()).ok(),
        next_run: Some(next.stdout.trim().to_string()).filter(|s| !s.is_empty()),
    })
}

/// Lit l'environnement actuel (pour conserver les secrets déjà enregistrés).
pub async fn current_secret(conn: &Connection, sudo: Option<&str>, key: &str) -> Result<Option<String>> {
    let out = conn.exec_sudo(&format!("cat {ENV_PATH} 2>/dev/null"), sudo, None).await?;
    Ok(out.stdout.lines().find_map(|l| l.strip_prefix(&format!("{key}='"))).map(|v| v.trim_end_matches('\'').to_string()))
}

fn restic(cmd: &str) -> String {
    format!("set -a; . {ENV_PATH}; set +a; restic {cmd}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub short_id: String,
    pub time: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub hostname: String,
}

pub async fn snapshots(conn: &Connection, sudo: Option<&str>) -> Result<Vec<Snapshot>> {
    crate::ssh::long(async move {
        let out = conn.exec_sudo(&restic("snapshots --json --tag zenytt"), sudo, None).await?.into_result()?;
        let mut list: Vec<Snapshot> =
            serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("réponse restic illisible : {e}")))?;
        list.reverse();
        Ok(list)
    })
    .await
}

fn valid_snapshot(id: &str) -> bool {
    id == "latest" || (id.len() >= 8 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
}

/// Contenu d'un dossier d'une sauvegarde (un seul niveau).
pub async fn list(conn: &Connection, sudo: Option<&str>, snapshot: &str, path: &str) -> Result<Vec<Node>> {
    crate::ssh::long(async move {
        if !valid_snapshot(snapshot) || !safe_path(path) {
            return Err(Error::Other("sauvegarde ou chemin invalide".into()));
        }
        let out = conn.exec_sudo(&restic(&format!("ls --json {snapshot} {}", shell_quote(path))), sudo, None).await?.into_result()?;
        let base = path.trim_end_matches('/');
        Ok(out
            .stdout
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|v| v.get("struct_type").and_then(|s| s.as_str()) == Some("node"))
            .filter_map(|v| {
                let p = v.get("path")?.as_str()?.to_string();
                let parent = p.rsplit_once('/').map(|x| x.0).unwrap_or("");
                (parent == base || (base.is_empty() && parent.is_empty())).then(|| Node {
                    name: v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                    kind: v.get("type").and_then(|n| n.as_str()).unwrap_or("file").to_string(),
                    size: v.get("size").and_then(|n| n.as_u64()).unwrap_or(0),
                    path: p,
                })
            })
            .collect())
    })
    .await
}

/// Restaure un chemin d'une sauvegarde dans un dossier temporaire du serveur (jamais en place).
pub async fn restore_to_temp(conn: &Connection, sudo: Option<&str>, snapshot: &str, path: &str) -> Result<String> {
    crate::ssh::long(async move {
        if !valid_snapshot(snapshot) || !safe_path(path) {
            return Err(Error::Other("sauvegarde ou chemin invalide".into()));
        }
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let target = format!("{RESTORE_ROOT}/{ts}");
        conn.exec_sudo(&restic(&format!("restore {snapshot} --target {target} --include {} 2>&1", shell_quote(path))), sudo, None)
            .await?
            .into_result()?;
        Ok(format!("{target}{path}"))
    })
    .await
}

/// Remet en place un élément restauré : l'actuel est d'abord mis de côté (`.zenytt-avant-restauration-…`).
pub async fn put_back(conn: &Connection, sudo: Option<&str>, restored: &str, original: &str) -> Result<String> {
    crate::ssh::long(async move {
        if !restored.starts_with(&format!("{RESTORE_ROOT}/")) || !safe_path(restored) || !safe_path(original) {
            return Err(Error::Other("chemins invalides".into()));
        }
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let aside = format!("{original}.zenytt-avant-restauration-{ts}");
        let cmd = format!(
            "set -e; [ -e {o} ] && mv {o} {a}; mkdir -p \"$(dirname {o})\"; cp -a {r} {o}; echo {a}",
            o = shell_quote(original),
            a = shell_quote(&aside),
            r = shell_quote(restored)
        );
        conn.exec_sudo(&cmd, sudo, None).await?.into_result()?;
        Ok(aside)
    })
    .await
}

/// Réimporte un dump restauré dans son conteneur de base de données.
pub async fn import_dump(conn: &Connection, sudo: Option<&str>, dump: &str, db: &DbSource) -> Result<String> {
    crate::ssh::long(async move {
        if !dump.starts_with(&format!("{RESTORE_ROOT}/")) || !safe_path(dump) || !safe_name(&db.container) {
            return Err(Error::Other("paramètres invalides".into()));
        }
        let c = &db.container;
        let cmd = match db.kind.as_str() {
            "mysql" => format!("docker exec -i {c} sh -c 'C=$(command -v mysql || command -v mariadb); export MYSQL_PWD=\"${{MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}}\"; exec \"$C\" -uroot' < {}", shell_quote(dump)),
            "postgres" => format!("docker exec -i {c} sh -c 'exec psql -U \"${{POSTGRES_USER:-postgres}}\" -d postgres' < {}", shell_quote(dump)),
            _ => return Err(Error::Other("type de base inconnu".into())),
        };
        Ok(conn.exec_sudo(&format!("{}{cmd} 2>&1", crate::docker::PODMAN_SHIM), sudo, None).await?.into_result()?.stdout)
    })
    .await
}

/// Vérifie l'intégrité du dépôt.
pub async fn check(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    crate::ssh::long(async move {
        let out = conn.exec_sudo(&restic("check 2>&1"), sudo, None).await?;
        Ok(out.stdout)
    })
    .await
}

// ---------- Copie du dépôt sur le PC ----------
//
// Un dépôt restic n'est fait que de fichiers immuables nommés par leur empreinte (sauf `config`,
// écrit une fois) : le recopier fichier par fichier, sans jamais réécrire un fichier déjà présent,
// donne une copie identique et toujours chiffrée. restic, sur le PC, la relit telle quelle.

/// Fichier du dépôt : chemin relatif (« data/ab/ab12… ») et taille.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    pub path: String,
    pub size: u64,
}

/// Dossiers d'un dépôt restic, dans l'ordre où les copier : les données avant les index qui les
/// référencent, les instantanés en dernier. Une copie interrompue reste ainsi cohérente.
const REPO_DIRS: [&str; 4] = ["data", "index", "keys", "snapshots"];

/// Chemin relatif acceptable dans un dépôt : `config`, ou `<dossier>/[xx/]<empreinte hexadécimale>`.
pub fn valid_repo_path(p: &str) -> bool {
    if p == "config" {
        return true;
    }
    let parts: Vec<&str> = p.split('/').collect();
    let hex = |s: &str| (2..=128).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit());
    match parts.as_slice() {
        ["data", sub, id] => sub.len() == 2 && hex(sub) && hex(id),
        [dir, id] => REPO_DIRS.contains(dir) && *dir != "data" && hex(id),
        _ => false,
    }
}

fn repo_rank(path: &str) -> usize {
    REPO_DIRS.iter().position(|d| path.starts_with(&format!("{d}/"))).unwrap_or(REPO_DIRS.len())
}

/// Lit `find`/`stat` (« taille chemin ») ; les verrous (`locks/`) et tout ce qui n'est pas du dépôt sont ignorés.
pub fn parse_repo_listing(text: &str) -> Vec<RepoFile> {
    text.lines()
        .filter_map(|l| {
            let (size, path) = l.trim().split_once(' ')?;
            let path = path.trim().trim_start_matches("./");
            let size = size.parse().ok()?;
            valid_repo_path(path).then(|| RepoFile { path: path.to_string(), size })
        })
        .collect()
}

/// Fichiers du dépôt local (dossier du serveur) de la configuration.
pub async fn repo_files(conn: &Connection, sudo: Option<&str>, repo: &str) -> Result<Vec<RepoFile>> {
    if !safe_path(repo) {
        return Err(Error::Other("dossier du dépôt invalide".into()));
    }
    // `-printf` est propre à GNU find ; busybox (Alpine) passe par stat.
    let script = format!(
        "cd {} || exit 1; [ -f config ] || {{ echo 'pas de dépôt restic dans ce dossier' >&2; exit 1; }}; find . -type f ! -path './locks/*' -printf '%s %P\\n' 2>/dev/null || find . -type f ! -path './locks/*' -exec stat -c '%s %n' {{}} +",
        shell_quote(repo)
    );
    let out = crate::ssh::long(conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, None)).await?.into_result()?;
    Ok(parse_repo_listing(&out.stdout))
}

/// Ce qu'il faut faire pour que la copie locale rejoigne le dépôt du serveur.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MirrorPlan {
    /// À télécharger, dans un ordre sûr (voir [`REPO_DIRS`]).
    pub download: Vec<RepoFile>,
    /// Fichiers locaux disparus du serveur (sauvegardes oubliées par la rétention) : instantanés
    /// d'abord, données en dernier.
    pub delete: Vec<String>,
}

pub fn plan_mirror(remote: &[RepoFile], local: &[RepoFile]) -> MirrorPlan {
    let have: std::collections::HashMap<&str, u64> = local.iter().map(|f| (f.path.as_str(), f.size)).collect();
    let wanted: std::collections::HashSet<&str> = remote.iter().map(|f| f.path.as_str()).collect();
    let mut download: Vec<RepoFile> = remote.iter().filter(|f| have.get(f.path.as_str()) != Some(&f.size)).cloned().collect();
    download.sort_by_key(|f| repo_rank(&f.path));
    let mut delete: Vec<String> = local.iter().filter(|f| !wanted.contains(f.path.as_str())).map(|f| f.path.clone()).collect();
    delete.sort_by_key(|p| std::cmp::Reverse(repo_rank(p)));
    MirrorPlan { download, delete }
}

/// Télécharge un fichier lisible par root seulement, en flux (`cat` via sudo), dans `local`
/// (écrit d'abord en `.part`, puis renommé). `on_bytes` reçoit les octets reçus ; `false` arrête.
pub async fn fetch_file_sudo(
    conn: &Connection,
    sudo: Option<&str>,
    remote: &str,
    expected: u64,
    local: &std::path::Path,
    on_bytes: &(dyn Fn(u64) -> bool + Send + Sync),
) -> Result<()> {
    use russh::ChannelMsg;
    use tokio::io::AsyncWriteExt;
    if !safe_path(remote) {
        return Err(Error::Other("chemin distant invalide".into()));
    }
    let io = |e: std::io::Error| Error::Other(format!("{} : {e}", local.display()));
    if let Some(dir) = local.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(io)?;
    }
    let part = local.with_extension("part");
    let mut file = tokio::fs::File::create(&part).await.map_err(io)?;
    let mut channel = conn.open_exec_sudo(&format!("cat -- {}", shell_quote(remote)), sudo).await?;
    let (mut done, mut code, mut stderr) = (0u64, None, Vec::new());
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                file.write_all(&data).await.map_err(io)?;
                done += data.len() as u64;
                if !on_bytes(data.len() as u64) {
                    let _ = channel.close().await;
                    drop(file);
                    let _ = tokio::fs::remove_file(&part).await;
                    return Err(crate::sftp::cancelled());
                }
            }
            ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    file.flush().await.map_err(io)?;
    drop(file);
    if code != Some(0) || done != expected {
        let _ = tokio::fs::remove_file(&part).await;
        let why = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(Error::Remote(format!(
            "{remote} : copie incomplète ({done} octets sur {expected}){}",
            if why.is_empty() { String::new() } else { format!(" — {why}") }
        )));
    }
    tokio::fs::rename(&part, local).await.map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_paths() {
        assert!(valid_repo_path("config"));
        assert!(valid_repo_path("data/ab/ab12cd34ef"));
        assert!(valid_repo_path("snapshots/0123abcd"));
        assert!(!valid_repo_path("locks/0123abcd"), "verrous ignorés");
        assert!(!valid_repo_path("data/../../etc/passwd"));
        assert!(!valid_repo_path("data/abc/ab12"), "sous-dossier de 2 caractères");
        assert!(!valid_repo_path("index/notes.txt"));
        let l = parse_repo_listing("155 config\n4096 ./data/ab/ab12cd\n12 locks/ffee\n7 snapshots/0a0b\n9 weird name\n");
        assert_eq!(l.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["config", "data/ab/ab12cd", "snapshots/0a0b"]);
    }

    #[test]
    fn mirror_plan_order() {
        let f = |p: &str, s: u64| RepoFile { path: p.into(), size: s };
        let remote = vec![f("snapshots/aa01", 1), f("config", 2), f("index/bb02", 3), f("data/cc/cc03", 4), f("keys/dd04", 5)];
        let local = vec![f("config", 2), f("data/cc/cc03", 1), f("snapshots/ee05", 1), f("data/ff/ff06", 9)];
        let plan = plan_mirror(&remote, &local);
        // Données (taille différente : copie interrompue) d'abord, instantanés en dernier.
        assert_eq!(
            plan.download.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["data/cc/cc03", "index/bb02", "keys/dd04", "snapshots/aa01"]
        );
        assert_eq!(plan.delete, vec!["snapshots/ee05", "data/ff/ff06"]);
        assert_eq!(plan_mirror(&remote, &remote), MirrorPlan::default());
    }

    #[test]
    fn validation() {
        let mut c = BackupConfig::default();
        assert!(c.validate().is_ok());
        c.paths.push("/etc/../root".into());
        assert!(c.validate().is_err());
        let mut c = BackupConfig { schedule: "25:00".into(), ..Default::default() };
        assert!(c.validate().is_err());
        c.schedule = "03:30".into();
        c.databases.push(DbSource { container: "db; rm -rf /".into(), kind: "mysql".into() });
        assert!(c.validate().is_err());
    }

    #[test]
    fn repository_and_env() {
        let c = BackupConfig {
            destination: Destination::S3 {
                endpoint: "https://s3.fr-par.scw.cloud/".into(),
                bucket: "mes-sauvegardes".into(),
                prefix: "vps".into(),
                access_key_id: "AK".into(),
            },
            ..Default::default()
        };
        assert!(c.validate().is_ok());
        assert_eq!(c.repository(), "s3:https://s3.fr-par.scw.cloud/mes-sauvegardes/vps");
        let env = env_file(&c, "motdepasse", Some("SK")).unwrap();
        assert!(env.contains("AWS_SECRET_ACCESS_KEY='SK'"));
        assert!(env_file(&c, "motdepasse", None).is_err());
        assert!(env_file(&c, "a'b", Some("SK")).is_err(), "une quote casserait le fichier");
    }

    #[test]
    fn script() {
        let c = BackupConfig {
            volumes: vec!["mypage_data".into()],
            databases: vec![
                DbSource { container: "nexus-mysql".into(), kind: "mysql".into() },
                DbSource { container: "pg".into(), kind: "postgres".into() },
            ],
            ..Default::default()
        };
        let s = run_script(&c);
        assert!(s.contains("docker exec nexus-mysql"));
        assert!(s.contains("--single-transaction"));
        assert!(s.contains("pg_dumpall"));
        assert!(s.contains("docker volume inspect -f '{{.Mountpoint}}' mypage_data"));
        assert!(s.contains("--keep-daily 7 --keep-weekly 4 --keep-monthly 6"));
        assert!(!s.contains("RESTIC_PASSWORD='"), "aucun secret dans le script");
    }

    #[test]
    fn snapshots_ids() {
        assert!(valid_snapshot("latest"));
        assert!(valid_snapshot("a1b2c3d4"));
        assert!(!valid_snapshot("a1b2; rm"));
    }
}
