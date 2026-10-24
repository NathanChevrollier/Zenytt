//! Diagnostic des sauvegardes : chaque source est-elle toujours d'actualité, pourquoi la dernière
//! exécution a échoué, et quelle est la prochaine étape. Un seul script borné par serveur
//! ([`probe_script`]) ; tout le reste est fait de fonctions pures, testées sur des sorties réelles.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::backup::{self, BackupConfig, Destination, Status, ENV_PATH};
use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Database,
    Volume,
    Path,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceState {
    Ok,
    /// Conteneur de base présent mais arrêté : le dump échouera.
    Stopped,
    /// Conteneur, volume ou dossier introuvable.
    Missing,
    /// Conteneur recréé sous un autre nom (même projet/service compose, ou même nom normalisé).
    Recreated,
    /// Une base présente dans la dernière sauvegarde n'existe plus.
    DbDropped,
    /// Dossier ou volume vide, serveur de base sans aucune base.
    Empty,
    /// Le serveur de base refuse la connexion utilisée par le dump.
    AuthFailed,
    /// Non vérifiable (Docker inaccessible, base qui ne répond pas…).
    Unknown,
}

/// Prochaine étape proposée. Unlock, EnableSchedule, Relink et RemoveSource sont exécutées par
/// [`apply_fix`] ; les autres renvoient vers des actions existantes de l'interface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Fix {
    Unlock,
    InstallRestic,
    EnableSchedule,
    RunNow,
    EditConfig,
    StartContainer { container: String },
    Relink { source: SourceKind, from: String, to: String },
    RemoveSource { source: SourceKind, name: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheck {
    pub source: SourceKind,
    pub name: String,
    pub state: SourceState,
    pub detail: String,
    pub fix: Option<Fix>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Danger,
    Warn,
    Info,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// Ligne de sortie qui a permis le diagnostic.
    pub evidence: Option<String>,
    pub fix: Option<Fix>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// Horloge du serveur (secondes).
    pub now: i64,
    pub last_success: Option<i64>,
    pub sources: Vec<SourceCheck>,
    pub issues: Vec<Issue>,
}

// ---------- Script de relevé ----------

const DBS_DIR: &str = "/var/lib/zenytt-backup/dbs";
const MYSQL_LIST: &str = r#"C=$(command -v mysql || command -v mariadb); export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; exec "$C" -uroot -N -B -e "SHOW DATABASES""#;
const PG_LIST: &str =
    r#"exec psql -U "${POSTGRES_USER:-postgres}" -d postgres -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate""#;

/// Script unique, lancé en root, qui relève tout ce que le diagnostic utilise. Chaque ligne commence
/// par une étiquette (`ct`, `vol`, `path`, `db`…). Chaque commande lente est bornée par `timeout` ;
/// les secrets restent dans l'environnement de restic, jamais dans une ligne de commande ni dans la sortie.
pub fn probe_script(cfg: &BackupConfig) -> String {
    let mut s = String::from(
        r#"DK=$(command -v docker || command -v podman)
T() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }
echo "now $(date +%s)"
if [ -n "$DK" ]; then
  out=$(T 20 "$DK" ps -a --no-trunc --format '{{.Names}}|{{.ID}}|{{.State}}|{{.Image}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null) && echo "docker ok"
  printf '%s\n' "$out" | head -n 500 | sed 's/^/ct /'
  T 20 "$DK" volume ls -q 2>/dev/null | head -n 2000 | sed 's/^/vol /'
fi
"#,
    );
    for v in &cfg.volumes {
        let q = shell_quote(v);
        s.push_str(&format!(
            "[ -n \"$DK\" ] && mp=$(T 10 \"$DK\" volume inspect -f '{{{{.Mountpoint}}}}' {q} 2>/dev/null) && [ -r \"$mp\" ] && echo \"volp $(ls -A \"$mp\" 2>/dev/null | head -n 2 | wc -l) {v}\"\n"
        ));
    }
    for p in &cfg.paths {
        let q = shell_quote(p);
        s.push_str(&format!(
            "if [ -d {q} ] && [ ! -r {q} ]; then echo \"path r {p}\"; elif [ -d {q} ]; then echo \"path $(ls -A {q} 2>/dev/null | head -n 2 | wc -l) {p}\"; elif [ -e {q} ]; then echo \"path f {p}\"; else echo \"path - {p}\"; fi\n"
        ));
    }
    for db in &cfg.databases {
        let c = &db.container;
        let q = shell_quote(c);
        let list = shell_quote(if db.kind == "mysql" { MYSQL_LIST } else { PG_LIST });
        s.push_str(&format!(
            "if [ -n \"$DK\" ] && [ \"$(T 10 \"$DK\" inspect -f '{{{{.State.Running}}}}' {q} 2>/dev/null)\" = true ]; then\n  out=$(T 20 \"$DK\" exec {q} sh -c {list} 2>&1); rc=$?\n  printf '%s\\n' \"$out\" | head -n 100 | cut -c1-300 | sed 's/^/db {c} /'; echo \"dbrc $rc {c}\"\nfi\n[ -f {DBS_DIR}/{c}.txt ] && head -n 200 {DBS_DIR}/{c}.txt | sed 's/^/seen {c} /'\n"
        ));
    }
    s.push_str(
        r#"if [ -d /run/systemd/system ]; then
  en=$(systemctl is-enabled zenytt-backup.timer 2>/dev/null)
  echo "timer ${en:-absent} $(systemctl is-active zenytt-backup.timer 2>/dev/null)"
  echo "svc $(systemctl show -p ActiveState --value zenytt-backup.service 2>/dev/null)"
  journalctl -u zenytt-backup.service -n 80 --no-pager -o cat 2>/dev/null | cut -c1-400 | sed 's/^/log /'
else
  echo "cron $([ -f /etc/cron.d/zenytt-backup ] && echo present || echo absent) $( (pgrep -x cron || pgrep -x crond) >/dev/null 2>&1 && echo running || echo stopped)"
  tail -n 80 /var/log/zenytt-backup.log 2>/dev/null | cut -c1-400 | sed 's/^/log /'
fi
"#,
    );
    let repo_dir = match &cfg.destination {
        Destination::Local { path } => shell_quote(path),
        Destination::S3 { .. } => String::new(),
    };
    s.push_str(&format!("df -Pk {repo_dir} /var/lib/zenytt-backup /tmp 2>/dev/null | awk 'NR>1 {{print \"df \"$4\" \"$5\" \"$6}}'\n"));
    s.push_str(&format!(
        r#"if command -v restic >/dev/null 2>&1 && [ -f {ENV_PATH} ]; then
  set -a; . {ENV_PATH}; set +a
  out=$(T 45 restic snapshots --json --tag zenytt --latest 1 --no-lock 2>&1); rc=$?
  echo "repo $rc"
  if [ "$rc" = 0 ]; then
    printf '%s' "$out" | grep -o '"time":"[^"]*"' | head -n 20 | sed 's/^/rtime /'
    echo "locks $(T 30 restic list locks --no-lock 2>/dev/null | wc -l)"
  else
    printf '%s\n' "$out" | tail -n 6 | cut -c1-400 | sed 's/^/rout /'
  fi
fi
"#
    ));
    s
}

// ---------- Lecture du relevé ----------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ct {
    pub name: String,
    pub id: String,
    pub state: String,
    pub image: String,
    pub project: Option<String>,
    pub service: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub enum Schedule {
    Systemd {
        enabled: String,
        active: String,
        service: String,
    },
    Cron {
        present: bool,
        running: bool,
    },
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default)]
pub struct Probe {
    pub now: Option<i64>,
    pub docker: bool,
    pub containers: Vec<Ct>,
    pub volumes: HashSet<String>,
    /// Volume → 0 s'il est vide.
    pub volume_entries: HashMap<String, u32>,
    /// Dossier → `-` absent, `f` fichier, sinon nombre d'entrées (0, 1 ou 2 = « au moins 2 »).
    pub paths: HashMap<String, String>,
    /// Conteneur → (code de sortie, lignes) de la liste des bases.
    pub dbs: HashMap<String, (i32, Vec<String>)>,
    /// Conteneur → lignes `CREATE DATABASE` du dernier dump.
    pub seen: HashMap<String, Vec<String>>,
    pub schedule: Schedule,
    pub log: Vec<String>,
    /// Code de sortie de `restic snapshots` (124 = délai dépassé).
    pub repo_rc: Option<i32>,
    pub repo_times: Vec<i64>,
    pub repo_output: Vec<String>,
    pub locks: Option<u32>,
    /// (Kio disponibles, % utilisé, point de montage).
    pub df: Vec<(u64, u32, String)>,
}

