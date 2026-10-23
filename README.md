# Zenytt

[![CI](https://github.com/NathanChevrollier/Zenytt/actions/workflows/ci.yml/badge.svg)](https://github.com/NathanChevrollier/Zenytt/actions/workflows/ci.yml)
[![Dernière version](https://img.shields.io/github/v/release/NathanChevrollier/Zenytt?label=version)](https://github.com/NathanChevrollier/Zenytt/releases/latest)
[![Licence PolyForm Shield](https://img.shields.io/badge/licence-PolyForm%20Shield%201.0.0-blue)](LICENSE)
[![Soutenir](https://img.shields.io/github/sponsors/NathanChevrollier?label=soutenir&logo=githubsponsors)](https://github.com/sponsors/NathanChevrollier)

*[English version](README.en.md)*

Application de bureau (Windows, macOS, Linux) pour administrer ses serveurs Linux : terminal SSH,
fichiers, supervision, Docker, bases de données, sites web, sauvegardes et audit de sécurité dans
une seule fenêtre.

**Tout passe par SSH.** Zenytt n'installe aucun panneau web, n'ouvre aucun port sur le serveur et ne
dépend d'aucun service tiers. Les identifiants restent dans le coffre-fort du système
d'exploitation, et tout ce qui transite par un serveur de relais est chiffré de bout en bout.

Zenytt est gratuit et développé sur mon temps libre. S'il te rend service, tu peux
[soutenir le projet sur GitHub Sponsors](https://github.com/sponsors/NathanChevrollier) ❤️

## Sommaire

- [Installation](#installation)
- [Premiers pas](#premiers-pas)
- [Fonctionnalités](#fonctionnalités)
- [Assistant IA](#assistant-ia)
- [Partage et synchronisation](#partage-et-synchronisation)
- [Serveur MCP (lecture seule)](#serveur-mcp-lecture-seule)
- [Agent `zenyttd`](#agent-zenyttd)
- [Modèle de sécurité](#modèle-de-sécurité)
- [Compatibilité serveur](#compatibilité-serveur)
- [Raccourcis clavier](#raccourcis-clavier)
- [Architecture du dépôt](#architecture-du-dépôt)
- [Développement](#développement)
- [Intégration continue et publication](#intégration-continue-et-publication)
- [Licence et mentions légales](#licence-et-mentions-légales)

## Installation

Par le gestionnaire de paquets de ton système :

```sh
winget install NathanChevrollier.Zenytt                              # Windows
brew tap NathanChevrollier/tap && brew install --cask zenytt-desktop # macOS
yay -S zenytt-desktop-bin                                            # Arch Linux (AUR)
flatpak install flathub dev.zenytt.desktop                           # Linux (Flatpak)
```

Les manifestes de chaque canal sont dans [`packaging/`](packaging/). Sinon, les installeurs sont
publiés sur la page [Releases](https://github.com/NathanChevrollier/Zenytt/releases/latest).

| Système | Fichier |
| --- | --- |
| Windows 10/11 | `Zenytt_x.y.z_x64-setup.exe` |
| Mac Apple Silicon (puce M1, M2, M3…) | `Zenytt_x.y.z_aarch64.dmg` |
| Mac Intel | `Zenytt_x.y.z_x64.dmg` |
| Linux | `.AppImage` (mises à jour automatiques), `.deb` ou `.rpm` |

Mac Apple Silicon ou Intel ? Menu  → *À propos de ce Mac* : la ligne « Puce » (Apple M…) ou
« Processeur » (Intel) le dit.

**Sur téléphone** : le compagnon Android (`.apk`) et iPhone (`.ipa`, via AltStore et un identifiant Apple gratuit) est
joint à chaque release. Pas à pas : [`apps/mobile`](apps/mobile/README.md#installer-lapp).

Zenytt vérifie au démarrage si une nouvelle version existe et propose de l'installer
(Réglages → Maintenance → Mises à jour). Les paquets sont signés : une version altérée est refusée.

> **Windows** — tant que la signature de code SignPath n'est pas active, SmartScreen affiche
> « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
> La chaîne de publication signe l'installeur dès que les secrets SignPath sont en place
> (voir [`packaging/README.md`](packaging/README.md#signature-de-code-windows-signpath)).
>
> **macOS** — l'app n'est pas notariée par Apple. Au premier lancement :
> *Réglages Système* → *Confidentialité et sécurité* → *Ouvrir quand même*. Si macOS indique que
> l'app « est endommagée », lancer une fois
> `xattr -dr com.apple.quarantine /Applications/Zenytt.app`.

## Premiers pas

1. **Ajouter un serveur** — section *Serveurs* → *Nouveau serveur* : hôte, port, utilisateur, puis
   mot de passe, clé OpenSSH, clé PuTTY `.ppk`, agent OpenSSH ou Pageant. Les sessions PuTTY et
   `~/.ssh/config` existantes peuvent être importées d'un clic.
2. **Approuver la clé d'hôte** à la première connexion : son empreinte est mémorisée et toute
   modification ultérieure bloque la connexion.
3. **Travailler** — le sélecteur en haut de la colonne de gauche choisit le serveur actif
   (**Ctrl+Shift+S**) ; en dessous, les sections du poste puis celles du serveur. La palette de
   commandes (**Ctrl+K**, préfixes `>` actions, `@` serveurs, `/` chemins, `#` conteneurs) ouvre
   n'importe quelle action sans quitter le clavier.

Les secrets ne sont jamais écrits dans les fichiers de configuration : ils vont dans le coffre-fort
du système (Windows Credential Manager, Trousseau macOS, Secret Service sous Linux).

## Fonctionnalités

| Section | Ce qu'elle fait |
|---|---|
| **Accueil** | Santé de tous les serveurs d'un coup d'œil : CPU, mémoire, disque, alertes, conteneurs arrêtés, certificats proches de l'expiration. |
| **Serveurs** | Profils SSH, dossiers de rangement, banque d'identifiants réutilisables, serveurs de rebond, import PuTTY et `ssh_config`, vérification de la clé d'hôte, **bureaux à distance ouverts dans l'app** : RDP (avec transfert de fichiers par le presse-papiers) et **VNC** (qualité d'image réglable, lecture seule) dans des clients intégrés, consoles de VM **SPICE** dans remote-viewer — le tout à travers un tunnel SSH quand la machine n'est joignable que depuis un serveur. |
| **Terminal** | Sessions **tmux persistantes** qui survivent aux coupures et à la fermeture de l'app. Onglets, division horizontale ou verticale réglable, panneau de fichiers qui suit le dossier courant, dépôt de fichiers Windows directement dans le dossier courant, **diffusion de la saisie** à plusieurs serveurs avec confirmation des commandes sensibles, **bouton « Pourquoi cette commande a échoué ? »** qui ouvre l'assistant sur l'erreur, **historique du serveur** en recherche approximative (Ctrl+Maj+R), fragments **à paramètres** (`{{conteneur}}`, `{{lignes:100}}`), enregistrement de session (asciicast). |
| **Fichiers** | Explorateur SFTP, **recherche par nom et grep distants** (Ctrl+P, rien n'est téléchargé), **compression et extraction côté serveur** (tar.gz, zip, tar.zst), **comparaison de deux fichiers**, **double panneau** pour copier d'un serveur à l'autre, glisser-déposer, transferts annulables, édition distante dans Monaco, repli sudo. |
| **Supervision** | CPU, mémoire, disques, réseau, processus, services systemd. Avec l'agent `zenyttd` : 30 jours d'historique et alertes (seuils, sites injoignables, sauvegardes en échec) vers Discord, ntfy ou webhook, même PC éteint. |
| **Docker** | Conteneurs, statistiques, logs en direct, shell dans un conteneur, projets compose (création assistée depuis l'interface), **catalogue d'applications en un clic** (Nextcloud, Vaultwarden, Uptime Kuma, Gitea, n8n, Plausible…, mots de passe générés, ports sur 127.0.0.1 seulement), images, **volumes avec leur taille réelle et détection des orphelins**, nettoyage chiffré en octets avant suppression, **registres privés** (Docker Hub, GitHub Packages, GitLab, AWS ECR, registre auto-hébergé) avec identifiants dans le coffre du système. **Déploiement** (pull → up → vérification → retour arrière automatique), **déploiement depuis GitHub** par clé restreinte, **restriction des ports publiés** à 127.0.0.1, accès local par tunnel. |
| **Bases de données** | MySQL/MariaDB, PostgreSQL et **SQLite**, en conteneur ou installés sur l'hôte : bases, tables, éditeur SQL avec **autocomplétion des tables et colonnes**, exécution (Ctrl+Entrée), **tri et filtres depuis l'en-tête**, **édition en cellule** avec aperçu du `UPDATE` avant exécution (clé primaire exigée), ajout et suppression de ligne, export CSV. **Explorateur Redis / Valkey** : clés par pages (SCAN), tous les types, durée de vie, console. |
| **Sites** | Domaine → nginx ou Apache → port → conteneur, certificats TLS, éditeur de vhost sécurisé, assistant « Nouveau site », **historique des configurations** avec comparaison et restauration. |
| **Journaux** | Logs Docker, systemd et fichiers suivis en direct, fusionnés, filtrables (texte, expression régulière, niveau) et exportables. |
| **Tunnels** | Tunnels SSH locaux (127.0.0.1 uniquement) pour joindre une base ou une interface d'administration sans l'exposer. |
| **Sauvegardes** | restic chiffré et dédupliqué : dumps MySQL/PostgreSQL cohérents, volumes, dossiers, vers le serveur ou un stockage S3. Planification, rétention, vérification, restauration (téléchargement, remise en place, réimport d'une base). |
| **Sécurité** | Audit (SSH, pare-feu, fail2ban, mises à jour, ports exposés, comptes UID 0, xrdp limité à 16 bits) et corrections guidées ; alertes ignorables puis archivées. Pour SSH et le pare-feu, une connexion de contrôle est maintenue et la modification est annulée automatiquement si elle échoue. |
| **Réglages** | Journal de toutes les actions, accès IA serveur par serveur, synchronisation, verrouillage de l'app, thème clair/sombre, raccourcis. |

## Assistant IA

Panneau latéral (**Ctrl+I**) relié au fournisseur de votre choix :

| Fournisseur | Détail |
|---|---|
| **Claude (Anthropic)** | API Messages, `claude-opus-5` par défaut |
| **Compatible OpenAI** | toute API exposant `/chat/completions` |
| **Local** | Ollama, LM Studio ou équivalent, sans rien envoyer à l'extérieur |

Trois modes d'exécution : **lecture seule** (il explique), **proposition** (chaque commande est
validée par vous, mode par défaut) et **autonome** (il exécute, mais les commandes sensibles
demandent quand même votre accord).

Ce qu'il peut consulter se choisit case par case, serveur par serveur : état, conteneurs, journaux,
sites, processus, fichiers de configuration, audit de sécurité. La clé d'API est rangée dans le
coffre-fort du système et chaque appel apparaît au journal d'actions.

## Partage et synchronisation

- **Terminal partagé** — une invitation `zenytt-term:…` donne un accès en lecture seule ou avec le
  contrôle à un terminal, sans créer de compte sur le serveur ni ouvrir de port.
- **Partage de configuration** — un code `zenytt-share:…` transmet un profil de serveur (et, si vous
  le voulez, ses secrets) à une autre installation de Zenytt.
- **Synchronisation multi-postes** — serveurs, identifiants, clés d'hôte approuvées, snippets et
  tunnels, soit par **fichier** (dossier OneDrive, Dropbox, Syncthing, partage réseau), soit par le
  petit serveur [`sync-server/`](sync-server/) à héberger soi-même.

Dans tous les cas, le contenu est chiffré côté client (AES-256-GCM, clé dérivée de votre phrase de
passe) : le relais ne voit jamais rien en clair et refuse tout contenu non chiffré.

## Serveur MCP (lecture seule)

`Zenytt --mcp` expose aux assistants compatibles (Claude Code, Claude Desktop…) **14 outils en
lecture seule** : état, historique, alertes, conteneurs, journaux, sites, configuration nginx,
audit, sauvegardes, processus, fichiers de configuration.

- Aucun outil ne peut modifier un serveur ni exécuter une commande libre.
- Seuls les serveurs autorisés dans Réglages → Accès IA (MCP) sont visibles.
- Les secrets sont masqués et les clés privées refusées.
- Chaque appel est inscrit au journal d'actions.

La configuration à copier se trouve dans Réglages → Accès IA (MCP).

## Agent `zenyttd`

Optionnel : Zenytt fonctionne sans lui, mais l'agent apporte l'historique et les alertes hors ligne.

- Binaire Linux statique d'environ 2 Mo (x86_64 et arm64), embarqué dans l'app et installé en un
  clic depuis Supervision → Alertes et agent.
- Tourne sous un utilisateur système dédié, avec un service systemd durci (`ProtectSystem=strict`,
  `NoNewPrivileges`, 64 Mo de RAM maximum).
- **N'écoute que sur un socket unix** (`/run/zenyttd/zenyttd.sock`) : l'app l'interroge à travers la
  connexion SSH, aucun port n'est ouvert.
- Configuration : `/etc/zenyttd/config.json` (`root:zenyttd`, `0640`), rechargée à chaud.

## Modèle de sécurité

- **Un seul canal** : SSH. Pas d'agent obligatoire, pas de port ouvert, pas de service tiers.
- **Secrets dans le coffre-fort de l'OS**, jamais dans les fichiers de configuration ni dans les
  sauvegardes de réglages non chiffrées.
- **Clé d'hôte vérifiée** à chaque connexion ; un changement d'empreinte bloque et prévient.
- **Modifications de configuration réversibles.** Chaque écriture nginx ou Apache suit le même
  déroulé, exécuté côté serveur par un seul script :
  1. sauvegarde complète de la configuration dans `/var/backups/zenytt/…` (30 dernières conservées) ;
  2. écriture du fichier ;
  3. test de configuration (`nginx -t`, `apachectl configtest`) ;
  4. rechargement ;
  5. en cas d'échec, restauration exacte des fichiers et des liens.

  Le serveur web n'est jamais rechargé avec une configuration invalide et les autres sites ne sont
  pas touchés ; les écritures hors des répertoires de configuration sont refusées.
- **Commandes sensibles confirmées** (suppression, redémarrage, diffusion à plusieurs serveurs).
- **Journal d'actions** local, consultable dans Réglages → Journal d'actions, alimenté par l'app, le MCP et l'assistant.
- **Verrouillage de l'app** par mot de passe, manuel (Ctrl+Shift+L) ou après inactivité.

## Compatibilité serveur

| Élément | Requis |
|---|---|
| Système | Linux avec `systemd` (Debian, Ubuntu, Rocky, Alma…), accès SSH |
| Terminal persistant | `tmux` (installé depuis l'app si absent) |
| Conteneurs | Docker ou Podman, accès direct ou via `sudo` |
| Sites | nginx ou Apache |
| Bases de données | MySQL/MariaDB, PostgreSQL (hôte ou conteneur), `sqlite3` pour SQLite, `redis-cli` pour Redis |
| Sauvegardes | restic (installé depuis l'app si absent) |
| Supervision étendue | agent `zenyttd` (facultatif) |

Les fonctions non disponibles sur un serveur sont signalées dans l'interface plutôt que masquées.

## Raccourcis clavier

Tous modifiables dans Réglages → Raccourcis (F1 affiche l'aide-mémoire).

| Action | Par défaut |
|---|---|
| Palette de commandes | `Ctrl+K` |
| Changer de serveur | `Ctrl+Shift+S` |
| Aide-mémoire des raccourcis | `F1` |
| Assistant IA | `Ctrl+I` |
| Verrouiller Zenytt | `Ctrl+Shift+L` |
| Nouvel onglet de terminal | `Ctrl+Shift+T` |
| Fermer l'onglet | `Ctrl+Shift+W` |
| Onglet suivant / précédent | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Rechercher dans le terminal | `Ctrl+Shift+F` |
| Historique des commandes du serveur | `Ctrl+Shift+R` |
| Chercher un fichier ou du texte (Fichiers) | `Ctrl+P` |
| Copier / coller dans le terminal | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| Actualiser la vue | `F5` |

## Architecture du dépôt

Monorepo pnpm + cargo.

| Dossier | Rôle |
|---|---|
| `apps/desktop` | Application Tauri 2 : interface React/TypeScript (`src/`) et commandes Rust (`src-tauri/`) |
| `crates/core` | SSH, SFTP, tmux, Docker, nginx, Apache, bases de données, systemd, audit, sauvegardes, déploiement |
| `crates/protocol` | Analyseurs `/proc`, types et protocole partagés entre l'app et l'agent |
| `crates/agent` | `zenyttd`, l'agent de supervision installé sur le serveur |
| `crates/profiles` | Profils, secrets (keyring), journal d'actions, export et synchronisation |
| `crates/mcp` | Serveur MCP en lecture seule, intégré à l'app via `--mcp` |
| `crates/ai` | Client des fournisseurs d'IA (Anthropic, compatible OpenAI, local) |
| `sync-server/` | Service à héberger pour la synchronisation et le relais de terminaux (workspace séparé) |
| `testenv/` | Faux VPS Docker (sshd, nginx, sudo, Docker-in-Docker) pour les tests |
| `docs/` | Notes d'architecture, audits et plans de travail |

L'interface ne parle jamais directement à un serveur : elle appelle des commandes Tauri, qui
s'appuient sur `zenytt-core` pour toute opération distante. Les secrets restent côté Rust.

## Développement

**Prérequis** : Rust stable, Node 24+, pnpm. Sous Windows : WebView2 et les MSVC Build Tools.
Pour compiler l'agent : `pip install ziglang`, `cargo install cargo-zigbuild`, puis
`rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl`.

```sh
pnpm install
pnpm build:agent   # binaires zenyttd, embarqués dans l'app au build suivant
pnpm dev           # app en mode développement
pnpm build         # installeurs dans target/release/bundle/
pnpm typecheck     # TypeScript
pnpm test          # tests Rust du workspace + tests front
```

L'app se compile sans l'agent : le bouton d'installation signale alors que le binaire n'a pas été
construit.

### Environnement de test

```sh
pnpm testenv       # faux VPS sur 127.0.0.1:2222 (root/zenytt, deploy/deploy)
cargo run -p zenytt-core --example smoke        # SSH, sudo, SFTP, shell
cargo run -p zenytt-core --example nginx_smoke  # écriture nginx sûre (valide, cassée, restauration)
cargo run -p zenytt-core --example cwd_smoke    # suivi du dossier courant du terminal
```

Le faux VPS a son propre démon Docker (Docker-in-Docker) : il ne voit jamais les conteneurs de la
machine hôte. Il embarque trois applications de démonstration — `demo-app`, `whoami` (port 8082) et
`demo-db` (MariaDB, mot de passe root `demo`). Pour tout supprimer :
`docker compose -f testenv/docker-compose.yml down -v`.

### Conventions

- Interface, commentaires et messages de commit en français.
- Commits au format [Conventional Commits](https://www.conventionalcommits.org/fr/) :
  `type(portée): message`.
- `cargo fmt`, `clippy -D warnings` et `tsc --noEmit` doivent passer avant de proposer un
  changement.

## Intégration continue et publication

À chaque push et pull request, GitHub Actions ([ci.yml](.github/workflows/ci.yml)) exécute :
typecheck, tests front, `cargo fmt`, `clippy -D warnings` (Linux et Windows), tests Rust, audit des
dépendances, tests de bout en bout contre le faux VPS, puis compilation de l'agent (zig).

Pour publier une version :

```sh
pnpm release 0.6.0
```

Le script met la version à jour (Cargo, app, Tauri), crée le commit `chore(release): v0.6.0` et le
tag `v0.6.0`, puis les pousse. Le tag déclenche [release.yml](.github/workflows/release.yml) : CI
complète, brouillon de release avec notes issues des commits, installeurs Windows (NSIS), macOS
(arm64 et Intel) et Linux (AppImage, deb, rpm) signés pour la mise à jour, puis publication avec le
manifeste `latest.json`. Si les secrets SignPath existent, l'installeur Windows est signé entre les
deux, et sa signature de mise à jour recalculée. Une fois la release publiée,
[winget.yml](.github/workflows/winget.yml) soumet la version à winget, et
`python3 scripts/packaging.py v0.6.0` met à jour les manifestes Homebrew, AUR et Flatpak. Un tag suffixé (`v0.6.0-beta.1`) produit une pré-release, ignorée par les
mises à jour automatiques.

La clé de signature des mises à jour est dans les secrets du dépôt
(`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) ; sa clé publique est dans
`tauri.conf.json`. Si elle est perdue, les versions déjà installées ne pourront plus se mettre à
jour automatiquement.

## Licence et mentions légales

© 2026 Nathan Chevrollier. Zenytt est un logiciel à **source disponible** sous licence
[PolyForm Shield 1.0.0](LICENSE) : tu peux l'utiliser gratuitement, y compris au travail, lire et
modifier son code, mais pas t'en servir pour proposer un produit ou service concurrent. Les
versions jusqu'à la 1.1.1 incluse restent sous licence MIT.

- [Conditions d'utilisation](docs/legal/conditions-utilisation.md)
- [Politique de confidentialité](docs/legal/confidentialite.md) : aucune télémétrie, tout reste sur ton ordinateur
- [Mentions légales](docs/legal/mentions-legales.md)
- [Composants tiers et leurs licences](THIRD_PARTY_NOTICES.md) (régénérer avec `python scripts/third-party-notices.py` quand les dépendances changent)
- [Signaler une faille de sécurité](SECURITY.md) · [Contribuer](CONTRIBUTING.md)
