//! Bases de données MySQL/MariaDB, PostgreSQL et SQLite du serveur : découverte, exploration et
//! exécution de SQL, en passant par les clients en ligne de commande (`mysql`, `psql`, `sqlite3`).
//!
//! Le SQL est transmis sur l'entrée standard et les mots de passe ne sont jamais écrits dans une
//! ligne de commande : pour un conteneur, ils sont lus dans son propre environnement
//! (`MYSQL_ROOT_PASSWORD`, `POSTGRES_USER`) ; en local, l'authentification passe par le socket
//! (`sudo mysql`, `sudo -u postgres psql`).

use serde::{Deserialize, Serialize};

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    /// MySQL, MariaDB ou Percona.
    Mysql,
    Postgres,
    /// Fichier SQLite ouvert sur le serveur avec `sqlite3`.
    Sqlite,
}

impl Engine {
    pub fn label(self) -> &'static str {
        match self {
            Engine::Mysql => "MySQL / MariaDB",
            Engine::Postgres => "PostgreSQL",
            Engine::Sqlite => "SQLite",
        }
    }

    /// Moteur correspondant à une image Docker, le cas échéant.
    pub fn from_image(image: &str) -> Option<Engine> {
        let i = image.to_ascii_lowercase();
        let name = i.rsplit('/').next().unwrap_or(&i);
        if name.starts_with("mysql") || name.starts_with("mariadb") || name.starts_with("percona") {
            Some(Engine::Mysql)
        } else if name.starts_with("postgres")
            || name.starts_with("timescale")
            || name.starts_with("pgvector")
            || name.starts_with("supabase/postgres")
        {
            Some(Engine::Postgres)
        } else {
            None
        }
    }
}

/// Instance de base de données : un conteneur Docker, ou le service installé sur le serveur.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    /// `container:<nom>` ou `local:mysql` / `local:postgres`.
    pub id: String,
    pub label: String,
    pub engine: Engine,
    /// Conteneur Docker, ou `None` pour le service installé sur le serveur.
    pub container: Option<String>,
    /// Version rapportée par le serveur de base de données.
    #[serde(default)]
    pub version: String,
    /// Chemin du fichier pour SQLite ; vide pour les autres moteurs.
    #[serde(default)]
    pub path: String,
    /// Compte enregistré dans Zenytt pour cette instance (keyring), ajouté côté application juste
    /// avant la requête : jamais reçu de l'interface ni renvoyé vers elle.
    #[serde(skip)]
    pub login: Option<Login>,
}

/// Identifiants d'une instance, quand ceux du conteneur (variables d'environnement) ne suffisent pas.
#[derive(Clone, PartialEq, Deserialize)]
pub struct Login {
    pub user: String,
    pub password: String,
}

impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Login({}, ***)", self.user)
    }
}

/// Deux premières lignes de l'entrée du client : utilisateur et mot de passe (vides : ceux du
/// conteneur ou du socket). Ils ne passent ainsi jamais par une ligne de commande.
pub fn login_prefix(login: Option<&Login>) -> Result<String> {
    match login {
        None => Ok("\n\n".into()),
        Some(l) => {
            if l.user.is_empty() || l.user.len() > 80 || !l.user.chars().all(|c| c.is_ascii_alphanumeric() || "_-.@".contains(c)) {
                return Err(Error::Other("nom d'utilisateur de base invalide".into()));
            }
            if l.password.contains(['\n', '\r']) {
                return Err(Error::Other("le mot de passe ne peut pas contenir de retour à la ligne".into()));
            }
            Ok(format!("{}\n{}\n", l.user, l.password))
        }
    }
}

/// Script lancé dans un conteneur MySQL/MariaDB : lit le compte sur ses deux premières lignes
/// d'entrée, sinon le prend dans l'environnement du conteneur (mot de passe root, sa variante
/// `_FILE`, puis le compte applicatif `MYSQL_USER`). Le mot de passe passe par `MYSQL_PWD` : le
/// client ne le demande jamais (une invite lirait la requête comme mot de passe).
pub(crate) const MYSQL_CONTAINER_SCRIPT: &str = r#"C=$(command -v mysql || command -v mariadb); IFS= read -r ZU; IFS= read -r ZP
if [ -z "$ZU" ]; then
  ZU=root; ZP="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; F="${MYSQL_ROOT_PASSWORD_FILE:-$MARIADB_ROOT_PASSWORD_FILE}"
  if [ -z "$ZP" ] && [ -n "$F" ] && [ -r "$F" ]; then ZP=$(cat "$F"); fi
  if [ -z "$ZP" ] && [ -z "$MYSQL_ALLOW_EMPTY_PASSWORD$MARIADB_ALLOW_EMPTY_ROOT_PASSWORD" ] && [ -n "$MYSQL_USER$MARIADB_USER" ]; then
    ZU="${MYSQL_USER:-$MARIADB_USER}"; ZP="${MYSQL_PASSWORD:-$MARIADB_PASSWORD}"; F="${MYSQL_PASSWORD_FILE:-$MARIADB_PASSWORD_FILE}"
    if [ -z "$ZP" ] && [ -n "$F" ] && [ -r "$F" ]; then ZP=$(cat "$F"); fi
  fi
fi
export MYSQL_PWD="$ZP"
"#;

/// Argument « base » du client MySQL : entre apostrophes, absent si aucune base n'est choisie.
pub(crate) fn mysql_db_arg(database: &str) -> String {
    if database.is_empty() { String::new() } else { format!(" {}", shell_quote(database)) }
}

/// Script complet (client compris) exécuté dans un conteneur MySQL pour une base.
pub(crate) fn mysql_container_script(database: &str) -> String {
    format!("{MYSQL_CONTAINER_SCRIPT}exec \"$C\" --batch --raw --unbuffered -u\"$ZU\"{}", mysql_db_arg(database))
}

impl Instance {
    /// Instance d'un moteur serveur (conteneur Docker ou service local).
    pub fn server(id: impl Into<String>, label: impl Into<String>, engine: Engine, container: Option<String>) -> Instance {
        Instance { id: id.into(), label: label.into(), engine, container, version: String::new(), path: String::new(), login: None }
    }

    /// Instance SQLite : un fichier sur le serveur, éventuellement dans un conteneur.
    pub fn sqlite(path: impl Into<String>, container: Option<String>) -> Instance {
        let path = path.into();
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        Instance {
            id: match &container {
                Some(c) => format!("sqlite:{c}:{path}"),
                None => format!("sqlite:{path}"),
            },
            label: format!("{name} (SQLite)"),
            engine: Engine::Sqlite,
            container,
            version: String::new(),
            path,
            login: None,
        }
    }
}

