## Quel fichier télécharger ?

| Mon ordinateur | Fichier |
| --- | --- |
| **Windows** 10 / 11 | `Zenytt_{v}_x64-setup.exe` |
| **Mac Apple Silicon** (puce M1, M2, M3, M4…) | `Zenytt_{v}_aarch64.dmg` |
| **Mac Intel** | `Zenytt_{v}_x64.dmg` |
| **Linux** | `Zenytt_{v}_amd64.AppImage` (mises à jour automatiques), `.deb` (Debian, Ubuntu) ou `.rpm` (Fedora) |

Mac Apple Silicon ou Intel ? Menu  → *À propos de ce Mac* : la ligne « Puce » (Apple M…) ou
« Processeur » (Intel) le dit.

**Premier lancement sur Mac** : l'app n'est pas encore notariée par Apple. Si macOS refuse de
l'ouvrir, *Réglages Système* → *Confidentialité et sécurité* → *Ouvrir quand même*. S'il indique
que l'app « est endommagée », lancer une fois dans le Terminal :
`xattr -dr com.apple.quarantine /Applications/Zenytt.app`

### Sur téléphone (Zenytt Compagnon)

| Téléphone | Fichier |
| --- | --- |
| **Android** | `Zenytt-Compagnon-{v}.apk` : l'ouvrir, puis autoriser l'installation depuis cette source si Android le demande |
| **iPhone** | `Zenytt-Compagnon-{v}.ipa` : à installer avec [AltStore](https://altstore.io) ou SideStore et ton identifiant Apple gratuit |

Sur iPhone, l'app n'est pas signée par Apple : l'installation gratuite dure **7 jours** puis doit être
rafraîchie (AltStore le fait seul tant qu'AltServer tourne sur le PC), avec 3 apps sideloadées au maximum.
Pas à pas : [Installer sur iPhone](https://github.com/NathanChevrollier/Zenytt/blob/main/apps/mobile/README.md#installer-sur-iphone-depuis-windows-altstore).

Les fichiers `.sig`, `.app.tar.gz` et `latest.json` servent aux mises à jour automatiques : inutile
de les télécharger. Déjà installé ? Zenytt se met à jour tout seul.

---

