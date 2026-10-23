# Zenytt Discord Bot

Bot Discord autonome pour centraliser les suggestions et signalements de bugs de Zenytt dans GitHub.

## Fonctionnalités

- `/setup-feedback` publie deux panneaux interactifs dans les salons configurés par ID.
- Les boutons et `/bug` / `/suggestion` ouvrent des modales Discord natives.
- Chaque retour crée une issue GitHub avec le label `bug` ou `enhancement`, le lien vers l'auteur Discord et son avatar.
- Le formulaire accepte jusqu'à 4 captures d'écran ou photos (PNG, JPEG, GIF, WebP, 8 Mo chacune). Le bot vérifie leur contenu réel, **retire leurs métadonnées** (position GPS, appareil, auteur, commentaires ; l'orientation des photos est gardée), puis les archive dans une branche dédiée du dépôt (`feedback-attachments`, sans lien avec le code) : les liens de Discord expirent, ceux de l'issue restent. Une image refusée n'empêche pas l'envoi du retour ; la personne est prévenue.
- La roadmap maintient un seul embed à jour avec les cartes du GitHub Project v2 (issues et brouillons), rangées selon leur statut, en français ou en anglais (« Todo », « En cours », « En test », « Terminé »…).
- `/zenytt status` affiche le ping, l'uptime et la dernière release GitHub de Zenytt.
- `/sync-roadmap` force la mise à jour du panneau et `/roadmap` affiche les chantiers en privé.
- Les commandes sont enregistrées au niveau de `GUILD_ID`, donc disponibles immédiatement sur le serveur ciblé.

## Pré-requis

- Node.js 22 LTS ou Docker.
- Un bot créé dans le [Discord Developer Portal](https://discord.com/developers/applications).
- Les intents privilégiés ne sont pas nécessaires: le bot utilise seulement `Guilds`.
- Le bot doit avoir les permissions `View Channels`, `Send Messages`, `Embed Links` et `Use Application Commands` dans les deux salons.
- Le token GitHub doit être un fine-grained token limité au dépôt Zenytt avec **uniquement** `Issues: Read and write` (et `Projects: Read` si le mode Project v2 est utilisé). Ne lui donne jamais `Contents: Write` sur le dépôt Zenytt : un jeton fuité pourrait y pousser un tag et déclencher une release signée.
- Les captures vont dans un **dépôt séparé** (`GITHUB_ATTACHMENTS_REPO`, même propriétaire) avec son propre jeton fine-grained (`GITHUB_ATTACHMENTS_TOKEN`, `Contents: Read and write` sur ce seul dépôt). Un jeton fine-grained a les mêmes droits sur tous les dépôts qu'il couvre : c'est pourquoi il en faut deux. Sans ces deux variables, le bot retombe sur le dépôt Zenytt et `GITHUB_TOKEN` (avertissement au démarrage) ; mets `GITHUB_ATTACHMENTS_BRANCH` vide pour désactiver les captures.
- Les fichiers dans les formulaires (composant « File Upload ») demandent un client Discord à jour ; discord.js 14.22 ou plus côté bot.

## Configuration locale

```powershell
Copy-Item .env.example .env
# Renseigner les secrets et identifiants dans .env
pnpm install
pnpm --filter zenytt-discord-bot typecheck
pnpm --filter zenytt-discord-bot test
pnpm --filter zenytt-discord-bot dev
```

Une fois connecté, exécuter `/setup-feedback` avec un membre qui dispose de `Manage Server`.

Pour la roadmap, crée un salon dédié et copie son ID dans `ROADMAP_CHANNEL_ID`. Le bot crée ou
retrouve son embed dans les 50 derniers messages, puis l'édite à intervalle régulier. Tu peux
forcer une mise à jour avec `/sync-roadmap`.

Pour lire le GitHub Project v2, crée un jeton « classic » (Settings → Developer settings →
Personal access tokens → Tokens (classic)) avec la seule permission `read:project`, et mets-le
dans `GITHUB_PROJECT_TOKEN` : les jetons fine-grained ne peuvent pas lire le projet d'un compte
personnel. Le bot retrouve seul le projet dont le titre contient le nom du dépôt
(`GITHUB_PROJECT_NUMBER` le force). Sans ce jeton, il se rabat sur les labels configurés.

## Configuration des secrets

| Variable                        | Rôle                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `DISCORD_TOKEN`                 | Token privé du bot Discord; ne jamais le publier.      |
| `CLIENT_ID`                     | Application ID du bot Discord.                         |
| `GUILD_ID`                      | ID du serveur où enregistrer les commandes.            |
| `GITHUB_TOKEN`                  | Fine-grained token GitHub limité au dépôt Zenytt, `Issues: Read and write` seulement. |
| `GITHUB_OWNER`                  | Propriétaire du dépôt, par défaut `NathanChevrollier`. |
| `GITHUB_REPO`                   | Nom du dépôt, par défaut `Zenytt`.                       |
| `GITHUB_PROJECT_TOKEN`          | Jeton classic `read:project` pour lire le Project v2.  |
| `GITHUB_PROJECT_NUMBER`         | Numéro du Project v2 (facultatif, trouvé seul sinon).  |
| `SUGGESTION_CHANNEL_ID`         | ID Discord du salon de suggestions.                    |
| `BUG_CHANNEL_ID`                | ID Discord du salon de bugs.                           |
| `ROADMAP_CHANNEL_ID`            | ID Discord du salon où publier le panneau roadmap.     |
| `ROADMAP_MESSAGE_ID`            | ID facultatif du message à éditer directement.         |
| `ROADMAP_SYNC_INTERVAL_MINUTES` | Intervalle de synchronisation, 15 minutes par défaut.  |
| `GITHUB_ATTACHMENTS_BRANCH`     | Branche des captures, `feedback-attachments` par défaut ; vide pour désactiver les captures. |
| `GITHUB_ATTACHMENTS_REPO`       | Dépôt séparé des captures (même propriétaire) ; vide : dépôt Zenytt (déconseillé). |
| `GITHUB_ATTACHMENTS_TOKEN`      | Jeton fine-grained `Contents: Read and write` limité à ce dépôt de captures. |
| `GITHUB_BUG_LABEL`              | Label appliqué aux bugs.                               |
| `GITHUB_SUGGESTION_LABEL`       | Label appliqué aux suggestions.                        |
| `GITHUB_BRAINSTORMING_LABEL`    | Label des idées, `brainstorming` par défaut.           |
| `GITHUB_IN_PROGRESS_LABEL`      | Label des issues en cours, `in-progress` par défaut.   |
| `GITHUB_TEST_LABEL`             | Label des issues en test, `test` par défaut.           |
| `GITHUB_DONE_LABEL`             | Label des issues terminées, `done` par défaut.         |

## Déploiement Docker

Créer `.env` à partir de `.env.example`, puis depuis ce dossier:

```bash
docker compose up -d --build
docker compose logs -f zenytt-discord-bot
docker compose down
```

Le conteneur tourne en utilisateur non-root, sans port exposé, avec un système de fichiers en lecture seule et redémarrage automatique. Le fichier `.env` reste sur le serveur et n'est jamais copié dans l'image.

## Structure

```text
src/
  commands/       Définitions des slash commands
  config/         Validation Zod de l'environnement
  events/         ready et interactionCreate
  services/       Formatage du feedback et client GitHub
  types/          Contrats métier
```

## Limites et exploitation

Les issues sont créées immédiatement après la soumission de la modale. Une erreur GitHub est renvoyée à l'utilisateur sans exposer le token; une nouvelle soumission peut être faite après correction. Le bot est stateless: aucun contenu n'est conservé localement et aucun stockage n'est requis pour un redémarrage. Les captures ne transitent qu'en mémoire, le temps d'être nettoyées et envoyées à GitHub.

Pour retirer une capture publiée (demande d'une personne, information sensible oubliée), supprime son fichier dans la branche `feedback-attachments` **et** réécris l'historique de cette branche (elle ne contient que des captures : `git checkout --orphan` puis un nouveau commit sans le fichier, et `git push --force`), car un fichier supprimé reste accessible dans les anciens commits.