/// Nom d'objet SQL acceptable dans une commande (base, table) : pas d'injection possible, pas
/// d'expansion shell (`$`) et jamais une option (`-eSHUTDOWN`).
pub fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.starts_with('-') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

pub(crate) fn check(instance: &Instance, database: Option<&str>) -> Result<()> {
    if let Some(c) = &instance.container {
        if !safe_name(c) {
            return Err(Error::Other("nom de conteneur invalide".into()));
        }
    }
    if let Some(d) = database {
        if !safe_name(d) {
            return Err(Error::Other(format!("nom de base invalide : {d}")));
        }
    }
    if instance.engine == Engine::Sqlite && !safe_file_path(&instance.path) {
        return Err(Error::Other("chemin de fichier SQLite invalide".into()));
    }
    Ok(())
}

/// Chemin de fichier acceptable pour SQLite. Le chemin est de toute façon passé entre apostrophes
/// (`shell_quote`), mais un chemin relatif ou contenant un retour à la ligne n'a aucun sens ici et
/// signale une erreur d'appel plutôt qu'un fichier réel.
pub fn safe_file_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= 4096 && !path.chars().any(char::is_control)
}

/// Commande shell qui lit le SQL sur son entrée standard et écrit le résultat sur stdout.
/// MySQL sort en mode « batch » (tabulations, valeurs échappées), PostgreSQL en CSV.
pub(crate) fn client_command(instance: &Instance, database: Option<&str>, limit: Option<usize>) -> Result<String> {
    check(instance, database)?;
    // L'entrée commence toujours par deux lignes (compte enregistré dans Zenytt, ou vides : voir
    // `login_prefix`), lues ici avant que le client ne reçoive le SQL.
    const SKIP_LOGIN: &str = "IFS= read -r ZU; IFS= read -r ZP;";
    let db = database.unwrap_or("");
    let mut cmd = match (instance.engine, &instance.container) {
        (Engine::Mysql, Some(c)) => format!("docker exec -i {c} sh -c {}", shell_quote(&mysql_container_script(db))),
        // Service local : socket en root, sauf si un compte est enregistré.
        (Engine::Mysql, None) => format!(
            "{SKIP_LOGIN} C=$(command -v mysql || command -v mariadb); if [ -n \"$ZU\" ]; then export MYSQL_PWD=\"$ZP\"; set -- -u\"$ZU\"; fi; \"$C\" --batch --raw --unbuffered \"$@\"{}", mysql_db_arg(db)
        ),
        (Engine::Postgres, Some(c)) => {
            let script = format!(
                "{SKIP_LOGIN} [ -n \"$ZU\" ] || ZU=\"${{POSTGRES_USER:-postgres}}\"; [ -n \"$ZP\" ] && export PGPASSWORD=\"$ZP\"; exec psql -U \"$ZU\" -d {} --csv -q -v ON_ERROR_STOP=1",
                database.unwrap_or("postgres")
            );
            format!("docker exec -i {c} sh -c {}", shell_quote(&script))
        }
        (Engine::Postgres, None) => {
            let d = database.unwrap_or("postgres");
            format!(
                "{SKIP_LOGIN} if [ -n \"$ZU\" ]; then PGPASSWORD=\"$ZP\" psql -h 127.0.0.1 -U \"$ZU\" -d {d} --csv -q -v ON_ERROR_STOP=1; else su -s /bin/sh postgres -c 'psql -d {d} --csv -q -v ON_ERROR_STOP=1'; fi"
            )
        }
        // SQLite n'a ni serveur ni utilisateur : le « nom de base » est le fichier lui-même.
        // `-bail` arrête au premier message d'erreur, sinon sqlite3 continue et renvoie 0.
        (Engine::Sqlite, Some(c)) => format!("{SKIP_LOGIN} docker exec -i {c} sqlite3 -batch -bail -csv -header {}", shell_quote(&instance.path)),
        (Engine::Sqlite, None) => format!("{SKIP_LOGIN} sqlite3 -batch -bail -csv -header {}", shell_quote(&instance.path)),
    };
    if let Some(n) = limit {
        // Une ligne de plus que demandé : elle signale un résultat tronqué.
        cmd = format!("{{ {cmd} ; }} | head -n {}", n + 2);
    }
    Ok(cmd)
}

/// Exécute du SQL sur l'instance et renvoie la sortie brute du client.
pub(crate) async fn run_sql(
    conn: &Connection,
    sudo: Option<&str>,
    instance: &Instance,
    database: Option<&str>,
    sql: &str,
    limit: Option<usize>,
) -> Result<String> {
    let cmd = client_command(instance, database, limit)?;
    let input = format!("{}{}\n", login_prefix(instance.login.as_ref())?, sql.trim_end().trim_end_matches(';'));
    // Le service local n'est joignable qu'en root (socket) ; un conteneur passe par Docker, qui
    // peut lui aussi demander sudo.
    let out = conn.exec_sudo(&cmd, sudo, Some(input.as_bytes())).await?;
    // Avec la limite de lignes, la commande se termine par `head` : son code de sortie masque
    // celui du client. L'erreur se lit donc dans stderr, une fois les avertissements écartés.
    let problem = real_errors(&out.stderr);
    if !problem.is_empty() && out.stdout.trim().is_empty() {
        return Err(Error::Remote(problem));
    }
    if !out.success() && out.stdout.trim().is_empty() {
        return Err(Error::Remote(if problem.is_empty() { "la requête a échoué".into() } else { problem }));
    }
    Ok(out.stdout)
}

/// Erreurs du client, sans ses avertissements habituels (mot de passe sur la ligne de commande…).
pub fn real_errors(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.contains("[Warning]") && !l.contains("Using a password on the command line"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// Lignes de valeurs ; `None` représente NULL.
    pub rows: Vec<Vec<Option<String>>>,
    /// Vrai si la limite d'affichage a coupé le résultat.
    pub truncated: bool,
    /// Durée d'exécution mesurée par Zenytt (aller-retour SSH compris), en millisecondes.
    pub duration_ms: u64,
}

/// Sortie « batch » de mysql : en-tête puis lignes, séparées par des tabulations.
/// Les valeurs échappent `\t`, `\n` et `\\`, et NULL s'écrit `NULL`.
pub fn parse_mysql(out: &str) -> QueryResult {
    let mut lines = out.split('\n').filter(|l| !l.is_empty());
    let Some(header) = lines.next() else { return QueryResult::default() };
    let unescape = |v: &str| {
        if v == "NULL" {
            return None;
        }
        let mut s = String::with_capacity(v.len());
        let mut chars = v.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                s.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => s.push('\n'),
                Some('t') => s.push('\t'),
                Some('r') => s.push('\r'),
                Some('0') => s.push('\0'),
                Some(other) => s.push(other),
                None => s.push('\\'),
            }
        }
        Some(s)
    };
    QueryResult {
        columns: header.split('\t').map(str::to_string).collect(),
        rows: lines.map(|l| l.split('\t').map(unescape).collect()).collect(),
        truncated: false,
        duration_ms: 0,
    }
}

