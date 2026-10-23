//! Administration des bases : sauvegarde et restauration, utilisateurs et droits, requêtes en cours.
//!
//! Les sauvegardes sont écrites dans un dossier de l'utilisateur SSH (`~/zenytt-sauvegardes-bdd`),
//! appartenant à cet utilisateur : elles se téléchargent par SFTP sans droits particuliers. Les
//! mots de passe des comptes passent dans le SQL, sur l'entrée standard du client, jamais dans une
//! ligne de commande.

use serde::Serialize;

use crate::db::{self, quote_ident, quote_literal, valid_db_name, Engine, Instance, QueryResult};
use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub const BACKUP_DIR_NAME: &str = "zenytt-sauvegardes-bdd";

/// Commande qui écrit la sauvegarde SQL d'une base sur sa sortie standard. Comme le client SQL,
/// elle lit d'abord le compte sur ses deux premières lignes d'entrée (voir [`db::login_prefix`]).
pub fn dump_command(instance: &Instance, database: &str) -> Result<String> {
    db::check(instance, Some(database))?;
    const SKIP_LOGIN: &str = "IFS= read -r ZU; IFS= read -r ZP;";
    const MYSQL_OPTS: &str = "--single-transaction --routines --triggers --events --databases";
    Ok(match (instance.engine, &instance.container) {
        (Engine::Mysql, Some(c)) => {
            let script = format!("{}D=$(command -v mysqldump || command -v mariadb-dump); exec \"$D\" -u\"$ZU\" {MYSQL_OPTS} {}", db::MYSQL_CONTAINER_SCRIPT, shell_quote(database));
            format!("docker exec -i {c} sh -c {}", shell_quote(&script))
        }
        (Engine::Mysql, None) => format!(
            "{SKIP_LOGIN} D=$(command -v mysqldump || command -v mariadb-dump); if [ -n \"$ZU\" ]; then export MYSQL_PWD=\"$ZP\"; set -- -u\"$ZU\"; fi; \"$D\" \"$@\" {MYSQL_OPTS} {}", shell_quote(database)
        ),
        (Engine::Postgres, Some(c)) => {
            let script = format!(
                "{SKIP_LOGIN} [ -n \"$ZU\" ] || ZU=\"${{POSTGRES_USER:-postgres}}\"; [ -n \"$ZP\" ] && export PGPASSWORD=\"$ZP\"; exec pg_dump -U \"$ZU\" -d {database} --clean --if-exists --no-owner"
            );
            format!("docker exec -i {c} sh -c {}", shell_quote(&script))
        }
        (Engine::Postgres, None) => format!(
            "{SKIP_LOGIN} if [ -n \"$ZU\" ]; then PGPASSWORD=\"$ZP\" pg_dump -h 127.0.0.1 -U \"$ZU\" -d {database} --clean --if-exists --no-owner; else su -s /bin/sh postgres -c 'pg_dump -d {database} --clean --if-exists --no-owner'; fi"
        ),
        (Engine::Sqlite, Some(c)) => format!("{SKIP_LOGIN} docker exec {c} sqlite3 {} .dump", shell_quote(&instance.path)),
        (Engine::Sqlite, None) => format!("{SKIP_LOGIN} sqlite3 {} .dump", shell_quote(&instance.path)),
    })
}

/// Nom de fichier de sauvegarde sûr : lettres, chiffres, `-`, `_`, `.`, terminé par `.sql` ou `.sql.gz`.
pub fn valid_backup_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        && (name.ends_with(".sql") || name.ends_with(".sql.gz"))
}

/// Dossier des sauvegardes (créé au besoin), et `uid:gid` de l'utilisateur SSH.
async fn backup_dir(conn: &Connection) -> Result<(String, String)> {
    let out = conn.exec(&format!("mkdir -p \"$HOME/{BACKUP_DIR_NAME}\" && chmod 700 \"$HOME/{BACKUP_DIR_NAME}\" && echo \"$HOME/{BACKUP_DIR_NAME}\" && echo \"$(id -u):$(id -g)\""), None).await?.into_result()?;
    let mut lines = out.stdout.lines();
    let dir = lines.next().unwrap_or("").trim().to_string();
    let owner = lines.next().unwrap_or("").trim().to_string();
    if !dir.starts_with('/') || !owner.contains(':') {
        return Err(Error::Other("dossier de sauvegarde introuvable".into()));
    }
    Ok((dir, owner))
}

