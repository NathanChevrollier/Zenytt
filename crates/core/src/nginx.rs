//! nginx : analyse des vhosts, certificats, et application sûre des modifications
//! (sauvegarde → écriture → `nginx -t` → reload, avec restauration automatique en cas d'échec).

use serde::{Deserialize, Serialize};

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

// ---------- Parseur ----------

#[derive(Debug, Clone, PartialEq)]
pub struct Directive {
    pub name: String,
    pub args: Vec<String>,
    pub block: Option<Vec<Directive>>,
    pub line: usize,
}

#[derive(Debug, PartialEq)]
enum Token {
    Word(String, usize),
    Open(usize),
    Close(usize),
    Semi(usize),
}

fn tokenize(src: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = src.chars().peekable();
    let mut line = 1;
    while let Some(&c) = chars.peek() {
        match c {
            '\n' => {
                line += 1;
                chars.next();
            }
            c if c.is_whitespace() => {
                chars.next();
            }
            '#' => {
                while let Some(&c) = chars.peek() {
                    if c == '\n' {
                        break;
                    }
                    chars.next();
                }
            }
            '{' => {
                out.push(Token::Open(line));
                chars.next();
            }
            '}' => {
                out.push(Token::Close(line));
                chars.next();
            }
            ';' => {
                out.push(Token::Semi(line));
                chars.next();
            }
            '"' | '\'' => {
                let quote = c;
                chars.next();
                let mut word = String::new();
                while let Some(c) = chars.next() {
                    if c == '\\' {
                        if let Some(n) = chars.next() {
                            word.push(n);
                        }
                    } else if c == quote {
                        break;
                    } else {
                        if c == '\n' {
                            line += 1;
                        }
                        word.push(c);
                    }
                }
                out.push(Token::Word(word, line));
            }
            _ => {
                let mut word = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || c == ';' || c == '{' || c == '}' {
                        break;
                    }
                    word.push(c);
                    chars.next();
                }
                out.push(Token::Word(word, line));
            }
        }
    }
    out
}

/// Analyse un fichier de configuration nginx en arbre de directives.
pub fn parse(src: &str) -> Vec<Directive> {
    let tokens = tokenize(src);
    let mut pos = 0;
    parse_block(&tokens, &mut pos)
}

fn parse_block(tokens: &[Token], pos: &mut usize) -> Vec<Directive> {
    let mut out = Vec::new();
    let mut words: Vec<(String, usize)> = Vec::new();
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Token::Word(w, l) => {
                words.push((w.clone(), *l));
                *pos += 1;
            }
            Token::Semi(_) => {
                *pos += 1;
                if let Some(((name, line), args)) = words.split_first() {
                    out.push(Directive { name: name.clone(), args: args.iter().map(|a| a.0.clone()).collect(), block: None, line: *line });
                }
                words.clear();
            }
            Token::Open(l) => {
                *pos += 1;
                let block = parse_block(tokens, pos);
                let (name, line) = words.first().cloned().unwrap_or_default();
                out.push(Directive {
                    name,
                    args: words.iter().skip(1).map(|a| a.0.clone()).collect(),
                    block: Some(block),
                    line: if line == 0 { *l } else { line },
                });
                words.clear();
            }
            Token::Close(_) => {
                *pos += 1;
                return out;
            }
        }
    }
    out
}

// ---------- Résumé des vhosts ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    pub proxy_pass: Option<String>,
    pub root: Option<String>,
    pub returns: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerBlock {
    pub server_names: Vec<String>,
    pub listen: Vec<String>,
    pub ssl: bool,
    pub root: Option<String>,
    pub ssl_certificate: Option<String>,
    /// Redirection globale (`return 301 https://…` au niveau du server).
    pub returns: Option<String>,
    pub locations: Vec<Location>,
    pub line: usize,
    /// Ports locaux ciblés par les `proxy_pass` (127.0.0.1:PORT, localhost:PORT).
    pub upstream_ports: Vec<u16>,
}

fn find<'a>(dirs: &'a [Directive], name: &str) -> Option<&'a Directive> {
    dirs.iter().find(|d| d.name == name)
}

/// Extrait le port local d'une cible `proxy_pass` (`http://127.0.0.1:3000/` → 3000).
pub fn local_port(target: &str) -> Option<u16> {
    let rest = target.split_once("://").map(|x| x.1).unwrap_or(target);
    let hostport = rest.split('/').next()?;
    let (host, port) = hostport.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if ["127.0.0.1", "localhost", "0.0.0.0", "::1"].contains(&host) {
        port.parse().ok()
    } else {
        None
    }
}