pub fn parse_probe(text: &str) -> Probe {
    let mut p = Probe::default();
    for line in text.lines() {
        let (tag, rest) = line.split_once(' ').unwrap_or((line, ""));
        let words: Vec<&str> = rest.split_whitespace().collect();
        match tag {
            "now" => p.now = rest.trim().parse().ok(),
            "docker" => p.docker = true,
            "ct" => {
                let f: Vec<&str> = rest.split('|').collect();
                if f.len() >= 4 && !f[0].is_empty() {
                    let opt = |i: usize| f.get(i).map(|s| s.trim()).filter(|s| !s.is_empty() && *s != "<no value>").map(str::to_string);
                    p.containers.push(Ct {
                        name: f[0].trim_start_matches('/').to_string(),
                        id: f[1].to_string(),
                        state: f[2].to_string(),
                        image: f[3].to_string(),
                        project: opt(4),
                        service: opt(5),
                    });
                }
            }
            "vol" if !rest.trim().is_empty() => {
                p.volumes.insert(rest.trim().to_string());
            }
            "volp" => {
                if let [n, name] = words[..] {
                    p.volume_entries.insert(name.to_string(), n.parse().unwrap_or(1));
                }
            }
            "path" => {
                if let [state, path] = words[..] {
                    p.paths.insert(path.to_string(), state.to_string());
                }
            }
            "db" => {
                let (c, l) = rest.split_once(' ').unwrap_or((rest, ""));
                p.dbs.entry(c.to_string()).or_insert((0, vec![])).1.push(l.trim().to_string());
            }
            "dbrc" => {
                if let [rc, c] = words[..] {
                    p.dbs.entry(c.to_string()).or_insert((0, vec![])).0 = rc.parse().unwrap_or(1);
                }
            }
            "seen" => {
                let (c, l) = rest.split_once(' ').unwrap_or((rest, ""));
                p.seen.entry(c.to_string()).or_default().push(l.to_string());
            }
            "timer" => {
                p.schedule = Schedule::Systemd {
                    enabled: words.first().unwrap_or(&"absent").to_string(),
                    active: words.get(1).unwrap_or(&"inactive").to_string(),
                    service: String::new(),
                }
            }
            "svc" => {
                if let Schedule::Systemd { service, .. } = &mut p.schedule {
                    *service = rest.trim().to_string();
                }
            }
            "cron" => p.schedule = Schedule::Cron { present: words.first() == Some(&"present"), running: words.get(1) == Some(&"running") },
            "log" => p.log.push(rest.to_string()),
            "df" => {
                if let [avail, used, mount] = words[..] {
                    if let (Ok(a), Ok(u)) = (avail.parse(), used.trim_end_matches('%').parse()) {
                        if !p.df.iter().any(|d| d.2 == mount) {
                            p.df.push((a, u, mount.to_string()));
                        }
                    }
                }
            }
            "repo" => p.repo_rc = rest.trim().parse().ok(),
            "rtime" => {
                if let Some(t) = rest.trim().strip_prefix("\"time\":\"").and_then(|t| t.strip_suffix('"')).and_then(rfc3339_secs) {
                    p.repo_times.push(t);
                }
            }
            "rout" => p.repo_output.push(rest.to_string()),
            "locks" => p.locks = rest.trim().parse().ok(),
            _ => {}
        }
    }
    p
}

/// `2026-10-24T03:05:19.123456789+02:00` → secondes depuis l'époque Unix.
pub fn rfc3339_secs(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let num = |a: usize| rest.get(a..a + 2)?.parse::<i64>().ok();
    let (h, mi, se) = (num(0)?, num(3)?, num(6)?);
    let tz = rest.get(8..)?.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = match tz {
        "Z" | "" => 0,
        _ => {
            let sign = if tz.starts_with('-') { -1 } else { 1 };
            let (oh, om) = (tz.get(1..3)?.parse::<i64>().ok()?, tz.get(4..6)?.parse::<i64>().ok()?);
            sign * (oh * 3600 + om * 60)
        }
    };
    // Jours depuis 1970-01-01 (algorithme « days from civil » de H. Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + se - offset)
}

/// Type de base d'après l'image du conteneur.
pub fn db_kind_of_image(image: &str) -> Option<&'static str> {
    let img = image.to_lowercase();
    if img.contains("mysql") || img.contains("mariadb") {
        Some("mysql")
    } else if img.contains("postgres") || img.contains("postgis") || img.contains("timescale") {
        Some("postgres")
    } else {
        None
    }
}

/// Nom comparable entre docker-compose v1 et v2 : `infra_postgres_1` ≈ `infra-postgres-1`.
fn norm(name: &str) -> String {
    let n = name.to_lowercase().replace('_', "-");
    match n.rsplit_once('-') {
        Some((head, tail)) if !head.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head.to_string(),
        _ => n,
    }
}

/// Noms des bases d'un dump : `CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`app\` …` (MySQL) ou
/// `CREATE DATABASE app WITH TEMPLATE = …` (PostgreSQL).
pub fn dump_databases(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|l| {
            let rest = l.trim().strip_prefix("CREATE DATABASE")?.trim_start();
            let rest = match rest.strip_prefix("/*") {
                Some(r) => r.split_once("*/")?.1.trim_start(),
                None => rest,
            };
            let name = match rest.strip_prefix('`').or_else(|| rest.strip_prefix('"')) {
                Some(r) => r.split(['`', '"']).next()?,
                None => rest.split([' ', ';']).next()?,
            };
            (!name.is_empty()).then(|| name.to_string())
        })
        .collect()
}

const SYSTEM_DBS: [&str; 7] = ["information_schema", "mysql", "performance_schema", "sys", "postgres", "template0", "template1"];

fn list_short(v: &[String]) -> String {
    if v.len() > 4 {
        format!("{}… (+{})", v[..4].join(", "), v.len() - 4)
    } else {
        v.join(", ")
    }
}

