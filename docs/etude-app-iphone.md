# Étude : une application iPhone pour Zenytt

*Ticket #26 · 5 octobre 2026 · statut : **proposition, décision à prendre** · étape 2 « Zenytt Compagnon » démarrée : [`apps/mobile`](../apps/mobile/README.md)*

## La demande

« Faire une app iPhone. » Le ticket ne précise pas l'usage. Les cas réalistes sur un téléphone
sont, dans l'ordre :

1. **Être prévenu et réagir vite** : une alerte (disque plein, conteneur tombé, sauvegarde ratée),
   un coup d'œil à l'état du serveur, un redémarrage de conteneur, un débannissement fail2ban.
2. **Dépanner en déplacement** : un terminal SSH pour une commande ou deux.
3. Administrer comme sur le PC (fichiers, sites nginx, bases, VM…) : peu réaliste sur un écran de
   téléphone, et déjà couvert par l'app de bureau.

## Ce qui est réutilisable

| Brique | Sur iPhone | Commentaire |
|---|---|---|
| Tauri 2 | Oui (cible iOS officielle depuis Tauri 2.0) | Même projet, même façon de déclarer les commandes. |
| `zenytt-core` (SSH, Docker, fail2ban, sauvegardes, supervision…) | Probablement | `russh` (Rust pur, `ring` pour la cryptographie) se compile pour `aarch64-apple-ios`. À vérifier sur un Mac : `ring` compile du C avec le SDK d'Apple. |
| `zenytt-profiles` (profils, secrets) | Oui, avec adaptation | `keyring` sait écrire dans le trousseau iOS ; le fichier `zenytt.json` irait dans le conteneur de l'app. |
| Synchronisation chiffrée existante | Oui | Le moyen naturel de récupérer ses serveurs sur le téléphone, sans ressaisie ni nouveau service. |
| Interface React | En partie | Le kit de composants et la logique (`lib/`) se réutilisent ; les pages sont pensées pour une souris et un grand écran : il faut une interface propre au téléphone. |
| Terminal (xterm.js) | Oui | Il faut une barre de touches (Échap, Ctrl, Tab, flèches) au-dessus du clavier iOS. |

## Ce qui ne passe pas sur iPhone

- **Lancer des programmes** : pas de mstsc, FreeRDP, remote-viewer ni PuTTY. Les écrans intégrés
  (RDP et VNC dans la webview) restent possibles, mais sont peu utilisables sur un téléphone.
- **Arrière-plan** : iOS coupe les connexions SSH quelques secondes après la sortie de l'app. Les
  sessions tmux de Zenytt aident (on retrouve son terminal), mais aucune surveillance continue
  n'est possible depuis le téléphone.
- **Mises à jour** : le module de mise à jour de Tauri ne fonctionne pas sur iOS ; tout passe par
  l'App Store (ou TestFlight).
- **Serveur MCP, icône de zone de notification, raccourcis globaux, démarrage avec le système** :
  propres au bureau.

## Prérequis et coûts

- **Compte Apple Developer** : 99 $ par an, au nom de l'éditeur (obligatoire pour TestFlight et
  l'App Store).
- **Un Mac** pour compiler et signer, ou la CI : `release.yml` utilise déjà des machines
  `macos-latest` sur GitHub Actions, réutilisables pour produire l'app iOS (les secrets de
  signature Apple s'ajoutent à ceux de la CI).
- **Un iPhone de test** (le simulateur ne suffit pas pour le trousseau et les notifications).
- **Revue App Store** : les clients SSH y sont acceptés (Termius, Blink Shell…). La fiche
  « confidentialité » de l'App Store doit refléter ce que fait l'app ; aujourd'hui : *aucune
  donnée collectée*.
- **Juridique** : la licence PolyForm Shield n'empêche pas une distribution sur l'App Store. Il
  faudrait ajouter les conditions d'Apple (EULA standard) et, en cas de notifications push, un
  service d'envoi à déclarer dans la politique de confidentialité.

## Les notifications : le vrai sujet

L'usage n°1 (être prévenu) demande des **notifications push**. Elles passent obligatoirement par le
service d'Apple (APNs), qui exige un serveur détenteur d'une clé Apple pour envoyer. Deux voies :

- **Sans serveur Zenytt** : l'agent `zenyttd` sait déjà envoyer ses alertes vers **ntfy**, dont
  l'app iPhone existe. On peut le proposer **dès aujourd'hui**, sans app Zenytt sur iPhone : c'est
  la réponse rapide au besoin d'alerte.
- **Avec un relais** : un petit service (par exemple dans `zenytt-sync`, que l'utilisateur
  héberge) qui relaie les alertes vers APNs. Plus intégré, mais c'est un service réseau de plus à
  maintenir et à déclarer dans la politique de confidentialité.

## Recommandation

Procéder par étapes, chacune utile en elle-même :

| Étape | Contenu | Effort indicatif |
|---|---|---|
| 0. Tout de suite | Documenter « alertes sur iPhone avec ntfy » (guide dans l'app + README). | 0,5 jour |
| 1. Faisabilité | Sur un Mac ou en CI : compiler `zenytt-core` et `zenytt-profiles` pour iOS, isoler par `cfg` ce qui est propre au bureau, lancer un squelette Tauri iOS qui ouvre une connexion SSH. | 2 à 3 jours |
| 2. « Zenytt Compagnon » | App iPhone centrée sur la consultation et les gestes rapides : serveurs récupérés par la synchronisation chiffrée, tableau de bord et supervision, alertes, conteneurs (redémarrer, journaux), fail2ban (débannir), terminal avec barre de touches. Distribution TestFlight puis App Store. | 3 à 5 semaines |
| 3. Plus tard | Notifications push par un relais APNs, widgets, iPad (écran plus grand : plus de pages réutilisables). | à chiffrer |

Ne **pas** viser une copie de l'app de bureau : l'effort serait celui d'une seconde application,
pour des pages (fichiers, sites, bases, VM) qu'on n'utilise pas sur un téléphone.

## Décisions attendues

1. Le besoin principal est-il bien « être prévenu et réagir » (ce qui oriente vers l'étape 0 puis
   le Compagnon) ?
2. Accord pour le compte Apple Developer (99 $/an) et la signature dans la CI ?
3. Lancer l'étape 1 (faisabilité), qui lève le seul vrai doute technique (compilation de la
   couche SSH pour iOS) avant tout engagement ?