fn collect_servers(dirs: &[Directive], out: &mut Vec<ServerBlock>) {
    for d in dirs {
        let Some(block) = &d.block else { continue };
        if d.name == "server" {
            let listen: Vec<String> = block.iter().filter(|x| x.name == "listen").map(|x| x.args.join(" ")).collect();
            let ssl = listen.iter().any(|l| l.contains("ssl") || l.contains("443")) || find(block, "ssl_certificate").is_some();
            let locations: Vec<Location> = block
                .iter()
                .filter(|x| x.name == "location")
                .map(|l| {
                    let inner = l.block.as_deref().unwrap_or_default();
                    Location {
                        path: l.args.join(" "),
                        proxy_pass: find(inner, "proxy_pass").and_then(|p| p.args.first().cloned()),
                        root: find(inner, "root").or_else(|| find(inner, "alias")).and_then(|p| p.args.first().cloned()),
                        returns: find(inner, "return").map(|r| r.args.join(" ")),
                    }
                })
                .collect();
            let mut upstream_ports: Vec<u16> = locations.iter().filter_map(|l| l.proxy_pass.as_deref().and_then(local_port)).collect();
            if let Some(p) = find(block, "proxy_pass").and_then(|p| p.args.first()).and_then(|t| local_port(t)) {
                upstream_ports.push(p);
            }
            upstream_ports.dedup();
            out.push(ServerBlock {
                server_names: block.iter().filter(|x| x.name == "server_name").flat_map(|x| x.args.clone()).collect(),
                listen,
                ssl,
                root: find(block, "root").and_then(|r| r.args.first().cloned()),
                ssl_certificate: find(block, "ssl_certificate").and_then(|r| r.args.first().cloned()),
                returns: find(block, "return").map(|r| r.args.join(" ")),
                locations,
                line: d.line,
                upstream_ports,
            });
        } else {
            // http { … } ou autre bloc englobant.
            collect_servers(block, out);
        }
    }
}

pub fn servers(src: &str) -> Vec<ServerBlock> {
    let mut out = Vec::new();
    collect_servers(&parse(src), &mut out);
    out
}

// ---------- Découverte sur le serveur ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteFile {
    /// Chemin tel que listé (lien dans sites-enabled, ou fichier de conf.d).
    pub path: String,
    /// Fichier réel (cible du lien).
    pub real_path: String,
    pub enabled: bool,
    pub servers: Vec<ServerBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    pub path: String,
    pub subject: String,
    pub domains: Vec<String>,
    /// Horodatage Unix (secondes) d'expiration.
    pub not_after: i64,
    pub issuer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxState {
    pub installed: bool,
    pub version: String,
    pub running: bool,
    pub files: Vec<SiteFile>,
    /// Sites présents dans sites-available mais non activés.
    pub disabled: Vec<SiteFile>,
    pub certificates: Vec<Certificate>,
    pub certbot: bool,
    /// Autres serveurs web ou reverse proxies détectés (Caddy, Apache, Traefik…).
    pub others: Vec<String>,
    /// Dossier de configuration (`/etc/nginx`, `/etc/apache2` ou `/etc/httpd`).
    pub conf_root: String,
}

const DISCOVER_SCRIPT: &str = r#"for b in caddy apache2 httpd traefik lighttpd haproxy; do command -v "$b" >/dev/null 2>&1 && echo "@@OTHER $b"; done
docker ps --format '{{.Image}}' 2>/dev/null | grep -Eio 'traefik|caddy|nginx-proxy-manager|nginx-proxy|haproxy' | sort -u | sed 's/^/@@OTHER docker:/'
command -v nginx >/dev/null 2>&1 || { echo @@NONGINX; exit 0; }
echo "@@VERSION $(nginx -v 2>&1)"
if pgrep -x nginx >/dev/null 2>&1; then echo @@RUNNING; fi
command -v certbot >/dev/null 2>&1 && echo @@CERTBOT
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  echo "@@FILE enabled $f $(readlink -f "$f")"
  cat "$f"; echo