fn is_auth_error(l: &str) -> bool {
    let l = l.to_lowercase();
    ["access denied", "password authentication failed", "authentication failed", "using password: no"].iter().any(|n| l.contains(n))
        || (l.contains("role \"") && l.contains("does not exist"))
}

// ---------- Sources ----------

pub fn assess_sources(cfg: &BackupConfig, p: &Probe) -> Vec<SourceCheck> {
    let mut out = Vec::new();
    let check = |source, name: &str, state, detail: String, fix| SourceCheck { source, name: name.to_string(), state, detail, fix };
    let configured: HashSet<&str> = cfg.databases.iter().map(|d| d.container.as_str()).collect();

    for db in &cfg.databases {
        let c = db.container.as_str();
        if !p.docker {
            out.push(check(SourceKind::Database, c, SourceState::Unknown, "Docker inaccessible : état non vérifié.".into(), None));
            continue;
        }
        let Some(ct) = p.containers.iter().find(|x| x.name == c) else {
            let free = |x: &&Ct| !configured.contains(x.name.as_str());
            let by_labels = db.project.as_ref().zip(db.service.as_ref()).and_then(|(pr, sv)| {
                p.containers.iter().filter(free).find(|x| x.project.as_ref() == Some(pr) && x.service.as_ref() == Some(sv))
            });
            let by_name = || p.containers.iter().filter(free).find(|x| norm(&x.name) == norm(c));
            if let Some(new) = by_labels.or_else(by_name) {
                out.push(check(
                    SourceKind::Database,
                    c,
                    SourceState::Recreated,
                    format!("Conteneur recréé sous le nom « {} » ({}) : la prochaine sauvegarde échouera tant que la source n'est pas mise à jour.", new.name, new.state),
                    Some(Fix::Relink { source: SourceKind::Database, from: c.into(), to: new.name.clone() }),
                ));
                continue;
            }
            let remove = Some(Fix::RemoveSource { source: SourceKind::Database, name: c.into() });
            if let Some(pr) = db.project.as_ref().filter(|pr| !p.containers.iter().any(|x| x.project.as_ref() == Some(pr))) {
                out.push(check(
                    SourceKind::Database,
                    c,
                    SourceState::Missing,
                    format!("Le projet compose « {pr} » n'existe plus sur le serveur."),
                    remove,
                ));
                continue;
            }
            let candidates: Vec<&Ct> =
                p.containers.iter().filter(free).filter(|x| db_kind_of_image(&x.image) == Some(db.kind.as_str())).collect();
            match candidates[..] {
                [one] => out.push(check(
                    SourceKind::Database,
                    c,
                    SourceState::Missing,
                    format!("Conteneur introuvable (supprimé ou renommé). Seul candidat du même type : « {} ».", one.name),
                    Some(Fix::Relink { source: SourceKind::Database, from: c.into(), to: one.name.clone() }),
                )),
                _ => out.push(check(
                    SourceKind::Database,
                    c,
                    SourceState::Missing,
                    "Conteneur introuvable : supprimé ou renommé.".into(),
                    remove,
                )),
            }
            continue;
        };
        if ct.state != "running" {
            let fix = matches!(ct.state.as_str(), "exited" | "created" | "dead").then(|| Fix::StartContainer { container: c.into() });
            out.push(check(
                SourceKind::Database,
                c,
                SourceState::Stopped,
                format!("Conteneur {} : le dump de cette base échouera.", ct.state),
                fix,
            ));
            continue;
        }
        let Some((rc, lines)) = p.dbs.get(c) else {
            out.push(check(SourceKind::Database, c, SourceState::Unknown, "Bases non listées : état non vérifié.".into(), None));
            continue;
        };
        let first = lines.iter().find(|l| !l.is_empty() && !l.starts_with("mysql: [Warning]")).cloned().unwrap_or_default();
        if *rc != 0 {
            let (state, detail) = if lines.iter().any(|l| is_auth_error(l)) {
                let hint = if db.kind == "mysql" {
                    "le conteneur doit définir MYSQL_ROOT_PASSWORD (ou MARIADB_ROOT_PASSWORD) avec le mot de passe root actuel"
                } else {
                    "le conteneur doit définir POSTGRES_USER avec un rôle existant"
                };
                (SourceState::AuthFailed, format!("Connexion refusée, le dump échouera : {hint}. ({first})"))
            } else if *rc == 124 {
                (SourceState::Unknown, "La base ne répond pas (délai de 20 s dépassé).".into())
            } else {
                (SourceState::Unknown, format!("Bases non listées : {first}"))
            };
            out.push(check(SourceKind::Database, c, state, detail, None));
            continue;
        }
        let current: Vec<String> =
            lines.iter().filter(|l| !l.is_empty() && !l.contains(' ')).filter(|l| !SYSTEM_DBS.contains(&l.as_str())).cloned().collect();
        let dropped: Vec<String> = p
            .seen
            .get(c)
            .map(|s| dump_databases(s))
            .unwrap_or_default()
            .into_iter()
            .filter(|d| !SYSTEM_DBS.contains(&d.as_str()) && !current.contains(d))
            .collect();
        if !dropped.is_empty() {
            out.push(check(
                SourceKind::Database,
                c,
                SourceState::DbDropped,
                format!("Absente(s) depuis la dernière sauvegarde : {}. Si ce n'est pas voulu, elle(s) ne sont plus que dans les sauvegardes existantes.", list_short(&dropped)),
                None,
            ));
        } else if current.is_empty() {
            out.push(check(
                SourceKind::Database,
                c,
                SourceState::Empty,
                "Aucune base de données dans ce serveur.".into(),
                Some(Fix::RemoveSource { source: SourceKind::Database, name: c.into() }),
            ));
        } else {
            out.push(check(
                SourceKind::Database,
                c,
                SourceState::Ok,
                format!("{} base(s) : {}", current.len(), list_short(&current)),
                None,
            ));
        }
    }

    for v in &cfg.volumes {
        if !p.docker {
            out.push(check(SourceKind::Volume, v, SourceState::Unknown, "Docker inaccessible : état non vérifié.".into(), None));
        } else if p.volumes.contains(v) {
            match p.volume_entries.get(v) {
                Some(0) => out.push(check(SourceKind::Volume, v, SourceState::Empty, "Volume vide.".into(), None)),
                _ => out.push(check(SourceKind::Volume, v, SourceState::Ok, "Volume présent.".into(), None)),
            }
        } else {
            // Projet compose renommé : `ancien_data` → `nouveau_data`.
            let suffix = v.split_once('_').map(|x| x.1).unwrap_or(v);
            let cands: Vec<&String> =
                p.volumes.iter().filter(|x| !cfg.volumes.contains(x) && x.split_once('_').map(|y| y.1) == Some(suffix)).collect();
            match cands[..] {
                [one] => out.push(check(
                    SourceKind::Volume,
                    v,
                    SourceState::Missing,
                    format!("Volume introuvable. Candidat probable : « {one} »."),
                    Some(Fix::Relink { source: SourceKind::Volume, from: v.clone(), to: one.clone() }),
                )),
                _ => out.push(check(
                    SourceKind::Volume,
                    v,
                    SourceState::Missing,
                    "Volume supprimé : la prochaine sauvegarde échouera.".into(),
                    Some(Fix::RemoveSource { source: SourceKind::Volume, name: v.clone() }),
                )),
            }
        }
    }

    for path in &cfg.paths {
        let remove = Some(Fix::RemoveSource { source: SourceKind::Path, name: path.clone() });
        out.push(match p.paths.get(path).map(String::as_str) {
            Some("-") => {
                check(SourceKind::Path, path, SourceState::Missing, "Dossier absent : il est ignoré à chaque sauvegarde.".into(), remove)
            }
            Some("0") => check(SourceKind::Path, path, SourceState::Empty, "Dossier vide.".into(), remove),
            Some("f") => check(SourceKind::Path, path, SourceState::Ok, "Fichier présent.".into(), None),
            Some(_) => check(SourceKind::Path, path, SourceState::Ok, "Dossier présent.".into(), None),
            None => check(SourceKind::Path, path, SourceState::Unknown, "Non vérifié.".into(), None),
        });
    }
    out
}