/// Fichier de sauvegarde sur le serveur.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Date de modification (secondes Unix).
    pub modified: i64,
}

pub async fn list_backups(conn: &Connection) -> Result<Vec<BackupFile>> {
    let (dir, _) = backup_dir(conn).await?;
    let out = conn
        .exec(
            &format!("cd {} && for f in *.sql *.sql.gz; do [ -f \"$f\" ] && stat -c '%s %Y %n' \"$f\"; done; true", shell_quote(&dir)),
            None,
        )
        .await?;
    let mut list: Vec<BackupFile> = out
        .stdout
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, ' ');
            let size = p.next()?.parse().ok()?;
            let modified = p.next()?.parse().ok()?;
            let name = p.next()?.to_string();
            valid_backup_name(&name).then(|| BackupFile { path: format!("{dir}/{name}"), name, size, modified })
        })
        .collect();
    list.sort_by_key(|b| std::cmp::Reverse(b.modified));
    Ok(list)
}

/// Sauvegarde une base (compressée) dans le dossier des sauvegardes ; renvoie le fichier créé.
pub async fn backup(conn: &Connection, sudo: Option<&str>, instance: &Instance, database: &str, stamp: &str) -> Result<BackupFile> {
    let dump = dump_command(instance, database)?;
    let (dir, owner) = backup_dir(conn).await?;
    let base = if instance.engine == Engine::Sqlite {
        instance.path.rsplit('/').next().unwrap_or("sqlite").replace(|c: char| !(c.is_ascii_alphanumeric() || "-_".contains(c)), "_")
    } else {
        database.to_string()
    };
    let name = format!("{base}-{stamp}.sql.gz");
    if !valid_backup_name(&name) {
        return Err(Error::Other("nom de sauvegarde invalide".into()));
    }
    let file = format!("{dir}/{name}");
    let (f, tmp, err) = (shell_quote(&file), shell_quote(&format!("{file}.part")), shell_quote(&format!("{file}.err")));
    let script = format!(
        // Le code de sortie de l'outil de sauvegarde est masqué par le tube : on juge sur ses messages
        // d'erreur et sur un contenu non vide.
        "{{ {dump}; }} 2>{err} | gzip > {tmp}\n\
         if ! gzip -t {tmp} 2>/dev/null || [ \"$(zcat {tmp} | head -c 1 | wc -c)\" = 0 ] || grep -qiE 'error|denied|fatal|does not exist|unknown database' {err}; then cat {err}; rm -f {tmp} {err}; exit 1; fi\n\
         mv -f {tmp} {f} && rm -f {err} && chown {owner} {f} && chmod 600 {f}"
    );
    let login = db::login_prefix(instance.login.as_ref())?;
    let out = crate::ssh::long(conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, Some(login.as_bytes()))).await?;
    if !out.success() {
        let msg = db::real_errors(&format!("{}\n{}", out.stdout, out.stderr));
        return Err(Error::Remote(if msg.is_empty() { "la sauvegarde a échoué".into() } else { msg }));
    }
    list_backups(conn)
        .await?
        .into_iter()
        .find(|b| b.name == name)
        .ok_or_else(|| Error::Other("sauvegarde introuvable après écriture".into()))
}

/// Rejoue un fichier SQL (compressé ou non) dans une base. `path` doit être dans le dossier des
/// sauvegardes (c'est là que l'interface dépose aussi les fichiers importés du PC).
pub async fn restore(conn: &Connection, sudo: Option<&str>, instance: &Instance, database: &str, name: &str) -> Result<String> {
    if !valid_backup_name(name) {
        return Err(Error::Other("fichier de sauvegarde invalide".into()));
    }
    let (dir, _) = backup_dir(conn).await?;
    let client = db::client_command(instance, (instance.engine != Engine::Sqlite).then_some(database), None)?;
    let file = shell_quote(&format!("{dir}/{name}"));
    // Le client attend le compte sur ses deux premières lignes, puis le SQL du fichier.
    let script = format!("{{ IFS= read -r ZU; IFS= read -r ZP; printf '%s\\n%s\\n' \"$ZU\" \"$ZP\"; zcat -f {file}; }} | {client}");
    let login = db::login_prefix(instance.login.as_ref())?;
    let out = crate::ssh::long(conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, Some(login.as_bytes()))).await?;
    let problem = db::real_errors(&out.stderr);
    if !out.success() {
        return Err(Error::Remote(if problem.is_empty() { "la restauration a échoué".into() } else { problem }));
    }
    Ok(problem)
}

