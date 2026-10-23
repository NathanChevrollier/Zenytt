//! Page GitHub : compte (jeton dans le coffre), dépôts, et clones présents sur les serveurs.
//!
//! Le jeton ne quitte jamais le coffre vers l'interface : elle ne reçoit que « configuré ou non » et
//! l'identifiant du compte. Vers un serveur, il voyage sur l'entrée standard de la commande
//! (voir `zenytt_core::github`), jamais dans une ligne de commande, une URL ou le journal d'actions.

use serde::Serialize;
use tauri::State;
use zenytt_core::github::{self, Clone as RepoClone, Repo};
use zenytt_core::ssh::shell_quote;
use zenytt_core::Connection;

use crate::commands::{err, need_shell, track};
use crate::sessions::Sessions;
use crate::store::{secrets, AuditLog, Store};

const OWNER: &str = secrets::GITHUB_OWNER;

fn token() -> Result<String, String> {
    secrets::get(OWNER, "token").ok_or_else(|| "aucun jeton GitHub : ajoute-le en haut de la page GitHub".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub configured: bool,
    pub login: Option<String>,
}

/// État du compte. Un jeton refusé par GitHub est signalé par une erreur, pas supprimé.
#[tauri::command]
pub async fn github_status() -> Result<GithubStatus, String> {
    match secrets::get(OWNER, "token") {
        None => Ok(GithubStatus { configured: false, login: None }),
        Some(t) => Ok(GithubStatus { configured: true, login: Some(github::login(&t).await.map_err(err)?) }),
    }
}

/// Vérifie le jeton auprès de GitHub puis le range dans le coffre. Un jeton vide supprime le compte.
#[tauri::command]
pub async fn github_set_token(token: String) -> Result<GithubStatus, String> {
    let token = token.trim();
    if token.is_empty() {
        secrets::set(OWNER, "token", "")?;
        return Ok(GithubStatus { configured: false, login: None });
    }
    if !github::valid_token(token) {
        return Err("jeton invalide : il ne contient normalement que des lettres, chiffres, « _ » et « - »".into());
    }
    let login = github::login(token).await.map_err(err)?;
    secrets::set(OWNER, "token", token)?;
    Ok(GithubStatus { configured: true, login: Some(login) })
}

#[tauri::command]
pub async fn github_repos() -> Result<Vec<Repo>, String> {
    github::repos(&token()?).await.map_err(err)
}

fn check_repo(owner: &str, repo: &str) -> Result<(), String> {
    if github::valid_repo(owner, repo) {
        Ok(())
    } else {
        Err("nom de dépôt invalide".into())
    }
}

async fn shell_conn(store: &Store, sessions: &Sessions, server_id: &str) -> Result<Connection, String> {
    need_shell(store, server_id)?;
    sessions.get(store, server_id).await
}

/// Détails de dossiers déjà identifiés comme clones.
async fn details(conn: &Connection, dirs: &[String]) -> Result<Vec<RepoClone>, String> {
    let out = conn.exec(&github::details_command(dirs).map_err(err)?, None).await.map_err(err)?;
    Ok(github::parse_details(&out.stdout))
}

/// Le dossier est-il bien un clone de `owner/repo` ? Évite d'agir (et d'envoyer le jeton) ailleurs.
async fn verify_origin(conn: &Connection, owner: &str, repo: &str, path: &str) -> Result<(), String> {
    if !github::valid_path(path) {
        return Err("chemin invalide".into());
    }
    let cmd = format!("git -c safe.directory='*' -C {} remote get-url origin", shell_quote(path));
    let out = conn.exec(&cmd, None).await.map_err(err)?;
    if out.success() && github::same_repo(out.stdout.trim(), owner, repo) {
        Ok(())
    } else {
        Err(format!("{path} n'est pas un clone de {owner}/{repo}"))
    }
}

/// Clones de `owner/repo` sur ce serveur : deux commandes au plus, quel que soit le nombre de dépôts.
#[tauri::command]
pub async fn github_clones(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    owner: String,
    repo: String,
) -> Result<Vec<RepoClone>, String> {
    check_repo(&owner, &repo)?;
    let conn = shell_conn(&store, &sessions, &server_id).await?;
    let scan = conn.exec(&github::scan_command(), None).await.map_err(err)?;
    let dirs = github::parse_scan(&scan.stdout, &owner, &repo);
    if dirs.is_empty() {
        return Ok(vec![]);
    }
    details(&conn, &dirs).await
}

#[derive(serde::Deserialize)]
pub struct RepoRef {
    owner: String,
    name: String,
}

/// Tout ce qui tourne sur ce serveur pour les dépôts donnés (clones, images GHCR, dossiers compose) : une seule
/// commande en lecture seule, quel que soit le nombre de dépôts.
#[tauri::command]
pub async fn github_server_deployments(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    repos: Vec<RepoRef>,
) -> Result<Vec<github::Deployment>, String> {
    if repos.len() > 2000 {
        return Err("trop de dépôts".into());
    }
    let mut list = Vec::with_capacity(repos.len());
    for r in repos {
        check_repo(&r.owner, &r.name)?;
        list.push((r.owner, r.name));
    }
    let conn = shell_conn(&store, &sessions, &server_id).await?;
    let out = conn.exec(&github::server_scan_command(), None).await.map_err(err)?;
    Ok(github::parse_deployments(&out.stdout, &list))
}

/// Relit l'état d'un clone ; `fetch` interroge d'abord GitHub (sinon avance/retard datent du dernier fetch).
#[tauri::command]
pub async fn github_clone_state(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    owner: String,
    repo: String,
    path: String,
    fetch: bool,
) -> Result<RepoClone, String> {
    check_repo(&owner, &repo)?;
    let conn = shell_conn(&store, &sessions, &server_id).await?;
    verify_origin(&conn, &owner, &repo, &path).await?;
    if fetch {
        run_git(&conn, github::fetch_command(&path, secrets::has(OWNER, "token")), true).await?;
    }
    details(&conn, &[path]).await?.pop().ok_or_else(|| "état du dépôt illisible".to_string())
}

/// Exécute une commande git construite par `github`, en lui passant le jeton sur l'entrée standard si elle l'attend.
async fn run_git(conn: &Connection, cmd: zenytt_core::Result<String>, with_token: bool) -> Result<String, String> {
    let stdin = if with_token { Some(github::token_stdin(&token()?)) } else { None };
    let out = conn.exec(&cmd.map_err(err)?, stdin.as_deref()).await.map_err(err)?.into_result().map_err(err)?;
    Ok(format!("{}{}", out.stdout, out.stderr).trim().to_string())
}

/// Clone `owner/repo` dans `<folder>/<repo>` ; renvoie le chemin du clone.
#[tauri::command]
pub async fn github_clone(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    owner: String,
    repo: String,
    folder: String,
) -> Result<String, String> {
    let detail = format!("{owner}/{repo} dans {folder}");
    let r = async {
        check_repo(&owner, &repo)?;
        let conn = shell_conn(&store, &sessions, &server_id).await?;
        let with_token = secrets::has(OWNER, "token");
        let (cmd, target) = github::clone_command(&owner, &repo, &folder, with_token).map_err(err)?;
        zenytt_core::ssh::long(run_git(&conn, Ok(cmd), with_token)).await?;
        Ok(target)
    }
    .await;
    track(&audit, &store, &server_id, "github.clone", &detail, r)
}

/// `git pull --ff-only` dans un clone de `owner/repo` ; renvoie la sortie de git.
#[tauri::command]
pub async fn github_pull(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    owner: String,
    repo: String,
    path: String,
) -> Result<String, String> {
    let detail = format!("{owner}/{repo} dans {path}");
    let r = async {
        check_repo(&owner, &repo)?;
        let conn = shell_conn(&store, &sessions, &server_id).await?;
        verify_origin(&conn, &owner, &repo, &path).await?;
        let with_token = secrets::has(OWNER, "token");
        zenytt_core::ssh::long(run_git(&conn, github::pull_command(&path, with_token), with_token)).await
    }
    .await;
    track(&audit, &store, &server_id, "github.pull", &detail, r)
}