// ---------- Cause d'un échec ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    ResticMissing,
    DiskFull,
    Locked,
    WrongPassword,
    DumpNotRunning,
    DumpNoContainer,
    DumpAuth,
    DumpTool,
    DumpOther,
    VolumeMissing,
    Timeout,
    Dns,
    Network,
    BucketMissing,
    Credentials,
    RepoMissing,
    Interrupted,
    Unknown,
}

const GLOBAL: &[(Cause, &[&str])] = &[
    (Cause::ResticMissing, &["restic: command not found", "restic: not found", "restic n'est pas installé"]),
    (Cause::DiskFull, &["no space left on device", "disk quota exceeded"]),
    (Cause::Locked, &["already locked", "unable to create lock"]),
    (Cause::WrongPassword, &["wrong password", "no key found"]),
];
const DUMP: &[(Cause, &[&str])] = &[
    (Cause::DumpNotRunning, &["is not running", "is paused", "is restarting"]),
    (Cause::DumpNoContainer, &["no such container"]),
    (Cause::DumpAuth, &["access denied for user", "password authentication failed", "authentication failed", "using password: no"]),
    (Cause::DumpTool, &["executable file not found", ": not found", "command not found"]),
];
const REPO: &[(Cause, &[&str])] = &[
    (Cause::Timeout, &["operation timed out", "timed out. terminating"]),
    (Cause::Dns, &["no such host", "server misbehaving", "name resolution", "name or service not known"]),
    (
        Cause::Network,
        &[
            "connection refused",
            "i/o timeout",
            "network is unreachable",
            "no route to host",
            "connection reset",
            "tls handshake",
            "deadline exceeded",
        ],
    ),
    (Cause::BucketMissing, &["nosuchbucket", "bucket does not exist"]),
    (
        Cause::Credentials,
        &[
            "invalidaccesskeyid",
            "access key id you provided",
            "signaturedoesnotmatch",
            "accessdenied",
            "access denied",
            "403 forbidden",
            "permission denied",
        ],
    ),
    (Cause::RepoMissing, &["is there a repository", "unable to open config file"]),
    (Cause::Interrupted, &["sauvegarde interrompue", "signal interrupt"]),
];

fn first_match(lines: &[&str], rules: &[(Cause, &[&str])]) -> Option<(Cause, String)> {
    rules.iter().find_map(|(cause, needles)| {
        lines
            .iter()
            .find(|l| {
                let l = l.to_lowercase();
                needles.iter().any(|n| l.contains(n))
            })
            .map(|l| (*cause, l.trim().to_string()))
    })
}

/// Conteneur dont le dump a échoué : `step` = `dump:<nom>`, ou message `dump de <nom>[ : …]`
/// (anciens scripts).
pub fn dump_container(step: &str, message: &str) -> Option<String> {
    step.strip_prefix("dump:")
        .map(str::to_string)
        .or_else(|| message.strip_prefix("dump de ").map(|r| r.split([' ', ':']).next().unwrap_or("").to_string()))
        .filter(|c| backup::safe_name(c))
}

/// Cause d'un échec, d'après l'étape, le message de last.json et les lignes de la dernière exécution.
/// Renvoie aussi la ligne qui a permis de conclure.
pub fn classify(step: &str, text: &str) -> (Cause, Option<String>) {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if let Some((c, l)) = first_match(&lines, GLOBAL) {
        return (c, Some(l));
    }
    let first = lines.first().copied().unwrap_or("");
    if step.starts_with("dump:") || first.starts_with("dump de ") {
        return first_match(&lines, DUMP)
            .map(|(c, l)| (c, Some(l)))
            .unwrap_or((Cause::DumpOther, lines.get(1).or(lines.first()).map(|l| l.to_string())));
    }
    if step.starts_with("volume:")
        || (first.starts_with("volume ") && first.contains("introuvable"))
        || text.to_lowercase().contains("no such volume")
    {
        return (Cause::VolumeMissing, Some(first.to_string()));
    }
    first_match(&lines, REPO).map(|(c, l)| (c, Some(l))).unwrap_or((Cause::Unknown, lines.first().map(|l| l.to_string())))
}

/// Lignes de la dernière exécution dans le journal (après le dernier « Sauvegarde Zenytt — »).
pub fn last_run_lines(log: &[String]) -> &[String] {
    let start = log.iter().rposition(|l| l.contains("Sauvegarde Zenytt —")).unwrap_or(0);
    &log[start..]
}

