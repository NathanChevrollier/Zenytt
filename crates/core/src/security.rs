//! Audit de sécurité (en lecture seule) et corrections guidées.
//!
//! Les corrections qui touchent l'accès SSH ou le pare-feu sont vérifiées par l'appelant avec une
//! **nouvelle** connexion avant d'être conservées ; sinon `ROLLBACK_*` est exécuté par la connexion
//! d'origine, qui reste ouverte pendant toute l'opération.

use serde::Serialize;

use crate::{Connection, Error, Result};

const AUDIT_SCRIPT: &str = r#"echo @@sshd; sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|x11forwarding) '
echo @@ufw; if command -v ufw >/dev/null; then ufw status 2>/dev/null | head -n1; else echo absent; fi
echo @@firewalld; if command -v firewall-cmd >/dev/null; then firewall-cmd --state 2>&1 | head -n1; else echo absent; fi
echo @@f2b; if command -v fail2ban-client >/dev/null; then if fail2ban-client ping >/dev/null 2>&1; then echo active; else echo inactive; fi; else echo absent; fi
echo @@f2bport; if fail2ban-client ping >/dev/null 2>&1; then for a in $(fail2ban-client get sshd actions 2>/dev/null | tail -n +2 | sed 's/^[|` -]*//' | tr ',' ' '); do fail2ban-client get sshd action "$a" port 2>/dev/null; done; fi
echo @@apt; if command -v apt-get >/dev/null; then U=$(mktemp); apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst' > "$U"; wc -l < "$U"; grep -ci security "$U"; rm -f "$U"; elif command -v dnf >/dev/null; then dnf -q check-update 2>/dev/null | grep -cE '^[A-Za-z0-9_.+-]+\.[A-Za-z0-9_]+[[:space:]]'; dnf -q updateinfo list --security 2>/dev/null | wc -l; else echo -1; echo -1; fi
echo @@unattended; if command -v apt-get >/dev/null; then if dpkg -s unattended-upgrades >/dev/null 2>&1; then echo yes; else echo no; fi; elif command -v dnf >/dev/null; then if systemctl is-enabled dnf-automatic.timer dnf-automatic-install.timer 2>/dev/null | grep -q '^enabled'; then echo yes; else echo no; fi; else echo na; fi
echo @@reboot; if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi
echo @@uid0; awk -F: '$3==0{print $1}' /etc/passwd
echo @@listen; ss -ltnpH 2>/dev/null
echo @@os; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
echo @@xrdp; if [ -f /etc/xrdp/xrdp.ini ]; then B=$(sed -n 's/^[[:space:]]*max_bpp[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' /etc/xrdp/xrdp.ini | head -n1); echo "${B:-default}"; else echo absent; fi
"#;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Ok,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// Correction proposée (identifiant pour `fix_script`).
    pub fix: Option<String>,
    pub fix_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub os: String,
    pub ssh_ports: Vec<u16>,
    pub findings: Vec<Finding>,
}

pub(crate) fn section<'a>(out: &'a str, name: &str) -> &'a str {
    let marker = format!("@@{name}\n");
    let Some(start) = out.find(&marker) else { return "" };
    let rest = &out[start + marker.len()..];
    if rest.starts_with("@@") {
        return "";
    }
    &rest[..rest.find("\n@@").map(|i| i + 1).unwrap_or(rest.len())]
}

fn finding(id: &str, severity: Severity, title: &str, detail: &str, fix: Option<(&str, &str)>) -> Finding {
    Finding {
        id: id.into(),
        severity,
        title: title.into(),
        detail: detail.into(),
        fix: fix.map(|f| f.0.into()),
        fix_label: fix.map(|f| f.1.into()),
    }
}