done
enabled_real="
$(readlink -f /etc/nginx/sites-enabled/* 2>/dev/null)
"
for f in /etc/nginx/sites-available/*; do
  [ -f "$f" ] || continue
  real=$(readlink -f "$f")
  case "$enabled_real" in *"
$real
"*) continue ;; esac
  echo "@@FILE disabled $f $real"
  cat "$f"; echo
done
"#;

/// Analyse la sortie du script de découverte.
pub fn parse_discovery(out: &str) -> NginxState {
    parse_discovery_with(out, "@@NONGINX", "nginx version: ", servers)
}

/// Analyse commune à nginx et Apache : seuls le marqueur « absent », le préfixe de version et
/// l'analyse des vhosts diffèrent.
pub(crate) fn parse_discovery_with(out: &str, absent: &str, version_prefix: &str, servers: fn(&str) -> Vec<ServerBlock>) -> NginxState {
    let mut state = NginxState {
        installed: true,
        version: String::new(),
        running: false,
        files: vec![],
        disabled: vec![],
        certificates: vec![],
        certbot: false,
        others: vec![],
        conf_root: "/etc/nginx".into(),
    };
    for o in out.lines().filter_map(|l| l.strip_prefix("@@OTHER ")) {
        let (name, docker) = match o.strip_prefix("docker:") {
            Some(n) => (n.to_lowercase(), true),
            None => (o.to_lowercase(), false),
        };
        let label = match name.as_str() {
            "apache2" | "httpd" => "Apache",
            "caddy" => "Caddy",
            "traefik" => "Traefik",
            "lighttpd" => "lighttpd",
            "haproxy" => "HAProxy",
            "nginx-proxy-manager" => "Nginx Proxy Manager",
            "nginx-proxy" => "nginx-proxy",
            _ => continue,
        };
        let label = if docker { format!("{label} (conteneur)") } else { label.to_string() };
        if !state.others.contains(&label) {
            state.others.push(label);
        }
    }
    if out.lines().any(|l| l == absent) {
        state.installed = false;
        return state;
    }
    let mut current: Option<(bool, String, String, String)> = None;
    let flush = |cur: &mut Option<(bool, String, String, String)>, st: &mut NginxState| {
        if let Some((enabled, path, real, body)) = cur.take() {
            let f = SiteFile { path, real_path: real, enabled, servers: servers(&body) };
            if enabled {
                st.files.push(f);
            } else {
                st.disabled.push(f);
            }
        }
    };
    for line in out.lines() {
        if let Some(v) = line.strip_prefix("@@VERSION ") {
            state.version = v.trim().trim_start_matches(version_prefix).to_string();
        } else if line == "@@RUNNING" {
            state.running = true;
        } else if line == "@@CERTBOT" {
            state.certbot = true;
        } else if let Some(root) = line.strip_prefix("@@ROOT ") {
            state.conf_root = root.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("@@FILE ") {
            flush(&mut current, &mut state);
            let mut parts = rest.splitn(3, ' ');
            let enabled = parts.next() == Some("enabled");
            let path = parts.next().unwrap_or("").to_string();
            let real = parts.next().unwrap_or("").to_string();
            current = Some((enabled, path, real, String::new()));
        } else if let Some((_, _, _, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&mut current, &mut state);
    state
}

/// Convertit une date `notAfter` d'openssl (`Nov 20 12:00:00 2026 GMT`) en horodatage Unix.
pub fn parse_openssl_date(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = months.iter().position(|m| *m == parts[0])? as i64 + 1;
    let day: i64 = parts[1].parse().ok()?;
    let hms: Vec<i64> = parts[2].split(':').filter_map(|x| x.parse().ok()).collect();
    let year: i64 = parts[3].parse().ok()?;
    if hms.len() != 3 {
        return None;
    }
    // Jours depuis l'epoch (algorithme de Howard Hinnant).
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + hms[0] * 3600 + hms[1] * 60 + hms[2])
}

fn parse_certs(out: &str) -> Vec<Certificate> {
    let mut certs = Vec::new();
    for chunk in out.split("@@CERT ").skip(1) {
        let (path, body) = chunk.split_once('\n').unwrap_or((chunk, ""));
        let get = |key: &str| body.lines().find_map(|l| l.strip_prefix(key)).map(|v| v.trim().to_string());
        let Some(not_after) = get("notAfter=").and_then(|d| parse_openssl_date(&d)) else { continue };
        let san = body.lines().skip_while(|l| !l.contains("Subject Alternative Name")).nth(1).unwrap_or("");
        let domains = san.split(',').filter_map(|x| x.trim().strip_prefix("DNS:")).map(str::to_string).collect();
        certs.push(Certificate {
            path: path.trim().to_string(),
            subject: get("subject=").unwrap_or_default(),
            issuer: get("issuer=").unwrap_or_default(),
            domains,
            not_after,
        });
    }
    certs
}

pub async fn discover(conn: &Connection, sudo: Option<&str>) -> Result<NginxState> {
    let out = conn.exec(DISCOVER_SCRIPT, None).await?.into_result()?;
    let mut state = parse_discovery(&out.stdout);
    read_certificates(conn, sudo, &mut state).await?;
    Ok(state)
}

/// Lit les certificats référencés par les vhosts (dates d'expiration, domaines).
pub(crate) async fn read_certificates(conn: &Connection, sudo: Option<&str>, state: &mut NginxState) -> Result<()> {
    let mut paths: Vec<String> =
        state.files.iter().chain(&state.disabled).flat_map(|f| f.servers.iter().filter_map(|s| s.ssl_certificate.clone())).collect();
    paths.sort();
    paths.dedup();
    if !paths.is_empty() {
        // Les certificats Let's Encrypt ne sont lisibles qu'en root. Chaque `openssl` met ~60 ms à
        // démarrer : ils tournent en parallèle, puis les sorties sont recollées dans l'ordre.
        let mut script = String::from("d=$(mktemp -d) || exit 1\n");
        for (i, p) in paths.iter().enumerate() {
            let q = shell_quote(p);
            script += &format!(
                "{{ printf '@@CERT %s\\n' {q}; openssl x509 -noout -subject -issuer -enddate -ext subjectAltName -in {q} 2>/dev/null; }} > \"$d/{i}\" &\n"
            );
        }
        script += "wait\n";
        for i in 0..paths.len() {
            script += &format!("cat \"$d/{i}\"\n");
        }
        script += "rm -rf \"$d\"\n";
        let certs = conn.exec_sudo(&script, sudo, None).await?;
        state.certificates = parse_certs(&certs.stdout);
    }
    Ok(())
}

// ---------- Application sûre ----------

/// Serveur web piloté : nginx ou Apache. Les deux passent par les mêmes scripts d'application
/// sûre (sauvegarde, test de la configuration, rechargement, restauration automatique).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Nginx,
    Apache,
}

impl Engine {
    pub fn label(self) -> &'static str {
        match self {
            Engine::Nginx => "nginx",
            Engine::Apache => "Apache",
        }
    }

    /// Dossier des sauvegardes de configuration sur le serveur.
    pub fn backup_root(self) -> &'static str {
        match self {
            Engine::Nginx => BACKUP_ROOT,
            Engine::Apache => "/var/backups/zenytt/apache",
        }
    }

    /// Définit `CONF` (dossier de configuration), `NAME` (dossier des sauvegardes), `test_conf`
    /// et `reload_conf`, utilisés par les scripts d'application et de restauration.
    fn prelude(self) -> &'static str {
        match self {
            Engine::Nginx => {
                "CONF=/etc/nginx; NAME=nginx\n\
                 test_conf() { nginx -t; }\n\
                 reload_conf() { systemctl reload nginx 2>/dev/null || nginx -s reload; }\n"
            }
            // Debian/Ubuntu : /etc/apache2 et apache2ctl ; RHEL/Fedora : /etc/httpd et apachectl (ou httpd).
            Engine::Apache => {
                "if [ -d /etc/apache2 ]; then CONF=/etc/apache2; SVC=apache2; CTL=$(command -v apache2ctl || command -v apachectl); \
                 else CONF=/etc/httpd; SVC=httpd; CTL=$(command -v apachectl || command -v httpd); fi\n\
                 NAME=apache\n\
                 case \"$CTL\" in */httpd) T=-t; G='-k graceful' ;; *) T=configtest; G=graceful ;; esac\n\
                 test_conf() { \"$CTL\" $T; }\n\
                 reload_conf() { systemctl reload \"$SVC\" 2>/dev/null || \"$CTL\" $G; }\n"
            }
        }
    }

    /// Seuls les fichiers du dossier de configuration du serveur web peuvent être écrits.
    pub fn valid_conf_path(self, p: &str) -> Result<()> {
        let roots: &[&str] = match self {
            Engine::Nginx => &["/etc/nginx/"],
            Engine::Apache => &["/etc/apache2/", "/etc/httpd/"],
        };
        if roots.iter().any(|r| p.starts_with(r)) && !p.contains("..") && !p.contains('\n') {
            Ok(())
        } else {
            Err(Error::Other(format!("chemin refusé (hors de {}) : {p}", roots.join(" ou "))))
        }
    }
}