/// Sortie CSV de psql (`--csv`) : guillemets doublés, valeur vide non citée = NULL.
pub fn parse_csv(out: &str) -> QueryResult {
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let (mut row, mut field, mut quoted, mut was_quoted) = (Vec::new(), String::new(), false, false);
    let mut chars = out.chars().peekable();
    let end_field = |row: &mut Vec<Option<String>>, field: &mut String, was_quoted: &mut bool| {
        row.push(if field.is_empty() && !*was_quoted { None } else { Some(std::mem::take(field)) });
        *was_quoted = false;
    };
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                was_quoted = true;
            }
            ',' => end_field(&mut row, &mut field, &mut was_quoted),
            '\r' => {}
            '\n' => {
                end_field(&mut row, &mut field, &mut was_quoted);
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        end_field(&mut row, &mut field, &mut was_quoted);
        rows.push(row);
    }
    if rows.is_empty() {
        return QueryResult::default();
    }
    let columns = rows.remove(0).into_iter().map(|c| c.unwrap_or_default()).collect();
    QueryResult { columns, rows, truncated: false, duration_ms: 0 }
}

pub(crate) fn parse(engine: Engine, out: &str) -> QueryResult {
    match engine {
        Engine::Mysql => parse_mysql(out),
        Engine::Postgres | Engine::Sqlite => parse_csv(out),
    }
}

