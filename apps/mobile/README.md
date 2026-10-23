# Zenytt Compagnon

Application Android et iOS (un seul projet Tauri 2) pour les coups d'œil et les gestes rapides sur tes
serveurs. Ce n'est pas une copie de l'app de bureau : voir l'étude [`docs/etude-app-iphone.md`](../../docs/etude-app-iphone.md)
(étape 2).

## Ce qu'elle fait

- **Serveurs** : récupérés depuis Zenytt sur ton PC par la synchronisation chiffrée existante, ou ajoutés à la main
  (hôte, port, utilisateur, mot de passe ou clé privée collée).
- **Tableau de bord** : CPU, mémoire, disque, charge, disponibilité (même relevé que le bureau) et alertes de l'agent
  `zenyttd` s'il est installé.
- **Conteneurs Docker** : liste, démarrer / arrêter / redémarrer, derniers journaux.
- **Fail2ban** : adresses bannies par jail, débannir.
- **Fichiers** : parcourir par SFTP, télécharger, envoyer (25 Mo max), renommer, supprimer.
- **Terminal** : xterm.js sur un shell SSH, avec une barre de touches (Échap, Tab, Ctrl et Alt collants, flèches, `|`, `~`, `/`).
- **Alertes** : alertes de tous les serveurs, relevées tant que l'écran est ouvert.

Le redémarrage du serveur n'est pas encore branché (bouton désactivé) : voir le TODO dans `src-tauri/src/ops.rs`.

## Lier le téléphone à ton PC (appairage)

1. Sur le PC, dans Zenytt : **Réglages → Synchronisation**, mode serveur (ou installation du serveur privé). Note la
   **phrase de passe** et copie le **code d'appairage** (`zenytt-pair:…`).
2. Sur le téléphone : **Serveurs → Rejoindre avec un code** (ou **Réglages**), colle le code, saisis la phrase de passe.
3. En mode privé, le serveur de synchronisation n'est joignable que par SSH : approuve l'empreinte du serveur quand
   l'app la montre (compare-la à celle que tu connais).
4. Les serveurs apparaissent. Si le PC ne synchronise pas les secrets (option « inclure les secrets »), ou pour les
   serveurs en clé SSH, ouvre le serveur → crayon → saisis le mot de passe ou colle la clé privée.

## Installer l'app

