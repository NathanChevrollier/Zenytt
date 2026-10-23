//! Bases de données du serveur : découverte des instances (conteneurs Docker ou service local),
//! exploration et exécution de SQL.

use tauri::State;
use zenytt_core::db::{self, Column, Engine, Filter, Instance, KeyPart, Login, Named, QueryResult, SortDir};
use zenytt_core::db_admin::{self, BackupFile};
use zenytt_core::db_schema::{self, SchemaOp};
use zenytt_core::docker::{self, Access};

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{secrets, AuditLog, Store};

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// Nom du secret (keyring) qui garde le compte d'une instance.
fn login_key(instance_id: &str) -> String {
    format!("db:{instance_id}")
}

/// Joint à l'instance le compte enregistré pour elle, s'il y en a un.
fn with_login(server_id: &str, mut instance: Instance) -> Instance {
    instance.login = secrets::get(server_id, &login_key(&instance.id)).and_then(|s| serde_json::from_str::<Login>(&s).ok());
    instance
}

/// Utilisateur enregistré pour l'instance (jamais le mot de passe).
#[tauri::command]
pub fn db_login_get(server_id: String, instance_id: String) -> Option<String> {
    secrets::get(&server_id, &login_key(&instance_id)).and_then(|s| serde_json::from_str::<Login>(&s).ok()).map(|l| l.user)
}

/// Enregistre le compte d'une instance dans le keyring ; utilisateur vide : l'oublie (retour aux
/// identifiants du conteneur ou du socket).
#[tauri::command]
pub fn db_login_set(server_id: String, instance_id: String, user: String, password: String) -> Result<(), String> {
    let key = login_key(&instance_id);
    if user.trim().is_empty() {
        return secrets::set(&server_id, &key, "");
    }
    let login = Login { user: user.trim().to_string(), password };
    // Même validation qu'à l'usage : un compte refusé plus tard ne doit pas être enregistré.
    db::login_prefix(Some(&login)).map_err(err)?;
    let json = serde_json::json!({ "user": login.user, "password": login.password }).to_string();
    secrets::set(&server_id, &key, &json)
}

/// Instances trouvées : conteneurs MySQL/MariaDB/PostgreSQL en cours, puis services installés.
/// La recherche côté Docker et la sonde des services locaux partent ensemble, et aucune version
/// n'est demandée ici : chaque sonde lance un client SQL sur le serveur, ce qui rendait
/// l'ouverture de l'onglet très lente. L'interface demande ensuite `db_version` pour la seule
/// instance affichée.
#[tauri::command]
pub async fn db_instances(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Instance>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    let containers = async {
        let (access, _) = docker::access(&conn, pw.as_deref()).await?;
        if access == Access::Unavailable {
            return Ok(Vec::new());
        }
        docker::containers(&conn, access, pw.as_deref()).await
    };
    let (containers, local) = tokio::join!(containers, conn.exec(db::LOCAL_PROBE, None));

    let mut out = Vec::new();
    for c in containers.map_err(err)? {
        if c.state != "running" {
            continue;
        }
        if let Some(engine) = Engine::from_image(&c.image) {
            out.push(Instance::server(format!("container:{}", c.name), format!("{} ({})", c.name, c.image), engine, Some(c.name)));
        }
    }
    out.extend(db::parse_local(&local.map_err(err)?.stdout));
    Ok(out)
}

/// Version d'une instance, demandée à part pour ne pas retarder la liste. Chaîne vide si
/// l'instance est injoignable (mot de passe absent du conteneur, client manquant) : l'erreur
/// s'affichera à la première requête.
#[tauri::command]
pub async fn db_version(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
) -> Result<String, String> {
    let instance = with_login(&server_id, instance);
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    Ok(db::version(&conn, pw.as_deref(), &instance).await)
}

/// Crée une base vide dans l'instance choisie. L'action est inscrite au journal.
#[tauri::command]
pub async fn db_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    name: String,
) -> Result<(), String> {
    let instance = with_login(&server_id, instance);
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db::create_database(&conn, pw.as_deref(), &instance, &name).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.create", &format!("{} · {name}", instance.label), r)
}

// ---------- Administration : sauvegardes, comptes, requêtes en cours ----------

#[tauri::command]
pub async fn db_backups(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<BackupFile>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    db_admin::list_backups(&conn).await.map_err(err)
}