/// `$1` = fichier cible, `$2` = lien à créer dans sites-enabled (ou vide), `$3` = mode,
/// `$4` = commande préalable (activation de modules Apache…), contenu sur stdin.
/// Chaque modification est précédée d'une sauvegarde complète du dossier de configuration ; si
/// le test ou le reload échoue, l'état précédent est restauré et le serveur web n'est jamais
/// laissé cassé.
pub const APPLY_SCRIPT: &str = r#"set -u
TARGET="$1"; LINK="${2:-}"; MODE="${3:-write}"; PRE="${4:-}"
DIR=$(basename "$CONF")
TS=$(date +%Y%m%d-%H%M%S)
# Deux modifications dans la même seconde ne partagent pas une sauvegarde.
while [ -e "/var/backups/zenytt/$NAME/$TS" ]; do sleep 1; TS=$(date +%Y%m%d-%H%M%S); done
BK="/var/backups/zenytt/$NAME/$TS"
mkdir -p "$BK" && cp -a "$CONF" "$BK/" || { echo "sauvegarde impossible"; exit 1; }
existed=0; [ -e "$TARGET" ] && existed=1
link_existed=0; [ -n "$LINK" ] && [ -e "$LINK" -o -L "$LINK" ] && link_existed=1
restore() {
  if [ $existed = 1 ]; then cp -a "$BK/$DIR/${TARGET#$CONF/}" "$TARGET"; else rm -f "$TARGET"; fi
  if [ -n "$LINK" ]; then
    if [ $link_existed = 1 ]; then cp -a "$BK/$DIR/${LINK#$CONF/}" "$LINK"; else rm -f "$LINK"; fi
  fi
}
[ -n "$PRE" ] && sh -c "$PRE" > "$BK/pre.log" 2>&1
case "$MODE" in
  write)
    if [ $existed = 1 ]; then cat > "$TARGET"; else cat > "$TARGET"; chmod 0644 "$TARGET"; fi
    [ -n "$LINK" ] && ln -sfn "$TARGET" "$LINK" ;;
  disable) cat > /dev/null; rm -f "$LINK" ;;
  enable) cat > /dev/null; ln -sfn "$TARGET" "$LINK" ;;
  delete) cat > /dev/null; rm -f "$LINK" "$TARGET" ;;
