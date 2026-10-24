//! Page GitHub : dépôts du compte (API REST) et clones présents sur les serveurs.
//!
//! Tout ce qui construit une commande ou lit une réponse est pur, donc testable sans réseau ni
//! serveur. Le jeton GitHub n'apparaît jamais dans une ligne de commande, une URL de dépôt ni un
//! journal : il part en en-tête HTTP côté poste, et en entrée standard (`read`) côté serveur,
//! où un assistant d'identifiants limité à `https://github.com` le donne à git.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::ssh::shell_quote;
use crate::{Error, Result};

const API: &str = "https://api.github.com";
/// 5 pages de 100 : au-delà, l'utilisateur filtre par la recherche.
const MAX_PAGES: u32 = 5;

/// Dépôt tel qu'affiché par l'interface.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    /// Identifiant GitHub : stable quand le dépôt est renommé ou transféré.
    pub id: u64,
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub private: bool,
    pub default_branch: String,
    pub pushed_at: Option<String>,
    /// Tickets et demandes de fusion ouverts (GitHub les additionne).
    pub open_issues: u32,
    pub description: Option<String>,
    pub fork: bool,
    pub archived: bool,
}

#[derive(Deserialize)]
struct RawOwner {
    login: String,
}

#[derive(Deserialize)]
struct RawRepo {
    #[serde(default)]
    id: u64,
    full_name: String,
    name: String,
    owner: RawOwner,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    default_branch: String,
    pushed_at: Option<String>,
    #[serde(default)]
    open_issues_count: u32,
    description: Option<String>,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    archived: bool,
}

/// Lit une page de `/user/repos`. Les entrées dont le nom ne passe pas la validation sont écartées :
/// elles finiraient dans des commandes distantes.
pub fn parse_repos(json: &str) -> Result<Vec<Repo>> {
    let raw: Vec<RawRepo> = serde_json::from_str(json).map_err(|e| Error::Other(format!("réponse GitHub illisible : {e}")))?;
    Ok(raw
        .into_iter()
        .filter(|r| valid_repo(&r.owner.login, &r.name))
        .map(|r| Repo {
            id: r.id,
            full_name: r.full_name,
            name: r.name,
            owner: r.owner.login,
            private: r.private,
            default_branch: r.default_branch,
            pushed_at: r.pushed_at,
            open_issues: r.open_issues_count,
            description: r.description,
            fork: r.fork,
            archived: r.archived,
        })
        .collect())
}

/// Caractères d'un jeton GitHub (`ghp_…`, `github_pat_…`, ancien format hexadécimal).
pub fn valid_token(t: &str) -> bool {
    !t.is_empty() && t.len() <= 255 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Message d'erreur selon la réponse de GitHub : jeton invalide (401), limite de requêtes (429, ou 403 avec
/// `x-ratelimit-remaining: 0` / `retry-after`), permission manquante (autre 403), introuvable (404).
pub fn map_http_error(status: u16, remaining: Option<&str>, retry_after: Option<&str>, body: &str) -> String {
    let msg =
        serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v["message"].as_str().map(str::to_string)).unwrap_or_default();
    let lower = msg.to_lowercase();
    match status {
        401 => "jeton refusé par GitHub (401) : invalide, expiré ou révoqué".into(),
        429 => "limite de requêtes GitHub atteinte (429, rate limit) : réessaie dans quelques minutes".into(),
        403 if remaining == Some("0") || retry_after.is_some() || lower.contains("rate limit") => {
            "limite de requêtes GitHub atteinte (403, rate limit) : réessaie dans quelques minutes".into()
        }
        403 => format!(
            "permission manquante (403) : le jeton n'a pas le droit demandé (Metadata et Contents en lecture, ou « repo » pour un jeton classique){}",
            if msg.is_empty() { String::new() } else { format!(" — GitHub : {msg}") }
        ),
        404 => "introuvable (404) : dépôt inexistant ou non accordé à ce jeton".into(),
        s => format!("GitHub a répondu {s}"),
    }
}

fn get(agent: &ureq::Agent, token: &str, url: &str) -> Result<String> {
    let mut resp = agent
        .get(url)
        .header("Authorization", &format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "Zenytt")
        .call()
        .map_err(|e| Error::Other(format!("GitHub injoignable : {e}")))?;
    let status = resp.status().as_u16();
    let header = |n: &str| resp.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (remaining, retry) = (header("x-ratelimit-remaining"), header("retry-after"));
    let text = resp.body_mut().read_to_string().map_err(|e| Error::Other(e.to_string()))?;
    match status {
        200..=299 => Ok(text),
        _ => Err(Error::Other(map_http_error(status, remaining.as_deref(), retry.as_deref(), &text))),
    }
}

fn agent() -> ureq::Agent {
    // SameHost : un dépôt renommé répond 301 vers api.github.com/repositories/{id}, qui demande aussi le jeton.
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .redirect_auth_headers(ureq::config::RedirectAuthHeaders::SameHost)
        .build()
        .into()
}

/// Identifiant du compte propriétaire du jeton (sert aussi à vérifier qu'il fonctionne).
pub async fn login(token: &str) -> Result<String> {
    let token = token.to_string();
    tokio::task::spawn_blocking(move || {
        #[derive(Deserialize)]
        struct U {
            login: String,
        }
        let u: U = serde_json::from_str(&get(&agent(), &token, &format!("{API}/user"))?).map_err(|e| Error::Other(e.to_string()))?;
        Ok(u.login)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))?
}

/// Dépôts du compte, du plus récemment modifié au plus ancien (plafonné à 500).
pub async fn repos(token: &str) -> Result<Vec<Repo>> {
    let token = token.to_string();
    tokio::task::spawn_blocking(move || {
        let agent = agent();
        let mut all = Vec::new();
        for page in 1..=MAX_PAGES {
            let text = get(
                &agent,
                &token,
                &format!("{API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page={page}"),
            )?;
            let count = serde_json::from_str::<Vec<serde_json::Value>>(&text).map(|v| v.len()).unwrap_or(0);
            all.extend(parse_repos(&text)?);
            if count < 100 {
                break;
            }
        }
        Ok(all)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))?
}

// ---- Informations d'un dépôt (CI, PR, tickets, sécurité, déploiements, version) ---------------

/// Lien github.com seulement : toute autre origine est écartée avant d'atteindre l'interface.
fn gh_url(u: Option<String>) -> Option<String> {
    u.filter(|u| u.starts_with("https://github.com/"))
}

fn parse<T: serde::de::DeserializeOwned>(json: &str) -> Result<T> {
    serde_json::from_str(json).map_err(|e| Error::Other(format!("réponse GitHub illisible : {e}")))
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
}

/// Exécution d'un workflow GitHub Actions.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiRun {
    pub name: String,
    pub branch: String,
    pub event: String,
    /// `queued`, `in_progress`, `completed`…
    pub status: String,
    /// `success`, `failure`, `cancelled`… (seulement une fois terminée).
    pub conclusion: Option<String>,
    pub url: Option<String>,
    pub started_at: Option<String>,
    /// Dernière mise à jour : avec `started_at`, donne la durée d'un run terminé.
    pub updated_at: Option<String>,
}

pub fn parse_runs(json: &str) -> Result<Vec<CiRun>> {
    #[derive(Deserialize)]
    struct Run {
        name: Option<String>,
        display_title: Option<String>,
        head_branch: Option<String>,
        #[serde(default)]
        event: String,
        status: Option<String>,
        conclusion: Option<String>,
        html_url: Option<String>,
        run_started_at: Option<String>,
        created_at: Option<String>,
        updated_at: Option<String>,
    }
    #[derive(Deserialize)]
    struct Page {
        workflow_runs: Vec<Run>,
    }
    Ok(parse::<Page>(json)?
        .workflow_runs
        .into_iter()
        .map(|r| CiRun {
            name: r.name.or(r.display_title).unwrap_or_default(),
            branch: r.head_branch.unwrap_or_default(),
            event: r.event,
            status: r.status.unwrap_or_default(),
            conclusion: r.conclusion,
            url: gh_url(r.html_url),
            started_at: r.run_started_at.or(r.created_at),
            updated_at: r.updated_at,
        })
        .collect())
}

/// Demande de fusion ouverte.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub draft: bool,
    pub created_at: Option<String>,
    pub url: Option<String>,
}