pub async fn delete_backup(conn: &Connection, name: &str) -> Result<()> {
    if !valid_backup_name(name) {
        return Err(Error::Other("fichier de sauvegarde invalide".into()));
    }
    let (dir, _) = backup_dir(conn).await?;
    conn.exec(&format!("rm -f {}", shell_quote(&format!("{dir}/{name}"))), None).await?.into_result()?;
    Ok(())
}

/// Le dossier où déposer un fichier importé du PC avant de le restaurer.
pub async fn import_dir(conn: &Connection) -> Result<String> {
    Ok(backup_dir(conn).await?.0)
}

// ---------- Utilisateurs ----------

/// Nom de compte acceptable : lettres, chiffres, `_`, `-`, `.` (refusé plutôt qu'échappé).
pub fn valid_user(name: &str) -> bool {
    !name.is_empty() && name.len() <= 63 && name.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
}

/// Hôte MySQL d'un compte : `%`, `localhost`, une IP ou un motif simple.
pub fn valid_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 255 && host.chars().all(|c| c.is_ascii_alphanumeric() || "%._-:/".contains(c))
}

const MYSQL_USERS: &str = "SELECT user AS utilisateur, host AS hote, \
     IF(account_locked = 'Y', 'verrouillé', '') AS etat FROM mysql.user ORDER BY user, host";
const MYSQL_USERS_OLD: &str = "SELECT user AS utilisateur, host AS hote, '' AS etat FROM mysql.user ORDER BY user, host";
const PG_USERS: &str = "SELECT rolname AS utilisateur, \
     CASE WHEN rolsuper THEN 'super-utilisateur' WHEN rolcanlogin THEN 'connexion' ELSE 'rôle' END AS type, \
     COALESCE((SELECT string_agg(datname, ', ') FROM pg_database d WHERE has_database_privilege(rolname, d.datname, 'CREATE') AND NOT datistemplate), '') AS bases \
     FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname";

pub async fn users(conn: &Connection, sudo: Option<&str>, instance: &Instance) -> Result<QueryResult> {
    let sql = match instance.engine {
        Engine::Mysql => MYSQL_USERS,
        Engine::Postgres => PG_USERS,
        Engine::Sqlite => return Err(Error::Other("SQLite n'a pas de comptes utilisateurs".into())),
    };
    let out = match db::run_sql(conn, sudo, instance, None, sql, Some(1000)).await {
        // MySQL 5.6 / anciennes MariaDB : pas de colonne account_locked.
        Err(_) if instance.engine == Engine::Mysql => db::run_sql(conn, sudo, instance, None, MYSQL_USERS_OLD, Some(1000)).await?,
        r => r?,
    };
    Ok(db::parse(instance.engine, &out))
}

/// SQL de création d'un compte avec tous les droits sur une base (ou aucune base).
pub fn create_user_sql(
    engine: Engine,
    user: &str,
    host: &str,
    password: &str,
    database: Option<&str>,
) -> Result<Vec<(Option<String>, String)>> {
    if !valid_user(user) {
        return Err(Error::Other("nom d'utilisateur invalide : lettres, chiffres, « _ », « - » et « . »".into()));
    }
    if password.len() < 8 {
        return Err(Error::Other("mot de passe trop court (8 caractères au moins)".into()));
    }
    if let Some(d) = database {
        if !valid_db_name(d) {
            return Err(Error::Other("nom de base invalide".into()));
        }
    }
    let pw = quote_literal(engine, password);
    Ok(match engine {
        Engine::Mysql => {
            if !valid_host(host) {
                return Err(Error::Other("hôte invalide (ex. %, localhost, 172.%)".into()));
            }
            let who = format!("{}@{}", quote_literal(engine, user), quote_literal(engine, host));
            let mut sql = format!("CREATE USER {who} IDENTIFIED BY {pw};\n");
            if let Some(d) = database {
                sql.push_str(&format!("GRANT ALL PRIVILEGES ON `{d}`.* TO {who};\n"));
            }
            sql.push_str("FLUSH PRIVILEGES");
            vec![(None, sql)]
        }
        Engine::Postgres => {
            let role = quote_ident(engine, user)?;
            let mut steps = vec![(None, format!("CREATE ROLE {role} LOGIN PASSWORD {pw}"))];
            if let Some(d) = database {
                steps.push((None, format!("GRANT ALL PRIVILEGES ON DATABASE \"{d}\" TO {role}")));
                // Depuis PostgreSQL 15, le schéma public n'est plus ouvert à tous : on l'ouvre au compte.
                steps.push((Some(d.to_string()), format!("GRANT ALL ON SCHEMA public TO {role}")));
            }
            steps
        }
        Engine::Sqlite => return Err(Error::Other("SQLite n'a pas de comptes utilisateurs".into())),
    })
}

