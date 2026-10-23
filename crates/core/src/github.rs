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
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).http_status_as_error(false).build().into()
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

/// Chemins (sans doublon) des dépôts dont `origin` est `owner/repo`.
pub fn parse_scan(out: &str, owner: &str, repo: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in out.lines() {
        let Some((path, url)) = line.split_once('\t') else { continue };
        if valid_path(path) && same_repo(url, owner, repo) && !found.iter().any(|p| p == path) {
            found.push(path.to_string());
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
fn container_repo<'a>(c: &Cont, repos: &'a [(String, String)]) -> Option<&'a (String, String)> {
    if let Some(r) = repos.iter().find(|(o, n)| same_repo(c.source, o, n)) {
        return Some(r);
    }
    let (owner, pkg, _) = parse_ghcr(c.image)?;
    repos.iter().filter(|(o, n)| o.eq_ignore_ascii_case(&owner) && package_matches(&pkg, n)).max_by_key(|(_, n)| n.len())
}

/// Lit la sortie de `server_scan_command` et la rattache aux dépôts `(propriétaire, nom)` du compte.
pub fn parse_deployments(out: &str, repos: &[(String, String)]) -> Vec<Deployment> {
    let mut found: Vec<Deployment> = Vec::new();
    let mut conts: Vec<Cont> = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(8, '\t').collect();
        match f.as_slice() {
            ["G", path, url] if valid_path(path) => {
                for (o, n) in repos.iter().filter(|(o, n)| same_repo(url, o, n)) {
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
        let Some((o, n)) = container_repo(c, repos) else { continue };
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
        let d = parse_deployments(out, &repos());
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
        assert_eq!(parse_scan(out, "octo", "app"), vec!["/srv/app", "/home/u/app"]);
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

    #[test]
    fn lecture_des_depots() {
        let json = r#"[{"full_name":"octo/app","name":"app","owner":{"login":"octo"},"private":true,"default_branch":"main",
"pushed_at":"2026-01-01T00:00:00Z","open_issues_count":4,"description":null,"fork":false,"archived":false},
{"full_name":"octo/bad name","name":"bad name","owner":{"login":"octo"}}]"#;
        let r = parse_repos(json).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].private && r[0].open_issues == 4 && r[0].default_branch == "main");
        assert!(parse_repos("pas du json").is_err());
    }
}