pub fn parse_pulls(json: &str) -> Result<Vec<Pull>> {
    #[derive(Deserialize)]
    struct P {
        number: u32,
        #[serde(default)]
        title: String,
        user: Option<RawUser>,
        #[serde(default)]
        draft: bool,
        created_at: Option<String>,
        html_url: Option<String>,
    }
    Ok(parse::<Vec<P>>(json)?
        .into_iter()
        .map(|p| Pull {
            number: p.number,
            title: p.title,
            author: p.user.map(|u| u.login).unwrap_or_default(),
            draft: p.draft,
            created_at: p.created_at,
            url: gh_url(p.html_url),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Label {
    pub name: String,
    /// Hexadécimal sur 6 caractères, ou vide s'il est illisible (la couleur finit dans un style).
    pub color: String,
}

/// Ticket ouvert (les demandes de fusion, que l'API des tickets renvoie aussi, sont exclues).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub labels: Vec<Label>,
    pub created_at: Option<String>,
    pub url: Option<String>,
}

pub fn parse_issues(json: &str) -> Result<Vec<Issue>> {
    #[derive(Deserialize)]
    struct L {
        name: String,
        #[serde(default)]
        color: String,
    }
    #[derive(Deserialize)]
    struct I {
        number: u32,
        #[serde(default)]
        title: String,
        user: Option<RawUser>,
        #[serde(default)]
        labels: Vec<L>,
        created_at: Option<String>,
        html_url: Option<String>,
        pull_request: Option<serde_json::Value>,
    }
    let hex = |c: String| if c.len() == 6 && c.bytes().all(|b| b.is_ascii_hexdigit()) { c } else { String::new() };
    Ok(parse::<Vec<I>>(json)?
        .into_iter()
        .filter(|i| i.pull_request.is_none())
        .map(|i| Issue {
            number: i.number,
            title: i.title,
            author: i.user.map(|u| u.login).unwrap_or_default(),
            labels: i.labels.into_iter().map(|l| Label { name: l.name, color: hex(l.color) }).collect(),
            created_at: i.created_at,
            url: gh_url(i.html_url),
        })
        .collect())
}

/// Alerte Dependabot ouverte.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub package: String,
    pub ecosystem: String,
    /// `critical`, `high`, `medium`, `low`.
    pub severity: String,
    pub summary: String,
    pub manifest: String,
    pub created_at: Option<String>,
    pub url: Option<String>,
}

/// 0 = le plus grave.
fn severity_rank(s: &str) -> usize {
    ["critical", "high", "medium", "low"].iter().position(|x| *x == s).unwrap_or(4)
}

/// Alertes triées de la plus grave à la moins grave.
pub fn parse_alerts(json: &str) -> Result<Vec<Alert>> {
    #[derive(Deserialize, Default)]
    struct Pkg {
        #[serde(default)]
        name: String,
        #[serde(default)]
        ecosystem: String,
    }
    #[derive(Deserialize, Default)]
    struct Dep {
        #[serde(default)]
        package: Pkg,
        #[serde(default)]
        manifest_path: String,
    }
    #[derive(Deserialize, Default)]
    struct Adv {
        #[serde(default)]
        severity: String,
        #[serde(default)]
        summary: String,
    }
    #[derive(Deserialize)]
    struct A {
        #[serde(default)]
        dependency: Dep,
        #[serde(default)]
        security_advisory: Adv,
        created_at: Option<String>,
        html_url: Option<String>,
    }
    let mut v: Vec<Alert> = parse::<Vec<A>>(json)?
        .into_iter()
        .map(|a| Alert {
            package: a.dependency.package.name,
            ecosystem: a.dependency.package.ecosystem,
            severity: a.security_advisory.severity,
            summary: a.security_advisory.summary,
            manifest: a.dependency.manifest_path,
            created_at: a.created_at,
            url: gh_url(a.html_url),
        })
        .collect();
    v.sort_by_key(|a| severity_rank(&a.severity));
    Ok(v)
}

/// Déploiement GitHub (Deployments API) avec l'état du dernier statut.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhDeployment {
    pub id: u64,
    pub environment: String,
    pub reference: String,
    pub sha: String,
    pub creator: String,
    pub created_at: Option<String>,
    /// `success`, `failure`, `in_progress`… ; `None` si aucun statut n'est publié ou lu.
    pub state: Option<String>,
}

pub fn parse_gh_deployments(json: &str) -> Result<Vec<GhDeployment>> {
    #[derive(Deserialize)]
    struct D {
        id: u64,
        #[serde(default)]
        environment: String,
        #[serde(default, rename = "ref")]
        reference: String,
        #[serde(default)]
        sha: String,
        creator: Option<RawUser>,
        created_at: Option<String>,
    }
    Ok(parse::<Vec<D>>(json)?
        .into_iter()
        .map(|d| GhDeployment {
            id: d.id,
            environment: d.environment,
            reference: d.reference,
            sha: d.sha.chars().take(7).collect(),
            creator: d.creator.map(|u| u.login).unwrap_or_default(),
            created_at: d.created_at,
            state: None,
        })
        .collect())
}

/// État du statut le plus récent (`/deployments/{id}/statuses`, du plus récent au plus ancien).
pub fn parse_deployment_state(json: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct S {
        state: String,
    }
    serde_json::from_str::<Vec<S>>(json).ok()?.into_iter().next().map(|s| s.state)
}

/// Dernière version publiée.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub tag: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub url: Option<String>,
}

pub fn parse_release(json: &str) -> Result<Release> {
    #[derive(Deserialize)]
    struct R {
        tag_name: String,
        name: Option<String>,
        published_at: Option<String>,
        #[serde(default)]
        prerelease: bool,
        html_url: Option<String>,
    }
    let r: R = parse(json)?;
    Ok(Release {
        tag: r.tag_name,
        name: r.name.filter(|n| !n.is_empty()),
        published_at: r.published_at,
        prerelease: r.prerelease,
        url: gh_url(r.html_url),
    })
}

/// Données d'un dépôt demandées séparément : chacune a sa permission, donc sa propre erreur.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Insight {
    Ci,
    Pulls,
    Issues,
    Alerts,
    Deployments,
    Release,
}

/// Adresse de l'API pour `insight`. `branch` ne sert qu'à la CI (derniers runs d'une branche) ; `limit` est borné à 1..=30.
pub fn insight_path(insight: Insight, owner: &str, repo: &str, branch: Option<&str>, limit: u32) -> Result<String> {
    if !valid_repo(owner, repo) {
        return Err(Error::Other("nom de dépôt invalide".into()));
    }
    let n = limit.clamp(1, 30);
    let b = match branch {
        // Un nom de branche contient parfois `/` : seuls des caractères sûrs passent, donc rien à encoder.
        Some(b)
            if !b.is_empty()
                && b.len() <= 200
                && b.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-' | b'/')) =>
        {
            format!("&branch={b}")
        }
        Some(_) => return Err(Error::Other("nom de branche invalide".into())),
        None => String::new(),
    };
    let base = format!("{API}/repos/{owner}/{repo}");
    Ok(match insight {
        Insight::Ci => format!("{base}/actions/runs?per_page={n}{b}"),
        Insight::Pulls => format!("{base}/pulls?state=open&per_page={n}"),
        // L'API des tickets renvoie aussi les PR : on en demande 100 pour qu'il en reste après filtrage.
        Insight::Issues => format!("{base}/issues?state=open&per_page=100"),
        Insight::Alerts => format!("{base}/dependabot/alerts?state=open&per_page=100"),
        Insight::Deployments => format!("{base}/deployments?per_page={n}"),
        Insight::Release => format!("{base}/releases/latest"),
    })
}

async fn fetch(token: &str, url: String) -> Result<String> {
    let token = token.to_string();
    tokio::task::spawn_blocking(move || get(&agent(), &token, &url)).await.map_err(|e| Error::Other(e.to_string()))?
}

pub async fn ci_runs(token: &str, owner: &str, repo: &str, branch: Option<&str>, limit: u32) -> Result<Vec<CiRun>> {
    parse_runs(&fetch(token, insight_path(Insight::Ci, owner, repo, branch, limit)?).await?)
}

pub async fn pulls(token: &str, owner: &str, repo: &str) -> Result<Vec<Pull>> {
    parse_pulls(&fetch(token, insight_path(Insight::Pulls, owner, repo, None, 30)?).await?)
}