/// Première instruction SQL : `SELECT`, `INSERT`… en majuscules, commentaires ignorés.
pub fn first_keyword(sql: &str) -> String {
    let mut text = sql.trim_start();
    loop {
        if let Some(rest) = text.strip_prefix("--") {
            text = rest.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(rest) = text.strip_prefix("/*") {
            text = rest.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ';').find(|w| !w.is_empty()).unwrap_or("").to_ascii_uppercase()
}

/// Mots qui, où qu'ils soient dans la requête, peuvent modifier quelque chose : `WITH x AS
/// (DELETE … RETURNING *) SELECT …`, `SELECT … INTO OUTFILE`, `EXPLAIN ANALYZE UPDATE…`. La liste
/// est volontairement large : un faux positif coûte une confirmation, un faux négatif une
/// modification non journalisée.
const WRITE_WORDS: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "MERGE",
    "REPLACE",
    "UPSERT",
    "CALL",
    "DO",
    "COPY",
    "LOCK",
    "RENAME",
    "VACUUM",
    "REINDEX",
    "CLUSTER",
    "REFRESH",
    "IMPORT",
    "LOAD",
    "HANDLER",
    "INTO",
    "OUTFILE",
    "DUMPFILE",
    "SET",
    "RESET",
    "KILL",
    "SHUTDOWN",
    "FLUSH",
    "PURGE",
    "INSTALL",
    "UNINSTALL",
    "COMMENT",
    "SECURITY",
    "DISCARD",
    "NOTIFY",
    "PREPARE",
    "EXECUTE",
    "EXEC",
    "DEALLOCATE",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "START",
    "ATTACH",
    "DETACH",
    "PRAGMA",
];

/// Requête sans commentaires, chaînes ni identifiants entre guillemets (remplacés par des espaces) :
/// il ne reste que les mots-clés et les noms nus.
fn sql_skeleton(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        // `#` n'est pas traité comme un commentaire : c'en est un pour MySQL, mais un opérateur
        // pour PostgreSQL, où l'ignorer masquerait la suite de la ligne (`SELECT 1 # 2; DROP …`).
        if c == '-' && next == Some('-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else if matches!(c, '\'' | '"' | '`') {
            i += 1;
            // L'antislash n'est pas lu comme un échappement : il l'est pour MySQL, pas pour
            // PostgreSQL. Le lire ainsi prolongerait la chaîne au-delà de sa vraie fin et y cacherait
            // une instruction ; l'ignorer ne peut que la raccourcir, donc signaler un mot de trop.
            while i < chars.len() {
                if chars[i] == c {
                    // Guillemet doublé : caractère échappé, la chaîne continue.
                    if chars.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
        } else if c == '$' {
            // Chaîne PostgreSQL `$$…$$` ou `$balise$…$balise$`.
            let tag_end = chars[i + 1..].iter().position(|&x| !(x.is_alphanumeric() || x == '_')).map(|p| i + 1 + p);
            match tag_end.filter(|&e| chars[e] == '$') {
                Some(e) => {
                    let tag: String = chars[i..=e].iter().collect();
                    let body: String = chars[e + 1..].iter().collect();
                    let skip = body.find(&tag).map(|p| body[..p].chars().count() + tag.chars().count()).unwrap_or(body.chars().count());
                    i = e + 1 + skip;
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            }
        } else {
            out.push(c);
            i += 1;
            continue;
        }
        out.push(' ');
    }
    out
}

/// Une requête qui ne fait que lire ? Les autres demandent confirmation dans l'interface et sont
/// inscrites au journal d'actions. Une seule instruction, commençant par un mot de lecture, sans
/// aucun mot d'écriture nulle part (sous-requêtes et CTE comprises).
pub fn is_read_only(sql: &str) -> bool {
    let skeleton = sql_skeleton(sql);
    let statements: Vec<&str> = skeleton.split(';').filter(|s| !s.trim().is_empty()).collect();
    let [only] = statements.as_slice() else { return false };
    let words: Vec<String> =
        only.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).map(str::to_ascii_uppercase).collect();
    let starts_read = matches!(
        words.first().map(String::as_str),
        Some("SELECT" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "WITH" | "TABLE" | "VALUES" | "ANALYZE")
    );
    starts_read && !words.iter().any(|w| WRITE_WORDS.contains(&w.as_str()))
}

/// Exécute une requête libre et renvoie ses lignes (au plus `limit`).
pub async fn query(
    conn: &Connection,
    sudo: Option<&str>,
    instance: &Instance,
    database: Option<&str>,
    sql: &str,
    limit: usize,
) -> Result<QueryResult> {
    if sql.trim().is_empty() {
        return Err(Error::Other("requête vide".into()));
    }
    let started = std::time::Instant::now();
    let out = crate::ssh::long(run_sql(conn, sudo, instance, database, sql, Some(limit))).await?;
    let mut result = parse(instance.engine, &out);
    if result.rows.len() > limit {
        result.rows.truncate(limit);
        result.truncated = true;
    }
    result.duration_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

const MYSQL_DATABASES: &str = "SELECT s.schema_name AS nom, \
     COALESCE(SUM(t.data_length + t.index_length), 0) AS taille, \
     COUNT(t.table_name) AS tables \
     FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name \
     GROUP BY s.schema_name ORDER BY s.schema_name";

const PG_DATABASES: &str = "SELECT datname AS nom, pg_database_size(datname) AS taille, 0 AS tables \
     FROM pg_database WHERE NOT datistemplate ORDER BY datname";

const MYSQL_TABLES: &str = "SELECT table_name AS nom, COALESCE(table_rows, 0) AS lignes, \
     COALESCE(data_length + index_length, 0) AS taille FROM information_schema.tables \
     WHERE table_schema = DATABASE() ORDER BY table_name";

/// SQLite ne tient aucune statistique de taille par table : seuls les noms sont connus.
const SQLITE_TABLES: &str = "SELECT name AS nom, 0 AS lignes, 0 AS taille FROM sqlite_master \
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

/// Hors du schéma `public` (pg-boss, extensions…), le nom est préfixé par son schéma : sans lui,
/// la table est introuvable (« relation does not exist »).
const PG_TABLES: &str = "SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS nom, \
     COALESCE(s.n_live_tup, 0) AS lignes, \
     pg_total_relation_size(c.oid) AS taille \
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' \
     ORDER BY n.nspname <> 'public', 1";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub name: String,
    /// Taille sur disque en octets (estimation du moteur).
    pub size: u64,
    /// Nombre de tables (base) ou de lignes (table), estimé.
    pub count: u64,
}

fn to_named(r: &QueryResult) -> Vec<Named> {
    r.rows
        .iter()
        .filter_map(|row| {
            let get = |i: usize| row.get(i).cloned().flatten().unwrap_or_default();
            let name = get(0);
            (!name.is_empty()).then(|| Named { name, size: get(1).parse().unwrap_or(0), count: get(2).parse().unwrap_or(0) })
        })
        .collect()
}

/// Nom de base acceptable : lettres, chiffres, tiret bas et tiret. Tout le reste est refusé plutôt
/// qu'échappé, car un nom de base ne peut pas être passé en paramètre lié.
pub fn valid_db_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 63 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Crée une base vide. L'encodage est fixé à UTF-8 pour éviter les surprises d'un serveur ancien.
pub async fn create_database(conn: &Connection, sudo: Option<&str>, instance: &Instance, name: &str) -> Result<()> {
    if !valid_db_name(name) {
        return Err(Error::Other("nom de base invalide : lettres, chiffres, « _ » et « - » seulement".into()));
    }
    let sql = match instance.engine {
        Engine::Mysql => format!("CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"),
        Engine::Postgres => format!("CREATE DATABASE \"{name}\" ENCODING 'UTF8'"),
        Engine::Sqlite => return Err(Error::Other("un fichier SQLite ne contient qu'une seule base".into())),
    };
    let out = run_sql(conn, sudo, instance, None, &sql, None).await?;
    let lower = out.to_lowercase();
    if lower.contains("error") || lower.contains("échec") {
        return Err(Error::Other(out.trim().to_string()));
    }
    Ok(())
}

/// Bases de l'instance, avec leur taille.
pub async fn databases(conn: &Connection, sudo: Option<&str>, instance: &Instance) -> Result<Vec<Named>> {
    let sql = match instance.engine {
        Engine::Mysql => MYSQL_DATABASES,
        Engine::Postgres => PG_DATABASES,
        // Un fichier SQLite est lui-meme la base : il n'y a rien a lister.
        Engine::Sqlite => return Ok(vec![Named { name: "main".into(), size: 0, count: 0 }]),
    };
    let out = run_sql(conn, sudo, instance, None, sql, Some(500)).await?;
    Ok(to_named(&parse(instance.engine, &out)))
}

/// Tables d'une base, avec leur taille et un nombre de lignes estimé.
pub async fn tables(conn: &Connection, sudo: Option<&str>, instance: &Instance, database: &str) -> Result<Vec<Named>> {
    let sql = match instance.engine {
        Engine::Mysql => MYSQL_TABLES,
        Engine::Postgres => PG_TABLES,
        Engine::Sqlite => SQLITE_TABLES,
    };
    let out = run_sql(conn, sudo, instance, Some(database), sql, Some(2000)).await?;
    Ok(to_named(&parse(instance.engine, &out)))
}

/// Requête d'aperçu du contenu d'une table (identifiant vérifié, jamais concaténé sans contrôle).
pub fn preview_query(engine: Engine, table: &str, limit: usize) -> Result<String> {
    if !safe_name(table) {
        return Err(Error::Other("nom de table invalide".into()));
    }
    Ok(format!("SELECT * FROM {} LIMIT {limit}", quote_ident(engine, table)?))
}

/// Version du serveur de base de données, pour l'affichage.
pub async fn version(conn: &Connection, sudo: Option<&str>, instance: &Instance) -> String {
    let sql = match instance.engine {
        Engine::Mysql => "SELECT VERSION()",
        Engine::Postgres => "SHOW server_version",
        Engine::Sqlite => "SELECT sqlite_version()",
    };
    match run_sql(conn, sudo, instance, None, sql, Some(2)).await {
        Ok(out) => parse(instance.engine, &out).rows.first().and_then(|r| r.first().cloned()).flatten().unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Instances installées directement sur le serveur (hors Docker).
///
/// Les processus des conteneurs sont visibles depuis l'hôte : un `mysqld` ou un `postgres` dont le
/// cgroup est celui d'un conteneur (docker, containerd, podman, kubernetes) n'est pas un service
/// local. Il faut aussi de quoi s'y connecter : le client `mysql`, ou l'utilisateur `postgres`.
pub const LOCAL_PROBE: &str = r#"host() { ! grep -qE 'docker|containerd|libpod|kubepods' "/proc/$p/cgroup" 2>/dev/null; }
for p in $(pgrep -x mysqld; pgrep -x mariadbd); do
  if host && { command -v mysql >/dev/null 2>&1 || command -v mariadb >/dev/null 2>&1; }; then echo mysql; break; fi
done
for p in $(pgrep -x postgres); do
  if host && id postgres >/dev/null 2>&1; then echo postgres; break; fi
done
true"#;

pub fn parse_local(out: &str) -> Vec<Instance> {
    out.lines()
        .filter_map(|l| match l.trim() {
            "mysql" => Some(Instance::server("local:mysql", "MySQL / MariaDB (serveur)", Engine::Mysql, None)),
            "postgres" => Some(Instance::server("local:postgres", "PostgreSQL (serveur)", Engine::Postgres, None)),
            _ => None,
        })
        .collect()
}

/// Colonne d'une table, telle que la décrit le moteur.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// Type déclaré (`int(11)`, `character varying(255)`, `TEXT`…).
    pub data_type: String,
    pub nullable: bool,
    /// Fait partie de la clé primaire de la table.
    pub primary: bool,
}

const MYSQL_COLUMNS: &str = "SELECT column_name, column_type, is_nullable, column_key \
     FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ";

const PG_COLUMNS: &str = "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
     CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, \
     CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary \
       AND a.attnum = ANY(i.indkey)) THEN 'PRI' ELSE '' END \
     FROM pg_attribute a WHERE a.attrelid = ";

/// Requête qui décrit les colonnes d'une table.
pub(crate) fn columns_query(engine: Engine, table: &str) -> Result<String> {
    Ok(match engine {
        Engine::Mysql => format!("{MYSQL_COLUMNS}{} ORDER BY ordinal_position", quote_literal(engine, table)),
        // `regclass` reçoit le nom cité (schéma compris) : `'"pgboss"."queue"'::regclass`.
        Engine::Postgres => format!(
            "{PG_COLUMNS}{}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            quote_literal(engine, &quote_ident(engine, table)?)
        ),
        // `PRAGMA table_info` ne suit pas la même disposition : cid, nom, type, notnull, défaut, pk.
        Engine::Sqlite => format!("PRAGMA table_info({})", quote_ident(Engine::Sqlite, table)?),
    })
}

/// Colonnes d'une table, avec le repérage de la clé primaire. C'est elle qui rend possible
/// l'édition d'une cellule : sans clé primaire, aucune ligne n'est identifiable de façon sûre.
pub async fn columns(
    conn: &Connection,
    sudo: Option<&str>,
    instance: &Instance,
    database: Option<&str>,
    table: &str,
) -> Result<Vec<Column>> {
    if !safe_name(table) {
        return Err(Error::Other("nom de table invalide".into()));
    }
    let sql = columns_query(instance.engine, table)?;
    let out = run_sql(conn, sudo, instance, database, &sql, Some(2000)).await?;
    let r = parse(instance.engine, &out);
    let get = |row: &Vec<Option<String>>, i: usize| row.get(i).cloned().flatten().unwrap_or_default();
    Ok(r.rows
        .iter()
        .filter_map(|row| {
            if instance.engine == Engine::Sqlite {
                let name = get(row, 1);
                return (!name.is_empty()).then(|| Column {
                    name,
                    data_type: get(row, 2),
                    nullable: get(row, 3) != "1",
                    primary: get(row, 5) != "0" && !get(row, 5).is_empty(),
                });
            }
            let name = get(row, 0);
            (!name.is_empty()).then(|| Column {
                name,
                data_type: get(row, 1),
                nullable: get(row, 2).eq_ignore_ascii_case("YES"),
                primary: get(row, 3) == "PRI",
            })
        })
        .collect())
}

/// Identifiant SQL cité pour le moteur. Le nom est d'abord validé : un nom refusé n'est jamais
/// échappé « au mieux », il fait échouer l'opération.
///
/// `schéma.table` (tables hors du schéma par défaut, comme celles de pg-boss) donne deux
/// identifiants cités séparément : `"pgboss"."queue"`, et non `"pgboss.queue"`.
pub fn quote_ident(engine: Engine, name: &str) -> Result<String> {
    let parts: Vec<&str> = name.split('.').collect();
    if !safe_name(name) || parts.len() > 2 || parts.iter().any(|p| p.is_empty()) {
        return Err(Error::Other(format!("nom d'objet invalide : {name}")));
    }
    Ok(parts
        .iter()
        .map(|p| match engine {
            Engine::Mysql => format!("`{p}`"),
            Engine::Postgres | Engine::Sqlite => format!("\"{p}\""),
        })
        .collect::<Vec<_>>()
        .join("."))
}

/// Chaîne SQL citée. MySQL traite la barre oblique inverse comme un caractère d'échappement dans
/// les littéraux (sauf en mode `NO_BACKSLASH_ESCAPES`) : elle doit donc être doublée, alors que
/// PostgreSQL et SQLite la prennent au pied de la lettre.
pub fn quote_literal(engine: Engine, value: &str) -> String {
    let escaped = match engine {
        Engine::Mysql => value.replace('\\', "\\\\").replace('\'', "''"),
        Engine::Postgres | Engine::Sqlite => value.replace('\'', "''"),
    };
    format!("'{escaped}'")
}

/// Valeur d'une cellule dans une requête : `NULL` sans guillemets, sinon une chaîne citée. Le
/// moteur convertit lui-même la chaîne vers le type de la colonne (entier, date…).
fn value_sql(engine: Engine, value: Option<&str>) -> String {
    match value {
        None => "NULL".into(),
        Some(v) => quote_literal(engine, v),
    }
}

/// Sens du tri d'une colonne.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

/// Condition posée sur une colonne depuis l'en-tête du tableau.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    /// Opérateur choisi dans la liste fermée de [`filter_operators`].
    pub op: String,
    /// Valeur comparée ; ignorée par `IS NULL` et `IS NOT NULL`.
    #[serde(default)]
    pub value: String,
}

/// Opérateurs acceptés dans un filtre de colonne. La liste est fermée : tout autre opérateur est
/// refusé, ce qui interdit d'injecter du SQL par ce champ.
pub fn filter_operators() -> &'static [&'static str] {
    &["=", "!=", "<", "<=", ">", ">=", "LIKE", "NOT LIKE", "IS NULL", "IS NOT NULL"]
}