Les fichiers sont sur la page [Releases](https://github.com/NathanChevrollier/Zenytt/releases/latest) :
`Zenytt-Compagnon-<version>.apk` (Android) et `Zenytt-Compagnon-<version>.ipa` (iPhone).

### Installer sur Android

1. Télécharge le `.apk` sur le téléphone.
2. Ouvre-le ; Android demande d'autoriser l'installation depuis cette source (navigateur ou gestionnaire de fichiers) : accepte.
3. L'APK est signé avec une clé de débogage : Play Protect peut afficher un avertissement, choisis « Installer quand même ».
   Les mises à jour se font en installant le `.apk` suivant par-dessus.

### Installer sur iPhone depuis Windows (AltStore)

L'IPA n'est pas signée par Apple : AltStore la signe avec **ton identifiant Apple gratuit**, sans compte Developer. Contraintes
d'Apple pour ce mode : l'app est valable **7 jours** puis doit être rafraîchie, et un identifiant gratuit n'autorise que
**3 apps** sideloadées à la fois.

1. Sur le PC, installe **iTunes** et **iCloud** depuis le site d'Apple (apple.com), pas les versions du Microsoft Store :
   AltServer ne fonctionne qu'avec les versions du site.
2. Installe **AltServer pour Windows** depuis [altstore.io](https://altstore.io) et lance-le (icône dans la zone de notification).
3. Branche l'iPhone au PC en USB, déverrouille-le et touche « Faire confiance à cet ordinateur ». Dans iTunes, coche
   « Synchroniser avec cet iPhone via le Wi-Fi ».
4. Clic sur l'icône AltServer → **Install AltStore** → ton iPhone, puis ton identifiant Apple et son mot de passe.
5. Sur l'iPhone : **Réglages → Général → VPN et gestion de l'appareil**, ouvre ton identifiant Apple et touche **Faire confiance**.
6. Active le **Mode développeur** (iOS 16 et plus) : **Réglages → Confidentialité et sécurité → Mode développeur**, puis
   redémarre l'iPhone et confirme.
7. Télécharge le `.ipa` sur l'iPhone (Safari), puis « Ouvrir dans » / Partager → **AltStore**. Ou, dans AltStore, onglet
   **My Apps** → **+** et choisis le fichier. Entre ton identifiant Apple si on te le demande.
8. Garde AltServer lancé sur le PC, sur le même Wi-Fi que l'iPhone : AltStore rafraîchit l'app tout seul avant les 7 jours
   (ou manuellement : My Apps → Refresh All). Passé le délai sans rafraîchissement, l'app ne s'ouvre plus ; il suffit de la
   rafraîchir, les données restent.

**Sans le PC** : [SideStore](https://sidestore.io) fait le même travail directement sur l'iPhone une fois installé (l'installation
initiale passe par un PC ou un Mac), avec un VPN de rafraîchissement local. Même limite de 7 jours.

**Voie payante** : un compte Apple Developer (99 $/an) supprime la limite de 7 jours et ouvre TestFlight puis l'App Store ;
il demande une signature de publication, que la CI ne fait pas aujourd'hui.

## Développer

Boucle rapide sur le PC (sans téléphone) : `pnpm dev:mobile` ouvre l'app dans une fenêtre de bureau étroite.
Tests : `pnpm --filter zenytt-mobile test`.

### Android (depuis Windows)

1. Android Studio, puis dans le SDK Manager : **Android SDK Platform** récente, **Platform-Tools**, **Build-Tools**, **NDK (Side by side)**, **Command-line Tools**.
2. **JDK 17** (celui d'Android Studio convient : `C:\Program Files\Android\Android Studio\jbr`).
3. Variables d'environnement : `JAVA_HOME`, `ANDROID_HOME` (`%LOCALAPPDATA%\Android\Sdk`) et `NDK_HOME` (`%ANDROID_HOME%\ndk\<version>`).
4. Cibles Rust :
   ```
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
5. Une fois : icônes et projet Gradle (le dossier `src-tauri/gen/` n'est pas versionné) :
   ```
   pnpm --filter zenytt-mobile tauri icon ../desktop/app-icon.svg
   pnpm --filter zenytt-mobile tauri android init
   ```
6. Téléphone en mode développeur avec le débogage USB, ou émulateur, puis `pnpm android`.
   Le téléphone doit joindre le PC par le réseau (`TAURI_DEV_HOST`, port 1430).

### iOS

Il faut un **Mac** avec Xcode (ou la CI : [`mobile.yml`](../../.github/workflows/mobile.yml) sur `macos-latest`), CocoaPods et les cibles
`aarch64-apple-ios` / `aarch64-apple-ios-sim`. Mêmes commandes avec `tauri ios init` puis `pnpm ios`.
TestFlight et l'App Store demandent un **compte Apple Developer (99 $/an)** ; pour un iPhone sans ce compte, voir
[Installer sur iPhone](#installer-sur-iphone-depuis-windows-altstore) (IPA non signée de la CI).

### CI

`mobile.yml` (lancement manuel ou tag `v*`) construit un APK signé avec la clé de débogage (installable à la main, pas
publiable sur le Play Store) et une IPA iOS **non signée** (arm64, release) pour AltStore / SideStore. Sur un tag, les deux sont
jointes à la release sous les noms `Zenytt-Compagnon-<version>.apk` / `.ipa`. Pas de signature de publication pour l'instant.

## Limites connues

- **Pas de surveillance en arrière-plan** : iOS coupe les connexions SSH peu après la sortie de l'app, Android les suspend.
  Les écrans n'interrogent les serveurs que lorsqu'ils sont visibles ; la connexion est rétablie à la reprise, et le terminal
  propose de se reconnecter (il repart sur un shell neuf). Pour être prévenu à tout moment : notifications ntfy de l'agent.
- **Secrets hors trousseau** : mots de passe et clés sont dans le stockage privé de l'app (`secrets.json`, dossier `keys/`),
  protégé par le bac à sable du système, mais pas dans Android Keystore ni dans le Trousseau iOS. À remplacer par un plugin
  de trousseau avant toute publication sur les magasins. Les fichiers sont en 0600 ; la sauvegarde Android est désactivée par
  le workflow (`android:allowBackup="false"`). **iOS** : le dossier de données de l'app est inclus dans les sauvegardes
  iTunes/iCloud (l'exclusion demande `NSURLIsExcludedFromBackupKey`, côté natif), donc les secrets aussi.
- **Pas d'agent SSH** sur téléphone, pas de fichier de clé du PC : les clés sont collées et copiées dans l'app.
- **Téléchargements** rangés dans le dossier privé de l'app (pas de feuille de partage pour l'instant) ; envois de 25 Mo maximum.
- Rien de tout cela n'a encore tourné sur un vrai téléphone : seule la partie Rust et l'interface ont été compilées et testées sur PC.