pub async fn issues(token: &str, owner: &str, repo: &str) -> Result<Vec<Issue>> {
    parse_issues(&fetch(token, insight_path(Insight::Issues, owner, repo, None, 30)?).await?)
}

pub async fn alerts(token: &str, owner: &str, repo: &str) -> Result<Vec<Alert>> {
    parse_alerts(&fetch(token, insight_path(Insight::Alerts, owner, repo, None, 30)?).await?)
}

/// Déploiements GitHub ; le dernier statut est lu pour le plus récent de 6 environnements au plus (un appel chacun).
pub async fn gh_deployments(token: &str, owner: &str, repo: &str) -> Result<Vec<GhDeployment>> {
    let mut list = parse_gh_deployments(&fetch(token, insight_path(Insight::Deployments, owner, repo, None, 30)?).await?)?;
    let mut seen: Vec<String> = Vec::new();
    for d in list.iter_mut() {
        if seen.contains(&d.environment) {
            continue;
        }
        if seen.len() >= 6 {
            break;
        }
        seen.push(d.environment.clone());
        // Un statut illisible ou refusé laisse l'état inconnu.
        let url = format!("{API}/repos/{owner}/{repo}/deployments/{}/statuses?per_page=1", d.id);
        d.state = fetch(token, url).await.ok().and_then(|t| parse_deployment_state(&t));
    }
    Ok(list)
}

/// Dernière version ; `None` si le dépôt n'en a pas (GitHub répond 404).
pub async fn latest_release(token: &str, owner: &str, repo: &str) -> Result<Option<Release>> {
    match fetch(token, insight_path(Insight::Release, owner, repo, None, 1)?).await {
        Ok(t) => parse_release(&t).map(Some),
        Err(Error::Other(m)) if m.starts_with("introuvable (404)") => Ok(None),
        Err(e) => Err(e),
    }
}

// ---- Dépôts renommés ou transférés ---------------------------------------------------------

/// Dépôt désigné par une URL ou une image, tel que GitHub le connaît aujourd'hui : `(id, propriétaire, nom)`.
pub type Resolved = (u64, String, String);
/// `(ancien propriétaire, ancien nom)` en minuscules, et dépôt actuel `(propriétaire, nom)` tel que listé par le compte.
pub type Rename = ((String, String), (String, String));
/// Résolutions au plus par examen : chacune coûte une requête à l'API.
pub const MAX_RESOLVE: usize = 20;

/// Lit `GET /repos/{owner}/{name}` (après la redirection d'un renommage).
pub fn parse_repo_ref(json: &str) -> Option<Resolved> {
    let r: RawRepo = serde_json::from_str(json).ok()?;
    (r.id != 0 && valid_repo(&r.owner.login, &r.name)).then_some((r.id, r.owner.login, r.name))
}

/// Ce que GitHub sait aujourd'hui de `owner/name` : il suit lui-même l'ancien nom d'un dépôt renommé ou transféré.
/// `None` : introuvable ou non accordé au jeton.
pub async fn resolve_repo(token: &str, owner: &str, name: &str) -> Result<Option<Resolved>> {
    if !valid_repo(owner, name) {
        return Err(Error::Other("nom de dépôt invalide".into()));
    }
    match fetch(token, format!("{API}/repos/{owner}/{name}")).await {
        Ok(t) => Ok(parse_repo_ref(&t)),
        Err(Error::Other(m)) if m.starts_with("introuvable (404)") => Ok(None),
        Err(e) => Err(e),
    }
}

/// `(propriétaire, nom)` en minuscules désignés par la sortie d'un examen (`scan_command` ou `server_scan_command`) qui ne
/// sont pas des dépôts de `repos` : URL `origin` d'un clone, label source ou image GHCR d'un conteneur. Ce sont les
/// candidats à un renommage, sans doublon et plafonnés à `MAX_RESOLVE`.
pub fn unknown_remotes(out: &str, repos: &[(String, String)]) -> Vec<(String, String)> {
    let known = |o: &str, n: &str| repos.iter().any(|(ro, rn)| ro.eq_ignore_ascii_case(o) && rn.eq_ignore_ascii_case(n));
    let mut found: Vec<(String, String)> = Vec::new();
    let mut add = |r: (String, String)| {
        if !known(&r.0, &r.1) && !found.contains(&r) && found.len() < MAX_RESOLVE {
            found.push(r);
        }
    };
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(8, '\t').collect();
        match f.as_slice() {
            ["G", _, url] | [_, url] => parse_remote(url).into_iter().for_each(&mut add),
            ["C", _, image, _, _, _, _, source] => {
                if let Some(r) = parse_remote(source) {
                    add(r);
                } else if let Some((o, p, _)) = parse_ghcr(image) {
                    // Image d'un dépôt du compte (`app-web` pour `app`) : rien à résoudre.
                    if !repos.iter().any(|(ro, rn)| ro.eq_ignore_ascii_case(&o) && package_matches(&p, rn)) {
                        add((o, p));
                    }
                }
            }
            _ => {}
        }
    }
    found
}

/// Anciens noms qui mènent à un dépôt du compte. `repos` : `(id s'il est connu, propriétaire, nom)` ; l'identifiant prime
/// sur le nom. Un nom qui se résout vers lui-même n'est pas un renommage (dépôt d'un tiers, simplement hors du compte).
pub fn link_renames(resolved: &[((String, String), Option<Resolved>)], repos: &[(Option<u64>, String, String)]) -> Vec<Rename> {
    resolved
        .iter()
        .filter_map(|((oo, on), r)| {
            let (id, o, n) = r.as_ref()?;
            if o.eq_ignore_ascii_case(oo) && n.eq_ignore_ascii_case(on) {
                return None;
            }
            let hit = repos
                .iter()
                .find(|(rid, _, _)| *rid == Some(*id))
                .or_else(|| repos.iter().find(|(_, ro, rn)| ro.eq_ignore_ascii_case(o) && rn.eq_ignore_ascii_case(n)))?;
            Some(((oo.to_ascii_lowercase(), on.to_ascii_lowercase()), (hit.1.clone(), hit.2.clone())))
        })
        .collect()
}

/// Ancien nom `owner/name` par lequel l'URL `url` désigne `owner/repo`, s'il passe par un renommage.
pub fn renamed_from(url: &str, owner: &str, repo: &str, renames: &[Rename]) -> Option<String> {
    let old = parse_remote(url)?;
    renames
        .iter()
        .find(|(from, (o, n))| *from == old && o.eq_ignore_ascii_case(owner) && n.eq_ignore_ascii_case(repo))
        .map(|((o, n), _)| format!("{o}/{n}"))
}

/// Remet `origin` sur le nom actuel du dépôt (`https://github.com/owner/repo.git`). Seulement dans un clone qui
/// appartient au compte SSH : comme `status`, on ne modifie pas la config d'un dépôt d'un autre utilisateur.
pub fn set_remote_command(dir: &str, owner: &str, repo: &str) -> Result<String> {
    if !valid_path(dir) || !valid_repo(owner, repo) {
        return Err(Error::Other("dépôt ou chemin invalide".into()));
    }
    let d = shell_quote(dir);
    Ok(sh(&format!(
        "if [ -O {d} ] && [ -O {d}/.git ]; then command git -c core.hooksPath=/dev/null -C {d} remote set-url origin {}; \
else echo 'clone appartenant à un autre utilisateur : URL du remote non modifiée' >&2; exit 1; fi",
        shell_quote(&format!("https://github.com/{owner}/{repo}.git"))
    )))
}

// ---- Validation ----------------------------------------------------------------------------

/// `^[A-Za-z0-9_.-]+$`, sans `.` ni `..`.
pub fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

pub fn valid_repo(owner: &str, repo: &str) -> bool {
    valid_slug(owner) && valid_slug(repo)
}

/// Chemin distant absolu, sans `..` ni caractère de contrôle, et qui n'est pas la racine.
pub fn valid_path(p: &str) -> bool {
    p.starts_with('/') && p.len() > 1 && p.len() <= 1024 && !p.chars().any(|c| c.is_control()) && !p.split('/').any(|seg| seg == "..")
}

// ---- Correspondance des URL ---------------------------------------------------------------