fn failure_issue(cause: Cause, container: Option<&str>, evidence: Option<String>, sources: &[SourceCheck], s3: bool) -> Issue {
    let c = container.unwrap_or("?");
    let source_fix = || sources.iter().find(|s| s.source == SourceKind::Database && s.name == c).and_then(|s| s.fix.clone());
    let repo_fix = Some(Fix::EditConfig);
    let (title, detail, fix): (String, String, Option<Fix>) = match cause {
        Cause::ResticMissing => ("restic n'est pas installé".into(), "Le script de sauvegarde ne trouve pas restic sur le serveur.".into(), Some(Fix::InstallRestic)),
        Cause::DiskFull => (
            "Disque plein".into(),
            "Plus d'espace pour écrire les exports de bases (/var/lib/zenytt-backup) ou le dépôt. Libère de la place (images Docker inutilisées, journaux) puis relance.".into(),
            None,
        ),
        Cause::Locked => (
            "Dépôt verrouillé".into(),
            "Une sauvegarde précédente s'est arrêtée sans libérer son verrou. « Déverrouiller » retire uniquement les verrous périmés (restic unlock).".into(),
            Some(Fix::Unlock),
        ),
        Cause::WrongPassword => (
            "Mot de passe du dépôt refusé".into(),
            "Le mot de passe enregistré sur le serveur ne correspond pas à ce dépôt. Réenregistre la configuration avec le bon mot de passe (une copie est dans le coffre-fort de ce PC).".into(),
            repo_fix,
        ),
        Cause::DumpNotRunning => (format!("Le conteneur {c} est arrêté"), "Le dump de la base a échoué car le conteneur ne tourne pas.".into(), source_fix().or(container.map(|c| Fix::StartContainer { container: c.into() }))),
        Cause::DumpNoContainer => (format!("Le conteneur {c} n'existe plus"), "Il a été supprimé ou recréé sous un autre nom : mets à jour ou retire cette source.".into(), source_fix()),
        Cause::DumpAuth => (
            format!("Accès refusé à la base de {c}"),
            "Le dump se connecte en root avec MYSQL_ROOT_PASSWORD / MARIADB_ROOT_PASSWORD (ou POSTGRES_USER) du conteneur : la variable manque ou ne correspond plus au mot de passe réel.".into(),
            None,
        ),
        Cause::DumpTool => (format!("Outil de dump introuvable dans {c}"), "mysqldump / mariadb-dump / pg_dumpall n'existe pas dans l'image : ce conteneur n'est peut-être pas un serveur de base.".into(), source_fix()),
        Cause::DumpOther => (format!("Échec du dump de {c}"), "L'export de la base a échoué ; la sortie ci-dessous donne le détail.".into(), source_fix()),
        Cause::VolumeMissing => ("Volume Docker introuvable".into(), "Un volume configuré a été supprimé ou renommé : mets à jour ou retire la source.".into(), None),
        Cause::Timeout => ("Sauvegarde arrêtée : délai dépassé".into(), "Elle a duré plus de 6 h (réseau lent, base figée) et systemd l'a arrêtée.".into(), Some(Fix::RunNow)),
        Cause::Dns => (
            "Stockage injoignable (DNS)".into(),
            if s3 { "Le nom de l'endpoint S3 ne se résout pas : vérifie l'adresse, ou le DNS du serveur." } else { "Résolution DNS impossible depuis le serveur." }.into(),
            repo_fix,
        ),
        Cause::Network => ("Stockage injoignable (réseau)".into(), "Le stockage ne répond pas : panne réseau, pare-feu sortant ou service du fournisseur indisponible.".into(), Some(Fix::RunNow)),
        Cause::BucketMissing => ("Bucket introuvable".into(), "Le bucket S3 configuré n'existe pas (ou plus) chez le fournisseur.".into(), repo_fix),
        Cause::Credentials => (
            "Identifiants du stockage refusés".into(),
            if s3 { "L'access key / secret key S3 est invalide, révoquée ou sans droit sur ce bucket." } else { "Accès refusé au dossier du dépôt." }.into(),
            repo_fix,
        ),
        Cause::RepoMissing => ("Dépôt introuvable".into(), "Le dépôt restic n'existe pas à l'emplacement configuré (dossier supprimé, préfixe changé).".into(), repo_fix),
        Cause::Interrupted => ("Sauvegarde interrompue".into(), "Elle a été arrêtée en cours de route (redémarrage du serveur, arrêt manuel).".into(), Some(Fix::RunNow)),
        Cause::Unknown => ("La dernière sauvegarde a échoué".into(), "Cause non reconnue : voir la sortie ci-dessous.".into(), Some(Fix::RunNow)),
    };
    Issue { severity: Severity::Danger, title, detail, evidence, fix }
}

fn ago(secs: i64) -> String {
    match secs {
        s if s < 7200 => format!("{} min", s / 60),
        s if s < 172_800 => format!("{} h", s / 3600),
        s => format!("{} jours", s / 86_400),
    }
}

/// Planification quotidienne + 10 min d'aléa + marge.
const STALE_AFTER: i64 = 26 * 3600;

pub fn diagnose(cfg: &BackupConfig, status: &Status, p: &Probe, sources: &[SourceCheck]) -> (Vec<Issue>, Option<i64>) {
    let mut issues = Vec::new();
    let now = p.now.unwrap_or(0);
    let s3 = matches!(cfg.destination, Destination::S3 { .. });
    let mut failure: Option<Cause> = None;

    if status.restic.is_none() {
        issues.push(Issue {
            severity: Severity::Danger,
            title: "restic n'est pas installé".into(),
            detail: "Aucune sauvegarde ne peut tourner.".into(),
            evidence: None,
            fix: Some(Fix::InstallRestic),
        });
        failure = Some(Cause::ResticMissing);
    }

    let mut running = false;
    match &p.schedule {
        Schedule::Systemd { enabled, active, service } => {
            running = service == "activating";
            if enabled != "enabled" || active != "active" {
                let fix = if enabled == "absent" { Fix::EditConfig } else { Fix::EnableSchedule };
                issues.push(Issue {
                    severity: Severity::Danger,
                    title: "Planification désactivée".into(),
                    detail: format!("zenytt-backup.timer est {enabled} / {active} : aucune sauvegarde ne partira automatiquement."),
                    evidence: None,
                    fix: Some(fix),
                });
            }
            if running {
                issues.push(Issue {
                    severity: Severity::Info,
                    title: "Sauvegarde en cours".into(),
                    detail: "Actualise dans quelques minutes pour voir le résultat.".into(),
                    evidence: None,
                    fix: None,
                });
            }
        }
        Schedule::Cron { present, running: cron_up } => {
            if !present {
                issues.push(Issue {
                    severity: Severity::Danger,
                    title: "Planification absente".into(),
                    detail: "/etc/cron.d/zenytt-backup n'existe plus : réenregistre la configuration pour la recréer.".into(),
                    evidence: None,
                    fix: Some(Fix::EditConfig),
                });
            } else if !cron_up {
                issues.push(Issue {
                    severity: Severity::Danger,
                    title: "Le service cron est arrêté".into(),
                    detail: "La sauvegarde est planifiée par cron, qui ne tourne pas : démarre le service cron (page Services).".into(),
                    evidence: None,
                    fix: None,
                });
            }
        }
        Schedule::Unknown => {}
    }

    if let Some(last) = status.last.as_ref().filter(|l| !l.ok) {
        let mut text = last.message.clone();
        for l in last_run_lines(&p.log) {
            text.push('\n');
            text.push_str(l);
        }
        let (cause, evidence) = classify(&last.step, &text);
        if failure != Some(cause) {
            let container = dump_container(&last.step, &last.message);
            let mut issue = failure_issue(cause, container.as_deref(), evidence, sources, s3);
            issue.detail = format!("{} (échec il y a {}.)", issue.detail, ago(now - last.finished_at));
            issues.push(issue);
            failure = Some(cause);
        }
    }

    let last_success = p.repo_times.iter().copied().chain(status.last.iter().filter(|l| l.ok).map(|l| l.finished_at)).max();
    match (&status.last, last_success) {
        (None, None) => issues.push(Issue {
            severity: Severity::Warn,
            title: "Aucune sauvegarde n'a encore tourné".into(),
            detail: format!("La première partira à {} ; tu peux la lancer dès maintenant.", cfg.schedule),
            evidence: None,
            fix: Some(Fix::RunNow),
        }),
        (_, Some(t)) if now - t > STALE_AFTER => {
            let missed = status.last.as_ref().is_some_and(|l| now - l.started_at > STALE_AFTER);
            issues.push(Issue {
                severity: if now - t > 3 * 86_400 { Severity::Danger } else { Severity::Warn },
                title: format!("Dernière sauvegarde réussie il y a {}", ago(now - t)),
                detail: if missed {
                    "La planification ne s'est pas déclenchée depuis : serveur éteint à l'heure prévue, ou planification désactivée."
                } else {
                    "Les exécutions suivantes ont échoué."
                }
                .into(),
                evidence: None,
                fix: Some(Fix::RunNow),
            });
        }
        (Some(l), None) if !l.ok && p.repo_rc == Some(0) => issues.push(Issue {
            severity: Severity::Danger,
            title: "Aucune sauvegarde n'a jamais réussi".into(),
            detail: "Le dépôt ne contient encore aucune sauvegarde.".into(),
            evidence: None,
            fix: None,
        }),
        _ => {}
    }

    match p.repo_rc {
        Some(124) => issues.push(Issue {
            severity: Severity::Warn,
            title: "Le dépôt ne répond pas".into(),
            detail: "La lecture des sauvegardes a dépassé 45 s : stockage lent ou injoignable.".into(),
            evidence: None,
            fix: None,
        }),
        Some(rc) if rc != 0 => {
            let (cause, evidence) = classify("repo", &p.repo_output.join("\n"));
            if failure != Some(cause) {
                let mut issue = failure_issue(cause, None, evidence, sources, s3);
                issue.title = format!("Dépôt inaccessible : {}", issue.title.to_lowercase());
                issues.push(issue);
                failure = Some(cause);
            }
        }
        _ => {}
    }

    if p.locks.is_some_and(|n| n > 0) && !running && failure != Some(Cause::Locked) {
        issues.push(Issue {
            severity: Severity::Warn,
            title: "Verrou restic en place".into(),
            detail: "Aucune sauvegarde ne tourne, mais un verrou est resté (exécution interrompue). Il peut bloquer la rétention ; « Déverrouiller » ne retire que les verrous périmés.".into(),
            evidence: None,
            fix: Some(Fix::Unlock),
        });
    }

    if failure != Some(Cause::DiskFull) {
        for (avail, used, mount) in &p.df {
            if *avail < 1_048_576 || *used >= 95 {
                issues.push(Issue {
                    severity: Severity::Warn,
                    title: format!("Espace disque faible sur {mount}"),
                    detail: format!(
                        "{:.1} Gio libres ({used} % utilisé) : les exports de bases ou le dépôt risquent de ne plus tenir.",
                        *avail as f64 / 1_048_576.0
                    ),
                    evidence: None,
                    fix: None,
                });
            }
        }
    }

    let blocking: Vec<&str> = sources
        .iter()
        .filter(|s| {
            matches!(s.state, SourceState::Stopped | SourceState::Recreated | SourceState::AuthFailed)
                || (s.state == SourceState::Missing && s.source != SourceKind::Path)
        })
        .map(|s| s.name.as_str())
        .collect();
    if !blocking.is_empty() {
        issues.push(Issue {
            severity: Severity::Warn,
            title: format!("{} source(s) feront échouer la prochaine sauvegarde", blocking.len()),
            detail: format!("{} : voir le tableau des sources pour la correction.", blocking.join(", ")),
            evidence: None,
            fix: None,
        });
    }

    issues.sort_by_key(|i| i.severity);
    (issues, last_success)
}

