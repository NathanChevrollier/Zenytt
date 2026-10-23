# Zenytt

[![CI](https://github.com/NathanChevrollier/Zenytt/actions/workflows/ci.yml/badge.svg)](https://github.com/NathanChevrollier/Zenytt/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/NathanChevrollier/Zenytt?label=version)](https://github.com/NathanChevrollier/Zenytt/releases/latest)
[![PolyForm Shield License](https://img.shields.io/badge/license-PolyForm%20Shield%201.0.0-blue)](LICENSE)
[![Sponsor](https://img.shields.io/github/sponsors/NathanChevrollier?label=sponsor&logo=githubsponsors)](https://github.com/sponsors/NathanChevrollier)

*[Version française](README.md)*

A desktop application (Windows, macOS, Linux) for running your Linux servers: SSH terminal, files,
monitoring, Docker, databases, websites, backups and security auditing in a single window.

**Everything goes over SSH.** Zenytt installs no web panel, opens no port on your server and depends
on no third-party service. Credentials stay in your operating system's keychain, and anything that
passes through a relay server is end-to-end encrypted.

Zenytt is free and built in my spare time. If it helps you, you can
[support the project on GitHub Sponsors](https://github.com/sponsors/NathanChevrollier) ❤️

> The application interface is currently in French. This page describes what it does for readers
> evaluating it; an English interface is on the roadmap.

## Contents

- [Installation](#installation)
- [Getting started](#getting-started)
- [Features](#features)
- [AI assistant](#ai-assistant)
- [Sharing and sync](#sharing-and-sync)
- [MCP server (read-only)](#mcp-server-read-only)
- [The `zenyttd` agent](#the-zenyttd-agent)
- [Security model](#security-model)
- [Server requirements](#server-requirements)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Development](#development)
- [License](#license)

## Installation

With your system's package manager:

```sh
winget install NathanChevrollier.Zenytt                              # Windows
brew tap NathanChevrollier/tap && brew install --cask zenytt-desktop # macOS
yay -S zenytt-desktop-bin                                            # Arch Linux (AUR)
flatpak install flathub dev.zenytt.desktop                           # Linux (Flatpak)
```

Or download an installer from the [Releases](https://github.com/NathanChevrollier/Zenytt/releases/latest) page:

| System | File |
| --- | --- |
| Windows 10/11 | `Zenytt_x.y.z_x64-setup.exe` |
| Mac Apple Silicon (M1, M2, M3… chip) | `Zenytt_x.y.z_aarch64.dmg` |
| Mac Intel | `Zenytt_x.y.z_x64.dmg` |
| Linux | `.AppImage` (auto-updates), `.deb` or `.rpm` |

Apple Silicon or Intel? Apple menu  → *About This Mac*: the "Chip" (Apple M…) or "Processor"
(Intel) line tells you.

**On your phone**: the Android (`.apk`) and iPhone (`.ipa`, sideloaded with AltStore and a free Apple ID) companion app is
attached to each release. Steps (in French): [`apps/mobile`](apps/mobile/README.md#installer-lapp).

Zenytt checks for new versions at startup and offers to install them. Update packages are signed: a
tampered version is rejected.

> **Windows** — until SignPath code signing is active, SmartScreen shows "Windows protected your
> PC" → *More info* → *Run anyway*.
>
> **macOS** — the app is not yet notarized by Apple. If macOS refuses to open it, run once:
> `xattr -dr com.apple.quarantine /Applications/Zenytt.app`.

## Getting started

1. **Add a server** — *Serveurs* → *Nouveau serveur*: host, port, user, then password, OpenSSH key,
   PuTTY `.ppk` key, OpenSSH agent or Pageant. Existing PuTTY sessions and `~/.ssh/config` can be
   imported in one click.
2. **Approve the host key** on first connection: its fingerprint is stored, and any later change
   blocks the connection.
3. **Work** — sections are in the left column, the active server in the top bar. The command palette
   (**Ctrl+K**) reaches any action without leaving the keyboard.

Secrets are never written to configuration files: they go to the system keychain (Windows
Credential Manager, macOS Keychain, Secret Service on Linux).

## Features

| Section | What it does |
|---|---|
| **Home** | Health of every server at a glance: CPU, memory, disk, alerts, stopped containers, certificates about to expire. |
| **Servers** | SSH profiles, folders, reusable credential vault, jump hosts, PuTTY and `ssh_config` import, host key verification, **remote desktops inside the app**: RDP (with file transfer through the clipboard) and **VNC** (adjustable image quality, view-only mode) in built-in clients, **SPICE** VM consoles in remote-viewer — all through an SSH tunnel when needed. |
| **Terminal** | **Persistent tmux sessions** that survive disconnects and closing the app. Tabs and splits, a file panel that follows the current directory, drag-and-drop uploads into it, **input broadcast** to several servers with confirmation of sensitive commands, a **"Why did this command fail?"** button that opens the assistant on the error, **fuzzy server history search** (Ctrl+Shift+R), **parameterised snippets** (`{{container}}`, `{{lines:100}}`), session recording (asciicast). |
| **Files** | SFTP browser, **remote name search and grep** (Ctrl+P, nothing is downloaded), **server-side compression and extraction** (tar.gz, zip, tar.zst), **side-by-side file comparison**, **dual pane** to copy between servers, cancellable transfers, remote editing in Monaco, sudo fallback. |
| **Monitoring** | CPU, memory, disks, network, processes, systemd services. With the `zenyttd` agent: 30 days of history and alerts (thresholds, unreachable sites, failed backups) to Discord, ntfy or a webhook, even with your PC off. |
| **Docker** | Containers, stats, live logs, shell into a container, Compose projects, a **one-click application catalogue** (Nextcloud, Vaultwarden, Uptime Kuma, Gitea, n8n, Plausible… with generated passwords and ports bound to 127.0.0.1 only), images, **volumes with their real size and orphan detection**, cleanup showing the space reclaimed before deleting, **private registries** (Docker Hub, GitHub Packages, GitLab, AWS ECR, self-hosted) with credentials in the system keychain. **Deployment** with automatic rollback, deployment from GitHub with a restricted key, **restricting published ports** to 127.0.0.1. |
| **Databases** | MySQL/MariaDB, PostgreSQL and **SQLite**, in containers or on the host: databases, tables, SQL editor with **table and column autocompletion**, **sort and filter from the column header**, **in-place cell editing** showing the exact `UPDATE` before it runs (a primary key is required), row insert and delete, CSV export. **Redis / Valkey explorer**: paged key browsing (SCAN), every type, TTL, console. |
| **Sites** | Domain → nginx or Apache → port → container, TLS certificates, safe vhost editor, "New site" wizard, **configuration history** with diff and restore. |
| **Logs** | Docker, systemd and followed files, live, merged, filterable (text, regex, level) and exportable. |
| **Tunnels** | Local SSH tunnels (127.0.0.1 only) to reach a database or admin UI without exposing it. |
| **Backups** | Encrypted, deduplicated restic: consistent MySQL/PostgreSQL dumps, volumes, folders, to the server or S3 storage. Scheduling, retention, verification, restore. |
| **Security** | Audit (SSH, firewall, fail2ban, updates, exposed ports, UID 0 accounts, xrdp capped at 16-bit colour) with guided fixes. SSH and firewall changes keep a control connection open and roll back automatically if they fail. |
| **Settings** | Log of every action, per-server AI access, sync, app lock, light/dark theme, shortcuts. |

## AI assistant

A side panel (**Ctrl+I**) connected to the provider of your choice:

| Provider | Details |
|---|---|
| **Claude (Anthropic)** | Messages API |
| **OpenAI-compatible** | any API exposing `/chat/completions` |
| **Local** | Ollama, LM Studio or similar, sending nothing outside |

Three execution modes: **read-only** (it explains), **propose** (you approve each command — the
default) and **autonomous** (it runs commands, but sensitive ones still ask). What it may read is
chosen box by box, server by server; the API key lives in the system keychain and every call is
logged.

## Sharing and sync

- **Shared terminal** — a `zenytt-term:…` invitation gives view-only or control access to a terminal,
  without creating an account on the server or opening a port.
- **Configuration sharing** — a `zenytt-share:…` code transfers a server profile (and optionally its
  secrets) to another Zenytt install.
- **Multi-device sync** — servers, credentials, approved host keys, snippets and tunnels, through a
  **file** (OneDrive, Dropbox, Syncthing, network share) or the small self-hosted
  [`sync-server/`](sync-server/).

Content is always encrypted client-side (AES-256-GCM, key derived from your passphrase): the relay
never sees plaintext and rejects anything unencrypted.

## MCP server (read-only)

`Zenytt --mcp` exposes **14 read-only tools** to compatible assistants (Claude Code, Claude Desktop…):
status, history, alerts, containers, logs, sites, nginx configuration, audit, backups, processes,
configuration files. No tool can modify a server or run an arbitrary command; only servers allowed
in Settings are visible; secrets are masked and private keys refused; every call is logged.

## The `zenyttd` agent

Optional: Zenytt works without it, but the agent brings history and offline alerts. A static Linux
binary of about 2 MB (x86_64 and arm64), embedded in the app and installed in one click. It runs as
a dedicated system user under a hardened systemd unit (`ProtectSystem=strict`, `NoNewPrivileges`,
64 MB RAM cap), and **only listens on a unix socket** — the app queries it through the SSH
connection, no port is opened.

## Security model

- **One channel**: SSH. No mandatory agent, no open port, no third-party service.
- **Secrets in the OS keychain**, never in configuration files.
- **Host key checked** on every connection; a changed fingerprint blocks and warns.
- **Reversible configuration changes.** Every nginx or Apache write follows the same server-side
  script: full backup, write, config test (`nginx -t`, `apachectl configtest`), reload, and exact
  restore on failure. The web server is never reloaded with an invalid configuration.
- **Sensitive commands confirmed** (deletion, restart, multi-server broadcast, database writes).
- **Local action log**, fed by the app, the MCP server and the assistant.
- **App lock** by password, manual (Ctrl+Shift+L) or after inactivity.

## Server requirements

| Item | Required |
|---|---|
| System | Linux with `systemd` (Debian, Ubuntu, Rocky, Alma…), SSH access |
| Persistent terminal | `tmux` (installed from the app if missing) |
| Containers | Docker or Podman, directly or through `sudo` |
| Sites | nginx or Apache |
| Databases | MySQL/MariaDB, PostgreSQL (host or container), `sqlite3`, `redis-cli` |
| Backups | restic (installed from the app if missing) |
| Extended monitoring | `zenyttd` agent (optional) |

Features unavailable on a given server are flagged in the interface rather than hidden.

## Keyboard shortcuts

All configurable in Settings → Preferences.

| Action | Default |
|---|---|
| Command palette | `Ctrl+K` |
| AI assistant | `Ctrl+I` |
| Lock Zenytt | `Ctrl+Shift+L` |
| New terminal tab / close tab | `Ctrl+Shift+T` / `Ctrl+Shift+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Search in terminal | `Ctrl+Shift+F` |
| Server command history | `Ctrl+Shift+R` |
| Find a file or text (Files) | `Ctrl+P` |
| Copy / paste in terminal | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| Refresh the view | `F5` |

## Development

**Prerequisites**: stable Rust, Node 24+, pnpm. On Windows: WebView2 and the MSVC Build Tools.

```sh
pnpm install
pnpm build:agent   # zenyttd binaries, embedded in the next app build
pnpm dev           # app in development mode
pnpm build         # installers in target/release/bundle/
pnpm typecheck     # TypeScript
pnpm test          # Rust workspace tests + frontend tests
```

The repository layout, test environment, CI and release process are described in detail in the
[French README](README.md#architecture-du-dépôt). Code comments and commit messages are in French.

## License

© 2026 Nathan Chevrollier. Zenytt is **source-available** under the
[PolyForm Shield License 1.0.0](LICENSE): free to use, including at work, to read and to modify,
but not to build a competing product or service. Versions up to and including 1.1.1 remain under
the MIT license.

- [Privacy policy](docs/legal/privacy.en.md): no telemetry, everything stays on your computer
- Terms of use and legal notice (French): [conditions](docs/legal/conditions-utilisation.md), [mentions légales](docs/legal/mentions-legales.md)
- [Third-party components](THIRD_PARTY_NOTICES.md) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)