/// `(propriétaire, dépôt)` d'une URL `origin` GitHub, en minuscules (GitHub ignore la casse).
/// Formes reconnues : `https://[user@]github.com/o/r[.git]`, `git@github.com:o/r[.git]`,
/// `ssh://git@github.com[:22]/o/r[.git]`. Toute autre machine (GitLab, miroir…) donne `None`.
pub fn parse_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let rest = if let Some(r) = url.strip_prefix("https://").or_else(|| url.strip_prefix("ssh://")) {
        let (authority, path) = r.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?; // retire un éventuel port
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    } else {
        let (authority, path) = url.split_once(':')?;
        if !authority.eq_ignore_ascii_case("git@github.com") {
            return None;
        }
        path
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    valid_repo(owner, repo).then(|| (owner.to_ascii_lowercase(), repo.to_ascii_lowercase()))
}

pub fn same_repo(url: &str, owner: &str, repo: &str) -> bool {
    parse_remote(url) == Some((owner.to_ascii_lowercase(), repo.to_ascii_lowercase()))
}

// ---- Commandes distantes -------------------------------------------------------------------

/// Préfixe des commandes qui parlent à GitHub. Avec un jeton : il est lu sur l'entrée standard (jamais
/// dans la ligne de commande) et donné à git par un assistant limité à `https://github.com`, non
/// enregistré dans `.git/config`. Sans jeton : pas de saisie interactive.
/// Dans les deux cas git est enveloppé avec un durcissement : la config du dépôt (souvent d'un tiers) ne
/// doit ni rediriger le jeton (`http.proxy`, `sslVerify`) ni lancer de code (`fsmonitor`, hooks).
fn auth_prefix(with_token: bool) -> &'static str {
    if with_token {
        "IFS= read -r ZT; export ZT; GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT; git() { command git -c http.sslVerify=true -c http.proxy= -c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.https://github.com.helper=!f() { echo username=x-access-token; echo \"password=$ZT\"; }; f' \"$@\"; }; "
    } else {
        "GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT; git() { command git -c http.sslVerify=true -c http.proxy= -c core.fsmonitor=false -c core.hooksPath=/dev/null \"$@\"; }; "
    }
}

/// Entrée standard à envoyer avec une commande construite avec `with_token`.
pub fn token_stdin(token: &str) -> Vec<u8> {
    format!("{token}\n").into_bytes()
}

fn sh(script: &str) -> String {
    format!("sh -c {}", shell_quote(script))
}

/// Une seule commande par serveur : cherche les dépôts git sous les dossiers usuels et affiche `chemin<TAB>origin`.
pub fn scan_command() -> String {
    sh("t=''; command -v timeout >/dev/null 2>&1 && t='timeout 25'; \
$t find /srv /opt /var/www \"$HOME\" -maxdepth 5 -name node_modules -prune -o -name .git -type d -print 2>/dev/null | head -300 | \
while IFS= read -r g; do d=${g%/.git}; r=$(git -c safe.directory='*' -C \"$d\" remote get-url origin 2>/dev/null) && printf '%s\\t%s\\n' \"$d\" \"$r\"; done")
}

/// Chemins (sans doublon) des dépôts dont `origin` est `owner/repo`, directement ou par un ancien nom (`renames`) :
/// `(chemin, ancien nom encore dans origin)`.
pub fn parse_scan(out: &str, owner: &str, repo: &str, renames: &[Rename]) -> Vec<(String, Option<String>)> {
    let mut found: Vec<(String, Option<String>)> = Vec::new();
    for line in out.lines() {
        let Some((path, url)) = line.split_once('\t') else { continue };
        if !valid_path(path) || found.iter().any(|(p, _)| p == path) {
            continue;
        }
        if same_repo(url, owner, repo) {
            found.push((path.to_string(), None));
        } else if let Some(old) = renamed_from(url, owner, repo, renames) {
            found.push((path.to_string(), Some(old)));
        }
    }
    found
}

/// Clone présent sur un serveur.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Clone {
    pub path: String,
    pub branch: String,
    /// Nombre de fichiers modifiés ou non suivis (`git status --porcelain`).
    pub dirty: u32,
    /// `(en avance, en retard)` sur la branche suivie ; `None` sans branche suivie.
    pub ahead_behind: Option<(u32, u32)>,
    pub commit: String,
    pub commit_date: String,
    pub subject: String,
    /// `origin` désigne encore l'ancien nom `owner/name` d'un dépôt renommé (GitHub redirige, mais l'URL est périmée).
    pub old_remote: Option<String>,
}

/// État de chaque dossier. Les chiffres d'avance/retard valent depuis le dernier `fetch`.
pub fn details_command(dirs: &[String]) -> Result<String> {
    if dirs.is_empty() || !dirs.iter().all(|d| valid_path(d)) {
        return Err(Error::Other("chemin invalide".into()));
    }
    let list: Vec<String> = dirs.iter().map(|d| shell_quote(d)).collect();
    Ok(sh(&format!(
        "g() {{ git -c safe.directory='*' -C \"$d\" \"$@\"; }}; \
s() {{ git -c core.fsmonitor=false -c log.showSignature=false -c gpg.program=false -c core.hooksPath=/dev/null -C \"$d\" \"$@\"; }}; for d in {}; do \
b=$(g symbolic-ref --short -q HEAD || echo HEAD); c=$(g rev-list --left-right --count 'HEAD...@{{u}}' 2>/dev/null | tr '\\t' ' '); \
if [ -O \"$d\" ] && [ -O \"$d/.git\" ]; then n=$(s status --porcelain --ignore-submodules 2>/dev/null | wc -l | tr -d ' '); l=$(s log -1 --format='%h%x09%cI%x09%s' 2>/dev/null); \
else n=0; l=$(printf '%s\\t%s\\t%s' - - 'propriétaire différent'); fi; \
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$d\" \"$b\" \"$n\" \"${{c:--}}\" \"$l\"; done",
        list.join(" ")
    )))
}

pub fn parse_details(out: &str) -> Vec<Clone> {
    out.lines()
        .filter_map(|line| {
            let mut f = line.splitn(7, '\t');
            let (path, branch, dirty, counts) = (f.next()?, f.next()?, f.next()?, f.next()?);
            let ahead_behind = counts.split_once(' ').and_then(|(a, b)| Some((a.parse().ok()?, b.trim().parse().ok()?)));
            Some(Clone {
                path: path.to_string(),
                branch: branch.to_string(),
                dirty: dirty.trim().parse().ok()?,
                ahead_behind,
                commit: f.next().unwrap_or_default().to_string(),
                commit_date: f.next().unwrap_or_default().to_string(),
                subject: f.next().unwrap_or_default().to_string(),
                old_remote: None,
            })
        })
        .filter(|c| valid_path(&c.path))
        .collect()
}

/// `git fetch` d'un dossier (à la demande seulement).
pub fn fetch_command(dir: &str, with_token: bool) -> Result<String> {
    if !valid_path(dir) {
        return Err(Error::Other("chemin invalide".into()));
    }
    Ok(sh(&format!("{}git -C {} fetch --quiet", auth_prefix(with_token), shell_quote(dir))))
}

pub fn pull_command(dir: &str, with_token: bool) -> Result<String> {
    if !valid_path(dir) {
        return Err(Error::Other("chemin invalide".into()));
    }
    Ok(sh(&format!("{}git -C {} pull --ff-only", auth_prefix(with_token), shell_quote(dir))))
}

/// Clone `owner/repo` dans `<dossier>/<dépôt>` et renvoie `(commande, chemin du clone)`. L'URL enregistrée
/// dans `.git/config` est `https://github.com/owner/repo.git`, sans jeton.
pub fn clone_command(owner: &str, repo: &str, folder: &str, with_token: bool) -> Result<(String, String)> {
    if !valid_repo(owner, repo) || !valid_path(folder) {
        return Err(Error::Other("dépôt ou dossier invalide".into()));
    }
    let target = format!("{}/{repo}", folder.trim_end_matches('/'));
    let cmd = format!(
        "{}mkdir -p {} && git clone --quiet -- {} {}",
        auth_prefix(with_token),
        shell_quote(folder),
        shell_quote(&format!("https://github.com/{owner}/{repo}.git")),
        shell_quote(&target)
    );
    Ok((sh(&cmd), target))
}

