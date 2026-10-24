//! Page GitHub : compte (jeton dans le coffre), dépôts, et clones présents sur les serveurs.
//!
//! Le jeton ne quitte jamais le coffre vers l'interface : elle ne reçoit que « configuré ou non » et
//! l'identifiant du compte. Vers un serveur, il voyage sur l'entrée standard de la commande
//! (voir `zenytt_core::github`), jamais dans une ligne de commande, une URL ou le journal d'actions.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

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

// Une commande par type de donnée : chacune demande sa propre permission au jeton, donc échoue seule.
// Le jeton ne sort pas du coffre ; il part en en-tête vers api.github.com et n'est pas journalisé.

/// Derniers runs GitHub Actions (`branch` : seulement ceux de cette branche), 30 au plus.
#[tauri::command]
pub async fn github_ci(owner: String, repo: String, branch: Option<String>, limit: Option<u32>) -> Result<Vec<github::CiRun>, String> {
    check_repo(&owner, &repo)?;
    github::ci_runs(&token()?, &owner, &repo, branch.as_deref(), limit.unwrap_or(8)).await.map_err(err)
}

#[tauri::command]
pub async fn github_pulls(owner: String, repo: String) -> Result<Vec<github::Pull>, String> {
    check_repo(&owner, &repo)?;
    github::pulls(&token()?, &owner, &repo).await.map_err(err)
}

#[tauri::command]
pub async fn github_issues(owner: String, repo: String) -> Result<Vec<github::Issue>, String> {
    check_repo(&owner, &repo)?;
    github::issues(&token()?, &owner, &repo).await.map_err(err)
}

#[tauri::command]
pub async fn github_alerts(owner: String, repo: String) -> Result<Vec<github::Alert>, String> {
    check_repo(&owner, &repo)?;
    github::alerts(&token()?, &owner, &repo).await.map_err(err)
}

#[tauri::command]
pub async fn github_gh_deployments(owner: String, repo: String) -> Result<Vec<github::GhDeployment>, String> {
    check_repo(&owner, &repo)?;
    github::gh_deployments(&token()?, &owner, &repo).await.map_err(err)
}

/// Dernière version publiée, ou `None` si le dépôt n'en a pas.
#[tauri::command]
pub async fn github_release(owner: String, repo: String) -> Result<Option<github::Release>, String> {
    check_repo(&owner, &repo)?;
    github::latest_release(&token()?, &owner, &repo).await.map_err(err)
}

/// Résolutions déjà faites cette session (`(propriétaire, nom)` en minuscules -> dépôt actuel, ou `None` si introuvable) :
/// une URL périmée ne coûte qu'une requête à l'API par lancement.
type Cache = HashMap<(String, String), Option<github::Resolved>>;
static RESOLVED: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

fn cached(key: &(String, String)) -> Option<Option<github::Resolved>> {
    RESOLVED.lock().ok()?.get(key).cloned()
}