/// Analyse la sortie du script d'audit.
pub fn parse_report(out: &str) -> Report {
    let mut f = Vec::new();
    let sshd: std::collections::HashMap<String, String> =
        section(out, "sshd").lines().filter_map(|l| l.split_once(' ').map(|(k, v)| (k.to_lowercase(), v.trim().to_lowercase()))).collect();
    let ssh_ports: Vec<u16> =
        section(out, "sshd").lines().filter_map(|l| l.strip_prefix("port ")).filter_map(|p| p.trim().parse().ok()).collect();

    if sshd.is_empty() {
        f.push(finding(
            "ssh-unknown",
            Severity::Low,
            "Configuration SSH illisible",
            "`sshd -T` n'a rien renvoyé : droits root nécessaires.",
            None,
        ));
    } else {
        match sshd.get("permitrootlogin").map(String::as_str) {
            Some("yes") => f.push(finding(
                "root-password",
                Severity::High,
                "Connexion root par mot de passe autorisée",
                "Un attaquant peut tenter de deviner le mot de passe root. Avec « prohibit-password », root ne peut se connecter qu'avec une clé.",
                Some(("root-prohibit-password", "Autoriser root uniquement par clé")),
            )),
            _ => f.push(finding("root-password", Severity::Ok, "Root ne peut pas se connecter par mot de passe", "", None)),
        }
        if sshd.get("passwordauthentication").map(String::as_str) == Some("yes") {
            f.push(finding(
                "password-auth",
                Severity::High,
                "Connexion SSH par mot de passe autorisée",
                "Les robots testent en permanence des mots de passe sur le port SSH. Les clés SSH sont bien plus sûres.",
                Some(("disable-password-auth", "N'autoriser que les clés SSH")),
            ));
        } else {
            f.push(finding("password-auth", Severity::Ok, "Connexion SSH par clé uniquement", "", None));
        }
        if sshd.get("x11forwarding").map(String::as_str) == Some("yes") {
            f.push(finding(
                "x11",
                Severity::Low,
                "Redirection X11 activée",
                "Rarement utile sur un serveur ; peut être désactivée dans sshd_config.",
                None,
            ));
        }
    }

    let firewalld = section(out, "firewalld").trim().to_string();
    match section(out, "ufw").trim() {
        // Distributions Red Hat (Rocky, Alma, Fedora…) : firewalld plutôt qu'ufw.
        "absent" if firewalld == "running" => f.push(finding("firewall", Severity::Ok, "Pare-feu firewalld actif", "", None)),
        "absent" if firewalld != "absent" && !firewalld.is_empty() => f.push(finding(
            "firewall",
            Severity::Medium,
            "Pare-feu firewalld inactif",
            "firewalld est installé mais arrêté. Note : les ports publiés par Docker contournent le pare-feu.",
            Some(("enable-ufw", "Activer firewalld (SSH, HTTP, HTTPS autorisés)")),
        )),
        "absent" => f.push(finding(
            "firewall",
            Severity::Medium,
            "Aucun pare-feu (ufw) installé",
            "Tout service qui écoute sur une interface publique est joignable depuis Internet. Note : les ports publiés par Docker contournent ufw.",
            Some(("enable-ufw", "Installer et activer ufw (SSH, HTTP, HTTPS autorisés)")),
        )),
        s if s.contains("inactive") => f.push(finding(
            "firewall",
            Severity::Medium,
            "Pare-feu ufw inactif",
            "ufw est installé mais désactivé. Note : les ports publiés par Docker contournent ufw.",
            Some(("enable-ufw", "Activer ufw (SSH, HTTP, HTTPS autorisés)")),
        )),
        _ => f.push(finding("firewall", Severity::Ok, "Pare-feu ufw actif", "", None)),
    }

    match section(out, "f2b").trim() {
        "active" => {
            // Le jail SSH bloque-t-il le bon port ? (« ssh » = 22 ; la plage 0:65535 couvre tout.)
            let watched: Vec<String> = section(out, "f2bport").lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect();
            let covers = |port: u16| {
                watched.iter().any(|w| {
                    w.split(',').any(|p| match p.trim().split_once(':') {
                        Some((a, b)) => a.parse::<u16>().is_ok_and(|a| a <= port) && b.parse::<u16>().is_ok_and(|b| port <= b),
                        None => p.trim() == port.to_string() || (port == 22 && p.trim() == "ssh"),
                    })
                })
            };
            let unprotected: Vec<u16> = ssh_ports.iter().copied().filter(|p| !covers(*p)).collect();
            if !watched.is_empty() && !unprotected.is_empty() {
                f.push(finding(
                    "fail2ban",
                    Severity::Medium,
                    "fail2ban ne protège pas le port SSH réel",
                    &format!(
                        "SSH écoute sur le port {} mais le jail sshd bloque le port {} : les attaques sont détectées, mais leur bannissement ne les arrête pas.",
                        unprotected.iter().map(u16::to_string).collect::<Vec<_>>().join(", "),
                        watched.join(", ")
                    ),
                    Some(("install-fail2ban", "Régler fail2ban sur le port SSH")),
                ));
            } else {
                f.push(finding("fail2ban", Severity::Ok, "fail2ban actif", "", None));
            }
        }
        "absent" => f.push(finding(
            "fail2ban",
            Severity::Medium,
            "fail2ban n'est pas installé",
            "fail2ban bannit temporairement les adresses qui multiplient les échecs de connexion SSH.",
            Some(("install-fail2ban", "Installer et activer fail2ban")),
        )),
        _ => f.push(finding(
            "fail2ban",
            Severity::Medium,
            "fail2ban installé mais arrêté",
            "",
            Some(("install-fail2ban", "Activer fail2ban")),
        )),
    }

    let apt: Vec<i64> = section(out, "apt").lines().filter_map(|l| l.trim().parse().ok()).collect();
    if let [total, security, ..] = apt[..] {
        if security > 0 {
            f.push(finding(
                "updates",
                Severity::High,
                &format!("{security} mise(s) à jour de sécurité en attente"),
                &format!("{total} paquet(s) à mettre à jour au total."),
                Some(("apply-updates", "Mettre à jour (dans un terminal)")),
            ));
        } else if total > 0 {
            f.push(finding(
                "updates",
                Severity::Low,
                &format!("{total} mise(s) à jour disponible(s)"),
                "",
                Some(("apply-updates", "Mettre à jour (dans un terminal)")),
            ));
        } else if total == 0 {
            f.push(finding("updates", Severity::Ok, "Système à jour", "", None));
        }
    }
    if section(out, "unattended").trim() == "no" && apt.first().is_some_and(|t| *t >= 0) {
        f.push(finding(
            "unattended",
            Severity::Medium,
            "Mises à jour de sécurité automatiques désactivées",
            "unattended-upgrades (Debian, Ubuntu) ou dnf-automatic (Rocky, Alma, Fedora) installe chaque nuit les correctifs de sécurité.",
            Some(("enable-unattended", "Activer les mises à jour de sécurité automatiques")),
        ));
    }
    if section(out, "reboot").trim() == "yes" {
        f.push(finding(
            "reboot",
            Severity::Medium,
            "Redémarrage nécessaire",
            "Des mises à jour (noyau…) ne seront effectives qu'après un redémarrage du serveur.",
            None,
        ));
    }
    let uid0: Vec<&str> = section(out, "uid0").lines().map(str::trim).filter(|u| !u.is_empty() && *u != "root").collect();
    if !uid0.is_empty() {
        f.push(finding(
            "uid0",
            Severity::Critical,
            "Comptes avec les droits root (UID 0)",
            &format!("{} : un compte UID 0 autre que root est un signe classique de compromission.", uid0.join(", ")),
            None,
        ));
    }

    // Services qui écoutent sur toutes les interfaces, hors SSH/HTTP/HTTPS.
    let mut exposed = Vec::new();
    for line in section(out, "listen").lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let Some(local) = cols.get(3) else { continue };
        let Some((addr, port)) = local.rsplit_once(':') else { continue };
        let Ok(port) = port.parse::<u16>() else { continue };
        let public = matches!(addr, "0.0.0.0" | "*" | "[::]" | "::");
        if !public || ssh_ports.contains(&port) || port == 80 || port == 443 {
            continue;
        }
        let process = line.split("((\"").nth(1).and_then(|p| p.split('"').next()).unwrap_or("?").to_string();
        if !exposed.iter().any(|(p, _): &(u16, String)| *p == port) {
            exposed.push((port, process));
        }
    }
    for (port, process) in exposed {
        let docker = process.starts_with("docker");
        f.push(finding(
            &format!("exposed-{port}"),
            Severity::Medium,
            &format!("Port {port} exposé sur Internet ({process})"),
            if docker {
                "Publié par Docker (qui contourne le pare-feu). Restreins-le à 127.0.0.1 depuis l'onglet Docker et accède-y par un tunnel."
            } else {
                "Si ce service n'a pas à être public, fais-le écouter sur 127.0.0.1 et accède-y par un tunnel."
            },
            None,
        ));
    }

    // xrdp limité à 16 bits (ou moins) : l'image arrive rayée, en couleurs dégradées, quel que soit
    // le client RDP. Ce n'est pas une faille, mais c'est ici qu'on le corrige, côté serveur.
    match section(out, "xrdp").trim() {
        "" | "absent" => {}
        value => {
            let bpp: Option<u32> = value.parse().ok();
            if bpp.is_some_and(|b| b < 24) {
                f.push(finding(
                    "xrdp-bpp",
                    Severity::Low,
                    &format!("Bureau à distance xrdp limité à {} bits", bpp.unwrap_or(16)),
                    "Les clients RDP (Zenytt compris) reçoivent alors une image rayée et des couleurs dégradées. Passer max_bpp à 32 dans /etc/xrdp/xrdp.ini corrige l'affichage.",
                    Some(("xrdp-32bpp", "Passer xrdp en couleurs 32 bits")),
                ));
            }
        }
    }

    f.sort_by_key(|x| x.severity);
    Report { os: section(out, "os").trim().to_string(), ssh_ports, findings: f }
}