fn filter_sql(engine: Engine, f: &Filter) -> Result<String> {
    let op = f.op.trim().to_ascii_uppercase();
    let op = filter_operators()
        .iter()
        .find(|o| **o == op || **o == f.op.trim())
        .ok_or_else(|| Error::Other(format!("opérateur refusé : {}", f.op)))?;
    let col = quote_ident(engine, &f.column)?;
    Ok(match *op {
        "IS NULL" => format!("{col} IS NULL"),
        "IS NOT NULL" => format!("{col} IS NOT NULL"),
        // LIKE sur une colonne numérique échoue sur PostgreSQL : la colonne est convertie en texte.
        "LIKE" | "NOT LIKE" if engine == Engine::Postgres => {
            format!("{col}::text {op} {}", quote_literal(engine, &f.value))
        }
        _ => format!("{col} {op} {}", quote_literal(engine, &f.value)),
    })
}

/// Requête de consultation d'une table avec tri et filtres posés depuis l'en-tête des colonnes.
/// Tout identifiant est validé et cité ; aucune partie ne vient telle quelle de l'interface.
pub fn table_query(
    engine: Engine,
    table: &str,
    filters: &[Filter],
    sort: Option<(&str, SortDir)>,
    limit: usize,
    offset: usize,
) -> Result<String> {
    let mut sql = format!("SELECT * FROM {}", quote_ident(engine, table)?);
    if !filters.is_empty() {
        let conditions = filters.iter().map(|f| filter_sql(engine, f)).collect::<Result<Vec<_>>>()?;
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    if let Some((col, dir)) = sort {
        sql.push_str(&format!(" ORDER BY {} {}", quote_ident(engine, col)?, if dir == SortDir::Desc { "DESC" } else { "ASC" }));
    }
    sql.push_str(&format!(" LIMIT {limit}"));
    if offset > 0 {
        sql.push_str(&format!(" OFFSET {offset}"));
    }
    Ok(sql)
}

/// Colonne et valeur qui identifient une ligne : la clé primaire lue dans le résultat affiché.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyPart {
    pub column: String,
    /// `None` pour une clé NULL, qui est refusée : elle n'identifie rien.
    pub value: Option<String>,
}