pub fn assess(cfg: &BackupConfig, status: &Status, p: &Probe) -> Health {
    let sources = assess_sources(cfg, p);
    let (issues, last_success) = diagnose(cfg, status, p, &sources);
    Health { now: p.now.unwrap_or(0), last_success, sources, issues }
}

pub async fn health(conn: &Connection, sudo: Option<&str>) -> Result<Health> {
    let status = backup::status(conn, sudo).await?;
    let cfg = status.config.clone().ok_or_else(|| Error::Other("aucune sauvegarde configurée".into()))?;
    let out = crate::ssh::with_limit(std::time::Duration::from_secs(180), conn.exec_sudo(&probe_script(&cfg), sudo, None)).await?;
    Ok(assess(&cfg, &status, &parse_probe(&out.stdout)))
}

// ---------- Corrections ----------

/// Applique « relier à … » ou « retirer la source » à la configuration. `labels` : projet et
/// service compose du conteneur cible (relier une base).
pub fn edit_sources(cfg: &BackupConfig, fix: &Fix, labels: (Option<String>, Option<String>)) -> Result<BackupConfig> {
    let mut c = cfg.clone();
    let bad = |m: &str| Err(Error::Other(m.into()));
    match fix {
        Fix::Relink { source: SourceKind::Database, from, to } => {
            if c.databases.iter().any(|d| &d.container == to) {
                return bad("ce conteneur est déjà sauvegardé");
            }
            let Some(d) = c.databases.iter_mut().find(|d| &d.container == from) else { return bad("source introuvable") };
            d.container = to.clone();
            (d.project, d.service) = labels;
        }
        Fix::Relink { source: SourceKind::Volume, from, to } => {
            if c.volumes.contains(to) {
                return bad("ce volume est déjà sauvegardé");
            }
            let Some(v) = c.volumes.iter_mut().find(|v| *v == from) else { return bad("source introuvable") };
            *v = to.clone();
        }
        Fix::RemoveSource { source, name } => {
            let before = c.databases.len() + c.volumes.len() + c.paths.len();
            match source {
                SourceKind::Database => c.databases.retain(|d| &d.container != name),
                SourceKind::Volume => c.volumes.retain(|v| v != name),
                SourceKind::Path => c.paths.retain(|p| p != name),
            }
            let after = c.databases.len() + c.volumes.len() + c.paths.len();
            if after == before {
                return bad("source introuvable");
            }
            if after == 0 {
                return bad("c'est la dernière source : garde-la ou modifie la configuration");
            }
        }
        _ => return bad("correction non applicable à la configuration"),
    }
    c.validate()?;
    Ok(c)
}

/// Retire les verrous périmés du dépôt (`restic unlock` ne touche pas à ceux d'une sauvegarde en cours).
pub async fn unlock(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    let out =
        crate::ssh::long(conn.exec_sudo(&format!("set -a; . {ENV_PATH}; set +a; restic unlock 2>&1"), sudo, None)).await?.into_result()?;
    Ok(out.stdout)
}

