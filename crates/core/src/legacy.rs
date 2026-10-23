//! Reprise des serveurs préparés sous l'ancien nom de l'application (versions ≤ 1.1.1) : agent
//! de supervision, sauvegardes, déploiement, réglages SSH et fail2ban, sessions tmux.
//!
//! Avec `zenytt_profiles::legacy` (côté poste), c'est le seul endroit qui connaît cet ancien nom.
//! Les deux modules pourront être supprimés quand plus aucune installation n'en dépendra.

use crate::{Connection, Result};

/// Détection sans droits particuliers : une ligne par élément à reprendre, rien s'il n'y en a pas.
const DETECT: &str = r#"for p in /usr/local/bin/helmd /etc/helmd /var/lib/helmd /etc/systemd/system/helmd.service \
  /etc/helm-backup /var/lib/helm-backup /var/backups/helm /etc/systemd/system/helm-backup.timer /etc/cron.d/helm-backup \
  /usr/local/bin/helm-deploy /etc/helm-deploy /etc/ssh/sshd_config.d/00-helm.conf \
  /etc/fail2ban/jail.d/helm-sshd.local /etc/fail2ban/jail.d/zz-helm-ignore.local; do
  [ -e "$p" ] && echo "$p"
done
exit 0"#;

/// Sessions tmux de l'utilisateur connecté, renommées sans droits particuliers.
const RENAME_TMUX: &str = r#"command -v tmux >/dev/null || exit 0
tmux ls -F '#S' 2>/dev/null | while read -r s; do
  case "$s" in helm-*) tmux rename-session -t "=$s" "zenytt-${s#helm-}" && echo "tmux : $s";; esac
done
exit 0"#;

/// Reprise en root. Chaque étape ne touche qu'à ce qui existe et n'écrase rien. Les réglages SSH,
/// sudoers et fail2ban ne sont appliqués qu'après validation (`sshd -t`, `visudo -c`,
/// `fail2ban-client -t`), sinon l'ancien fichier est remis. Dernière ligne : `AGENT=1` si l'agent
/// était installé (à réinstaller sous son nouveau nom).
const MIGRATE: &str = r#"set -u
SYSTEMD=0; [ -d /run/systemd/system ] && SYSTEMD=1
AGENT=0
move() { [ -e "$1" ] && [ ! -e "$2" ] && mv "$1" "$2" && echo "déplacé : $1 → $2"; return 0; }
# Réécrit $1 vers $2 (droits conservés) en remplaçant les anciens noms, puis supprime $1.
rewrite() {
  [ -f "$1" ] || return 0
  sed -e 's/helm-backup/zenytt-backup/g; s/helm-deploy/zenytt-deploy/g; s#/var/backups/helm#/var/backups/zenytt#g; s/helmd/zenyttd/g; s/Helm/Zenytt/g' "$1" > "$2.zenytt-tmp" \
    && chmod --reference="$1" "$2.zenytt-tmp" && mv "$2.zenytt-tmp" "$2" && { [ "$1" = "$2" ] || rm -f "$1"; } && echo "réécrit : $2"
}

# 1. Agent de supervision : arrêté, configuration et historique conservés, réinstallé ensuite.
if [ -e /usr/local/bin/helmd ] || [ -e /etc/systemd/system/helmd.service ] || [ -d /etc/helmd ]; then
  AGENT=1
  [ $SYSTEMD = 1 ] && systemctl disable --now helmd >/dev/null 2>&1
  pkill -x helmd 2>/dev/null
  move /etc/helmd /etc/zenyttd
  move /var/lib/helmd /var/lib/zenyttd
  [ -f /etc/zenyttd/config.json ] && sed -i 's/helmd/zenyttd/g' /etc/zenyttd/config.json
  if id helmd >/dev/null 2>&1 && ! id zenyttd >/dev/null 2>&1; then
    usermod -l zenyttd -d /home/zenyttd helmd 2>/dev/null && groupmod -n zenyttd helmd 2>/dev/null && echo "compte helmd renommé zenyttd"
  fi
  rm -f /etc/systemd/system/helmd.service /usr/local/bin/helmd
  [ $SYSTEMD = 1 ] && systemctl daemon-reload
fi