/// Ce que GitHub sait aujourd'hui de chacun de ces noms (cache, sinon API). Une erreur passagère (réseau, limite) n'est pas
/// mise en cache : le nom reste simplement non rattaché jusqu'au prochain examen.
async fn resolve_all(names: Vec<(String, String)>) -> Vec<((String, String), Option<github::Resolved>)> {
    let Ok(token) = token() else { return vec![] };
    let mut out = Vec::with_capacity(names.len());
    for key in names {
        let r = match cached(&key) {
            Some(r) => r,
            None => match github::resolve_repo(&token, &key.0, &key.1).await {
                Ok(r) => {
                    if let Ok(mut m) = RESOLVED.lock() {
                        m.insert(key.clone(), r.clone());
                    }
                    r
                }
                Err(_) => continue,
            },
        };
        out.push((key, r));
    }
    out
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

/// Le dossier est-il bien un clone de `owner/repo` (au besoin par l'ancien nom d'un dépôt renommé, que GitHub redirige) ?
/// Évite d'agir (et d'envoyer le jeton) ailleurs. Renvoie l'ancien nom si `origin` est resté dessus.
async fn verify_origin(conn: &Connection, owner: &str, repo: &str, path: &str) -> Result<Option<String>, String> {
    if !github::valid_path(path) {
        return Err("chemin invalide".into());
    }
    let cmd = format!("git -c safe.directory='*' -C {} remote get-url origin", shell_quote(path));
    let out = conn.exec(&cmd, None).await.map_err(err)?;
    let url = out.stdout.trim();
    if out.success() && github::same_repo(url, owner, repo) {
        return Ok(None);
    }
    if out.success() {
        if let Some(old) = github::parse_remote(url) {
            let renames = github::link_renames(&resolve_all(vec![old]).await, &[(None, owner.to_string(), repo.to_string())]);
            if let Some(old) = github::renamed_from(url, owner, repo, &renames) {
                return Ok(Some(old));
            }
        }
    }
    Err(format!("{path} n'est pas un clone de {owner}/{repo}"))
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
    // Anciens noms du même propriétaire (renommage), ou déjà résolus par l'examen du serveur (transfert).
    let names = github::unknown_remotes(&scan.stdout, &[(owner.clone(), repo.clone())])
        .into_iter()
        .filter(|k| k.0.eq_ignore_ascii_case(&owner) || cached(k).is_some())
        .collect();
    let renames = github::link_renames(&resolve_all(names).await, &[(None, owner.clone(), repo.clone())]);
    let found = github::parse_scan(&scan.stdout, &owner, &repo, &renames);
    if found.is_empty() {
        return Ok(vec![]);
    }
    let dirs: Vec<String> = found.iter().map(|(p, _)| p.clone()).collect();
    let mut clones = details(&conn, &dirs).await?;
    for c in &mut clones {
        c.old_remote = found.iter().find(|(p, _)| *p == c.path).and_then(|(_, o)| o.clone());
    }
    Ok(clones)
}

#[derive(serde::Deserialize)]
pub struct RepoRef {
    /// Identifiant GitHub : rattache un ancien nom au dépôt même si la liste du compte n'est pas à jour.
    #[serde(default)]
    id: Option<u64>,
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
    for r in &repos {
        check_repo(&r.owner, &r.name)?;
        list.push((r.owner.clone(), r.name.clone()));
    }
    let conn = shell_conn(&store, &sessions, &server_id).await?;
    let out = conn.exec(&github::server_scan_command(), None).await.map_err(err)?;
    // URL ou image qui ne désigne aucun dépôt du compte : peut-être un ancien nom (dépôt renommé ou transféré).
    let resolved = resolve_all(github::unknown_remotes(&out.stdout, &list)).await;
    let ids: Vec<_> = repos.into_iter().map(|r| (r.id, r.owner, r.name)).collect();
    Ok(github::parse_deployments(&out.stdout, &list, &github::link_renames(&resolved, &ids)))
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
    let old_remote = verify_origin(&conn, &owner, &repo, &path).await?;
    if fetch {
        run_git(&conn, github::fetch_command(&path, secrets::has(OWNER, "token")), true).await?;
    }
    let mut c = details(&conn, &[path]).await?.pop().ok_or_else(|| "état du dépôt illisible".to_string())?;
    c.old_remote = old_remote;
    Ok(c)
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

/// Remet `origin` sur le nom actuel d'un dépôt renommé (`git remote set-url`) ; renvoie l'état du clone.
#[tauri::command]
pub async fn github_set_remote(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    owner: String,
    repo: String,
    path: String,
) -> Result<RepoClone, String> {
    let detail = format!("{owner}/{repo} dans {path}");
    let r = async {
        check_repo(&owner, &repo)?;
        let conn = shell_conn(&store, &sessions, &server_id).await?;
        verify_origin(&conn, &owner, &repo, &path).await?;
        run_git(&conn, github::set_remote_command(&path, &owner, &repo), false).await?;
        details(&conn, std::slice::from_ref(&path)).await?.pop().ok_or_else(|| "état du dépôt illisible".to_string())
    }
    .await;
    track(&audit, &store, &server_id, "github.set_remote", &detail, r)
}