pub async fn audit(conn: &Connection, sudo: Option<&str>) -> Result<Report> {
    let out = conn.exec_sudo(AUDIT_SCRIPT, sudo, None).await?;
    Ok(parse_report(&out.stdout))
}

/// Modification de sshd : drop-in `00-zenytt.conf` (lu en premier, donc prioritaire sur
/// `50-cloud-init.conf`) si sshd_config inclut le dossier, sinon directive en tête du fichier.
/// `$1` = directives (une par ligne). Sauvegarde, `sshd -t`, puis reload.
const SSHD_SCRIPT: &str = r#"set -u
CONF=/etc/ssh/sshd_config
BK=/var/backups/zenytt/sshd_config.$(date +%Y%m%d-%H%M%S)
mkdir -p /var/backups/zenytt && cp -a "$CONF" "$BK" || { echo "@@FAILED sauvegarde"; exit 1; }
DROP=/etc/ssh/sshd_config.d/00-zenytt.conf
[ -f "$DROP" ] && cp -a "$DROP" "$BK.drop"
if grep -Eqi '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$CONF"; then
  touch "$DROP"
  printf '%s\n' "$1" | while IFS=' ' read -r key val; do
    [ -n "$key" ] || continue
    sed -i "/^[[:space:]]*$key[[:space:]]/Id" "$DROP"
    echo "$key $val" >> "$DROP"
  done
  chmod 644 "$DROP"