# 2. Sauvegardes restic : dépôt, configuration, planification.
if [ -d /etc/helm-backup ] || [ -e /etc/systemd/system/helm-backup.timer ] || [ -e /etc/cron.d/helm-backup ]; then
  [ $SYSTEMD = 1 ] && systemctl disable --now helm-backup.timer >/dev/null 2>&1
  move /etc/helm-backup /etc/zenytt-backup
  move /var/lib/helm-backup /var/lib/zenytt-backup
  move /var/backups/helm /var/backups/zenytt
  move /var/log/helm-backup.log /var/log/zenytt-backup.log
  for f in /etc/zenytt-backup/*; do
    [ -f "$f" ] && grep -q -e helm -e Helm "$f" && rewrite "$f" "$f"
  done
  rewrite /etc/systemd/system/helm-backup.service /etc/systemd/system/zenytt-backup.service
  rewrite /etc/systemd/system/helm-backup.timer /etc/systemd/system/zenytt-backup.timer
  rewrite /etc/cron.d/helm-backup /etc/cron.d/zenytt-backup
  if [ $SYSTEMD = 1 ] && [ -e /etc/systemd/system/zenytt-backup.timer ]; then
    systemctl daemon-reload && systemctl enable --now zenytt-backup.timer >/dev/null 2>&1 && echo "planification des sauvegardes réactivée"
  fi
fi

# 3. Déploiement : script, configurations, sudoers, clés de déploiement.
if [ -e /usr/local/bin/helm-deploy ] || [ -d /etc/helm-deploy ]; then
  rewrite /usr/local/bin/helm-deploy /usr/local/bin/zenytt-deploy
  move /etc/helm-deploy /etc/zenytt-deploy
  move /var/log/helm-deploy.log /var/log/zenytt-deploy.log
  for f in /etc/sudoers.d/helm-deploy-*; do
    [ -f "$f" ] || continue
    new="/etc/sudoers.d/zenytt-deploy-${f#/etc/sudoers.d/helm-deploy-}"
    tmp="$(mktemp)"
    sed 's/helm-deploy/zenytt-deploy/g' "$f" > "$tmp"
    if visudo -cf "$tmp" >/dev/null 2>&1; then
      install -m 0440 "$tmp" "$new" && rm -f "$f" && echo "sudoers : $new"
    else
      echo "sudoers : $f refusé par visudo, laissé tel quel"
    fi
    rm -f "$tmp"
  done
  for keys in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
    [ -f "$keys" ] && grep -q helm-deploy "$keys" && sed -i 's/helm-deploy/zenytt-deploy/g' "$keys" && echo "clés de déploiement : $keys"
  done
fi

# 4. Réglages SSH : sshd n'est rechargé que si la configuration est valide.
if [ -f /etc/ssh/sshd_config.d/00-helm.conf ]; then
  sed 's/Helm/Zenytt/g' /etc/ssh/sshd_config.d/00-helm.conf > /etc/ssh/sshd_config.d/00-zenytt.conf
  chmod --reference=/etc/ssh/sshd_config.d/00-helm.conf /etc/ssh/sshd_config.d/00-zenytt.conf
  mv /etc/ssh/sshd_config.d/00-helm.conf /etc/ssh/sshd_config.d/00-helm.conf.zenytt-old
  if sshd -t 2>/dev/null; then
    rm -f /etc/ssh/sshd_config.d/00-helm.conf.zenytt-old
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    echo "réglages SSH : 00-zenytt.conf"
  else
    rm -f /etc/ssh/sshd_config.d/00-zenytt.conf
    mv /etc/ssh/sshd_config.d/00-helm.conf.zenytt-old /etc/ssh/sshd_config.d/00-helm.conf
    echo "réglages SSH : configuration refusée par sshd -t, ancien fichier conservé"
  fi
fi

# 5. fail2ban.
if [ -f /etc/fail2ban/jail.d/helm-sshd.local ] || [ -f /etc/fail2ban/jail.d/zz-helm-ignore.local ]; then
  rewrite /etc/fail2ban/jail.d/helm-sshd.local /etc/fail2ban/jail.d/zenytt-sshd.local
  rewrite /etc/fail2ban/jail.d/zz-helm-ignore.local /etc/fail2ban/jail.d/zz-zenytt-ignore.local
  fail2ban-client -t >/dev/null 2>&1 && fail2ban-client reload >/dev/null 2>&1 && echo "fail2ban rechargé"
fi

echo "AGENT=$AGENT"
"#;

/// Ce qu'une reprise a fait sur le serveur.
#[derive(Debug, Default)]
pub struct Report {
    /// Lignes de compte rendu, pour le journal.
    pub lines: Vec<String>,
    /// L'agent était installé sous l'ancien nom : il faut le réinstaller.
    pub reinstall_agent: bool,
}

/// Le serveur a-t-il encore des éléments installés sous l'ancien nom ? (sans droits particuliers)
pub async fn needs_migration(conn: &Connection) -> Result<bool> {
    Ok(!conn.run(DETECT).await?.trim().is_empty())
}

/// Renomme les sessions tmux de l'utilisateur connecté (aucun droit particulier requis).
pub async fn rename_tmux_sessions(conn: &Connection) -> Result<Vec<String>> {
    Ok(conn.run(RENAME_TMUX).await?.lines().map(str::to_string).collect())
}

/// Reprend les éléments installés en root sous l'ancien nom.
pub async fn migrate(conn: &Connection, sudo: Option<&str>) -> Result<Report> {
    let out = conn.exec_sudo(MIGRATE, sudo, None).await?.into_result()?.stdout;
    let mut report = Report::default();
    for line in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match line.strip_prefix("AGENT=") {
            Some(flag) => report.reinstall_agent = flag == "1",
            None => report.lines.push(line.to_string()),
        }
    }
    Ok(report)
}