pub async fn create_user(
    conn: &Connection,
    sudo: Option<&str>,
    instance: &Instance,
    user: &str,
    host: &str,
    password: &str,
    database: Option<&str>,
) -> Result<()> {
    for (db_name, sql) in create_user_sql(instance.engine, user, host, password, database)? {
        db::run_sql(conn, sudo, instance, db_name.as_deref(), &sql, None).await?;
    }
    Ok(())
}

pub fn password_sql(engine: Engine, user: &str, host: &str, password: &str) -> Result<String> {
    if !valid_user(user) || (engine == Engine::Mysql && !valid_host(host)) {
        return Err(Error::Other("compte invalide".into()));
    }
    if password.len() < 8 {
        return Err(Error::Other("mot de passe trop court (8 caractères au moins)".into()));
    }
    let pw = quote_literal(engine, password);
    Ok(match engine {
        Engine::Mysql => format!("ALTER USER {}@{} IDENTIFIED BY {pw}", quote_literal(engine, user), quote_literal(engine, host)),
        Engine::Postgres => format!("ALTER ROLE {} PASSWORD {pw}", quote_ident(engine, user)?),
        Engine::Sqlite => return Err(Error::Other("SQLite n'a pas de comptes utilisateurs".into())),
    })
}

pub async fn set_password(
    conn: &Connection,
    sudo: Option<&str>,
    instance: &Instance,
    user: &str,
    host: &str,
    password: &str,
) -> Result<()> {
    db::run_sql(conn, sudo, instance, None, &password_sql(instance.engine, user, host, password)?, None).await?;
    Ok(())
}

pub fn drop_user_sql(engine: Engine, user: &str, host: &str) -> Result<String> {
    if !valid_user(user) || (engine == Engine::Mysql && !valid_host(host)) {
        return Err(Error::Other("compte invalide".into()));
    }
    if matches!(user, "root" | "postgres" | "mysql.sys" | "mysql.session" | "mysql.infoschema" | "mariadb.sys") {
        return Err(Error::Other(format!("« {user} » est un compte système : Zenytt ne le supprime pas")));
    }
    Ok(match engine {
        Engine::Mysql => format!("DROP USER {}@{}", quote_literal(engine, user), quote_literal(engine, host)),
        Engine::Postgres => format!("DROP ROLE {}", quote_ident(engine, user)?),
        Engine::Sqlite => return Err(Error::Other("SQLite n'a pas de comptes utilisateurs".into())),
    })
}

pub async fn drop_user(conn: &Connection, sudo: Option<&str>, instance: &Instance, user: &str, host: &str) -> Result<()> {
    db::run_sql(conn, sudo, instance, None, &drop_user_sql(instance.engine, user, host)?, None).await?;
    Ok(())
}

// ---------- Requêtes en cours ----------

const MYSQL_ACTIVITY: &str = "SELECT id, user AS utilisateur, host AS origine, db AS base, command AS commande, time AS secondes, \
     state AS etat, LEFT(info, 300) AS requete FROM information_schema.processlist \
     WHERE command <> 'Sleep' AND id <> CONNECTION_ID() ORDER BY time DESC";
const PG_ACTIVITY: &str = "SELECT pid AS id, usename AS utilisateur, COALESCE(client_addr::text, 'local') AS origine, datname AS base, \
     state AS etat, COALESCE(EXTRACT(EPOCH FROM now() - query_start)::int, 0) AS secondes, LEFT(query, 300) AS requete \
     FROM pg_stat_activity WHERE state IS NOT NULL AND state <> 'idle' AND pid <> pg_backend_pid() ORDER BY secondes DESC";