esac
if ! test_conf > "$BK/test.log" 2>&1; then
  restore
  echo "@@FAILED test"
  cat "$BK/test.log"
  exit 2
fi
if ! reload_conf > "$BK/reload.log" 2>&1; then
  restore
  test_conf >/dev/null 2>&1 && reload_conf
  echo "@@FAILED reload"
  cat "$BK/reload.log"
  exit 3
fi
# On ne garde que les 30 dernières sauvegardes.
ls -1d /var/backups/zenytt/$NAME/* 2>/dev/null | head -n -30 | xargs -r rm -rf
echo "@@OK $BK"
cat "$BK/test.log"
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub ok: bool,
    /// Dossier de sauvegarde créé avant la modification.
    pub backup: Option<String>,
    /// Sortie du test de configuration (ou du reload en cas d'échec).
    pub log: String,
}

fn parse_apply(out: &str) -> ApplyResult {
    let first = out.lines().find(|l| l.starts_with("@@")).unwrap_or("");
    let log: String = out.lines().filter(|l| !l.starts_with("@@")).collect::<Vec<_>>().join("\n");
    match first.strip_prefix("@@OK ") {
        Some(bk) => ApplyResult { ok: true, backup: Some(bk.trim().to_string()), log },
        None => ApplyResult { ok: false, backup: None, log: if log.is_empty() { out.to_string() } else { log } },
    }
}

#[cfg(test)]
fn valid_conf_path(p: &str) -> Result<()> {
    Engine::Nginx.valid_conf_path(p)
}

/// Script complet : définitions propres au serveur web, puis le script commun.
fn full_script(engine: Engine, body: &str) -> String {
    format!("{}{body}", engine.prelude())
}

// Paramètres transmis tels quels au script : les regrouper n'apporterait rien.
#[allow(clippy::too_many_arguments)]
async fn apply_script(
    conn: &Connection,
    sudo: Option<&str>,
    engine: Engine,
    target: &str,
    link: &str,
    mode: &str,
    content: &str,
    pre: &str,
) -> Result<ApplyResult> {
    engine.valid_conf_path(target)?;
    if !link.is_empty() {
        engine.valid_conf_path(link)?;
    }
    let cmd = format!(
        "bash -c {} zenytt-web {} {} {} {}",
        shell_quote(&full_script(engine, APPLY_SCRIPT)),
        shell_quote(target),
        shell_quote(link),
        shell_quote(mode),
        shell_quote(pre)
    );
    let out = conn.exec_sudo(&cmd, sudo, Some(content.as_bytes())).await?;
    let text = format!("{}{}", out.stdout, out.stderr);
    if !text.contains("@@OK") && !text.contains("@@FAILED") {
        return Err(Error::Remote(text.trim().to_string()));
    }
    Ok(parse_apply(&text))
}

/// Écrit un fichier de configuration du serveur web `engine`, après la commande préalable `pre`
/// (constante choisie par Zenytt, jamais une saisie de l'utilisateur).
pub async fn write_config_for(
    conn: &Connection,
    sudo: Option<&str>,
    engine: Engine,
    path: &str,
    content: &str,
    enable_link: Option<&str>,
    pre: &str,
) -> Result<ApplyResult> {
    apply_script(conn, sudo, engine, path, enable_link.unwrap_or(""), "write", content, pre).await
}

pub async fn set_enabled_for(
    conn: &Connection,
    sudo: Option<&str>,
    engine: Engine,
    available: &str,
    link: &str,
    enabled: bool,
) -> Result<ApplyResult> {
    apply_script(conn, sudo, engine, available, link, if enabled { "enable" } else { "disable" }, "", "").await
}

pub async fn delete_site_for(conn: &Connection, sudo: Option<&str>, engine: Engine, available: &str, link: &str) -> Result<ApplyResult> {
    apply_script(conn, sudo, engine, available, link, "delete", "", "").await
}

/// Teste la configuration actuelle et renvoie la sortie du test.
pub async fn test_for(conn: &Connection, sudo: Option<&str>, engine: Engine) -> Result<(bool, String)> {
    let cmd = format!("bash -c {}", shell_quote(&full_script(engine, "test_conf 2>&1\n")));
    let out = conn.exec_sudo(&cmd, sudo, None).await?;
    Ok((out.success(), format!("{}{}", out.stdout, out.stderr)))
}

pub async fn reload_for(conn: &Connection, sudo: Option<&str>, engine: Engine) -> Result<String> {
    let cmd = format!("bash -c {}", shell_quote(&full_script(engine, "test_conf 2>&1 && reload_conf 2>&1\n")));
    let out = conn.exec_sudo(&cmd, sudo, None).await?;
    Ok(out.into_result()?.stdout)
}

// ---------- Historique des sauvegardes ----------

pub const BACKUP_ROOT: &str = "/var/backups/zenytt/nginx";

/// Nom de sauvegarde valide (`AAAAMMJJ-HHMMSS`), seul format accepté dans les chemins.
pub fn valid_backup_name(name: &str) -> bool {
    name.len() == 15 && name.as_bytes()[8] == b'-' && name.chars().enumerate().all(|(i, c)| i == 8 || c.is_ascii_digit())
}

/// Sauvegardes disponibles, de la plus récente à la plus ancienne.
pub async fn backups_for(conn: &Connection, sudo: Option<&str>, engine: Engine) -> Result<Vec<String>> {
    let out = conn.exec_sudo(&format!("ls -1 {} 2>/dev/null || true", engine.backup_root()), sudo, None).await?.into_result()?;
    let mut list: Vec<String> = out.stdout.lines().map(str::trim).filter(|n| valid_backup_name(n)).map(str::to_string).collect();
    list.sort_unstable_by(|a, b| b.cmp(a));
    Ok(list)
}

/// Différences entre une sauvegarde et la configuration actuelle (format diff unifié).
pub async fn backup_diff_for(conn: &Connection, sudo: Option<&str>, engine: Engine, name: &str) -> Result<String> {
    if !valid_backup_name(name) {
        return Err(Error::Other("nom de sauvegarde invalide".into()));
    }
    // `diff` renvoie 1 quand il trouve des différences : ce n'est pas une erreur.
    let body = format!("diff -ruN /var/backups/zenytt/$NAME/{name}/$(basename \"$CONF\") \"$CONF\" | head -c 800000; true\n");
    let out = conn.exec_sudo(&format!("bash -c {}", shell_quote(&full_script(engine, &body))), sudo, None).await?;
    Ok(out.stdout)
}

/// Restaure une sauvegarde complète du dossier de configuration. L'état actuel est lui-même
/// sauvegardé, la configuration restaurée est testée, et l'état actuel revient si le test ou le
/// reload échoue.
pub const RESTORE_SCRIPT: &str = r#"set -u
DIR=$(basename "$CONF")
SRC="/var/backups/zenytt/$NAME/$1/$DIR"
[ -d "$SRC" ] || { echo "@@FAILED sauvegarde introuvable"; exit 1; }
TS=$(date +%Y%m%d-%H%M%S)
# Deux modifications dans la même seconde ne partagent pas une sauvegarde.
while [ -e "/var/backups/zenytt/$NAME/$TS" ]; do sleep 1; TS=$(date +%Y%m%d-%H%M%S); done
BK="/var/backups/zenytt/$NAME/$TS"
mkdir -p "$BK" && cp -a "$CONF" "$BK/" || { echo "@@FAILED sauvegarde de l'état actuel impossible"; exit 1; }
rm -rf "$CONF.zenytt-restore" "$CONF.zenytt-old"
cp -a "$SRC" "$CONF.zenytt-restore" || { echo "@@FAILED copie impossible"; exit 1; }
mv "$CONF" "$CONF.zenytt-old" && mv "$CONF.zenytt-restore" "$CONF"
if test_conf > "$BK/test.log" 2>&1 && reload_conf >> "$BK/test.log" 2>&1; then
  rm -rf "$CONF.zenytt-old"
  echo "@@OK $BK"
  cat "$BK/test.log"
else
  rm -rf "$CONF"
  mv "$CONF.zenytt-old" "$CONF"
  test_conf >/dev/null 2>&1 && reload_conf
  echo "@@FAILED test"
  cat "$BK/test.log"
  exit 2
fi
"#;

pub async fn restore_backup_for(conn: &Connection, sudo: Option<&str>, engine: Engine, name: &str) -> Result<ApplyResult> {
    if !valid_backup_name(name) {
        return Err(Error::Other("nom de sauvegarde invalide".into()));
    }
    let cmd = format!("bash -c {} zenytt-restore {name}", shell_quote(&full_script(engine, RESTORE_SCRIPT)));
    let out = conn.exec_sudo(&cmd, sudo, None).await?;
    let text = format!("{}{}", out.stdout, out.stderr);
    if !text.contains("@@OK") && !text.contains("@@FAILED") {
        return Err(Error::Remote(text.trim().to_string()));
    }
    Ok(parse_apply(&text))
}

// ---------- Nouveau site ----------

/// vhost HTTP en reverse proxy vers un port local, prêt à recevoir HTTPS via certbot.
pub fn proxy_vhost(domain: &str, port: u16) -> String {
    format!(
        r#"# Généré par Zenytt
server {{
    listen 80;
    listen [::]:80;
    server_name {domain};

    client_max_body_size 50m;

    location / {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }}
}}
"#
    )
}

/// Fichier docker-compose d'un site : le port n'est publié que sur 127.0.0.1 (seul nginx y accède).
pub fn site_compose(name: &str, image: &str, host_port: u16, container_port: u16, env: &[(String, String)]) -> String {
    let mut s = format!(
        "# Généré par Zenytt\nservices:\n  app:\n    image: {image}\n    container_name: {name}\n    restart: unless-stopped\n    ports:\n      - \"127.0.0.1:{host_port}:{container_port}\"\n"
    );
    if !env.is_empty() {
        s.push_str("    environment:\n");
        for (k, v) in env {
            s.push_str(&format!("      {k}: {}\n", serde_json::to_string(v).unwrap_or_default()));
        }
    }
    s
}

/// Valide un nom de domaine (sous-domaine compris).
pub fn valid_domain(d: &str) -> bool {
    let d = d.trim_end_matches('.');
    d.len() <= 253
        && d.contains('.')
        && d.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

/// Ports TCP déjà en écoute sur le serveur.
pub async fn used_ports(conn: &Connection) -> Result<Vec<u16>> {
    let out = conn.run("ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null").await?;
    let mut ports: Vec<u16> = out
        .lines()
        .filter_map(|l| l.split_whitespace().find(|w| w.contains(':') && w.rsplit(':').next().is_some_and(|p| p.parse::<u16>().is_ok())))
        .filter_map(|w| w.rsplit(':').next()?.parse().ok())
        .collect();
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}

/// Premier port libre à partir de `start`, en évitant aussi ceux réservés par Docker.
pub fn first_free(used: &[u16], start: u16) -> u16 {
    (start..u16::MAX).find(|p| !used.contains(p)).unwrap_or(start)
}

/// Certificat Let's Encrypt avec le plugin certbot du serveur web (`--nginx` ou `--apache`).
pub async fn certbot_for(conn: &Connection, sudo: Option<&str>, engine: Engine, domain: &str, email: &str) -> Result<String> {
    crate::ssh::long(async move {
        if !valid_domain(domain) {
            return Err(Error::Other(format!("domaine invalide : {domain}")));
        }
        let (plugin, package) = match engine {
            Engine::Nginx => ("--nginx", "python3-certbot-nginx"),
            Engine::Apache => ("--apache", "python3-certbot-apache"),
        };
        let cmd = format!(
            "command -v certbot >/dev/null || {{ echo 'certbot n'\\''est pas installé (apt install certbot {package})'; exit 1; }}; \
             certbot {plugin} -d {} --non-interactive --agree-tos -m {} --redirect 2>&1",
            shell_quote(domain),
            shell_quote(email)
        );
        let out = conn.exec_sudo(&cmd, sudo, None).await?;
        if out.success() {
            Ok(out.stdout)
        } else {
            Err(Error::Remote(format!("{}{}", out.stdout, out.stderr).trim().to_string()))
        }
    })
    .await
}

pub async fn renew_certificates(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    crate::ssh::long(async move {
        let out = conn.exec_sudo("certbot renew --no-random-sleep-on-renew 2>&1", sudo, None).await?;
        Ok(format!("{}{}", out.stdout, out.stderr))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO: &str = r#"
# commentaire
server {
    listen 80;
    server_name demo.example.com www.demo.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name demo.example.com;
    ssl_certificate /etc/letsencrypt/live/demo.example.com/fullchain.pem;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host "$host";
    }
    location /static/ { alias /var/www/static/; }
    location = /health { return 200 'ok;{}'; }
}
"#;

    #[test]
    fn parses_servers() {
        let s = servers(DEMO);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].server_names, vec!["demo.example.com", "www.demo.example.com"]);
        assert_eq!(s[0].returns.as_deref(), Some("301 https://$host$request_uri"));
        assert!(!s[0].ssl);
        assert!(s[1].ssl);
        assert_eq!(s[1].upstream_ports, vec![8081]);
        assert_eq!(s[1].locations.len(), 3);
        assert_eq!(s[1].locations[1].root.as_deref(), Some("/var/www/static/"));
        // Le « ; » et les accolades dans une chaîne entre quotes ne cassent pas l'analyse.
        assert_eq!(s[1].locations[2].returns.as_deref(), Some("200 ok;{}"));
    }

    #[test]
    fn servers_inside_http_block() {
        let s = servers("http { server { listen 8080; server_name a.b; } }");
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].listen, vec!["8080"]);
    }

    #[test]
    fn local_ports() {
        assert_eq!(local_port("http://127.0.0.1:3000/"), Some(3000));
        assert_eq!(local_port("http://localhost:8080"), Some(8080));
        assert_eq!(local_port("http://backend:8080"), None);
        assert_eq!(local_port("http://unix:/run/app.sock"), None);
    }

    #[test]
    fn discovery_output() {
        let out = format!("@@VERSION nginx version: nginx/1.24.0\n@@RUNNING\n@@FILE enabled /etc/nginx/sites-enabled/demo /etc/nginx/sites-available/demo\n{DEMO}\n@@FILE disabled /etc/nginx/sites-available/old /etc/nginx/sites-available/old\nserver {{ server_name old.example.com; }}\n");
        let st = parse_discovery(&out);
        assert_eq!(st.version, "nginx/1.24.0");
        assert!(st.running);
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].real_path, "/etc/nginx/sites-available/demo");
        assert_eq!(st.files[0].servers.len(), 2);
        assert_eq!(st.disabled[0].servers[0].server_names, vec!["old.example.com"]);
        assert!(!parse_discovery("@@NONGINX\n").installed);
        let other = parse_discovery("@@OTHER caddy\n@@OTHER docker:traefik\n@@NONGINX\n");
        assert!(!other.installed);
        assert_eq!(other.others, vec!["Caddy", "Traefik (conteneur)"]);
    }

    #[test]
    fn openssl_dates() {
        assert_eq!(parse_openssl_date("Jan  1 00:00:00 1970 GMT"), Some(0));
        assert_eq!(parse_openssl_date("Nov 20 12:00:00 2026 GMT"), Some(1_795_176_000));
        assert_eq!(parse_openssl_date("garbage"), None);
    }

    #[test]
    fn certs() {
        let out = "@@CERT /etc/x/fullchain.pem\nsubject=CN = demo.example.com\nissuer=C = US, O = Let's Encrypt, CN = R11\nnotAfter=Nov 20 12:00:00 2026 GMT\nX509v3 Subject Alternative Name: \n    DNS:demo.example.com, DNS:www.demo.example.com\n";
        let c = parse_certs(out);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].domains, vec!["demo.example.com", "www.demo.example.com"]);
        assert!(c[0].issuer.contains("Let's Encrypt"));
    }

    #[test]
    fn apply_results() {
        let ok =
            parse_apply("@@OK /var/backups/zenytt/nginx/20260921\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n");
        assert!(ok.ok);
        assert_eq!(ok.backup.as_deref(), Some("/var/backups/zenytt/nginx/20260921"));
        let ko = parse_apply("@@FAILED test\nnginx: [emerg] unexpected \"}\"\n");
        assert!(!ko.ok);
        assert!(ko.log.contains("emerg"));
    }

    #[test]
    fn backup_names() {
        assert!(valid_backup_name("20260921-133323"));
        assert!(!valid_backup_name("20260921-13332"));
        assert!(!valid_backup_name("../../etc/pass"));
        assert!(!valid_backup_name("20260921x133323"));
    }

    #[test]
    fn domains_and_paths() {
        assert!(valid_domain("app.example.com"));
        assert!(!valid_domain("localhost"));
        assert!(!valid_domain("a..b.com"));
        assert!(!valid_domain("x.com; rm -rf /"));
        assert!(valid_conf_path("/etc/nginx/sites-available/x").is_ok());
        assert!(valid_conf_path("/etc/nginx/../passwd").is_err());
        assert!(valid_conf_path("/etc/passwd").is_err());
    }

    #[test]
    fn free_ports() {
        assert_eq!(first_free(&[8100, 8101, 8103], 8100), 8102);
        let vhost = proxy_vhost("app.example.com", 8102);
        assert_eq!(servers(&vhost)[0].upstream_ports, vec![8102]);
        let compose = site_compose("app", "nginx:alpine", 8102, 80, &[("A".into(), "b \"c\"".into())]);
        assert!(compose.contains("\"127.0.0.1:8102:80\""));
        assert!(compose.contains(r#"A: "b \"c\"""#));
    }
}
