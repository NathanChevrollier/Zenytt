//! Terminaux interactifs.

use tauri::ipc::Channel;
use tauri::State;
use zenytt_core::shell_history;

use crate::sessions::{Sessions, TermEvent};
use crate::store::{secrets, Store};

#[tauri::command]
pub async fn term_open(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    cols: u32,
    rows: u32,
    command: Option<String>,
    tmux_session: Option<String>,
    on_event: Channel<TermEvent>,
) -> Result<u64, String> {
    let conn = sessions.get(&store, &server_id).await?;
    // Mot de passe sudo enregistré : une commande `sudo …` lancée dans l'onglet ne le redemande pas.
    let sudo_pw = command.as_deref().filter(|c| c.contains("sudo")).and_then(|_| secrets::get(&server_id, "sudo"));
    // Propre à ce terminal : la sortie d'un programme (journal, console de VM, conteneur) ne peut
    // pas imiter le signal de l'amorce sans le connaître.
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    // Une session tmux remplace le shell : elle survit aux coupures et à la fermeture de l'app.
    let command = match (command, tmux_session) {
        // Onglet ouvert sur une commande (mises à jour, journal…) : elle est lancée par un shell
        // qui annonce son PID, sinon Zenytt perdrait le dossier courant de cet onglet.
        (Some(c), _) if sudo_pw.is_some() => Some(announcing_pid(&with_sudo_primed(&c, &nonce))),
        (Some(c), _) => Some(announcing_pid(&c)),
        (None, Some(name)) => Some(zenytt_core::tmux::attach_command(&name).map_err(|e| e.to_string())?),
        // Shell simple : il annonce son PID (séquence OSC ignorée par l'affichage) pour que
        // Zenytt retrouve son dossier courant (panneau Fichiers, glisser-déposer).
        (None, None) => Some(announcing_pid(LOGIN_SHELL)),
    };
    sessions.open_terminal(&conn, cols, rows, command, sudo_pw.map(|pw| (pw, nonce)), on_event).await
}

/// Fait précéder la commande d'une amorce de sudo : l'autorisation sudo est liée au terminal, donc
/// elle doit être obtenue dans ce terminal. Le script coupe l'écho, émet la séquence OSC privée
/// `7771;<nonce>`, lit le mot de passe que Zenytt écrit alors (jamais dans la ligne de commande ni
/// à l'écran), l'envoie à `sudo -S -v`, puis lance la commande. Rien à faire pour root, NOPASSWD
/// ou une autorisation en cache : l'amorce émet alors `7771;<nonce>;-` et Zenytt n'écrit rien. Si
/// le mot de passe est refusé, sudo le redemande normalement.
fn with_sudo_primed(command: &str, nonce: &str) -> String {
    format!(
        "if [ \"$(id -u)\" != 0 ] && ! sudo -n true 2>/dev/null; then \
           stty -echo; printf '\\033]7771;{nonce}\\007'; IFS= read -r zpw; stty echo; \
           printf '%s\\n' \"$zpw\" | sudo -S -p '' -v >/dev/null 2>&1; unset zpw; \
         else printf '\\033]7771;{nonce};-\\007'; \
         fi; {command}"
    )
}

/// Octets de fin de sortie à conserver d'un paquet à l'autre : de quoi reconstituer un marqueur
/// coupé entre deux paquets (marqueur + octet suivant, le nonce fait 32 caractères).
pub const SUDO_TAIL: usize = 64;