pub async fn activity(conn: &Connection, sudo: Option<&str>, instance: &Instance) -> Result<QueryResult> {
    let sql = match instance.engine {
        Engine::Mysql => MYSQL_ACTIVITY,
        Engine::Postgres => PG_ACTIVITY,
        Engine::Sqlite => return Err(Error::Other("SQLite n'a pas de requêtes en cours à surveiller".into())),
    };
    Ok(db::parse(instance.engine, &db::run_sql(conn, sudo, instance, None, sql, Some(500)).await?))
}

/// Arrête une requête (`whole` : ferme aussi la connexion).
pub fn kill_sql(engine: Engine, id: u64, whole: bool) -> Result<String> {
    Ok(match engine {
        Engine::Mysql => format!("KILL {}{id}", if whole { "" } else { "QUERY " }),
        Engine::Postgres => format!("SELECT {}({id})", if whole { "pg_terminate_backend" } else { "pg_cancel_backend" }),
        Engine::Sqlite => return Err(Error::Other("rien à arrêter sur SQLite".into())),
    })
}

pub async fn kill(conn: &Connection, sudo: Option<&str>, instance: &Instance, id: u64, whole: bool) -> Result<()> {
    db::run_sql(conn, sudo, instance, None, &kill_sql(instance.engine, id, whole)?, None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mysql() -> Instance {
        Instance::server("container:db", "db", Engine::Mysql, Some("db".into()))
    }

    #[test]
    fn dump_commands() {
        let m = dump_command(&mysql(), "shop").unwrap();
        assert!(m.contains("--databases ") && m.contains("shop") && m.contains("docker exec -i db") && !m.contains("-it"), "{m}");
        assert!(!m.contains(" -p") && m.contains("MYSQL_PWD"), "même authentification que le client : {m}");
        let pg = dump_command(&Instance::server("local:postgres", "pg", Engine::Postgres, None), "app").unwrap();
        assert!(pg.contains("pg_dump -d app"));
        assert!(dump_command(&mysql(), "shop; rm -rf /").is_err());
        assert!(dump_command(&mysql(), "-eSHUTDOWN").is_err() && dump_command(&mysql(), "$ZP").is_err());
        let s = dump_command(&Instance::sqlite("/srv/app/db.sqlite", None), "main").unwrap();
        assert!(s.ends_with("sqlite3 '/srv/app/db.sqlite' .dump") && s.starts_with("IFS= read -r ZU"), "{s}");
    }

    #[test]
    fn backup_names() {
        assert!(valid_backup_name("shop-2026-09-30_1402.sql.gz") && valid_backup_name("import.sql"));
        assert!(
            !valid_backup_name("../etc/passwd.sql")
                && !valid_backup_name("a b.sql")
                && !valid_backup_name(".cache.sql")
                && !valid_backup_name("x.txt")
        );
    }

    #[test]
    fn user_sql_is_quoted() {
        let steps = create_user_sql(Engine::Mysql, "app", "%", "p'ass\\word", Some("shop")).unwrap();
        assert_eq!(steps.len(), 1);
        let sql = &steps[0].1;
        assert!(sql.contains("CREATE USER 'app'@'%' IDENTIFIED BY 'p''ass\\\\word'"), "{sql}");
        assert!(sql.contains("GRANT ALL PRIVILEGES ON `shop`.* TO 'app'@'%'"));
        let pg = create_user_sql(Engine::Postgres, "app", "", "secret-123", Some("shop")).unwrap();
        assert_eq!(pg.len(), 3);
        assert_eq!(pg[2].0.as_deref(), Some("shop"), "droits du schéma public donnés dans la base elle-même");
        assert!(create_user_sql(Engine::Mysql, "app'--", "%", "secret-123", None).is_err());
        assert!(create_user_sql(Engine::Mysql, "app", "%", "court", None).is_err());
        assert!(drop_user_sql(Engine::Mysql, "root", "localhost").is_err(), "compte système protégé");
        assert_eq!(kill_sql(Engine::Postgres, 42, false).unwrap(), "SELECT pg_cancel_backend(42)");
        assert_eq!(kill_sql(Engine::Mysql, 7, true).unwrap(), "KILL 7");
    }
}