/// Dossier du serveur où déposer un fichier .sql importé du PC.
#[tauri::command]
pub async fn db_import_dir(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<String, String> {
    let conn = sessions.get(&store, &server_id).await?;
    db_admin::import_dir(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn db_backup(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    database: String,
    stamp: String,
) -> Result<BackupFile, String> {
    let instance = with_login(&server_id, instance);
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        let stamp: String = stamp.chars().filter(|c| c.is_ascii_alphanumeric() || "-_".contains(*c)).take(32).collect();
        db_admin::backup(&conn, pw.as_deref(), &instance, &database, &stamp).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.backup", &format!("{} · {database}", instance.label), r)
}

#[tauri::command]
pub async fn db_restore(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    database: String,
    file: String,
) -> Result<String, String> {
    let instance = with_login(&server_id, instance);
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db_admin::restore(&conn, pw.as_deref(), &instance, &database, &file).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.restore", &format!("{} · {database} ← {file}", instance.label), r)
}

#[tauri::command]
pub async fn db_backup_delete(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    file: String,
) -> Result<(), String> {
    let r = async {
        let conn = sessions.get(&store, &server_id).await?;
        db_admin::delete_backup(&conn, &file).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.backup_delete", &file, r)
}

#[tauri::command]
pub async fn db_users(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
) -> Result<QueryResult, String> {
    let instance = with_login(&server_id, instance);
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    db_admin::users(&conn, pw.as_deref(), &instance).await.map_err(err)
}

/// Crée un compte avec tous les droits sur une base. Le mot de passe n'est pas journalisé.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_user_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    user: String,
    host: String,
    password: String,
    database: Option<String>,
) -> Result<(), String> {
    let instance = with_login(&server_id, instance);
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db_admin::create_user(&conn, pw.as_deref(), &instance, &user, &host, &password, database.as_deref()).await.map_err(err)
    }
    .await;
    let detail = format!("{} · {user}@{host}{}", instance.label, database.as_deref().map(|d| format!(" → {d}")).unwrap_or_default());
    track(&audit, &store, &server_id, "db.user_create", &detail, r)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_user_password(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    user: String,
    host: String,
    password: String,
) -> Result<(), String> {
    let instance = with_login(&server_id, instance);
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db_admin::set_password(&conn, pw.as_deref(), &instance, &user, &host, &password).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.user_password", &format!("{} · {user}@{host}", instance.label), r)
}

#[tauri::command]
pub async fn db_user_drop(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    user: String,
    host: String,
) -> Result<(), String> {
    let instance = with_login(&server_id, instance);
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db_admin::drop_user(&conn, pw.as_deref(), &instance, &user, &host).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.user_drop", &format!("{} · {user}@{host}", instance.label), r)
}

#[tauri::command]
pub async fn db_activity(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
) -> Result<QueryResult, String> {
    let instance = with_login(&server_id, instance);
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    db_admin::activity(&conn, pw.as_deref(), &instance).await.map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_kill(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    id: u64,
    whole: bool,
) -> Result<(), String> {
    let instance = with_login(&server_id, instance);
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db_admin::kill(&conn, pw.as_deref(), &instance, id, whole).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.kill", &format!("{} · {id}{}", instance.label, if whole { " (connexion)" } else { "" }), r)
}

#[tauri::command]
pub async fn db_databases(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
) -> Result<Vec<Named>, String> {
    let instance = with_login(&server_id, instance);
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    db::databases(&conn, pw.as_deref(), &instance).await.map_err(err)
}

#[tauri::command]
pub async fn db_tables(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    database: String,
) -> Result<Vec<Named>, String> {
    let instance = with_login(&server_id, instance);
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    db::tables(&conn, pw.as_deref(), &instance, &database).await.map_err(err)
}

/// Exécute du SQL. Les requêtes qui modifient les données sont inscrites au journal d'actions.
/// Remplace le contenu des littéraux entre guillemets par `?` : un `IDENTIFIED BY 'secret'` ne
/// doit pas finir dans les journaux.
fn mask_literals(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut quote: Option<char> = None;
    let mut chars = sql.chars();
    while let Some(c) = chars.next() {
        match quote {
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                out.push_str(&format!("{c}?"));
            }
            None => out.push(c),
            Some(_) if c == '\\' => {
                chars.next();
            }
            Some(q) if c == q => {
                quote = None;
                out.push(c);
            }
            Some(_) => {}
        }
    }
    out
}

#[tauri::command]
pub async fn db_query(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    database: Option<String>,
    sql: String,
    limit: Option<usize>,
) -> Result<QueryResult, String> {
    let instance = with_login(&server_id, instance);
    let read_only = db::is_read_only(&sql);
    let r: Result<QueryResult, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db::query(&conn, pw.as_deref(), &instance, database.as_deref(), &sql, limit.unwrap_or(500).min(5000)).await.map_err(err)
    }
    .await;
    if read_only {
        return r;
    }
    let detail = format!(
        "{} · {} : {}",
        instance.label,
        database.unwrap_or_default(),
        mask_literals(&sql).split_whitespace().collect::<Vec<_>>().join(" ")
    );
    track(&audit, &store, &server_id, "db.query", &detail.chars().take(500).collect::<String>(), r)
}

/// SQL d'une opération de structure (créer une table, ajouter une colonne…), montré à
/// l'utilisateur puis exécuté par `db_query`, qui l'inscrit au journal.
#[tauri::command]
pub fn db_schema_sql(engine: Engine, op: SchemaOp) -> Result<String, String> {
    db_schema::schema_sql(engine, &op).map_err(err)
}

/// Types de colonne proposés pour le moteur.
#[tauri::command]
pub fn db_column_types(engine: Engine) -> Vec<&'static str> {
    db_schema::column_types(engine).to_vec()
}

/// Requête d'aperçu du contenu d'une table (identifiant vérifié côté Rust).
#[tauri::command]
pub fn db_preview_query(engine: Engine, table: String, limit: usize) -> Result<String, String> {
    db::preview_query(engine, &table, limit.min(5000)).map_err(err)
}

/// Colonnes d'une table, avec le repérage de la clé primaire. C'est cette information qui autorise
/// — ou interdit — l'édition d'une cellule dans le tableau de résultats.
#[tauri::command]
pub async fn db_columns(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    database: Option<String>,
    table: String,
) -> Result<Vec<Column>, String> {
    let instance = with_login(&server_id, instance);
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    db::columns(&conn, pw.as_deref(), &instance, database.as_deref(), &table).await.map_err(err)
}

/// Requête de consultation d'une table avec le tri et les filtres posés depuis l'en-tête des
/// colonnes. Le SQL est construit côté Rust : l'interface n'envoie que des noms et des valeurs.
#[tauri::command]
pub fn db_table_query(
    engine: Engine,
    table: String,
    filters: Vec<Filter>,
    sort_column: Option<String>,
    sort_desc: bool,
    limit: usize,
    offset: usize,
) -> Result<String, String> {
    let sort = sort_column.as_deref().map(|c| (c, if sort_desc { SortDir::Desc } else { SortDir::Asc }));
    db::table_query(engine, &table, &filters, sort, limit.min(5000), offset).map_err(err)
}

/// `UPDATE` d'une seule cellule, renvoyé pour être montré à l'utilisateur avant exécution. Il est
/// ensuite lancé par `db_query`, qui l'inscrit au journal comme toute requête d'écriture.
#[tauri::command]
pub fn db_update_cell_sql(
    engine: Engine,
    table: String,
    column: String,
    value: Option<String>,
    key: Vec<KeyPart>,
) -> Result<String, String> {
    db::update_cell_sql(engine, &table, &column, value.as_deref(), &key).map_err(err)
}

/// `DELETE` d'une seule ligne, désignée par sa clé primaire.
#[tauri::command]
pub fn db_delete_row_sql(engine: Engine, table: String, key: Vec<KeyPart>) -> Result<String, String> {
    db::delete_row_sql(engine, &table, &key).map_err(err)
}

/// `INSERT` d'une ligne : les colonnes absentes prennent la valeur par défaut du moteur.
#[tauri::command]
pub fn db_insert_row_sql(engine: Engine, table: String, values: Vec<(String, Option<String>)>) -> Result<String, String> {
    db::insert_row_sql(engine, &table, &values).map_err(err)
}

/// Fichiers SQLite trouvés sur le serveur. La recherche est lancée à la demande (bouton) : elle
/// balaye plusieurs dossiers et n'a pas à retarder l'ouverture de l'onglet.
#[tauri::command]
pub async fn db_sqlite_files(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Instance>, String> {
    let (conn, _) = admin(&store, &sessions, &server_id).await?;
    let out = zenytt_core::ssh::long(conn.exec(db::SQLITE_PROBE, None)).await.map_err(err)?;
    Ok(db::parse_sqlite(&out.stdout))
}

/// Ouvre un fichier SQLite choisi à la main (par exemple repéré dans l'explorateur de fichiers).
#[tauri::command]
pub fn db_sqlite_instance(path: String, container: Option<String>) -> Result<Instance, String> {
    if !db::safe_file_path(&path) {
        return Err("chemin invalide : un chemin absolu est attendu".into());
    }
    Ok(Instance::sqlite(path, container))
}

#[cfg(test)]
mod mask_tests {
    use super::mask_literals;

    #[test]
    fn literals_are_masked() {
        assert_eq!(mask_literals("ALTER USER 'bob'@'%' IDENTIFIED BY 'p\\'w d'"), "ALTER USER '?'@'?' IDENTIFIED BY '?'");
        assert_eq!(mask_literals("SET PASSWORD = \"x\"; SELECT 1"), "SET PASSWORD = \"?\"; SELECT 1");
        assert_eq!(mask_literals("CREATE USER a IDENTIFIED BY 'oops"), "CREATE USER a IDENTIFIED BY '?");
    }
}