/// Réponse à la sortie d'un terminal amorcé (voir [`with_sudo_primed`]) : `None` tant que l'amorce
/// ne s'est pas annoncée ; sinon l'amorce est désarmée, avec le texte à écrire s'il y en a un. Un
/// mot de passe contenant un caractère de contrôle n'est jamais écrit : la suite partirait au shell.
pub fn sudo_answer(output: &[u8], nonce: &str, password: &str) -> Option<Option<String>> {
    let marker = format!("\x1b]7771;{nonce}");
    let at = output.windows(marker.len()).position(|w| w == marker.as_bytes())?;
    match output.get(at + marker.len()) {
        Some(b'\x07') if !password.chars().any(char::is_control) => Some(Some(format!("{password}\n"))),
        Some(b'\x07' | b';') => Some(None),
        // Séquence coupée en fin de sortie : l'appelant rejoue la fin (`SUDO_TAIL`) avec le paquet
        // suivant, jusqu'à la limite qu'il s'est fixée.
        _ => None,
    }
}

/// Shell de connexion de l'utilisateur (`exec` : il garde le PID annoncé).
const LOGIN_SHELL: &str = r#"exec "${SHELL:-/bin/sh}" -l"#;

/// Fait précéder une commande de la séquence OSC privée 7770, qui transmet à l'interface le PID
/// du shell qui l'exécute (séquence ignorée par l'affichage). Zenytt retrouve ensuite le dossier
/// courant de cet onglet via `/proc`, y compris quand un programme y tourne au premier plan.
fn announcing_pid(command: &str) -> String {
    let script = format!(r#"printf "\033]7770;%s\007" "$$"; {command}"#);
    format!("exec sh -c '{}'", script.replace('\'', r"'\''"))
}

/// Dossier de travail du terminal dont `pid` est le shell : celui du programme au premier plan
/// (shell imbriqué, `cd` dans un éditeur…), sinon celui du shell lui-même.
///
/// Sortie : le chemin, puis `locked` quand le programme au premier plan appartient à un autre
/// utilisateur (shell root ouvert par `sudo -i` ou `su`) : son dossier est illisible sans droits,
/// et le chemin donné n'est alors que celui du shell de départ.
fn cwd_of_pid(pid: u32) -> String {
    format!(
        "fg=$(ps -o tpgid= -p {pid} 2>/dev/null | tr -d ' '); \
         if [ -n \"$fg\" ] && [ \"$fg\" != -1 ] && [ \"$fg\" != {pid} ]; then \
           d=$(readlink /proc/$fg/cwd 2>/dev/null); \
           [ -n \"$d\" ] && {{ echo \"$d\"; exit 0; }}; \
           [ -d /proc/$fg ] && locked=1; \
         fi; \
         d=$(readlink /proc/{pid}/cwd 2>/dev/null); \
         [ -n \"$d\" ] && {{ echo \"$d\"; [ -n \"$locked\" ] && echo locked; }}; true"
    )
}

/// Dossier courant d'un terminal, tel que le serveur le voit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermCwd {
    path: String,
    /// Le programme au premier plan appartient à un autre utilisateur (voir [`cwd_of_pid`]).
    locked: bool,
}

fn parse_cwd(stdout: &str) -> Option<TermCwd> {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    let path = lines.next()?;
    path.starts_with('/').then(|| TermCwd { path: path.to_string(), locked: lines.next() == Some("locked") })
}

/// Dossier courant d'un terminal : via le PID du panneau tmux ou celui annoncé par le shell, puis
/// le chemin donné par tmux en dernier recours. `None` si aucune piste n'aboutit (serveur
/// déconnecté, système sans /proc, terminal lancé sur une commande).
#[tauri::command]
pub async fn term_cwd(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    tmux_session: Option<String>,
    pid: Option<u32>,
) -> Result<Option<TermCwd>, String> {
    if !sessions.is_connected(&server_id).await {
        return Ok(None);
    }
    if tmux_session.is_none() && pid.is_none() {
        return Ok(None);
    }
    let conn = sessions.get(&store, &server_id).await?;

    if let Some(name) = tmux_session {
        let cmd = zenytt_core::tmux::pane_path_command(&name).map_err(|e| e.to_string())?;
        let out = conn.exec(&cmd, None).await.map_err(|e| e.to_string())?;
        let mut lines = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty());
        // Première ligne : le chemin donné par tmux ; deuxième : le PID du shell du panneau.
        // /proc passe en premier : tmux retombe sans rien dire sur le shell du panneau quand le
        // programme au premier plan appartient à root, et on perdrait l'information.
        let tmux_path = lines.next().unwrap_or_default().to_string();
        if let Some(pane_pid) = lines.next().and_then(|p| p.parse::<u32>().ok()) {
            let out = conn.exec(&cwd_of_pid(pane_pid), None).await.map_err(|e| e.to_string())?;
            if let Some(cwd) = parse_cwd(&out.stdout) {
                return Ok(Some(cwd));
            }
        }
        return Ok(tmux_path.starts_with('/').then_some(TermCwd { path: tmux_path, locked: false }));
    }

    let out = conn.exec(&cwd_of_pid(pid.unwrap_or(0)), None).await.map_err(|e| e.to_string())?;
    Ok(parse_cwd(&out.stdout))
}