// ---- Déploiements (clones, images GHCR, dossiers compose) ------------------------------------

/// Une seule commande par serveur : dépôts git (`G<TAB>chemin<TAB>origin`) puis conteneurs Docker
/// (`C<TAB>nom<TAB>image<TAB>état<TAB>création<TAB>projet compose<TAB>dossier compose<TAB>label source`). Lecture seule, sans sudo.
pub fn server_scan_command() -> String {
    sh(r#"t=''; command -v timeout >/dev/null 2>&1 && t='timeout 25'; T=$(printf '\t'); \
$t find /srv /opt /var/www "$HOME" -maxdepth 5 -name node_modules -prune -o -name .git -type d -print 2>/dev/null | head -300 | \
while IFS= read -r g; do d=${g%/.git}; r=$(git -c safe.directory='*' -C "$d" remote get-url origin 2>/dev/null) && printf 'G\t%s\t%s\n' "$d" "$r"; done; \
command -v docker >/dev/null 2>&1 && $t docker ps -a --format "C${T}{{.Names}}${T}{{.Image}}${T}{{.State}}${T}{{.CreatedAt}}${T}{{.Label \"com.docker.compose.project\"}}${T}{{.Label \"com.docker.compose.project.working_dir\"}}${T}{{.Label \"org.opencontainers.image.source\"}}" 2>/dev/null; true"#)
}

/// `(propriétaire, paquet, étiquette)` d'une image `ghcr.io/owner/pkg[:tag][@digest]`, en minuscules (sauf l'étiquette).
pub fn parse_ghcr(image: &str) -> Option<(String, String, String)> {
    let image = image.trim();
    let rest = image.get(..8).filter(|p| p.eq_ignore_ascii_case("ghcr.io/")).map(|_| &image[8..])?;
    let rest = rest.split('@').next()?;
    let (path, tag) = match rest.rsplit_once(':') {
        Some((p, t)) if !t.contains('/') => (p, t),
        _ => (rest, "latest"),
    };
    let mut seg = path.split('/');
    let (owner, pkg) = (seg.next()?, seg.next()?);
    (valid_repo(owner, pkg) && valid_slug(tag)).then(|| (owner.to_ascii_lowercase(), pkg.to_ascii_lowercase(), tag.to_string()))
}

/// Le paquet GHCR appartient-il au dépôt : même nom, ou `<dépôt>-suffixe` / `<dépôt>_suffixe` ?
pub fn package_matches(pkg: &str, repo: &str) -> bool {
    let (p, r) = (pkg.to_ascii_lowercase(), repo.to_ascii_lowercase());
    p == r || (p.len() > r.len() && p.starts_with(&r) && matches!(p.as_bytes()[r.len()], b'-' | b'_'))
}

/// Étiquette qui ressemble à un SHA de commit (7 à 40 hexadécimaux dont un chiffre et une lettre), éventuellement `sha-…`.
pub fn commit_sha(tag: &str) -> Option<String> {
    let t = tag.strip_prefix("sha-").unwrap_or(tag);
    let ok = (7..=40).contains(&t.len())
        && t.bytes().all(|b| b.is_ascii_hexdigit())
        && t.bytes().any(|b| b.is_ascii_digit())
        && t.bytes().any(|b| b.is_ascii_alphabetic());
    ok.then(|| t[..7].to_ascii_lowercase())
}

/// Nom de dossier comparable : minuscules, `_` ramené à `-`.
fn norm_name(s: &str) -> String {
    s.to_ascii_lowercase().replace('_', "-")
}

/// `2026-01-02 03:04:05 +0000 UTC` (docker) vers `2026-01-02T03:04:05+00:00`.
pub fn docker_date(s: &str) -> Option<String> {
    let mut p = s.split_whitespace();
    let (d, t, z) = (p.next()?, p.next()?, p.next()?);
    (d.len() == 10 && z.len() == 5 && (z.starts_with('+') || z.starts_with('-'))).then(|| format!("{d}T{t}{}:{}", &z[..3], &z[3..]))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub image: String,
    pub tag: String,
    /// Les 7 premiers caractères si l'étiquette est un SHA de commit.
    pub sha: Option<String>,
    pub state: String,
    pub created: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentKind {
    Clone,
    Image,
    ComposeDir,
}

/// Un endroit où tourne un dépôt sur un serveur. `certain` : clone avec `origin` correct, ou image / label qui correspond.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    /// `owner/repo` tel que listé par GitHub.
    pub repo: String,
    pub kind: DeploymentKind,
    pub certain: bool,
    /// Dossier du clone, ou dossier de travail compose.
    pub path: Option<String>,
    pub project: Option<String>,
    pub containers: Vec<ContainerInfo>,
}

struct Cont<'a> {
    name: &'a str,
    image: &'a str,
    state: &'a str,
    created: &'a str,
    project: &'a str,
    dir: &'a str,
    source: &'a str,
}

/// Dépôt (parmi `repos`) auquel appartient le conteneur : label source identique au dépôt, sinon image GHCR du même
/// propriétaire. En cas d'ambiguïté (`app` et `app-api`), le nom le plus long gagne.
/// Sinon, même règle sur l'ancien nom d'un dépôt renommé (`renames`).
fn container_repo<'a>(c: &Cont, repos: &'a [(String, String)], renames: &'a [Rename]) -> Option<&'a (String, String)> {
    if let Some(r) = repos.iter().find(|(o, n)| same_repo(c.source, o, n)) {
        return Some(r);
    }
    if let Some((_, r)) = renames.iter().find(|((o, n), _)| same_repo(c.source, o, n)) {
        return Some(r);
    }
    let (owner, pkg, _) = parse_ghcr(c.image)?;
    let by = |o: &str, n: &str| o.eq_ignore_ascii_case(&owner) && package_matches(&pkg, n);
    repos
        .iter()
        .filter(|(o, n)| by(o, n))
        .max_by_key(|(_, n)| n.len())
        .or_else(|| renames.iter().filter(|((o, n), _)| by(o, n)).max_by_key(|((_, n), _)| n.len()).map(|(_, r)| r))
}