/// Clause `WHERE` qui désigne exactement une ligne. Une clé vide ou partiellement NULL est refusée
/// plutôt que traduite : c'est la seule protection contre un `UPDATE` qui toucherait toute la table.
fn where_key(engine: Engine, key: &[KeyPart]) -> Result<String> {
    if key.is_empty() {
        return Err(Error::Other("aucune clé primaire : cette ligne ne peut pas être modifiée en place".into()));
    }
    let mut parts = Vec::with_capacity(key.len());
    for k in key {
        let Some(value) = &k.value else {
            return Err(Error::Other(format!("clé primaire NULL sur « {} » : ligne non identifiable", k.column)));
        };
        parts.push(format!("{} = {}", quote_ident(engine, &k.column)?, quote_literal(engine, value)));
    }
    Ok(parts.join(" AND "))
}

/// MySQL accepte `LIMIT 1` sur `UPDATE` et `DELETE` : une borne de plus, au cas où la clé fournie
/// ne serait pas réellement unique. PostgreSQL ne le permet pas.
fn limit_one(engine: Engine) -> &'static str {
    match engine {
        Engine::Mysql => " LIMIT 1",
        Engine::Postgres | Engine::Sqlite => "",
    }
}

/// `UPDATE` d'une seule cellule, prêt à être montré à l'utilisateur avant exécution.
pub fn update_cell_sql(engine: Engine, table: &str, column: &str, value: Option<&str>, key: &[KeyPart]) -> Result<String> {
    Ok(format!(
        "UPDATE {} SET {} = {} WHERE {}{}",
        quote_ident(engine, table)?,
        quote_ident(engine, column)?,
        value_sql(engine, value),
        where_key(engine, key)?,
        limit_one(engine),
    ))
}

/// `DELETE` d'une seule ligne, désignée par sa clé primaire.
pub fn delete_row_sql(engine: Engine, table: &str, key: &[KeyPart]) -> Result<String> {
    Ok(format!("DELETE FROM {} WHERE {}{}", quote_ident(engine, table)?, where_key(engine, key)?, limit_one(engine)))
}

/// `INSERT` d'une ligne. Les colonnes laissées de côté prennent la valeur par défaut du moteur.
pub fn insert_row_sql(engine: Engine, table: &str, values: &[(String, Option<String>)]) -> Result<String> {
    if values.is_empty() {
        return Err(Error::Other("aucune valeur à insérer".into()));
    }
    let mut cols = Vec::with_capacity(values.len());
    let mut vals = Vec::with_capacity(values.len());
    for (c, v) in values {
        cols.push(quote_ident(engine, c)?);
        vals.push(value_sql(engine, v.as_deref()));
    }
    Ok(format!("INSERT INTO {} ({}) VALUES ({})", quote_ident(engine, table)?, cols.join(", "), vals.join(", ")))
}

/// Exécute une instruction d'écriture (pas de lignes à lire) et renvoie le message du moteur.
pub async fn execute(conn: &Connection, sudo: Option<&str>, instance: &Instance, database: Option<&str>, sql: &str) -> Result<String> {
    let out = crate::ssh::long(run_sql(conn, sudo, instance, database, sql, None)).await?;
    Ok(out.trim().to_string())
}

/// Cherche les fichiers SQLite du serveur dans les emplacements habituels. La recherche est bornée
/// (profondeur et dossiers) : un `find /` sur un serveur chargé peut durer des minutes.
pub const SQLITE_PROBE: &str = "command -v sqlite3 >/dev/null 2>&1 || exit 0\n\
     for d in /opt /srv /var/lib /var/www /home /root /data; do [ -d \"$d\" ] && \
       find \"$d\" -maxdepth 5 -type f \\( -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' \\) \
       -size -2G 2>/dev/null; done | head -n 60\n\
     true";

