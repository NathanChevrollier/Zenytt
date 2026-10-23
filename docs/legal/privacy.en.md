# Zenytt privacy policy

*Last updated: October 5, 2026 — the [French version](confidentialite.md) prevails.*

Zenytt is a desktop application that runs **on your computer**. It has no user account, no central
server and **no telemetry**: its publisher receives no usage statistics, crash reports or any
other data about you.

## Data stored on your computer

- Server profiles and settings, including private networks (private addresses and WireGuard public
  keys): `zenytt.json` in the app configuration folder.
- Passwords (including database accounts you save), key passphrases, API keys and tokens: your operating system's credential store
  (Windows Credential Manager, macOS Keychain, Linux Secret Service), never in plain text.
- Approved host key fingerprints, UI state, a local action log, and a technical log (5 rotating
  files of up to 2 MB, no secrets).
- Labels and notes you put on IP addresses (fail2ban), mount point settings and containers marked
  "stopped on purpose": `zenytt.json`.
- If you turn on IP location: the DB-IP Lite databases, in the app data folder (`geo`), used to
  locate addresses **on your computer** without sending them anywhere.
- If you ask for it ("Copy to this PC"): a copy of a server's backup repository, in the folder you
  choose. It stays **encrypted** by restic and is unreadable without the backup password.
- Folders you sort containers and virtual machines into, with the rest of the UI state.

Uninstalling Zenytt and deleting its configuration folder and credential entries removes everything.

## Data sent to your own servers

Zenytt connects over SSH to the servers you configure. The private network (WireGuard) links the
servers you choose: each server generates its own private key, which never leaves it; traffic flows
directly between your servers, encrypted, never through the publisher or a third party. A virtual machine's screen is shown through an SSH tunnel;
its VNC password, if any, is read from the server and kept in memory only for the session (or, if
you open the screen in the system client, remote-viewer, passed through a temporary file readable
by you only, which remote-viewer deletes as soon as it has read it). Database
backups made from Zenytt are written on the server, in the SSH user's `~/zenytt-sauvegardes-bdd`
folder, and only leave it if you download them; passwords of database accounts you create or change
travel over the encrypted SSH connection and are not stored by Zenytt. Tools a
feature needs (WireGuard, restic, tmux…) are installed with the server's package manager, which
contacts your distribution's repositories; if your distribution has no restic package, the server
downloads the official binary from GitHub and checks its hash before installing it. fail2ban settings
you define in Zenytt are written on the server, in Zenytt's own file
(`/etc/fail2ban/jail.d/zz-zenytt-settings.local`).

## Third-party services (only when you use the feature)

| Feature | Service | Data sent |
|---|---|---|
| Updates | GitHub | Your IP address and installed version, at startup |
| Access diagnostics | api.ipify.org | Your IP address |
| IP location (fail2ban, off by default) | download.db-ip.com (DB-IP) | Your IP address, as for any download. No address from your logs is sent: Zenytt downloads a free database (CC BY 4.0) and looks addresses up on your computer, about once a month |
| Server public IP | api.ipify.org, from the server | The server's IP address |
| Domain expiry | rdap.org and domain registries | Your sites' domain names |
| AI assistant (off until a provider is set) | The provider you choose (Anthropic, OpenAI, Google Gemini, Mistral, OpenRouter, or a local model) | Your messages and what the assistant reads on your servers (logs, configs). Detected secrets are masked before sending, without absolute guarantee |
| Alerts | Discord, ntfy or any webhook you configure | Alert text |
| Backups | Storage you configure | Backups encrypted by restic |
| Sync / shared terminal | A folder or a `zenytt-sync` server you host | End-to-end encrypted data (AES-256-GCM); your passphrase never leaves your devices |
| HTTPS certificates | Let's Encrypt, from the server | Domain and the email you enter |

Each service applies its own privacy policy. Some are located outside the EU (notably the US).

## Community Discord bot

The Zenytt community Discord server has a bot that turns suggestions and bug reports sent through
its form into issues on the project's **public** GitHub repository. This is the only processing of
personal data by the publisher, and it only concerns people who use that form.

- **Data**: the text you enter, the screenshots or photos you attach, your Discord username, ID and
  avatar URL.
- **Purpose and legal basis**: handling your feedback publicly with the community (legitimate
  interest; sending the form is voluntary).
- **Publication**: the issue and images are **visible to everyone** on GitHub. The bot removes
  image metadata (GPS location, device model, author, date, comments) before publishing; hiding what
  the image shows (passwords, IP addresses, emails) is up to you. Images are kept in a dedicated
  branch of the repository (`feedback-attachments`).
- **Recipients**: GitHub, Inc. (US), which hosts the repository, and Discord, which delivers the
  form. The bot itself keeps nothing.
- **Retention and rights**: as long as the issue exists. You can ask for an issue or image to be
  changed or deleted at the contact address in the [legal notice](mentions-legales.md); the image is
  then removed from the branch and its history.

## Your rights

Since the app sends no data to the publisher, there is nothing to access, correct or delete on its
side: your data stays under your control (for the Discord bot, see above). Questions: see the contact in the
[legal notice](mentions-legales.md). You may also contact your data protection authority (in
France, the CNIL).