else
  printf '%s\n' "$1" | while IFS=' ' read -r key val; do
    [ -n "$key" ] || continue
    sed -i "s/^[[:space:]]*$key[[:space:]].*/# & (désactivé par Zenytt)/I" "$CONF"
    sed -i "1i $key $val" "$CONF"
  done
fi
E=$(mktemp)
if ! sshd -t 2>"$E"; then
  cp -a "$BK" "$CONF"; if [ -f "$BK.drop" ]; then cp -a "$BK.drop" "$DROP"; else rm -f "$DROP"; fi
  echo "@@FAILED"; cat "$E"; rm -f "$E"; exit 2
fi
rm -f "$E"
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload
echo "@@OK $BK"
"#;

/// Restaure sshd_config (et le drop-in) depuis la sauvegarde `$1`.
const SSHD_ROLLBACK: &str = r#"BK="$1"
cp -a "$BK" /etc/ssh/sshd_config
if [ -f "$BK.drop" ]; then cp -a "$BK.drop" /etc/ssh/sshd_config.d/00-zenytt.conf; else rm -f /etc/ssh/sshd_config.d/00-zenytt.conf; fi
sshd -t && { systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload; }
echo "@@ROLLEDBACK"
"#;

/// Pare-feu : ufw (Debian, Ubuntu) ou firewalld (Rocky, Alma, Fedora). Les ports SSH actuels sont
/// autorisés AVANT l'activation, pour ne jamais couper la connexion en cours.
const UFW_SCRIPT: &str = r#"set -e
SSH_PORTS=$(sshd -T 2>/dev/null | awk '/^port /{print $2}')
if command -v apt-get >/dev/null; then
  command -v ufw >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
  for p in $SSH_PORTS; do ufw allow "$p/tcp"; done
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  echo "@@OK ufw"
else
  command -v firewall-cmd >/dev/null || dnf install -y firewalld || yum install -y firewalld
  if firewall-cmd --state >/dev/null 2>&1; then
    for p in $SSH_PORTS; do firewall-cmd --permanent --add-port="$p/tcp"; done
    firewall-cmd --permanent --add-service=ssh --add-service=http --add-service=https
    firewall-cmd --reload
  else
    # Règles écrites hors ligne, puis démarrage : aucun instant où le port SSH serait fermé.
    for p in $SSH_PORTS; do firewall-offline-cmd --add-port="$p/tcp"; done
    firewall-offline-cmd --add-service=ssh --add-service=http --add-service=https
    systemctl enable --now firewalld
  fi
  echo "@@OK firewalld"
