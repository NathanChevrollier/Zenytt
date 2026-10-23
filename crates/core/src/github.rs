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
    let text = resp.body_mut().read_to_string().map_err(|e| Error::Other(e.to_string()))?;
    match status {
        200..=299 => Ok(text),
        401 | 403 => Err(Error::Other("jeton refusé par GitHub (401/403) : expiré, révoqué ou sans droit de lecture".into())),
        s => Err(Error::Other(format!("GitHub a répondu {s}"))),
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
            let text = get(&agent, &token, &format!("{API}/user/repos?per_page=100&sort=updated&page={page}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