pub async fn enable_schedule(conn: &Connection, sudo: Option<&str>) -> Result<()> {
    conn.exec_sudo("systemctl enable --now zenytt-backup.timer 2>&1", sudo, None).await?.into_result()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{DbSource, LastRun};

    fn cfg() -> BackupConfig {
        BackupConfig {
            paths: vec!["/etc/nginx".into(), "/opt/sites".into(), "/etc/letsencrypt".into()],
            volumes: vec!["nexus-dashboard_mysql_data".into(), "old_uploads".into(), "gone_vol".into()],
            databases: vec![
                DbSource { container: "infra_postgres_1".into(), kind: "postgres".into(), project: None, service: None },
                DbSource { container: "nexus-mysql-prod".into(), kind: "mysql".into(), project: None, service: None },
                DbSource {
                    container: "laravel-db".into(),
                    kind: "mysql".into(),
                    project: Some("projet-laravel".into()),
                    service: Some("db".into()),
                },
                DbSource { container: "shop-db".into(), kind: "mysql".into(), project: Some("shop".into()), service: Some("db".into()) },
            ],
            ..Default::default()
        }
    }

    // Relevé inspiré du vrai VPS : laravel-db arrêté, nexus-mysql-prod sans MYSQL_ROOT_PASSWORD,
    // shop recréé par compose v2 sous « shop-db-1 ».
    const PROBE: &str = "now 1792859119
docker ok
ct infra_postgres_1|509bbef195a4|running|postgres:16-alpine|infra|postgres
ct laravel-db|7a1c|exited|mysql:8.0|projet-laravel|db
ct nexus-mysql-prod|99aa|running|mysql:8.0|nexus-dashboard|db
ct shop-db-1|1234|running|mariadb:11|shop|db
ct mypage-web-1|55|running|ghcr.io/x/mypage-web:ab5d||
vol nexus-dashboard_mysql_data
vol projet-laravel_dbdata
vol new_uploads
volp 2 nexus-dashboard_mysql_data
path 2 /etc/nginx
path - /opt/sites
path 0 /etc/letsencrypt
db infra_postgres_1 postgres
db infra_postgres_1 nexus
dbrc 0 infra_postgres_1
seen infra_postgres_1 CREATE DATABASE nexus WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.utf8';
seen infra_postgres_1 CREATE DATABASE analytics WITH TEMPLATE = template0 ENCODING = 'UTF8';
db nexus-mysql-prod ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)
dbrc 1 nexus-mysql-prod
timer enabled active
svc failed
log Starting zenytt-backup.service - Sauvegarde Zenytt (restic)...
log Sauvegarde Zenytt — Fri Oct 23 03:04:30 UTC 2026
log Dump MySQL/MariaDB : nexus-mysql-prod
log Enter password: mysqldump: Got error: 1045: Access denied for user 'root'@'localhost' (using password: NO) when trying to connect
log ÉCHEC : dump de nexus-mysql-prod
log Sauvegarde Zenytt — Sat Oct 24 03:05:19 UTC 2026
log Dump PostgreSQL : infra_postgres_1
log Dump MySQL/MariaDB : laravel-db
log Error response from daemon: container 509bbef195a446ad8245caf028df4fee49ee499def9ae9a1e916c46d9af48a8e is not running
log ÉCHEC : dump de laravel-db
log zenytt-backup.service: Main process exited, code=exited, status=1/FAILURE
df 51234567 42% /
df 8123 99% /tmp
repo 0
rtime \"time\":\"2026-10-21T03:04:35.123456789Z\"
locks 1
";

    fn status(last: Option<LastRun>) -> Status {
        Status { restic: Some("restic 0.14.0".into()), config: Some(cfg()), last, next_run: None }
    }

    fn failed(msg: &str, step: &str) -> LastRun {
        LastRun { started_at: 1792811119, finished_at: 1792811119, ok: false, message: msg.into(), step: step.into() }
    }

    #[test]
    fn time_parse() {
        assert_eq!(rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_secs("2026-10-24T03:05:19Z"), Some(1792811119));
        assert_eq!(rfc3339_secs("2026-10-24T05:05:19.5+02:00"), Some(1792811119));
        assert_eq!(rfc3339_secs("2024-02-29T00:00:00Z"), Some(1709164800));
        assert_eq!(rfc3339_secs("n'importe quoi"), None);
    }

    #[test]
    fn dump_names() {
        let l = |s: &str| s.to_string();
        let names = dump_databases(&[
            l("CREATE DATABASE /*!32312 IF NOT EXISTS*/ `laravel` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;"),
            l("CREATE DATABASE nexus WITH TEMPLATE = template0 ENCODING = 'UTF8';"),
            l("CREATE DATABASE \"Mon App\" WITH TEMPLATE = template0;"),
            l("-- autre"),
        ]);
        assert_eq!(names, vec!["laravel", "nexus", "Mon App"]);
    }

    #[test]
    fn sources_on_real_probe() {
        let p = parse_probe(PROBE);
        assert!(p.docker);
        assert_eq!(p.containers[4].project, None);
        let s = assess_sources(&cfg(), &p);
        let by = |n: &str| s.iter().find(|x| x.name == n).unwrap();
        // Base présente, mais « analytics » a disparu depuis le dernier dump.
        assert_eq!(by("infra_postgres_1").state, SourceState::DbDropped);
        assert!(by("infra_postgres_1").detail.contains("analytics"));
        assert_eq!(by("nexus-mysql-prod").state, SourceState::AuthFailed);
        assert!(by("nexus-mysql-prod").detail.contains("MYSQL_ROOT_PASSWORD"));
        assert_eq!(by("laravel-db").state, SourceState::Stopped);
        assert_eq!(by("laravel-db").fix, Some(Fix::StartContainer { container: "laravel-db".into() }));
        assert_eq!(by("shop-db").state, SourceState::Recreated);
        assert_eq!(by("shop-db").fix, Some(Fix::Relink { source: SourceKind::Database, from: "shop-db".into(), to: "shop-db-1".into() }));
        assert_eq!(by("nexus-dashboard_mysql_data").state, SourceState::Ok);
        assert_eq!(
            by("old_uploads").fix,
            Some(Fix::Relink { source: SourceKind::Volume, from: "old_uploads".into(), to: "new_uploads".into() })
        );
        assert_eq!(by("gone_vol").state, SourceState::Missing);
        assert_eq!(by("/etc/nginx").state, SourceState::Ok);
        assert_eq!(by("/opt/sites").state, SourceState::Missing);
        assert_eq!(by("/etc/letsencrypt").state, SourceState::Empty);
    }

    #[test]
    fn container_gone() {
        let mut c = cfg();
        c.databases = vec![
            DbSource { container: "infra_postgres_1".into(), kind: "postgres".into(), project: None, service: None },
            DbSource { container: "blog-db".into(), kind: "mysql".into(), project: Some("blog".into()), service: Some("db".into()) },
        ];
        // compose v2 : infra_postgres_1 devient infra-postgres-1 ; le projet blog a disparu.
        let p = parse_probe("now 1\ndocker ok\nct infra-postgres-1|1|running|postgres:16|infra|postgres\n");
        let s = assess_sources(&c, &p);
        assert_eq!(s[0].state, SourceState::Recreated);
        assert!(s[1].detail.contains("projet compose « blog »"));
        assert_eq!(s[1].fix, Some(Fix::RemoveSource { source: SourceKind::Database, name: "blog-db".into() }));
        let none = assess_sources(&c, &parse_probe("now 1\n"));
        assert!(none.iter().take(2).all(|x| x.state == SourceState::Unknown), "Docker inaccessible");
    }

    #[test]
    fn classify_real_outputs() {
        let c = |step: &str, t: &str| classify(step, t).0;
        assert_eq!(
            c("", "dump de laravel-db\nError response from daemon: container 509bbef1 is not running\nÉCHEC : dump de laravel-db"),
            Cause::DumpNotRunning
        );
        assert_eq!(
            c("dump:nexus", "dump de nexus : Enter password: mysqldump: Got error: 1045: Access denied for user 'root'@'localhost' (using password: NO) when trying to connect"),
            Cause::DumpAuth
        );
        assert_eq!(c("dump:pg", "dump de pg : pg_dumpall: error: connection to server on socket \"/var/run/postgresql/.s.PGSQL.5432\" failed: FATAL:  password authentication failed for user \"app\""), Cause::DumpAuth);
        assert_eq!(c("dump:x", "dump de x : Error response from daemon: No such container: x"), Cause::DumpNoContainer);
        assert_eq!(c("dump:x", "dump de x : OCI runtime exec failed: exec failed: unable to start container process: exec: \"pg_dumpall\": executable file not found in $PATH"), Cause::DumpTool);
        assert_eq!(c("", "dump de x : mysqldump: Error 2013: Lost connection to server during query"), Cause::DumpOther);
        assert_eq!(
            c("forget", "rétention (forget/prune) impossible : unable to create lock in backend: repository is already locked exclusively by PID 4242 on vps by root (UID 0, GID 0) lock was created at 2026-10-20 03:00:12 (96h5m0s ago)"),
            Cause::Locked
        );
        assert_eq!(c("repo", "dépôt inaccessible : Fatal: wrong password or no key found"), Cause::WrongPassword);
        assert_eq!(c("repo", "Fatal: unable to open config file: Stat: Get \"https://s3.fr-par.scw.cloud/b/?location=\": dial tcp: lookup s3.fr-par.scw.cloud on 127.0.0.53:53: no such host"), Cause::Dns);
        assert_eq!(c("repo", "Fatal: unable to open config file: Stat: The access key ID you provided does not exist in our records.\nIs there a repository at the following location?"), Cause::Credentials);
        assert_eq!(c("repo", "Fatal: unable to open config file: Stat: The specified bucket does not exist."), Cause::BucketMissing);
        assert_eq!(c("repo", "Fatal: unable to open config file: Stat: dial tcp 1.2.3.4:443: i/o timeout"), Cause::Network);
        assert_eq!(c("repo", "Fatal: unable to open config file: stat /var/backups/zenytt/restic/config: no such file or directory\nIs there a repository at the following location?"), Cause::RepoMissing);
        assert_eq!(
            c("backup:1", "Fatal: unable to save snapshot: write /var/backups/zenytt/restic/data/ab/x: no space left on device"),
            Cause::DiskFull
        );
        assert_eq!(c("", "/etc/zenytt-backup/run.sh: line 30: restic: command not found"), Cause::ResticMissing);
        assert_eq!(
            c("interrupted", "sauvegarde interrompue\nzenytt-backup.service: start operation timed out. Terminating."),
            Cause::Timeout
        );
        assert_eq!(c("interrupted", "sauvegarde interrompue"), Cause::Interrupted);
        assert_eq!(c("volume:v", "volume v introuvable : Error: No such volume: v"), Cause::VolumeMissing);
        assert_eq!(c("", "quelque chose d'inédit"), Cause::Unknown);
        assert_eq!(dump_container("", "dump de laravel-db"), Some("laravel-db".into()));
        assert_eq!(dump_container("dump:pg", "x"), Some("pg".into()));
        assert_eq!(dump_container("", "dump de a;b : x"), None);
    }

    #[test]
    fn diagnose_real_vps() {
        let p = parse_probe(PROBE);
        let h = assess(&cfg(), &status(Some(failed("dump de laravel-db", ""))), &p);
        let titles: Vec<&str> = h.issues.iter().map(|i| i.title.as_str()).collect();
        // Ancien last.json sans cause : le journal donne la vraie raison.
        let first = &h.issues[0];
        assert_eq!(first.title, "Le conteneur laravel-db est arrêté", "{titles:?}");
        assert_eq!(first.fix, Some(Fix::StartContainer { container: "laravel-db".into() }));
        assert!(first.evidence.as_deref().unwrap().contains("is not running"));
        assert!(titles.iter().any(|t| t.starts_with("Dernière sauvegarde réussie il y a 3 jours")), "{titles:?}");
        assert!(titles.contains(&"Verrou restic en place"));
        assert!(titles.contains(&"Espace disque faible sur /tmp"));
        assert!(titles.iter().any(|t| t.contains("feront échouer")));
        assert_eq!(h.last_success, Some(1792551875));
    }

    #[test]
    fn diagnose_schedule_and_never() {
        let p = parse_probe("now 2000000000\ntimer disabled inactive\nsvc inactive\nrepo 0\nlocks 0\n");
        let (issues, _) = diagnose(&cfg(), &status(None), &p, &[]);
        assert_eq!(issues[0].fix, Some(Fix::EnableSchedule));
        assert!(issues.iter().any(|i| i.title == "Aucune sauvegarde n'a encore tourné"));
        // Dernière exécution réussie mais vieille de 4 jours, timer actif : planification manquée.
        let ok = LastRun {
            started_at: 2_000_000_000 - 4 * 86_400,
            finished_at: 2_000_000_000 - 4 * 86_400,
            ok: true,
            message: String::new(),
            step: "done".into(),
        };
        let p = parse_probe("now 2000000000\ntimer enabled active\nsvc inactive\n");
        let (issues, last) = diagnose(&cfg(), &status(Some(ok)), &p, &[]);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Danger);
        assert!(issues[0].detail.contains("ne s'est pas déclenchée"));
        assert_eq!(last, Some(2_000_000_000 - 4 * 86_400));
        // Dépôt inaccessible alors que la dernière exécution était bonne.
        let p = parse_probe("now 2000000000\ntimer enabled active\nrepo 1\nrout Fatal: wrong password or no key found\n");
        let ok = LastRun {
            started_at: 2_000_000_000 - 3600,
            finished_at: 2_000_000_000 - 3000,
            ok: true,
            message: String::new(),
            step: String::new(),
        };
        let (issues, _) = diagnose(&cfg(), &status(Some(ok)), &p, &[]);
        assert_eq!(issues[0].title, "Dépôt inaccessible : mot de passe du dépôt refusé");
        assert_eq!(issues[0].fix, Some(Fix::EditConfig));
    }

    #[test]
    fn edits() {
        let c = cfg();
        let r = edit_sources(
            &c,
            &Fix::Relink { source: SourceKind::Database, from: "shop-db".into(), to: "shop-db-1".into() },
            (Some("shop".into()), Some("db".into())),
        )
        .unwrap();
        assert!(r.databases.iter().any(|d| d.container == "shop-db-1" && d.project.as_deref() == Some("shop")));
        assert!(
            edit_sources(&c, &Fix::Relink { source: SourceKind::Database, from: "shop-db".into(), to: "laravel-db".into() }, (None, None))
                .is_err(),
            "déjà sauvegardé"
        );
        assert!(
            edit_sources(&c, &Fix::Relink { source: SourceKind::Database, from: "shop-db".into(), to: "x; rm -rf /".into() }, (None, None))
                .is_err(),
            "nom validé"
        );
        let r = edit_sources(&c, &Fix::RemoveSource { source: SourceKind::Path, name: "/opt/sites".into() }, (None, None)).unwrap();
        assert_eq!(r.paths.len(), 2);
        assert!(edit_sources(&c, &Fix::RemoveSource { source: SourceKind::Path, name: "/nope".into() }, (None, None)).is_err());
        let one = BackupConfig { paths: vec!["/etc".into()], volumes: vec![], databases: vec![], ..Default::default() };
        assert!(
            edit_sources(&one, &Fix::RemoveSource { source: SourceKind::Path, name: "/etc".into() }, (None, None)).is_err(),
            "dernière source"
        );
        assert!(edit_sources(&c, &Fix::Unlock, (None, None)).is_err());
    }

    #[test]
    fn script_is_quoted_and_bounded() {
        let s = probe_script(&cfg());
        assert!(s.contains("inspect -f '{{.State.Running}}' 'laravel-db'"));
        assert!(s.contains("restic snapshots --json --tag zenytt --latest 1 --no-lock"));
        assert!(s.contains("T 20 \"$DK\" exec 'nexus-mysql-prod' sh -c "));
        assert!(!s.contains("RESTIC_PASSWORD"), "aucun secret dans le script");
        assert!(s.contains("df -Pk '/var/backups/zenytt/restic'"));
    }
}