fi
"#;

/// fail2ban, avec un jail SSH qui surveille le VRAI port SSH (sur Debian, le jail par défaut ne
/// protège que le port 22 : inefficace si SSH écoute ailleurs).
const FAIL2BAN_SCRIPT: &str = r#"set -e
if ! command -v fail2ban-client >/dev/null; then
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
  else dnf install -y epel-release || true; dnf install -y fail2ban || yum install -y fail2ban; fi
fi
PORTS=$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | paste -sd, -)
# jail.d/*.local est lu après jail.local : seuls « enabled » et « port » sont redéfinis.
printf '# Géré par Zenytt : protection SSH sur le port réellement utilisé.\n[sshd]\nenabled = true\nport = %s\n' "${PORTS:-ssh}" > /etc/fail2ban/jail.d/zenytt-sshd.local
systemctl enable --now fail2ban 2>/dev/null || fail2ban-client ping >/dev/null 2>&1 || fail2ban-client start
fail2ban-client reload >/dev/null 2>&1 || true
echo '@@OK fail2ban'
"#;

const UNATTENDED_SCRIPT: &str = r#"set -e
if command -v apt-get >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades
  echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
  DEBIAN_FRONTEND=noninteractive dpkg-reconfigure -f noninteractive unattended-upgrades
else
  dnf install -y dnf-automatic
  sed -i 's/^apply_updates.*/apply_updates = yes/; s/^upgrade_type.*/upgrade_type = security/' /etc/dnf/automatic.conf
  systemctl enable --now dnf-automatic.timer
fi
echo '@@OK unattended'
"#;

/// xrdp en 32 bits : sauvegarde de xrdp.ini, `max_bpp=32` (remplacé, ou ajouté à [Globals]),
/// puis redémarrage du service.
const XRDP_32BPP_SCRIPT: &str = r#"set -e
F=/etc/xrdp/xrdp.ini
[ -f "$F" ] || { echo "@@FAILED xrdp n'est pas installé"; exit 1; }
mkdir -p /var/backups/zenytt && cp -a "$F" "/var/backups/zenytt/xrdp.ini.$(date +%Y%m%d-%H%M%S)"
if grep -Eq '^[[:space:]]*max_bpp[[:space:]]*=' "$F"; then
  sed -i -E 's/^[[:space:]]*max_bpp[[:space:]]*=.*/max_bpp=32/' "$F"
else
  sed -i '/^\[Globals\]/a max_bpp=32' "$F"
fi
grep -Eq '^max_bpp=32$' "$F" || { echo "@@FAILED max_bpp non modifié"; exit 1; }
systemctl restart xrdp 2>/dev/null || service xrdp restart
echo '@@OK xrdp'
"#;

/// Ce qu'une correction va faire, pour l'afficher avant exécution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixPlan {
    pub id: String,
    pub description: String,
    pub script: String,
    /// La correction touche l'accès SSH : une nouvelle connexion doit être vérifiée.
    pub needs_verification: bool,
}