/// Fichiers SQLite retenus : les chemins renvoyés par [`SQLITE_PROBE`], dédoublonnés.
pub fn parse_sqlite(out: &str) -> Vec<Instance> {
    let mut seen = std::collections::HashSet::new();
    out.lines()
        .map(str::trim)
        .filter(|l| safe_file_path(l))
        .filter(|l| seen.insert(l.to_string()))
        .map(|l| Instance::sqlite(l, None))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(engine: Engine, name: &str) -> Instance {
        Instance::server(format!("container:{name}"), name, engine, Some(name.into()))
    }

    #[test]
    fn engines_from_images() {
        assert_eq!(Engine::from_image("mariadb:11"), Some(Engine::Mysql));
        assert_eq!(Engine::from_image("docker.io/library/postgres:16-alpine"), Some(Engine::Postgres));
        assert_eq!(Engine::from_image("ghcr.io/moi/mysql-backup"), Some(Engine::Mysql));
        assert_eq!(Engine::from_image("nginx:alpine"), None);
    }

    #[test]
    fn commands_are_safe() {
        let cmd = client_command(&container(Engine::Mysql, "nexus-mysql"), Some("app"), Some(100)).unwrap();
        assert!(cmd.contains("docker exec -i nexus-mysql") && cmd.contains("MYSQL_ROOT_PASSWORD"));
        assert!(cmd.ends_with("| head -n 102"));
        assert!(!cmd.contains("-p'"), "aucun mot de passe en clair dans la commande");
        let pg = client_command(&container(Engine::Postgres, "pg"), Some("app"), None).unwrap();
        assert!(pg.contains("ZU=\"${POSTGRES_USER:-postgres}\"") && pg.contains("psql -U \"$ZU\" -d app --csv"), "{pg}");
        assert!(client_command(&container(Engine::Mysql, "db; rm -rf /"), None, None).is_err());
        assert!(client_command(&container(Engine::Mysql, "db"), Some("app; DROP"), None).is_err());
        // Une base ne peut être ni une option du client, ni une expansion shell.
        for bad in ["-eSHUTDOWN", "$ZP", "a$b"] {
            assert!(client_command(&container(Engine::Mysql, "db"), Some(bad), None).is_err(), "{bad}");
        }
        let local = client_command(&Instance::server("l", "l", Engine::Mysql, None), Some("app"), None).unwrap();
        assert!(local.ends_with("\"$@\" 'app'"), "{local}");
    }

    #[test]
    fn tables_outside_public_schema_are_qualified() {
        // pg-boss range ses tables dans le schéma « pgboss » : `"queue"` seul n'existe pas.
        assert!(PG_TABLES.contains("n.nspname || '.' || c.relname"));
        assert_eq!(quote_ident(Engine::Postgres, "pgboss.queue").unwrap(), "\"pgboss\".\"queue\"");
        assert_eq!(quote_ident(Engine::Postgres, "queue").unwrap(), "\"queue\"");
        assert_eq!(preview_query(Engine::Postgres, "pgboss.queue", 5).unwrap(), "SELECT * FROM \"pgboss\".\"queue\" LIMIT 5");
        assert!(columns_query(Engine::Postgres, "pgboss.queue").unwrap().contains("'\"pgboss\".\"queue\"'::regclass"));
        assert!(quote_ident(Engine::Postgres, "a.b.c").is_err() && quote_ident(Engine::Postgres, ".a").is_err());
    }

    #[test]
    fn local_probe_ignores_container_processes() {
        // Les processus des conteneurs sont visibles depuis l'hôte : sans ce filtre, un conteneur
        // postgres faisait apparaître un « PostgreSQL (serveur) » fantôme (su: user postgres does not exist).
        assert!(LOCAL_PROBE.contains("/proc/$p/cgroup") && LOCAL_PROBE.contains("docker"));
        assert!(LOCAL_PROBE.contains("id postgres"), "le service local suppose l'utilisateur postgres");
        assert!(LOCAL_PROBE.contains("command -v mysql"), "et un client mysql sur l'hôte");
    }

    #[test]
    fn mysql_never_prompts_for_a_password() {
        // `-p""` (variable vide) fait demander le mot de passe au client, qui lit alors la première
        // ligne de la requête : « Enter password: … Access denied ».
        let cmd = client_command(&container(Engine::Mysql, "nexus-mysql"), Some("app"), None).unwrap();
        assert!(!cmd.contains(" -p"), "{cmd}");
        assert!(cmd.contains("MYSQL_PWD") && cmd.contains("MYSQL_ROOT_PASSWORD_FILE") && cmd.contains("MYSQL_USER"));
        let local = client_command(&Instance::server("local:mysql", "m", Engine::Mysql, None), Some("app"), None).unwrap();
        assert!(!local.contains(" -p") && local.contains("MYSQL_PWD"));
    }

    #[test]
    fn login_goes_first_on_stdin() {
        assert_eq!(login_prefix(None).unwrap(), "\n\n");
        let l = Login { user: "app".into(), password: "s3cret".into() };
        assert_eq!(login_prefix(Some(&l)).unwrap(), "app\ns3cret\n");
        assert!(login_prefix(Some(&Login { user: "app".into(), password: "a\nb".into() })).is_err());
        assert!(login_prefix(Some(&Login { user: "a b".into(), password: "x".into() })).is_err());
    }

    /// Le script exécuté dans le conteneur choisit bien le compte, avec un faux client `mysql`.
    #[cfg(unix)]
    #[test]
    fn mysql_container_script_picks_credentials() {
        let dir = std::env::temp_dir().join(format!("zenytt-mysql-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("mysql");
        std::fs::write(&fake, "#!/bin/sh\necho \"PWD=$MYSQL_PWD ARGS=$*\"\n").unwrap();
        std::process::Command::new("chmod").arg("+x").arg(&fake).status().unwrap();
        let pwfile = dir.join("rootpw");
        std::fs::write(&pwfile, "depuis-fichier").unwrap();
        let run = |env: &[(&str, &str)], stdin: &str| {
            use std::io::Write;
            let mut cmd = std::process::Command::new("sh");
            cmd.arg("-c").arg(mysql_container_script("app")).env_clear().env("PATH", format!("{}:/usr/bin:/bin", dir.display()));
            for (k, v) in env {
                cmd.env(k, v);
            }
            let mut child = cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
            child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
        };
        assert!(run(&[("MYSQL_ROOT_PASSWORD", "r00t")], "\n\n").contains("PWD=r00t ARGS=--batch --raw --unbuffered -uroot app"));
        let f = pwfile.display().to_string();
        assert!(run(&[("MYSQL_ROOT_PASSWORD_FILE", &f)], "\n\n").contains("PWD=depuis-fichier"));
        let u = run(&[("MYSQL_USER", "nexus"), ("MYSQL_PASSWORD", "np")], "\n\n");
        assert!(u.contains("PWD=np") && u.contains("-unexus"), "{u}");
        let saved = run(&[("MYSQL_ROOT_PASSWORD", "r00t")], "admin\nenregistre\n");
        assert!(saved.contains("PWD=enregistre") && saved.contains("-uadmin"), "identifiants de Zenytt prioritaires : {saved}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mysql_output() {
        let r = parse_mysql("id\tnom\tnote\n1\tAlice\tdeux\\nlignes\n2\tNULL\tavec\\ttab\n");
        assert_eq!(r.columns, ["id", "nom", "note"]);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][2], Some("deux\nlignes".into()));
        assert_eq!(r.rows[1][1], None, "NULL");
        assert_eq!(r.rows[1][2], Some("avec\ttab".into()));
    }

    #[test]
    fn csv_output() {
        let r = parse_csv("id,nom,note\n1,\"Alice, dite \"\"Al\"\"\",\n2,Bob,\"deux\nlignes\"\n");
        assert_eq!(r.columns, ["id", "nom", "note"]);
        assert_eq!(r.rows[0][1], Some("Alice, dite \"Al\"".into()));
        assert_eq!(r.rows[0][2], None, "champ vide non cité = NULL");
        assert_eq!(r.rows[1][2], Some("deux\nlignes".into()));
    }

    #[test]
    fn read_only_detection() {
        assert!(is_read_only("  -- commentaire\n SELECT 1"));
        assert!(is_read_only("/* x */ with a as (select 1) select * from a"));
        assert!(!is_read_only("DELETE FROM users"));
        assert!(!is_read_only("update t set a=1"));
        // Écritures cachées derrière un premier mot de lecture.
        assert!(!is_read_only("SELECT 1; DROP TABLE users"));
        assert!(!is_read_only("with d as (delete from sessions returning *) select count(*) from d"));
        assert!(!is_read_only("SELECT * INTO OUTFILE '/tmp/x' FROM users"));
        assert!(!is_read_only("EXPLAIN ANALYZE UPDATE users SET plan = 'pro'"));
        assert!(!is_read_only("select 1 /* ; */ ; insert into t values (1)"));
        // Mots d'écriture dans des chaînes, commentaires ou identifiants : sans effet.
        assert!(is_read_only("SELECT 'DROP TABLE x; DELETE' AS txt FROM logs -- update\n"));
        assert!(is_read_only("select \"update\", created_at from \"delete\" where note = 'it''s; drop'"));
        assert!(is_read_only("SELECT $$ drop table x $$ AS body"));
        assert!(is_read_only("SELECT 1;"));
        assert!(!is_read_only("SELECT 'a\\'; DROP TABLE x; --'"), "PostgreSQL : l'antislash ne protège pas le guillemet");
        assert!(!is_read_only("SELECT 1 # 2; DROP TABLE x"), "PostgreSQL : # est un opérateur");
        assert_eq!(first_keyword("INSERT INTO t VALUES (1)"), "INSERT");
        assert!(preview_query(Engine::Mysql, "users", 100).unwrap().contains("`users`"));
        assert!(preview_query(Engine::Postgres, "users; DROP TABLE x", 10).is_err());
    }

    #[test]
    fn warnings_are_not_errors() {
        assert_eq!(
            real_errors(
                "mysql: [Warning] Using a password on the command line interface can be insecure.
"
            ),
            ""
        );
        assert_eq!(
            real_errors(
                "ERROR 1064 (42000) at line 1: You have an error
"
            ),
            "ERROR 1064 (42000) at line 1: You have an error"
        );
    }

    #[test]
    fn local_instances() {
        let l = parse_local("mysql\npostgres\n");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].engine, Engine::Mysql);
        assert!(l[1].container.is_none());
    }

    fn key(column: &str, value: &str) -> Vec<KeyPart> {
        vec![KeyPart { column: column.into(), value: Some(value.into()) }]
    }

    #[test]
    fn literals_escape_per_engine() {
        assert_eq!(quote_literal(Engine::Mysql, "l'ete"), "'l''ete'");
        // MySQL interprete la barre oblique inverse dans un litteral : elle doit etre doublee.
        assert_eq!(quote_literal(Engine::Mysql, "c:\\x"), "'c:\\\\x'");
        assert_eq!(quote_literal(Engine::Postgres, "c:\\x"), "'c:\\x'");
        assert_eq!(quote_ident(Engine::Mysql, "users").unwrap(), "`users`");
        assert_eq!(quote_ident(Engine::Postgres, "users").unwrap(), "\"users\"");
        assert!(quote_ident(Engine::Mysql, "users`; DROP TABLE x").is_err());
    }

    #[test]
    fn cell_update_needs_a_key() {
        let sql = update_cell_sql(Engine::Mysql, "users", "email", Some("a@b.c"), &key("id", "7")).unwrap();
        assert_eq!(sql, "UPDATE `users` SET `email` = 'a@b.c' WHERE `id` = '7' LIMIT 1");
        // Sans cle primaire, l'operation est refusee : jamais d'UPDATE sur toute la table.
        assert!(update_cell_sql(Engine::Mysql, "users", "email", None, &[]).is_err());
        // Une cle NULL n'identifie rien.
        assert!(update_cell_sql(Engine::Mysql, "users", "email", None, &[KeyPart { column: "id".into(), value: None }]).is_err());
        assert!(update_cell_sql(Engine::Postgres, "users", "email", None, &key("id", "7")).unwrap().ends_with("WHERE \"id\" = '7'"));
        assert!(update_cell_sql(Engine::Postgres, "users", "email", None, &key("id", "7")).unwrap().contains("SET \"email\" = NULL"));
    }

    #[test]
    fn row_delete_and_insert() {
        assert_eq!(delete_row_sql(Engine::Postgres, "t", &key("id", "1")).unwrap(), "DELETE FROM \"t\" WHERE \"id\" = '1'");
        let ins = insert_row_sql(Engine::Mysql, "t", &[("a".into(), Some("1".into())), ("b".into(), None)]).unwrap();
        assert_eq!(ins, "INSERT INTO `t` (`a`, `b`) VALUES ('1', NULL)");
        assert!(insert_row_sql(Engine::Mysql, "t", &[]).is_err());
    }

    #[test]
    fn header_sort_and_filters() {
        let filters = vec![
            Filter { column: "nom".into(), op: "LIKE".into(), value: "a%".into() },
            Filter { column: "actif".into(), op: "IS NOT NULL".into(), value: String::new() },
        ];
        let sql = table_query(Engine::Mysql, "users", &filters, Some(("id", SortDir::Desc)), 100, 200).unwrap();
        assert_eq!(sql, "SELECT * FROM `users` WHERE `nom` LIKE 'a%' AND `actif` IS NOT NULL ORDER BY `id` DESC LIMIT 100 OFFSET 200");
        // Sur PostgreSQL, LIKE est applique au texte de la colonne pour accepter les numeriques.
        let pg = table_query(Engine::Postgres, "users", &filters[..1], None, 10, 0).unwrap();
        assert!(pg.contains("\"nom\"::text LIKE 'a%'"));
        // Un operateur hors liste est refuse, pas echappe.
        let bad = vec![Filter { column: "id".into(), op: "= 1 OR 1".into(), value: String::new() }];
        assert!(table_query(Engine::Mysql, "users", &bad, None, 10, 0).is_err());
        assert!(table_query(Engine::Mysql, "users", &[], Some(("id; DROP", SortDir::Asc)), 10, 0).is_err());
    }

    #[test]
    fn sqlite_instances_and_commands() {
        let i = Instance::sqlite("/var/lib/app/data.db", None);
        assert_eq!(i.engine, Engine::Sqlite);
        assert_eq!(i.label, "data.db (SQLite)");
        let cmd = client_command(&i, None, Some(10)).unwrap();
        assert!(cmd.contains("sqlite3 -batch -bail -csv -header '/var/lib/app/data.db'"), "{cmd}");
        // Un chemin relatif ou pietine n'atteint jamais le serveur.
        assert!(client_command(&Instance::sqlite("data.db", None), None, None).is_err());
        let found = parse_sqlite("/opt/a.db\n/opt/a.db\nrelatif.db\n/srv/b.sqlite\n");
        assert_eq!(found.len(), 2, "doublons et chemins relatifs ecartes");
        assert_eq!(found[1].path, "/srv/b.sqlite");
    }
}