/// Lit la sortie de `server_scan_command` et la rattache aux dépôts `(propriétaire, nom)` du compte, y compris par
/// l'ancien nom d'un dépôt renommé (`renames`, voir `link_renames`).
pub fn parse_deployments(out: &str, repos: &[(String, String)], renames: &[Rename]) -> Vec<Deployment> {
    let mut found: Vec<Deployment> = Vec::new();
    let mut conts: Vec<Cont> = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(8, '\t').collect();
        match f.as_slice() {
            ["G", path, url] if valid_path(path) => {
                let direct = repos.iter().filter(|(o, n)| same_repo(url, o, n));
                let renamed = renames.iter().filter(|((o, n), _)| same_repo(url, o, n)).map(|(_, r)| r);
                for (o, n) in direct.chain(renamed) {
                    let repo = format!("{o}/{n}");
                    if !found.iter().any(|d| d.kind == DeploymentKind::Clone && d.repo == repo && d.path.as_deref() == Some(path)) {
                        found.push(Deployment {
                            repo,
                            kind: DeploymentKind::Clone,
                            certain: true,
                            path: Some(path.to_string()),
                            project: None,
                            containers: vec![],
                        });
                    }
                }
            }
            ["C", name, image, state, created, project, dir, source] if valid_slug(name) => {
                conts.push(Cont { name, image, state, created, project, dir, source })
            }
            _ => {}
        }
    }
    let info = |c: &Cont| {
        let tag =
            parse_ghcr(c.image).map(|g| g.2).unwrap_or_else(|| c.image.rsplit_once(':').map(|(_, t)| t.to_string()).unwrap_or_default());
        ContainerInfo {
            name: c.name.into(),
            image: c.image.into(),
            sha: commit_sha(&tag),
            tag,
            state: c.state.into(),
            created: docker_date(c.created),
        }
    };
    // Images : un déploiement par (dépôt, projet compose), ou par conteneur hors compose.
    for c in &conts {
        let Some((o, n)) = container_repo(c, repos, renames) else { continue };
        let repo = format!("{o}/{n}");
        let project = (!c.project.is_empty()).then(|| c.project.to_string());
        let path = valid_path(c.dir).then(|| c.dir.to_string());
        let existing =
            found.iter_mut().find(|d| d.kind == DeploymentKind::Image && d.repo == repo && project.is_some() && d.project == project);
        if let Some(d) = existing {
            d.containers.push(info(c));
        } else {
            found.push(Deployment { repo, kind: DeploymentKind::Image, certain: true, path, project, containers: vec![info(c)] });
        }
    }
    // Dossiers compose au même nom que le dépôt, pas déjà couverts.
    let mut dirs: Vec<(&str, &str)> = conts.iter().filter(|c| valid_path(c.dir)).map(|c| (c.dir, c.project)).collect();
    dirs.sort();
    dirs.dedup();
    for (dir, project) in dirs {
        let base = norm_name(dir.rsplit('/').next().unwrap_or_default());
        for (o, n) in repos.iter().filter(|(_, n)| norm_name(n) == base) {
            let repo = format!("{o}/{n}");
            let covered = found.iter().any(|d| {
                d.repo == repo
                    && (d.path.as_deref() == Some(dir)
                        || (d.kind == DeploymentKind::Image && !project.is_empty() && d.project.as_deref() == Some(project)))
            });
            if !covered {
                let containers = conts.iter().filter(|c| c.dir == dir && c.project == project).map(info).collect();
                found.push(Deployment {
                    repo,
                    kind: DeploymentKind::ComposeDir,
                    certain: false,
                    path: Some(dir.into()),
                    project: (!project.is_empty()).then(|| project.into()),
                    containers,
                });
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repos() -> Vec<(String, String)> {
        ["MyPage", "scanlib", "Zenytt", "app", "app-api"].iter().map(|n| ("NathanChevrollier".to_string(), n.to_string())).collect()
    }

    #[test]
    fn images_ghcr() {
        assert_eq!(
            parse_ghcr("ghcr.io/nathanchevrollier/mypage-web:4f0aa05c"),
            Some(("nathanchevrollier".into(), "mypage-web".into(), "4f0aa05c".into()))
        );
        assert_eq!(parse_ghcr("GHCR.io/Octo/App@sha256:abc"), Some(("octo".into(), "app".into(), "latest".into())));
        assert_eq!(parse_ghcr("docker.io/library/nginx:1"), None);
        assert_eq!(parse_ghcr("ghcr.io/onlyowner"), None);
        assert!(package_matches("mypage-web", "MyPage") && package_matches("scanlib_worker", "scanlib") && package_matches("app", "app"));
        assert!(!package_matches("mypager", "mypage") && !package_matches("my", "mypage"));
        assert_eq!(commit_sha("4f0aa05c1d2e").as_deref(), Some("4f0aa05"));
        assert_eq!(commit_sha("sha-ABCDEF1234").as_deref(), Some("abcdef1"));
        for t in ["latest", "1.2.3", "1234567", "abcdefg", "deadbee"] {
            assert_eq!(commit_sha(t), None, "{t}");
        }
        assert_eq!(docker_date("2026-01-02 03:04:05 +0100 CET").as_deref(), Some("2026-01-02T03:04:05+01:00"));
    }

    #[test]
    fn deploiements_mypage_et_scanlib() {
        let out = "G\t/var/www/html/Zenytt\thttps://github.com/NathanChevrollier/Zenytt.git\n\
G\t/var/www/html/scanlib\tgit@github.com:nathanchevrollier/scanlib.git\n\
G\t/x/other\thttps://gitlab.com/NathanChevrollier/MyPage.git\n\
C\tmypage-web-1\tghcr.io/nathanchevrollier/mypage-web:4f0aa05c1d2e\trunning\t2026-01-02 03:04:05 +0000 UTC\tmypage\t/srv/apps/mypage\thttps://github.com/nginx/docker-nginx-unprivileged\n\
C\tmypage-status-1\tghcr.io/nathanchevrollier/mypage-status:4f0aa05c1d2e\texited\t2026-01-02 03:04:05 +0000 UTC\tmypage\t/srv/apps/mypage\t\n\
C\tlab\tmyimg:1\trunning\t2026-01-02 03:04:05 +0000 UTC\t\t\thttps://github.com/NathanChevrollier/scanlib\n\
C\tapi\tghcr.io/nathanchevrollier/app-api:v1\trunning\t2026-01-02 03:04:05 +0000 UTC\t\t\t\n\
C\tzenytt-sync\tnode:20\trunning\t2026-01-02 03:04:05 +0000 UTC\tzenytt-sync\t/opt/stacks/zenytt-sync\t\n\
C\tfoo\tnode:20\trunning\t2026-01-02 03:04:05 +0000 UTC\tscan_lib\t/opt/scan_lib\t\n\
C\tfoo2\tnode:20\trunning\t2026-01-02 03:04:05 +0000 UTC\tx\t/opt/stacks/mypage\t\nbad\n";
        let d = parse_deployments(out, &repos(), &[]);
        let of =
            |r: &str, k: DeploymentKind| d.iter().filter(|x| x.repo == format!("NathanChevrollier/{r}") && x.kind == k).collect::<Vec<_>>();
        assert_eq!(of("Zenytt", DeploymentKind::Clone).len(), 1);
        assert_eq!(of("MyPage", DeploymentKind::Clone).len(), 0, "gitlab ignoré");
        let img = of("MyPage", DeploymentKind::Image);
        assert_eq!(img.len(), 1);
        assert!(img[0].certain && img[0].project.as_deref() == Some("mypage") && img[0].path.as_deref() == Some("/srv/apps/mypage"));
        assert_eq!(img[0].containers.len(), 2, "le label vers nginx n'a aucun effet");
        assert_eq!(img[0].containers[0].sha.as_deref(), Some("4f0aa05"));
        assert_eq!(img[0].containers[1].state, "exited");
        // /srv/apps/mypage est couvert par l'image ; /opt/stacks/mypage ne l'est pas : « probable »
        let probable = of("MyPage", DeploymentKind::ComposeDir);
        assert_eq!(probable.len(), 1);
        assert!(!probable[0].certain && probable[0].path.as_deref() == Some("/opt/stacks/mypage"));
        // label source identique -> image certaine
        assert_eq!(of("scanlib", DeploymentKind::Image).len(), 1);
        assert_eq!(of("scanlib", DeploymentKind::ComposeDir).len(), 0, "scan_lib != scanlib");
        // le nom le plus long gagne
        assert_eq!(of("app-api", DeploymentKind::Image).len(), 1);
        assert_eq!(of("app", DeploymentKind::Image).len(), 0);
        assert_eq!(of("Zenytt", DeploymentKind::ComposeDir).len(), 0);
        assert!(server_scan_command().contains("docker ps -a --format"));
    }

    // Cas réel : dépôt renommé Helm -> Zenytt sur GitHub, clone du VPS resté sur l'ancienne URL.
    #[test]
    fn depot_renomme_rattache_par_id() {
        let out = "G\t/var/www/html/Zenytt\thttps://github.com/NathanChevrollier/Helm.git\n\
G\t/srv/app\thttps://github.com/NathanChevrollier/app.git\n\
G\t/srv/tiers\thttps://github.com/octo/lib.git\n\
G\t/srv/tiers2\tgit@github.com:octo/lib.git\n\
C\thelm-web\tghcr.io/nathanchevrollier/helm-web:4f0aa05c1d2e\trunning\t2026-01-02 03:04:05 +0000 UTC\t\t\t\n\
C\tmypage\tghcr.io/nathanchevrollier/mypage-web:1\trunning\t2026-01-02 03:04:05 +0000 UTC\t\t\t\n";
        let unknown = unknown_remotes(out, &repos());
        assert_eq!(
            unknown,
            vec![
                ("nathanchevrollier".into(), "helm".into()),
                ("octo".into(), "lib".into()),
                ("nathanchevrollier".into(), "helm-web".into())
            ],
            "dépôts du compte et images de leurs paquets exclus, sans doublon"
        );
        let resolved = vec![
            (unknown[0].clone(), Some((42, "NathanChevrollier".to_string(), "Zenytt".to_string()))),
            (unknown[1].clone(), Some((7, "octo".to_string(), "lib".to_string()))),
            (unknown[2].clone(), None),
        ];
        // L'identifiant prime : le compte liste encore « Zenytt-old » sous l'id 42 (liste pas encore actualisée).
        let account =
            vec![(Some(42), "NathanChevrollier".to_string(), "Zenytt-old".to_string()), (None, "octo".to_string(), "x".to_string())];
        let r = link_renames(&resolved, &account);
        assert_eq!(r, vec![(("nathanchevrollier".into(), "helm".into()), ("NathanChevrollier".into(), "Zenytt-old".into()))]);
        // Sans id : rattaché par le nom actuel ; un dépôt tiers qui se résout vers lui-même n'est pas un renommage.
        let r = link_renames(&resolved, &[(None, "NathanChevrollier".into(), "Zenytt".into()), (None, "octo".into(), "lib".into())]);
        assert_eq!(r, vec![(("nathanchevrollier".into(), "helm".into()), ("NathanChevrollier".into(), "Zenytt".into()))]);

        let d = parse_deployments(out, &repos(), &r);
        let z: Vec<_> = d.iter().filter(|x| x.repo == "NathanChevrollier/Zenytt").collect();
        assert_eq!(z.len(), 2, "clone et image helm-web rattachés à Zenytt");
        assert!(z.iter().any(|x| x.kind == DeploymentKind::Clone && x.path.as_deref() == Some("/var/www/html/Zenytt")));
        assert!(z.iter().any(|x| x.kind == DeploymentKind::Image && x.certain));
        assert_eq!(parse_deployments(out, &repos(), &[]).iter().filter(|x| x.repo == "NathanChevrollier/Zenytt").count(), 0);

        let scan =
            "/var/www/html/Zenytt\thttps://github.com/NathanChevrollier/Helm.git\n/srv/z\thttps://github.com/nathanchevrollier/zenytt\n";
        assert_eq!(
            parse_scan(scan, "NathanChevrollier", "Zenytt", &r),
            vec![("/var/www/html/Zenytt".into(), Some("nathanchevrollier/helm".into())), ("/srv/z".into(), None)]
        );
        assert_eq!(
            renamed_from("git@github.com:NathanChevrollier/helm.git", "nathanchevrollier", "zenytt", &r).as_deref(),
            Some("nathanchevrollier/helm")
        );
        assert_eq!(renamed_from("https://github.com/NathanChevrollier/Helm.git", "octo", "app", &r), None, "autre dépôt");
    }

    #[test]
    fn lecture_d_un_depot_resolu_et_remote() {
        let json = r#"{"id":42,"full_name":"NathanChevrollier/Zenytt","name":"Zenytt","owner":{"login":"NathanChevrollier"}}"#;
        assert_eq!(parse_repo_ref(json), Some((42, "NathanChevrollier".into(), "Zenytt".into())));
        assert_eq!(parse_repo_ref(r#"{"id":1,"full_name":"o/a b","name":"a b","owner":{"login":"o"}}"#), None);
        assert_eq!(parse_repo_ref(r#"{"message":"Moved Permanently"}"#), None);
        let c = set_remote_command("/var/www/html/it's", "NathanChevrollier", "Zenytt").unwrap();
        assert!(
            c.starts_with("sh -c '")
                && c.contains("remote set-url origin")
                && c.contains("https://github.com/NathanChevrollier/Zenytt.git")
        );
        assert!(c.contains("[ -O") && c.contains("core.hooksPath=/dev/null"), "seulement dans un clone du compte SSH, sans hook");
        assert!(set_remote_command("/srv/../etc", "o", "r").is_err() && set_remote_command("/srv/a", "o;x", "r").is_err());
    }

    #[test]
    fn erreurs_http() {
        let perm = r#"{"message":"Resource not accessible by personal access token"}"#;
        assert!(map_http_error(401, None, None, "").contains("jeton refusé"));
        assert!(map_http_error(403, Some("0"), None, "").contains("rate limit"));
        assert!(map_http_error(403, None, Some("60"), "").contains("rate limit"));
        let p = map_http_error(403, Some("4000"), None, perm);
        assert!(p.contains("permission manquante") && p.contains("Resource not accessible") && !p.contains("rate limit"));
        assert!(map_http_error(429, None, None, "").contains("429"));
        assert!(map_http_error(404, None, None, "").contains("introuvable"));
    }

    #[test]
    fn urls_origin_reconnues() {
        let ok = |u: &str| parse_remote(u) == Some(("octo".into(), "app".into()));
        assert!(ok("https://github.com/octo/app.git"));
        assert!(ok("https://github.com/octo/app"));
        assert!(ok("https://github.com/Octo/App/"));
        assert!(ok("https://x-access-token@github.com/octo/app.git"));
        assert!(ok("git@github.com:octo/app.git"));
        assert!(ok("ssh://git@github.com/octo/app.git"));
        assert!(ok("ssh://git@github.com:22/octo/app"));
        assert!(!same_repo("https://github.com/octo/app2.git", "octo", "app"));
        assert!(same_repo("git@github.com:OCTO/app.git", "octo", "App"));
    }

    #[test]
    fn urls_etrangeres_refusees() {
        for u in [
            "https://gitlab.com/octo/app.git",
            "https://github.com.evil.io/octo/app.git",
            "https://evil.io/github.com/octo/app.git",
            "git@gitlab.com:octo/app.git",
            "https://github.com/octo",
            "https://github.com/octo/app/extra",
            "https://github.com/octo/ap p",
            "/srv/local/repo",
            "",
        ] {
            assert_eq!(parse_remote(u), None, "{u}");
        }
    }

    #[test]
    fn validation() {
        assert!(valid_repo("octo-cat", "my.repo_2"));
        for bad in ["", ".", "..", "a/b", "a b", "a;b", "a$(x)", "é"] {
            assert!(!valid_slug(bad), "{bad}");
        }
        assert!(valid_path("/srv/app"));
        for bad in ["srv/app", "/", "/srv/../etc", "/srv/a\nb", "~/x", ""] {
            assert!(!valid_path(bad), "{bad:?}");
        }
        assert!(valid_token("github_pat_11AB_cd-ef") && valid_token("ghp_abc123"));
        assert!(!valid_token("") && !valid_token("a b") && !valid_token("a\nb") && !valid_token("a'b"));
    }

    #[test]
    fn lecture_du_scan() {
        let out = "/srv/app\thttps://github.com/octo/app.git\n/home/u/app\tgit@github.com:octo/app.git\n\
/srv/app\thttps://github.com/octo/app\n/opt/other\thttps://github.com/octo/other\n/srv/x\ngarbage\n/etc/../x\thttps://github.com/octo/app\n";
        assert_eq!(parse_scan(out, "octo", "app", &[]), vec![("/srv/app".into(), None), ("/home/u/app".into(), None)]);
    }

    #[test]
    fn lecture_des_details() {
        let out = "/srv/app\tmain\t3\t1 2\tabc1234\t2026-01-02T03:04:05+00:00\tfix: a\tb\n/srv/b\tdev\t0\t-\t\t\t\nbad line\n";
        let c = parse_details(out);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].dirty, c[0].ahead_behind), (3, Some((1, 2))));
        assert_eq!(c[0].subject, "fix: a\tb");
        assert_eq!(c[1].ahead_behind, None);
    }

    #[test]
    fn commandes_citees_et_sans_jeton() {
        let (cmd, target) = clone_command("octo", "app", "/srv/it's", true).unwrap();
        assert_eq!(target, "/srv/it's/app");
        assert!(cmd.starts_with("sh -c '"));
        assert!(cmd.contains("read -r ZT"), "le jeton vient de l'entrée standard");
        assert!(cmd.contains("credential.https://github.com.helper"), "limité à github.com");
        assert!(cmd.contains("https://github.com/octo/app.git") && !cmd.contains("@github.com"));
        assert!(!clone_command("octo", "app", "/srv", false).unwrap().0.contains("read -r"));
        assert!(clone_command("octo;rm", "app", "/srv", false).is_err());
        assert!(clone_command("octo", "app", "srv/../x", false).is_err());
        assert!(pull_command("/srv/a b", false).unwrap().contains("--ff-only"));
        assert!(pull_command("/srv/$(x)", false).unwrap().contains("'/srv/$(x)'"), "cité, donc inerte");
        assert!(pull_command("../x", false).is_err() && fetch_command("rel", false).is_err());
        assert!(details_command(&["/srv/a".into(), "/srv/b".into()]).unwrap().contains("'/srv/b'"));
        assert!(details_command(&[]).is_err());
    }

    #[test]
    fn status_et_log_exigent_le_meme_proprietaire() {
        let c = details_command(&["/srv/a".into()]).unwrap();
        // `status` et `log` passent par `s()` : jamais de safe.directory, durcis, derrière le test de propriétaire.
        assert!(c.contains("[ -O") && c.contains("propriétaire différent"));
        assert!(c.contains("s status --porcelain --ignore-submodules") && c.contains("s log -1"));
        assert!(!c.contains("g status") && !c.contains("g log"));
        let s_def = &c[c.find("s() {").unwrap()..];
        let s_def = &s_def[..s_def.find("; };").unwrap()];
        assert!(!s_def.contains("safe.directory"));
        for h in ["core.fsmonitor=false", "log.showSignature=false", "gpg.program=false", "core.hooksPath=/dev/null"] {
            assert!(s_def.contains(h), "{h}");
        }
    }

    #[test]
    fn git_authentifie_est_durci() {
        for t in [true, false] {
            let c = pull_command("/srv/a", t).unwrap();
            for h in ["http.sslVerify=true", "http.proxy=", "core.fsmonitor=false", "core.hooksPath=/dev/null"] {
                assert!(c.contains(h), "{t} {h}");
            }
        }
    }

    // Formes relevées sur l'API (Zenytt) puis réduites ; les alertes suivent la documentation de l'API Dependabot.
    #[test]
    fn lecture_des_runs() {
        let json = r#"{"total_count":2,"workflow_runs":[
{"id":1,"name":"Mobile","display_title":"Mobile","head_branch":"feat/mobile-ipa","event":"workflow_dispatch","status":"queued","conclusion":null,
"html_url":"https://github.com/NathanChevrollier/Zenytt/actions/runs/39993224328","run_started_at":"2026-10-23T17:12:55Z","created_at":"2026-10-23T17:12:50Z","updated_at":"2026-10-23T17:12:55Z"},
{"id":2,"name":null,"display_title":"CI","head_branch":"main","event":"push","status":"completed","conclusion":"failure",
"html_url":"https://evil.example/x","run_started_at":null,"created_at":"2026-10-23T10:00:00Z","updated_at":"2026-10-23T10:04:30Z"}]}"#;
        let r = parse_runs(json).unwrap();
        assert_eq!((r[0].status.as_str(), r[0].conclusion.clone()), ("queued", None));
        assert_eq!(r[0].url.as_deref(), Some("https://github.com/NathanChevrollier/Zenytt/actions/runs/39993224328"));
        assert_eq!(
            (r[1].name.as_str(), r[1].conclusion.as_deref(), r[1].url.clone()),
            ("CI", Some("failure"), None),
            "hôte étranger écarté"
        );
        assert_eq!(r[1].started_at.as_deref(), Some("2026-10-23T10:00:00Z"));
        assert_eq!(parse_runs(r#"{"total_count":0,"workflow_runs":[]}"#).unwrap(), vec![]);
        assert!(parse_runs("[]").is_err());
    }

    #[test]
    fn lecture_des_pr_et_tickets_sans_melange() {
        let pulls = r#"[{"number":45,"title":"Refonte","draft":false,"html_url":"https://github.com/o/r/pull/45","created_at":"2026-10-23T16:45:08Z","user":{"login":"octo"}},
{"number":46,"title":"WIP","draft":true,"html_url":"https://github.com/o/r/pull/46","user":null}]"#;
        let p = parse_pulls(pulls).unwrap();
        assert_eq!((p[0].number, p[0].draft, p[0].author.as_str()), (45, false, "octo"));
        assert!(p[1].draft && p[1].author.is_empty());
        let issues = r#"[{"number":45,"title":"une PR","html_url":"https://github.com/o/r/pull/45","labels":[],"pull_request":{"url":"https://api.github.com/repos/o/r/pulls/45"},"user":{"login":"octo"}},
{"number":44,"title":"Suggestion","html_url":"https://github.com/o/r/issues/44","labels":[{"name":"enhancement","color":"a2eeef"},{"name":"x","color":"red;}"}],"pull_request":null,"created_at":"2026-10-23T15:56:20Z","user":{"login":"octo"}}]"#;
        let i = parse_issues(issues).unwrap();
        assert_eq!(i.len(), 1, "la PR est exclue");
        assert_eq!(i[0].number, 44);
        assert_eq!((i[0].labels[0].color.as_str(), i[0].labels[1].color.as_str()), ("a2eeef", ""));
    }

    #[test]
    fn lecture_des_alertes_triees() {
        let json = r#"[
{"number":3,"state":"open","dependency":{"package":{"ecosystem":"npm","name":"lodash"},"manifest_path":"pnpm-lock.yaml","scope":"runtime"},
"security_advisory":{"ghsa_id":"GHSA-x","summary":"Prototype pollution","severity":"medium"},"html_url":"https://github.com/o/r/security/dependabot/3","created_at":"2026-01-01T00:00:00Z"},
{"number":4,"state":"open","dependency":{"package":{"ecosystem":"rust","name":"tokio"},"manifest_path":"Cargo.lock"},
"security_advisory":{"summary":"Boum","severity":"critical"},"html_url":"https://github.com/o/r/security/dependabot/4"}]"#;
        let a = parse_alerts(json).unwrap();
        assert_eq!(
            (a[0].package.as_str(), a[0].severity.as_str(), a[0].ecosystem.as_str(), a[0].manifest.as_str()),
            ("tokio", "critical", "rust", "Cargo.lock")
        );
        assert_eq!(a[1].package, "lodash");
        assert_eq!(parse_alerts("[]").unwrap(), vec![]);
    }

    #[test]
    fn lecture_des_deploiements_et_version() {
        let json = r#"[{"url":"https://api.github.com/repos/o/r/deployments/7281125823","id":7281125823,"sha":"4f0aa05c1d2e3f4a","ref":"v1.3.0","task":"deploy",
"environment":"release","creator":{"login":"octo","id":1},"created_at":"2026-10-23T14:45:04Z"}]"#;
        let d = parse_gh_deployments(json).unwrap();
        assert_eq!(
            (d[0].environment.as_str(), d[0].reference.as_str(), d[0].sha.as_str(), d[0].creator.as_str()),
            ("release", "v1.3.0", "4f0aa05", "octo")
        );
        assert_eq!(parse_deployment_state(r#"[{"state":"success","id":1},{"state":"in_progress"}]"#).as_deref(), Some("success"));
        assert_eq!(parse_deployment_state("[]"), None);
        let rel = parse_release(r#"{"tag_name":"v1.3.0","name":"Zenytt v1.3.0","prerelease":false,"published_at":"2026-10-23T14:45:16Z","html_url":"https://github.com/o/r/releases/tag/v1.3.0"}"#).unwrap();
        assert_eq!((rel.tag.as_str(), rel.name.as_deref(), rel.prerelease), ("v1.3.0", Some("Zenytt v1.3.0"), false));
    }

    #[test]
    fn adresses_de_l_api() {
        let p = |i, b: Option<&str>, n| insight_path(i, "octo", "app", b, n);
        assert_eq!(
            p(Insight::Ci, Some("feat/x"), 1).unwrap(),
            "https://api.github.com/repos/octo/app/actions/runs?per_page=1&branch=feat/x"
        );
        assert!(p(Insight::Ci, None, 999).unwrap().ends_with("per_page=30"));
        assert!(p(Insight::Ci, Some("a&b"), 1).is_err() && p(Insight::Ci, Some(""), 1).is_err());
        assert!(p(Insight::Release, None, 1).unwrap().ends_with("/releases/latest"));
        assert!(
            insight_path(Insight::Pulls, "o/x", "app", None, 1).is_err() && insight_path(Insight::Pulls, "octo", "..", None, 1).is_err()
        );
    }

    #[test]
    fn lecture_des_depots() {
        let json = r#"[{"id":9,"full_name":"octo/app","name":"app","owner":{"login":"octo"},"private":true,"default_branch":"main",
"pushed_at":"2026-01-01T00:00:00Z","open_issues_count":4,"description":null,"fork":false,"archived":false},
{"full_name":"octo/bad name","name":"bad name","owner":{"login":"octo"}}]"#;
        let r = parse_repos(json).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].id == 9 && r[0].private && r[0].open_issues == 4 && r[0].default_branch == "main");
        assert!(parse_repos("pas du json").is_err());
    }
}