/// Fait défiler l'historique d'une session tmux (molette de la souris dans le terminal).
#[tauri::command]
pub async fn tmux_scroll(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    session: String,
    up: bool,
    lines: u32,
) -> Result<(), String> {
    if !sessions.is_connected(&server_id).await {
        return Ok(());
    }
    let conn = sessions.get(&store, &server_id).await?;
    let cmd = zenytt_core::tmux::scroll_command(&session, up, lines).map_err(|e| e.to_string())?;
    conn.exec(&cmd, None).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn term_write(sessions: State<'_, Sessions>, id: u64, data: String) -> Result<(), String> {
    sessions.write_terminal(id, data.as_bytes()).await
}

#[tauri::command]
pub async fn term_resize(sessions: State<'_, Sessions>, id: u64, cols: u32, rows: u32) -> Result<(), String> {
    sessions.resize_terminal(id, cols, rows).await
}

#[tauri::command]
pub async fn term_close(sessions: State<'_, Sessions>, id: u64) -> Result<(), String> {
    sessions.close_terminal(id).await;
    Ok(())
}

/// Historique des commandes du shell de l'utilisateur (bash et zsh), le plus récent d'abord,
/// sans doublons. Lu seulement sur demande (palette Ctrl+K), jamais conservé par Zenytt.
#[tauri::command]
pub async fn shell_history(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<String>, String> {
    if !sessions.is_connected(&server_id).await {
        return Ok(vec![]);
    }
    let conn = sessions.get(&store, &server_id).await?;
    let out = conn
        .exec("for f in \"$HOME/.bash_history\" \"$HOME/.zsh_history\"; do [ -r \"$f\" ] && tail -n 3000 \"$f\"; done", None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_history(&out.stdout))
}

fn parse_history(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in text.lines().rev() {
        // zsh (EXTENDED_HISTORY) : « : 1700000000:0;commande » ; bash (HISTTIMEFORMAT) : « #1700000000 ».
        let cmd = match line.strip_prefix(": ") {
            Some(rest) if rest.contains(';') => rest.split_once(';').map(|x| x.1).unwrap_or(rest),
            _ => line,
        }
        .trim();
        if cmd.is_empty() || (cmd.starts_with('#') && cmd[1..].chars().all(|c| c.is_ascii_digit())) {
            continue;
        }
        if seen.insert(cmd.to_string()) {
            out.push(cmd.to_string());
            if out.len() >= 500 {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{announcing_pid, parse_cwd, LOGIN_SHELL};

    #[test]
    fn dossier_du_terminal() {
        let c = parse_cwd("/etc/nginx\n").unwrap();
        assert_eq!((c.path.as_str(), c.locked), ("/etc/nginx", false));
        let c = parse_cwd("/home/alice\nlocked\n").unwrap();
        assert_eq!((c.path.as_str(), c.locked), ("/home/alice", true));
        assert!(parse_cwd("").is_none());
        assert!(parse_cwd("readlink: permission denied").is_none());
    }

    #[test]
    fn annonce_le_pid_avant_le_shell() {
        let c = announcing_pid(LOGIN_SHELL);
        assert!(c.starts_with("exec sh -c 'printf "), "{c}");
        assert!(c.contains("7770"), "{c}");
        assert!(c.contains(r#"exec "${SHELL:-/bin/sh}" -l"#), "{c}");
    }

    #[test]
    fn protege_les_apostrophes_de_la_commande() {
        let c = announcing_pid("echo 'salut'; exec \"$SHELL\" -l");
        // Aucune apostrophe de la commande ne doit fermer la chaîne du `sh -c`.
        assert!(c.contains(r"'\''salut'\''"), "{c}");
        assert!(c.ends_with("-l'"), "{c}");
    }

    #[test]
    fn amorce_sudo_sans_mot_de_passe_en_clair() {
        let c = announcing_pid(&super::with_sudo_primed("sudo apt-get update; exec \"$SHELL\" -l", "abc123"));
        assert!(c.contains("stty -echo") && c.contains("sudo -S -p"), "{c}");
        assert!(c.contains(r"\033]7771;abc123\007") && c.contains(r"\033]7771;abc123;-\007"), "{c}");
        // Le script d'amorce passe avant la commande de l'utilisateur.
        assert!(c.find("sudo -S").unwrap() < c.find("apt-get").unwrap(), "{c}");
        assert!(c.starts_with("exec sh -c '") && c.ends_with("-l'"), "{c}");
    }

    #[test]
    fn mot_de_passe_ecrit_seulement_sur_le_bon_signal() {
        use super::sudo_answer;
        let n = "0123456789abcdef0123456789abcdef";
        let ready = format!("\x1b]7770;42\x07\x1b]7771;{n}\x07");
        assert_eq!(sudo_answer(ready.as_bytes(), n, "pw"), Some(Some("pw\n".into())));
        // Root, NOPASSWD, autorisation en cache : désarmé sans rien écrire.
        assert_eq!(sudo_answer(format!("\x1b]7771;{n};-\x07").as_bytes(), n, "pw"), Some(None));
        // Ancien marqueur fixe ou mauvais nonce (journal, console de VM, conteneur) : rien.
        assert_eq!(sudo_answer(b"\x1b]7771;\x07", n, "pw"), None);
        assert_eq!(sudo_answer(b"\x1b]7771;ffffffffffffffffffffffffffffffff\x07", n, "pw"), None);
        assert_eq!(sudo_answer(b"sortie ordinaire", n, "pw"), None);
        // Marqueur coupé entre deux paquets : retrouvé en rejouant la fin du précédent.
        for (full, want) in [(ready.clone(), Some(Some("pw\n".to_string()))), (format!("\x1b]7771;{n};-\x07"), Some(None))] {
            for cut in 1..full.len() {
                let (a, b) = full.as_bytes().split_at(cut);
                assert_eq!(sudo_answer(&a[..a.len().min(10)], n, "pw"), None);
                assert_eq!(sudo_answer(&[a, b].concat(), n, "pw"), want, "coupure {cut}");
            }
        }
        // Caractère de contrôle dans le mot de passe : jamais écrit.
        for pw in ["a\nrm -rf ~", "a\rb", "a\x03"] {
            assert_eq!(sudo_answer(ready.as_bytes(), n, pw), Some(None), "{pw:?}");
        }
    }

    #[test]
    fn history() {
        let h = super::parse_history("ls\n#1700000000\ndocker ps\n: 1700000001:0;htop\nls\n");
        assert_eq!(h, vec!["ls", "htop", "docker ps"]);
    }
}

/// Historique des commandes du shell distant, dédoublonné et classé (le plus récent d'abord).
/// Zenytt lit les fichiers que le shell tient déjà : rien n'est installé sur le serveur, et les
/// commandes qui contiennent visiblement un secret sont écartées côté Rust.
#[tauri::command]
pub async fn term_history(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<Vec<shell_history::Entry>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    shell_history::history(&conn).await.map_err(|e| e.to_string())
}