pub fn fix_plan(id: &str) -> Result<FixPlan> {
    let plan = |description: &str, script: String, needs_verification: bool| FixPlan {
        id: id.into(),
        description: description.into(),
        script,
        needs_verification,
    };
    Ok(match id {
        "root-prohibit-password" => plan(
            "root ne pourra plus se connecter qu'avec une clé SSH. Une nouvelle connexion est testée ; en cas d'échec, l'ancienne configuration est restaurée automatiquement.",
            SSHD_SCRIPT.replace("\"$1\"", "'PermitRootLogin prohibit-password'"),
            true,
        ),
        "disable-password-auth" => plan(
            "Seules les clés SSH seront acceptées. Une nouvelle connexion est testée ; en cas d'échec, l'ancienne configuration est restaurée automatiquement.",
            SSHD_SCRIPT.replace("\"$1\"", "'PasswordAuthentication no\nKbdInteractiveAuthentication no'"),
            true,
        ),
        "enable-ufw" => plan(
            "Installe/active le pare-feu (ufw sur Debian/Ubuntu, firewalld sur Rocky/Alma/Fedora) en autorisant SSH (ton port actuel), HTTP et HTTPS ; tout le reste entrant est bloqué. Une nouvelle connexion est testée ; en cas d'échec, le pare-feu est désactivé.",
            UFW_SCRIPT.to_string(),
            true,
        ),
        "install-fail2ban" => plan(
            "Installe fail2ban et l'active au démarrage, avec une protection SSH réglée sur ton port SSH réel.",
            FAIL2BAN_SCRIPT.to_string(),
            false,
        ),
        "enable-unattended" => plan(
            "Active l'installation automatique des correctifs de sécurité (unattended-upgrades ou dnf-automatic).",
            UNATTENDED_SCRIPT.to_string(),
            false,
        ),
        "xrdp-32bpp" => plan(
            "Règle xrdp en couleurs 32 bits (max_bpp=32, xrdp.ini sauvegardé dans /var/backups/zenytt), puis redémarre xrdp. Les sessions de bureau à distance ouvertes sur ce serveur seront coupées.",
            XRDP_32BPP_SCRIPT.to_string(),
            false,
        ),
        _ => return Err(Error::Other(format!("correction inconnue : {id}"))),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixOutcome {
    pub ok: bool,
    pub output: String,
    /// Identifiant de retour arrière (sauvegarde sshd, ou `ufw`), si la correction en a un.
    pub rollback: Option<String>,
}

pub async fn apply_fix(conn: &Connection, sudo: Option<&str>, id: &str) -> Result<FixOutcome> {
    crate::ssh::long(async move {
        let plan = fix_plan(id)?;
        let out = conn.exec_sudo(&format!("bash -c {} zenytt-fix", crate::ssh::shell_quote(&plan.script)), sudo, None).await?;
        let text = format!("{}{}", out.stdout, out.stderr);
        let ok = out.success() && text.contains("@@OK");
        let rollback = text
            .lines()
            .find_map(|l| l.strip_prefix("@@OK "))
            .map(|s| s.trim().to_string())
            .filter(|s| s != "fail2ban" && s != "unattended" && s != "xrdp");
        Ok(FixOutcome { ok, output: text.replace("@@OK", "OK").replace("@@FAILED", "ÉCHEC"), rollback })
    })
    .await
}

/// Annule une correction SSH ou pare-feu (appelé si la connexion de contrôle échoue).
pub async fn rollback(conn: &Connection, sudo: Option<&str>, token: &str) -> Result<String> {
    let cmd = if token == "ufw" {
        "ufw --force disable && echo @@ROLLEDBACK".to_string()
    } else if token == "firewalld" {
        "systemctl disable --now firewalld && echo @@ROLLEDBACK".to_string()
    } else if token.starts_with("/var/backups/zenytt/sshd_config.") && !token.contains("..") && !token.contains(' ') {
        format!("bash -c {} zenytt-rollback {}", crate::ssh::shell_quote(SSHD_ROLLBACK), crate::ssh::shell_quote(token))
    } else {
        return Err(Error::Other("jeton de retour arrière invalide".into()));
    };
    Ok(conn.exec_sudo(&cmd, sudo, None).await?.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fail2ban_wrong_port() {
        let out = "@@sshd
port 6666
@@ufw
Status: active
@@f2b
active
@@f2bport
ssh
@@os
Debian
";
        let r = parse_report(out);
        let f = r.findings.iter().find(|f| f.id == "fail2ban").unwrap();
        assert_eq!(f.severity, Severity::Medium);
        assert!(f.detail.contains("6666"));
        let ok = parse_report(&out.replace(
            "@@f2bport
ssh",
            "@@f2bport
6666",
        ));
        assert_eq!(ok.findings.iter().find(|f| f.id == "fail2ban").unwrap().severity, Severity::Ok);
        let rhel = parse_report(
            "@@sshd
port 22
@@ufw
absent
@@firewalld
running
@@f2b
absent
@@os
Rocky
",
        );
        assert_eq!(rhel.findings.iter().find(|f| f.id == "firewall").unwrap().severity, Severity::Ok);
    }

    const SAMPLE: &str = "@@sshd\nport 6666\npermitrootlogin yes\npasswordauthentication yes\nx11forwarding yes\n@@ufw\nStatus: inactive\n@@f2b\nabsent\n@@apt\n12\n3\n@@unattended\nno\n@@reboot\nyes\n@@uid0\nroot\ntoor\n@@listen\nLISTEN 0 4096 0.0.0.0:6666 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\nLISTEN 0 4096 0.0.0.0:3307 0.0.0.0:* users:((\"docker-proxy\",pid=2,fd=4))\nLISTEN 0 4096 127.0.0.1:8081 0.0.0.0:* users:((\"docker-proxy\",pid=3,fd=4))\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:((\"nginx\",pid=4,fd=6))\n@@os\nUbuntu 24.04 LTS\n";

    #[test]
    fn report() {
        let r = parse_report(SAMPLE);
        assert_eq!(r.ssh_ports, vec![6666]);
        assert_eq!(r.os, "Ubuntu 24.04 LTS");
        let ids: Vec<&str> = r.findings.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(r.findings[0].id, "uid0", "le critique d'abord");
        for id in ["root-password", "password-auth", "firewall", "fail2ban", "updates", "unattended", "reboot", "exposed-3307", "x11"] {
            assert!(ids.contains(&id), "{id} manquant : {ids:?}");
        }
        assert!(!ids.contains(&"exposed-8081"), "127.0.0.1 n'est pas exposé");
        assert!(!ids.contains(&"exposed-6666"), "le port SSH est normal");
        let upd = r.findings.iter().find(|f| f.id == "updates").unwrap();
        assert_eq!(upd.severity, Severity::High);
    }

    #[test]
    fn xrdp_colour_depth() {
        let base = "@@sshd\nport 22\n@@ufw\nStatus: active\n@@f2b\nactive\n@@os\nDebian\n";
        let with = |v: &str| parse_report(&format!("{base}@@xrdp\n{v}\n"));
        let low = with("16");
        let f = low.findings.iter().find(|f| f.id == "xrdp-bpp").expect("xrdp en 16 bits signalé");
        assert_eq!(f.fix.as_deref(), Some("xrdp-32bpp"));
        assert!(f.title.contains("16 bits"));
        // 24 ou 32 bits, valeur absente (défaut de xrdp) ou xrdp non installé : rien à signaler.
        for v in ["24", "32", "default", "absent"] {
            assert!(!with(v).findings.iter().any(|f| f.id == "xrdp-bpp"), "{v}");
        }
        assert!(!parse_report(base).findings.iter().any(|f| f.id == "xrdp-bpp"));
        let p = fix_plan("xrdp-32bpp").unwrap();
        assert!(p.script.contains("max_bpp=32") && p.script.contains("/var/backups/zenytt/xrdp.ini"));
        assert!(!p.needs_verification);
    }

    #[test]
    fn plans() {
        let p = fix_plan("disable-password-auth").unwrap();
        assert!(p.needs_verification);
        assert!(p.script.contains("PasswordAuthentication no"));
        assert!(p.script.contains("00-zenytt.conf"));
        assert!(fix_plan("rm-rf").is_err());
    }
}
