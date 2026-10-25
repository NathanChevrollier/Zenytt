// Fiches d'aide : section Aide (toutes les fiches) et « ? » d'une page (uniquement la sienne).
//
// Chaque fiche suit le même plan, du plus utile au plus rare :
//   1. à quoi ça sert            → `summary`
//   2. ce que Zenytt fait tout seul → `automatic`
//   3. comment ça marche ici      → `how`
//   4. ce qu'il faut sur le serveur → `requirements`
//   5. mise en place, commandes prêtes → `steps`
//   6. quand ça coince            → `troubleshooting`
//   7. bon à savoir               → `notes`
//
// Les commandes sont exactes et vérifiées contre le code de Zenytt (plans d'installation tmux,
// préparation restic, sondes Docker) : elles ne servent que de recours quand l'automatique échoue.
import type { SectionId } from "../sections";

export type GuideId =
  | "home"
  | "servers"
  | "terminal"
  | "sessions"
  | "files"
  | "monitoring"
  | "schedule"
  | "docker"
  | "vms"
  | "compose"
  | "databases"
  | "sites"
  | "logs"
  | "agent"
  | "backups"
  | "tunnels"
  | "mesh"
  | "security"
  | "share"
  | "sync"
  | "ai"
  | "rdp"
  | "settings";

/** Famille de fiches, pour ranger la section Aide. */
export type GuideTopic = "prise-en-main" | "exploitation" | "securite" | "partage";

export interface GuideStep {
  text: string;
  command?: string;
  /** La commande a besoin des droits root : elle s'affiche préfixée de `sudo`. */
  sudo?: boolean;
}

export interface GuideProblem {
  /** Ce que l'on constate. */
  symptom: string;
  /** Pourquoi, et quoi faire. */
  answer: string;
  command?: string;
  sudo?: boolean;
}

export interface Guide {
  id: GuideId;
  title: string;
  topic: GuideTopic;
  summary: string;
  section?: SectionId;
  /** Onglet de la section à ouvrir (« Ouvrir … »). */
  tab?: string;
  automatic?: string;
  /** Comment la fonctionnalité marche dans Zenytt : ce que l'app fait, où l'on clique. */
  how?: string[];
  requirements?: string[];
  steps?: GuideStep[];
  troubleshooting?: GuideProblem[];
  notes?: string[];
}

export const TOPICS: { id: GuideTopic; label: string; description: string }[] = [
  { id: "prise-en-main", label: "Prise en main", description: "Se connecter, travailler au quotidien." },
  { id: "exploitation", label: "Exploitation", description: "Conteneurs, sites, bases, supervision, sauvegardes." },
  { id: "securite", label: "Sécurité et accès", description: "Audit, pare-feu, tunnels, bureau à distance." },
  { id: "partage", label: "Partage et réglages", description: "Plusieurs postes, plusieurs personnes, assistant IA." },
];

/** Installation d'un paquet, dans l'ordre des gestionnaires que Zenytt sait utiliser. */
const install = (paquet: string): GuideStep[] => [
  { text: "Debian, Ubuntu, Raspberry Pi OS", command: `apt-get update && apt-get install -y ${paquet}`, sudo: true },
  { text: "Fedora, Rocky, Alma, CentOS", command: `dnf install -y ${paquet}`, sudo: true },
  { text: "Arch, Manjaro", command: `pacman -S --noconfirm --needed ${paquet}`, sudo: true },
  { text: "Alpine", command: `apk add ${paquet}`, sudo: true },
];

export const GUIDES: Guide[] = [
  // ---------------------------------------------------------------- prise en main
  {
    id: "servers",
    title: "Ajouter et connecter un serveur",
    topic: "prise-en-main",
    section: "servers",
    summary: "Un profil rassemble l'adresse, l'utilisateur et la façon de s'authentifier. Tout le reste de Zenytt s'appuie dessus.",
    how: [
      "Les secrets ne sont jamais écrits dans les fichiers de configuration : ils vont dans le coffre-fort du système (Credential Manager, Trousseau, Secret Service).",
      "À la première connexion, l'empreinte de la clé d'hôte est mémorisée ; si elle change ensuite, Zenytt bloque et prévient au lieu de se connecter quand même.",
      "Le mot de passe sudo enregistré dans le profil sert aux actions qui en ont besoin : écriture nginx, pare-feu, agent, sauvegardes.",
      "Un serveur de rebond (bastion) se choisit dans le profil : Zenytt traverse le premier pour joindre le second.",
      "Une identité de la banque (Serveurs → Identifiants) remplace l'utilisateur et les secrets sur plusieurs profils à la fois.",
    ],
    requirements: ["un accès SSH (mot de passe, clé OpenSSH, clé PuTTY .ppk, agent OpenSSH ou Pageant)"],
    steps: [
      { text: "Créer une clé dédiée à Zenytt sur ton PC, plutôt qu'un mot de passe", command: "ssh-keygen -t ed25519 -C zenytt" },
      { text: "L'installer sur le serveur", command: "ssh-copy-id -i ~/.ssh/id_ed25519.pub utilisateur@serveur" },
      { text: "Vérifier l'empreinte du serveur, côté serveur, pour la comparer à celle que Zenytt affiche", command: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub", sudo: true },
    ],
    troubleshooting: [
      { symptom: "« Permission denied » alors que le mot de passe est bon", answer: "sshd refuse peut-être l'authentification par mot de passe, ou le compte est limité. Vérifier :", command: "grep -E 'PasswordAuthentication|PermitRootLogin|AllowUsers' /etc/ssh/sshd_config", sudo: true },
      { symptom: "Connexion qui échoue depuis peu, sans rien avoir changé", answer: "Ton IP est peut-être bannie par fail2ban. Le diagnostic de connexion de Zenytt (fiche du serveur → Diagnostiquer, ou palette Ctrl+K) le détecte ; côté serveur :", command: "fail2ban-client status sshd", sudo: true },
      { symptom: "« L'empreinte de l'hôte a changé »", answer: "Le serveur a été réinstallé, ou quelqu'un s'interpose. Ne valider qu'après avoir comparé l'empreinte affichée avec celle lue sur la console du serveur." },
    ],
  },
  {
    id: "terminal",
    title: "Terminal : dossier courant, fichiers, copier-coller",
    topic: "prise-en-main",
    section: "terminal",
    summary: "Le terminal de Zenytt connaît le dossier où tu te trouves : le panneau Fichiers suit tes « cd », et un fichier déposé depuis Windows atterrit au bon endroit.",
    how: [
      "Au démarrage, le shell annonce son identifiant de processus par une séquence invisible ; Zenytt lit ensuite /proc pour connaître le dossier courant, même quand un programme tourne au premier plan.",
      "Le panneau Fichiers se recale tout seul après chaque « cd » (relevé toutes les 2,5 secondes).",
      "Le viseur du panneau coupe ce suivi quand tu veux naviguer ailleurs à la main ; recliquer le réactive et recale le panneau.",
      "Glisser des fichiers Windows sur le terminal les envoie dans le dossier courant du shell.",
      "Copier-coller : Ctrl+Maj+C et Ctrl+Maj+V, ou le clic droit. Un collage de plusieurs lignes demande confirmation.",
      "Le panneau Fichiers se redimensionne en tirant son bord gauche ; double-clic pour revenir à la largeur d'origine.",
      "Quand une commande échoue, un bouton discret apparaît sous le terminal : « Pourquoi cette commande a échoué ? » ouvre l'assistant avec la commande, sa sortie et la correction proposée.",
      "Ctrl+Maj+R cherche dans l'historique du serveur, en approximatif : « dcps » trouve « docker compose ps ». Les commandes habituelles remontent, Entrée les lance, Maj+Entrée les écrit sans les lancer.",
      "Ctrl+R reste au shell : sa propre recherche inversée continue de fonctionner comme avant.",
      "Un fragment peut demander ses paramètres avant l'envoi : écris {{conteneur}} ou {{lignes:100}} dans sa commande.",
    ],
    requirements: ["un shell POSIX (bash, zsh, sh)", "/proc monté, c'est-à-dire un Linux classique"],
    steps: [{ text: "Vérifier que le suivi de dossier est possible sur ce serveur", command: "readlink /proc/$$/cwd" }],
    troubleshooting: [
      { symptom: "« Dossier courant du terminal introuvable »", answer: "Le serveur n'expose pas /proc (BSD, certains conteneurs), ou le terminal est déconnecté. Les autres fonctions du terminal marchent quand même." },
      { symptom: "La sélection à la souris ne fonctionne pas dans une session tmux", answer: "tmux capte la souris quand « mouse on » est actif. Zenytt force « mouse off » sur ses propres sessions ; pour une session créée à la main :", command: "tmux set-option -g mouse off" },
      { symptom: "L'historique du serveur est vide", answer: "Le shell n'écrit souvent son fichier qu'à la déconnexion. Zenytt lit ~/.bash_history, ~/.zsh_history et l'historique de fish ; pour forcer l'écriture tout de suite :", command: "history -a" },
      { symptom: "Les durées d'exécution n'apparaissent pas dans l'historique", answer: "Seul zsh les enregistre, en mode étendu ; bash ne les garde jamais. Zenytt affiche la durée quand le shell la donne et ne l'invente pas. Pour les avoir sous zsh, ajouter « setopt EXTENDED_HISTORY » à ~/.zshrc. Sous bash, « HISTTIMEFORMAT » donne au moins la date :", command: "echo 'export HISTTIMEFORMAT=\"%F %T \"' >> ~/.bashrc" },
      { symptom: "Le bouton de diagnostic n'apparaît pas alors qu'une commande a échoué", answer: "Zenytt n'installe rien sur le serveur : le code de retour n'est pas lisible, la détection se fait sur le texte de la sortie. Une commande qui échoue sans rien écrire passe inaperçue — le clic droit propose « Expliquer ce qui s'affiche »." },
    ],
    notes: ["Les commandes qui contiennent visiblement un secret (mot de passe, jeton, clé) sont écartées de l'historique de Zenytt : les reproposer dans une liste, c'est les réafficher."],
  },
  {
    id: "sessions",
    title: "Sessions persistantes (tmux)",
    topic: "prise-en-main",
    section: "terminal",
    summary: "Un terminal qui survit à une coupure réseau, à la veille du PC et à la fermeture de Zenytt : le programme continue de tourner sur le serveur et l'onglet se rebranche dessus.",
    automatic: "Zenytt installe tmux lui-même : Terminal → bouton « Sessions tmux » de la barre d'outils → Installer tmux. Les commandes ci-dessous ne servent que si l'installation automatique échoue.",
    how: [
      "Chaque onglet persistant correspond à une session tmux nommée « zenytt-… » sur le serveur.",
      "Terminal → « Sessions tmux » liste les sessions existantes : les reprendre dans un onglet, ou les fermer.",
      "Les onglets et la division de l'écran sont restaurés au démarrage de Zenytt.",
    ],
    requirements: ["tmux sur le serveur", "un compte capable d'installer des paquets, seulement pour l'installation"],
    steps: [
      { text: "Vérifier si tmux est déjà présent", command: "command -v tmux || echo 'tmux absent'" },
      ...install("tmux"),
      { text: "Unraid n'a pas de gestionnaire de paquets : passer par le plugin « un-get » (Apps → un-get)", command: "un-get update && un-get install tmux" },
      { text: "Lister les sessions créées par Zenytt", command: "tmux ls" },
    ],
    troubleshooting: [
      { symptom: "Le bouton d'installation dit qu'aucun gestionnaire de paquets n'est reconnu", answer: "Installer tmux à la main avec l'outil de ta distribution. Sans tmux, les terminaux fonctionnent : ils ne survivent simplement pas aux coupures." },
      { symptom: "Une session laissée ouverte consomme des ressources", answer: "Un programme lancé dans une session continue de tourner. La reprendre puis l'arrêter, ou la fermer depuis Terminal → « Sessions tmux »." },
    ],
  },
  {
    id: "files",
    title: "Fichiers et transferts",
    topic: "prise-en-main",
    section: "files",
    summary: "Explorateur SFTP, recherche de fichiers et de texte, archives, comparaison, copie d'un serveur à l'autre en double panneau, édition distante, repli sudo.",
    how: [
      "Tout passe par le canal SFTP de la connexion SSH : aucun service à installer.",
      "Le double panneau copie d'un serveur à l'autre en passant par ton PC ; le transfert s'annule en cours de route.",
      "Un fichier ouvert s'édite dans l'éditeur intégré et repart sur le serveur à l'enregistrement.",
      "Un fichier appartenant à root est lu et écrit via sudo si le profil a un mot de passe sudo.",
      "Ctrl+P cherche un fichier par son nom, ou du texte dans les fichiers : find et grep tournent sur le serveur, rien n'est téléchargé. Un résultat ouvre l'éditeur sur la bonne ligne.",
      "« Compresser » crée une archive tar.gz, zip ou tar.zst côté serveur, sans qu'un octet transite par ton PC ; « Extraire ici » la dépose dans le dossier affiché, après avoir montré son contenu.",
      "Deux fichiers sélectionnés : « Comparer » les affiche côte à côte avec leurs différences surlignées.",
    ],
    requirements: ["le sous-système SFTP activé dans sshd (cas par défaut)", "tar, zip ou zstd sur le serveur pour les archives"],
    steps: [
      { text: "Vérifier que SFTP est activé", command: "grep -i sftp /etc/ssh/sshd_config" },
      { text: "L'activer s'il manque, puis recharger sshd", command: "printf 'Subsystem sftp internal-sftp\\n' >> /etc/ssh/sshd_config && systemctl reload ssh", sudo: true },
    ],
  },

  // ---------------------------------------------------------------- exploitation
  {
    id: "home",
    title: "Vue d'ensemble",
    topic: "exploitation",
    section: "home",
    summary: "L'état de tous les serveurs sur un écran : charge, mémoire, disque, conteneurs arrêtés, alertes, certificats proches de l'expiration.",
    how: [
      "Les relevés viennent de l'agent quand il est installé, sinon d'une lecture directe à la connexion.",
      "« À traiter » regroupe ce qui demande une action : conteneurs arrêtés, alertes actives, certificats qui expirent.",
      "L'activité récente est le journal local de Zenytt : toutes les actions faites depuis l'app, le MCP ou l'assistant.",
    ],
  },
  {
    id: "monitoring",
    title: "Supervision : ce que montrent les chiffres",
    topic: "exploitation",
    section: "monitoring",
    summary: "Ressources en direct ou sur 30 jours avec l'agent, services, tâches planifiées, alimentation, sécurité et mises à jour : trois onglets.",
    how: [
      "Vue d'ensemble : la fiche du serveur, six chiffres clés, les courbes de la période choisie (seuils d'alerte en pointillés), les disques, les processus les plus actifs, « À traiter » et l'alimentation (par SSH ou par l'hébergeur).",
      "Activité : services systemd et tâches planifiées côte à côte ; un clic sur un service ouvre son journal, « Tous les processus » ouvre la liste complète.",
      "Sécurité et mises à jour : score de l'audit, paquets et versions, fail2ban, pare-feu et accès SSH, sur une seule page.",
      "Sans agent : les chiffres sont lus à la demande pendant que Zenytt est ouvert, sans historique.",
      "Avec l'agent : 30 jours de moyennes par minute, et des alertes qui partent même PC éteint.",
      "La charge (« load ») se compare au nombre de cœurs : 2.00 sur 4 cœurs, c'est la moitié de la machine.",
      "La mémoire affichée exclut le cache : un cache élevé n'est pas un problème.",
    ],
  },
  {
    id: "schedule",
    title: "Tâches planifiées (cron et timers)",
    topic: "exploitation",
    section: "monitoring",
    tab: "schedule",
    summary: "Tout ce qui se déclenche tout seul sur le serveur : crontabs des utilisateurs, fichiers système de /etc/cron.d, et timers systemd.",
    how: [
      "Zenytt lit les crontabs de chaque utilisateur, /etc/crontab, /etc/cron.d, les dossiers cron.hourly/daily/weekly/monthly, et « systemctl list-timers ».",
      "Chaque ligne est traduite en français (« chaque jour à 03:00 ») et accompagnée de ce que la commande fait réellement quand Zenytt la reconnaît.",
      "« Modifier » ouvre le crontab dans l'éditeur ; la syntaxe est vérifiée avant enregistrement.",
    ],
    requirements: ["cron ou systemd (les deux sont lus)"],
    steps: [
      { text: "Voir un crontab utilisateur", command: "crontab -l -u root", sudo: true },
      { text: "Voir les prochains déclenchements systemd", command: "systemctl list-timers --all --no-pager" },
      { text: "Suivre l'exécution de cron en direct", command: "journalctl -u cron -f", sudo: true },
    ],
    notes: [
      "Une tâche qui écrit dans un fichier de log sans rotation finit par remplir le disque : vérifier /var/log.",
      "Les heures des timers systemd s'affichent en UTC si le serveur est en UTC.",
    ],
  },
  {
    id: "docker",
    title: "Docker : relier Zenytt au démon",
    topic: "exploitation",
    section: "docker",
    summary: "Conteneurs, statistiques, journaux en direct, shell dans un conteneur, images, volumes et nettoyage chiffré.",
    automatic: "Zenytt détecte tout seul s'il peut parler à Docker directement, sinon il passe par sudo. Podman est reconnu de la même façon.",
    how: [
      "« Shell » ouvre un onglet de terminal dans le conteneur (bash s'il existe, sinon sh).",
      "« Logs » (d'un conteneur, d'un projet compose ou d'un service systemd) ouvre un tiroir qui suit la sortie en direct : filtre, niveaux, pause, export, « Charger plus » et « Ouvrir dans Journaux ». Son menu ⋯ garde le suivi dans un onglet de terminal.",
      "« Restreindre les ports » réécrit les ports publiés en 127.0.0.1 : le service n'est plus joignable depuis Internet, on y accède ensuite par un tunnel.",
      "L'onglet « Images, volumes et nettoyage » mesure la taille réelle de chaque volume et signale ceux qu'aucun conteneur, même arrêté, n'utilise : le gain en octets est annoncé avant toute suppression.",
      "L'onglet « Applications » montre une carte par projet compose (ses actions dans l'en-tête, ses services dedans) et une carte « Hors compose » ; « Affichage » repasse au tableau des conteneurs, par dossier local ou sans groupe.",
      "Le bouton « Registres » de l'en-tête range les identifiants de Docker Hub, GitHub Packages, GitLab, AWS ECR ou d'un registre privé dans le coffre du système, et connecte un serveur en un clic : le jeton part sur l'entrée standard de docker login, jamais dans une ligne de commande.",
    ],
    requirements: ["Docker ou Podman installé", "l'utilisateur dans le groupe docker, ou un mot de passe sudo dans le profil"],
    steps: [
      { text: "Vérifier que Docker répond", command: "docker version --format '{{.Server.Version}}'" },
      { text: "Installer Docker (script officiel)", command: "curl -fsSL https://get.docker.com | sh", sudo: true },
      { text: "Autoriser l'utilisateur à parler à Docker sans sudo", command: "usermod -aG docker $USER", sudo: true },
      { text: "Refermer puis rouvrir la session SSH pour que le groupe s'applique, et vérifier", command: "docker ps" },
    ],
    troubleshooting: [
      { symptom: "« permission denied » sur /var/run/docker.sock", answer: "L'utilisateur n'est pas dans le groupe docker et aucun mot de passe sudo n'est enregistré. Ajouter l'un ou l'autre." },
      { symptom: "Le disque se remplit sans raison apparente", answer: "Images, volumes et caches de construction s'accumulent. Docker → Images, volumes et nettoyage montre ce qui est récupérable ; en ligne de commande :", command: "docker system df" },
    ],
    notes: [
      "Mettre un utilisateur dans le groupe docker revient à lui donner les droits root : à réserver à un compte d'administration.",
      "Une fois connecté à un registre, Docker garde le jeton dans ~/.docker/config.json, simplement encodé en base64 si aucun « credential helper » n'est installé. Zenytt le signale : utilise des jetons en lecture seule plutôt que le mot de passe du compte.",
      "Pour AWS ECR, le client aws (AWS CLI v2) doit être installé sur le serveur : Zenytt lui passe la clé d'accès sur l'entrée standard pour obtenir le jeton du jour.",
    ],
  },
  {
    id: "vms",
    title: "Machines virtuelles (libvirt)",
    topic: "exploitation",
    section: "vms",
    summary: "Voir et piloter les VM KVM/QEMU d'un serveur : démarrer, éteindre, voir leur écran ou leur console série, sans rien exposer sur Internet.",
    automatic: "Zenytt détecte libvirt, choisit l'accès direct (groupe libvirt) ou sudo, et ouvre l'écran d'une VM par un tunnel SSH vers 127.0.0.1.",
    how: [
      "Zenytt utilise virsh sur le serveur, toujours sur la connexion système (qemu:///system) : la liste est celle de virt-manager.",
      "Une VM est désignée par son UUID dans chaque commande : un nom avec espaces, accents ou apostrophes ne pose aucun problème.",
      "L'écran (VNC) s'affiche dans Zenytt à travers un tunnel SSH ; le port VNC n'a jamais besoin d'être ouvert.",
      "Il peut aussi s'ouvrir dans le client du système (remote-viewer de virt-viewer), toujours par le tunnel : c'est le moyen d'afficher une VM en SPICE. Le tiroir Machines (à droite) laisse choisir le moyen par défaut ; l'autre reste au clic droit.",
      "Les VM se rangent dans des dossiers (menu ⋯ d'une VM, ou glisser-déposer), propres à ce PC : la page et le tiroir Machines les affichent pareil.",
      "La console série s'ouvre dans un onglet terminal (Ctrl+] pour en sortir).",
      "Forcer l'arrêt et supprimer demandent toujours confirmation ; chaque action est inscrite dans le journal.",
    ],
    requirements: [
      "libvirt et QEMU installés sur le serveur",
      "ton utilisateur dans le groupe libvirt, ou le mot de passe sudo renseigné dans le profil",
      "pour l'écran : un affichage VNC (le SPICE s'ouvre dans remote-viewer, à installer sur ce PC)",
    ],
    steps: [
      { text: "Installer libvirt (Debian, Ubuntu)", command: "sudo apt install qemu-system-x86 libvirt-daemon-system libvirt-clients virtinst" },
      { text: "Installer libvirt (Rocky, Alma, Fedora)", command: "sudo dnf install qemu-kvm libvirt virt-install && sudo systemctl enable --now libvirtd" },
      { text: "Donner l'accès à ton utilisateur, puis te reconnecter", command: "sudo usermod -aG libvirt $USER" },
      { text: "Passer l'écran d'une VM en VNC, écouté seulement en local", command: "virt-xml <vm> --edit --graphics vnc,listen=127.0.0.1", sudo: true },
    ],
    troubleshooting: [
      { symptom: "« failed to connect to the hypervisor »", answer: "Ton utilisateur n'a pas accès à libvirt : ajoute-le au groupe libvirt (puis reconnecte-toi), ou renseigne le mot de passe sudo dans le profil du serveur.", command: "id -nG" },
      { symptom: "« Écran » refuse d'ouvrir une VM en SPICE", answer: "Zenytt n'affiche que le VNC : choisis « Écran dans le client du système » (remote-viewer, virt-manager.org/download), utilise la console série, ou passe l'affichage de la VM en VNC avec la commande ci-dessus." },
      { symptom: "Aucune adresse IP n'est affichée", answer: "La VM n'a pas de bail DHCP du réseau de libvirt (pont vers le LAN, IP fixe). Installe l'agent invité dans la VM pour que libvirt la connaisse :", command: "sudo apt install qemu-guest-agent" },
    ],
    notes: ["La création de VM, les instantanés et le stockage arrivent dans les prochaines versions."],
  },
  {
    id: "compose",
    title: "Projets Compose et déploiement",
    topic: "exploitation",
    section: "docker",
    summary: "Déployer une application du catalogue en un clic, créer un projet compose à la main, le déployer avec retour arrière automatique, ou depuis un dépôt GitHub privé.",
    how: [
      "Un projet, c'est un dossier avec son compose.yml : Zenytt y lance « docker compose » à ta place.",
      "« Catalogue » propose des applications prêtes à déployer (Nextcloud, Vaultwarden, Uptime Kuma, Gitea, n8n…) : Zenytt remplit les mots de passe avec de l'aléa du système et n'ouvre les ports que sur 127.0.0.1.",
      "Le catalogue est intégré à Zenytt : aucun dépôt tiers n'est interrogé, et tu relis le docker-compose.yml et le .env avant qu'ils ne soient écrits sur le serveur.",
      "Pour publier l'application sur un sous-domaine, enchaîne avec la page Sites : il crée le vhost nginx et le certificat HTTPS vers le port local choisi.",
      "Déployer enchaîne pull → up → vérification que les conteneurs tiennent ; si l'un d'eux retombe, l'état précédent est remis.",
      "Le déploiement GitHub génère une clé de déploiement restreinte à un dépôt : rien d'autre n'est accessible avec elle.",
    ],
    requirements: ["le plugin Docker Compose v2", "un dossier de projet accessible à ton utilisateur", "git, seulement pour le déploiement GitHub"],
    steps: [
      { text: "Vérifier Compose v2", command: "docker compose version" },
      { text: "L'installer sur Debian/Ubuntu s'il manque", command: "apt-get install -y docker-compose-plugin", sudo: true },
      { text: "Préparer un dossier de projet", command: "install -d -o $USER -g $USER /opt/mon-projet", sudo: true },
      { text: "Coller la clé de déploiement dans le dépôt (Settings → Deploy keys), puis vérifier depuis le serveur", command: "ssh -T git@github.com" },
    ],
    troubleshooting: [
      { symptom: "« docker compose : commande inconnue »", answer: "C'est l'ancienne version « docker-compose » (avec un tiret) qui est installée. Installer le plugin v2." },
      { symptom: "Le déploiement revient en arrière tout seul", answer: "Un conteneur n'est pas resté debout. Les journaux du projet disent pourquoi :", command: "docker compose logs --tail 200" },
    ],
  },
  {
    id: "databases",
    title: "Bases de données",
    topic: "exploitation",
    section: "databases",
    summary: "Parcourir bases et tables de MySQL/MariaDB, PostgreSQL et SQLite, éditer les lignes en place, exécuter du SQL, exporter en CSV, et explorer Redis.",
    how: [
      "Les requêtes passent par le client en ligne de commande du serveur, à travers SSH : aucun port de base n'a besoin d'être ouvert.",
      "Pour un conteneur, Zenytt lit le mot de passe root dans ses variables d'environnement ; pour une instance locale, il utilise l'authentification par socket.",
      "Ctrl+Entrée exécute la requête ; le résultat s'exporte en CSV.",
      "Ouvre une table depuis la liste de gauche pour l'éditer : clic sur un en-tête pour trier, clic droit pour filtrer, double-clic sur une cellule pour la modifier.",
      "L'édition en place exige une clé primaire : Zenytt la lit dans le schéma et montre le UPDATE exact avant de l'exécuter. Sans clé primaire, le tableau reste en lecture seule.",
      "Le bouton SQLite cherche les fichiers .db / .sqlite dans /opt, /srv, /var/lib, /var/www, /home, /root et /data.",
      "Le bouton Redis ouvre l'explorateur de clés : parcours par pages avec SCAN, lecture de tous les types, durée de vie et console.",
      "Une instance injoignable reste listée : l'erreur apparaît à la première requête, avec sa cause.",
    ],
    requirements: [
      "une instance en conteneur ou sur l'hôte",
      "le client mysql/mariadb/psql, sqlite3 ou redis-cli accessible",
      "les identifiants (variables du conteneur, ou socket local)",
      "une clé primaire sur la table pour l'édition en place",
    ],
    steps: [
      { text: "Repérer une instance en conteneur", command: "docker ps --format '{{.Names}} {{.Image}}' | grep -Ei 'mysql|mariadb|postgres'" },
      { text: "Vérifier le client dans le conteneur", command: "docker exec <conteneur> sh -c 'command -v mysql || command -v mariadb || command -v psql'" },
      { text: "Vérifier une instance installée sur l'hôte", command: "systemctl status mariadb postgresql --no-pager" },
    ],
    troubleshooting: [
      { symptom: "« Access denied » à la première requête", answer: "Le conteneur ne porte pas MYSQL_ROOT_PASSWORD (ou POSTGRES_PASSWORD) dans ses variables. Les afficher :", command: "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <conteneur>" },
      { symptom: "Je veux utiliser un outil graphique de mon PC", answer: "Ouvrir un tunnel vers le port de la base plutôt que de l'exposer : voir la fiche Tunnels." },
    ],
  },
  {
    id: "sites",
    title: "Sites, nginx ou Apache, certificats",
    topic: "exploitation",
    section: "sites",
    summary: "Relier un sous-domaine à un conteneur ou à un port local, éditer le vhost sans risque, suivre les certificats, restaurer une configuration précédente.",
    how: [
      "Chaque écriture suit le même déroulé côté serveur : sauvegarde complète, écriture, test de configuration, rechargement, et restauration exacte si le test ou le rechargement échoue.",
      "Le serveur web n'est donc jamais rechargé avec une configuration invalide, et les autres sites ne sont pas touchés.",
      "Les 30 dernières sauvegardes sont conservées et consultables dans l'historique, avec comparaison et restauration.",
      "Les écritures hors du dossier de configuration sont refusées.",
    ],
    requirements: ["nginx ou Apache", "un mot de passe sudo dans le profil", "certbot pour Let's Encrypt"],
    steps: [
      { text: "Vérifier le serveur web", command: "nginx -v || apachectl -v" },
      { text: "Installer nginx", command: "apt-get install -y nginx", sudo: true },
      { text: "Installer certbot", command: "apt-get install -y certbot python3-certbot-nginx", sudo: true },
      { text: "Tester la configuration à la main", command: "nginx -t", sudo: true },
      { text: "Voir les sauvegardes prises par Zenytt", command: "ls -1 /var/backups/zenytt/nginx", sudo: true },
    ],
    troubleshooting: [
      { symptom: "Le certificat ne se renouvelle pas", answer: "Le renouvellement passe par le port 80, qui doit rester joignable. Essai à blanc :", command: "certbot renew --dry-run", sudo: true },
      { symptom: "Le domaine ne pointe pas encore sur le serveur", answer: "Zenytt affiche l'IP résolue à côté du site ; tant qu'elle ne correspond pas, le certificat échouera." },
    ],
  },
  {
    id: "logs",
    title: "Journaux",
    topic: "exploitation",
    section: "logs",
    summary: "Conteneurs, services systemd et fichiers suivis en direct, fusionnés dans une même vue, filtrables et exportables.",
    how: [
      "Les sources se cochent dans la colonne de gauche ; tout est fusionné par horodatage.",
      "Le filtre accepte du texte ou une expression régulière, et un niveau minimum.",
      "L'export enregistre ce qui est affiché, filtre compris.",
    ],
    steps: [
      { text: "Équivalent en ligne de commande, pour un service", command: "journalctl -u nginx -f", sudo: true },
      { text: "Pour un conteneur", command: "docker logs -f --tail 200 <conteneur>" },
    ],
  },
  {
    id: "agent",
    title: "Agent zenyttd : historique et alertes hors ligne",
    topic: "exploitation",
    section: "monitoring",
    tab: "alerts",
    summary: "Sans agent, Zenytt montre l'état en direct quand il est ouvert. Avec l'agent, le serveur garde 30 jours d'historique et envoie les alertes même PC éteint.",
    automatic: "Installation en un clic : Supervision › Vue d'ensemble › Alertes (« Régler… ») → Installer. Zenytt envoie le binaire par SSH et crée le service.",
    how: [
      "L'agent n'ouvre aucun port : il écoute sur un socket unix et Zenytt l'interroge à travers SSH.",
      "Il tourne sous un utilisateur dédié, avec un service systemd durci et 64 Mo de mémoire au maximum.",
      "Les alertes (seuils, site injoignable, sauvegarde en échec) partent vers Discord, ntfy ou un webhook.",
      "Les seuils et destinations se règlent depuis Zenytt ; le fichier est rechargé à chaud.",
    ],
    requirements: ["systemd", "un mot de passe sudo dans le profil", "Linux x86_64 ou arm64"],
    steps: [
      { text: "Vérifier le service", command: "systemctl status zenyttd --no-pager" },
      { text: "Voir ses journaux", command: "journalctl -u zenyttd -n 50 --no-pager", sudo: true },
      { text: "Lire sa configuration", command: "cat /etc/zenyttd/config.json", sudo: true },
      { text: "Redémarrer après une modification manuelle", command: "systemctl restart zenyttd", sudo: true },
    ],
    troubleshooting: [
      { symptom: "Le service ne démarre pas", answer: "Regarder la raison exacte dans le journal :", command: "journalctl -u zenyttd -n 30 --no-pager", sudo: true },
      { symptom: "Aucune alerte ne part", answer: "Vérifier la destination (webhook, ntfy, Discord) depuis Supervision › Vue d'ensemble › Alertes (« Régler… ») : un bouton envoie un message de test." },
    ],
  },
  {
    id: "backups",
    title: "Sauvegardes (restic)",
    topic: "exploitation",
    section: "backups",
    summary: "Sauvegardes chiffrées et dédupliquées : dumps de bases cohérents, volumes Docker, dossiers ; vers le serveur ou un stockage S3.",
    automatic: "Zenytt installe restic (bouton « Installer restic », ou à la première configuration) et prépare /etc/zenytt-backup, puis pose la planification. Sans paquet dans ta distribution, il prend le programme officiel sur GitHub, vérifié par son empreinte.",
    how: [
      "Les bases sont exportées avant la copie, sans arrêter le service, pour obtenir un dump cohérent.",
      "La déduplication fait qu'une sauvegarde quotidienne ne coûte que ce qui a changé.",
      "La restauration propose de télécharger, de remettre en place, ou de réimporter une base.",
      "La vérification relit le dépôt et signale une corruption avant que tu en aies besoin.",
      "Dépôt gardé sur le serveur : « Copie sur ce PC » en télécharge un double, puis seulement les nouveautés à chaque mise à jour. Il reste chiffré ; restic l'ouvre avec le même mot de passe (restic -r <dossier> snapshots).",
    ],
    requirements: ["restic", "un mot de passe sudo dans le profil", "de la place disque, ou un accès S3"],
    steps: [
      { text: "Vérifier restic", command: "restic version" },
      ...install("restic").slice(0, 2),
      { text: "Lancer la sauvegarde à la main (script créé par Zenytt)", command: "/etc/zenytt-backup/run.sh", sudo: true },
      { text: "Vérifier la planification", command: "systemctl list-timers 'zenytt-backup*' --no-pager" },
    ],
    troubleshooting: [
      { symptom: "La sauvegarde échoue depuis un changement de mot de passe de base", answer: "Le script utilise les identifiants enregistrés à la configuration : refaire Sauvegardes → ⋯ → Modifier la configuration." },
    ],
    notes: [
      "La phrase de passe du dépôt est indispensable pour restaurer : Zenytt la garde dans le coffre-fort, garde-la aussi ailleurs.",
      "Une sauvegarde sur le même disque que les données ne protège pas d'une panne de disque : prévoir S3, un autre serveur, ou la copie sur ce PC.",
    ],
  },

  // ---------------------------------------------------------------- sécurité et accès
  {
    id: "security",
    title: "Audit de sécurité et corrections",
    topic: "securite",
    section: "monitoring",
    tab: "security",
    summary: "État de SSH, du pare-feu, de fail2ban, des mises à jour, des ports exposés et des comptes privilégiés, avec des corrections guidées.",
    how: [
      "L'audit est en lecture seule : rien n'est modifié sans ton accord explicite.",
      "Avant de toucher à SSH ou au pare-feu, Zenytt garde une connexion de contrôle ouverte ; si la modification te coupe l'accès, elle est annulée automatiquement.",
      "Une alerte qui ne te concerne pas peut être ignorée : elle passe dans les archivées, avec la raison.",
      "Tout est dans Supervision › Sécurité et mises à jour : le score en tête (« Voir les constats » ouvre la liste complète, à corriger ou ignorer), puis les mises à jour, fail2ban (prisons, bannissements en cours), le pare-feu (règles) et les accès SSH. Les constats prioritaires remontent aussi dans « À traiter » de la vue d'ensemble.",
      "fail2ban → Réglages : durée de bannissement, nombre d'échecs et fenêtre par défaut ou par jail, bannissement progressif, jails à activer (recidive, nginx…). Zenytt les écrit dans son propre fichier, teste la configuration et la restaure si fail2ban la refuse.",
    ],
    requirements: ["un mot de passe sudo pour appliquer les corrections", "ufw ou firewalld, fail2ban"],
    steps: [
      { text: "Installer pare-feu et fail2ban", command: "apt-get install -y ufw fail2ban", sudo: true },
      { text: "État du pare-feu", command: "ufw status verbose", sudo: true },
      { text: "Prisons actives", command: "fail2ban-client status", sudo: true },
      { text: "Ports réellement à l'écoute", command: "ss -lntp", sudo: true },
    ],
    troubleshooting: [
      { symptom: "Je me suis banni moi-même", answer: "Depuis la console du fournisseur (KVM/VNC), lever le bannissement :", command: "fail2ban-client set sshd unbanip <ton-ip>", sudo: true },
    ],
  },
  {
    id: "tunnels",
    title: "Tunnels : joindre un service sans l'exposer",
    topic: "securite",
    section: "tunnels",
    summary: "Un port du serveur devient accessible sur ton PC en 127.0.0.1, à travers la connexion SSH. Le service reste invisible depuis Internet.",
    how: [
      "Zenytt n'écoute que sur 127.0.0.1 : le tunnel n'est pas partagé avec ton réseau local.",
      "La connexion SSH s'ouvre à la première utilisation du port.",
      "Un tunnel peut démarrer automatiquement au lancement de Zenytt.",
    ],
    steps: [
      { text: "Équivalent en ligne de commande, pour comparaison", command: "ssh -N -L 13306:127.0.0.1:3306 utilisateur@serveur" },
      { text: "Voir ce qui écoute côté serveur", command: "ss -lntp", sudo: true },
    ],
    troubleshooting: [
      { symptom: "« Address already in use » à l'ouverture", answer: "Le port local est déjà pris : en choisir un autre (Zenytt en propose un libre)." },
    ],
  },
  {
    id: "mesh",
    title: "Réseau privé entre serveurs",
    topic: "securite",
    section: "mesh",
    summary: "Relie des serveurs de différents hébergeurs comme s'ils étaient sur le même réseau local, chiffré par WireGuard : une base de données joignable par ton app sans être exposée sur Internet.",
    automatic: "Zenytt installe WireGuard, fait générer une clé par chaque serveur, choisit un sous-réseau libre, attribue les adresses, ouvre le port UDP dans ufw ou firewalld et relie tous les serveurs entre eux.",
    how: [
      "Chaque serveur reçoit une adresse privée (10.77.0.1, 10.77.0.2…) sur l'interface zenytt, et joint directement chaque autre serveur.",
      "La clé privée de chaque serveur est générée sur le serveur et n'en sort jamais, même pas vers Zenytt.",
      "Le sous-réseau est choisi pour ne recouvrir aucune adresse déjà utilisée sur tes serveurs (réseaux Docker, LAN, autre VPN).",
      "Un serveur derrière une box (NAT) joint les serveurs publics ; deux serveurs derrière NAT ne se joignent pas encore entre eux.",
      "« Réparer » réapplique la configuration à tous les serveurs sans couper les liens existants.",
    ],
    requirements: [
      "un noyau Linux 5.6 ou plus récent (WireGuard intégré)",
      "sudo (le mot de passe du profil sert)",
      "le port UDP 51820 ouvert dans le pare-feu de l'hébergeur pour les serveurs publics",
    ],
    steps: [
      { text: "Voir l'état de l'interface et des liens", command: "wg show zenytt", sudo: true },
      { text: "Tester un lien vers un autre membre", command: "ping -c3 10.77.0.2" },
    ],
    troubleshooting: [
      {
        symptom: "« jamais relié » entre deux serveurs publics",
        answer: "Le port UDP est sans doute bloqué par le pare-feu de l'hébergeur (console OVH, Hetzner, AWS…). L'ouvrir en UDP pour le port affiché, puis vérifier que WireGuard l'écoute :",
        command: "ss -ulnp | grep 518",
        sudo: true,
      },
      { symptom: "L'interface ne démarre pas", answer: "Voir le message de wg-quick :", command: "wg-quick up zenytt", sudo: true },
    ],
    notes: ["Les fichiers gérés par Zenytt sont /etc/wireguard/zenytt.conf et /etc/wireguard/zenytt.key ; un wg0 existant n'est jamais touché."],
  },
  {
    id: "rdp",
    title: "Bureau à distance (RDP, VNC, SPICE)",
    topic: "securite",
    section: "servers",
    summary: "Ouvrir la session graphique d'une machine Windows (RDP), d'un bureau Linux, d'un Raspberry Pi ou d'un Mac (VNC) dans Zenytt, et la console d'une VM QEMU/KVM (SPICE).",
    how: [
      "La session s'affiche dans Zenytt : le client RDP est intégré à l'app, rien n'est installé sur la machine distante.",
      "La connexion part toujours de ton PC. Si la machine n'est joignable que depuis un de tes serveurs, Zenytt monte un tunnel SSH le temps de la session : le port 3389 n'est jamais exposé sur Internet.",
      "La barre de session donne Ctrl+Alt+Suppr, le collage vers la machine, la taille d'affichage (ajustée ou réelle), le plein écran (Échap pour sortir) et la déconnexion.",
      "Le presse-papiers suit dans les deux sens, et la machine s'adapte à la taille de la fenêtre.",
      "Le clavier part en mode « caractères », qui convient à un clavier français face à une machine en disposition différente ; le bouton clavier bascule en touches brutes si un logiciel distant l'exige.",
      "Le client du système (mstsc, FreeRDP) reste disponible sur la fiche, à côté de « Se connecter ».",
      "Fichiers en RDP : copie un fichier sur la machine, Zenytt propose « Enregistrer sur le PC » ; dans l'autre sens, le bouton d'envoi (ou un glisser-déposer sur la session) prépare les fichiers, qu'il reste à coller (Ctrl+V) dans l'explorateur de la machine. Le texte et les images passent directement par le presse-papiers.",
      "VNC : choisis le protocole « VNC » dans la fiche. La session s'ouvre dans Zenytt (noVNC), avec un réglage de qualité d'image — basse latence pour une connexion lente, qualité maximale sur le réseau local — la lecture seule, le presse-papiers et Ctrl+Alt+Suppr.",
      "SPICE : la console d'une VM QEMU/KVM s'ouvre dans remote-viewer (virt-viewer), à travers le tunnel SSH le cas échéant. Le fichier de connexion est effacé par remote-viewer dès sa lecture : le mot de passe ne reste pas sur le disque.",
    ],
    requirements: [
      "le Bureau à distance activé sur la machine cible",
      "un compte autorisé à ouvrir une session à distance",
      "un mot de passe enregistré dans la fiche du bureau : le client intégré ouvre la session sans écran de connexion, il ne peut donc rien demander en route. Sans mot de passe, « Se connecter » reste grisé et seul le client du système fonctionne.",
      "en VNC : un serveur VNC sur la machine (x11vnc, TigerVNC, wayvnc, Partage d'écran de macOS, ou la console VNC d'une VM)",
      "en SPICE : remote-viewer installé sur ce PC (paquet virt-viewer)",
    ],
    steps: [
      { text: "Activer le Bureau à distance sur Windows (PowerShell, en administrateur)", command: "Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0; Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'" },
      { text: "Autoriser un compte qui n'est pas administrateur", command: "net localgroup \"Utilisateurs du Bureau à distance\" <compte> /add" },
      { text: "Sur un Linux, installer un serveur RDP", command: "apt-get install -y xrdp && systemctl enable --now xrdp", sudo: true },
      { text: "Vérifier que le port écoute sur la machine", command: "ss -lntp | grep 3389", sudo: true },
      { text: "Partager un bureau Linux existant en VNC, sur la boucle locale seulement (on y accède par le tunnel SSH)", command: "apt-get install -y x11vnc && x11vnc -storepasswd && x11vnc -display :0 -localhost -forever -usepw", sudo: true },
    ],
    troubleshooting: [
      {
        symptom: "« Connexion impossible » immédiate",
        answer: "Rien n'écoute sur le port, ou le pare-feu bloque. Depuis le serveur qui sert de relais (ou depuis ton PC en direct) :",
        command: "nc -vz <machine> 3389",
      },
      {
        symptom: "La connexion s'ouvre puis se referme aussitôt",
        answer: "Le plus souvent, les identifiants sont refusés (compte, domaine, ou mot de passe périmé). Le domaine se renseigne dans la fiche du bureau à distance ; sans domaine, un compte Microsoft s'écrit « MicrosoftAccount\\adresse ».",
      },
      {
        symptom: "Écran noir après la connexion",
        answer: "Une session est déjà ouverte sur la machine avec le même compte, ou la stratégie limite les sessions simultanées. Fermer la session locale, ou se connecter avec un autre compte.",
      },
      {
        symptom: "Le clavier tape les mauvais caractères",
        answer: "Basculer le bouton clavier de la barre : « caractères » suit ta disposition, « touches brutes » suit celle de la machine distante.",
      },
      {
        symptom: "Image rayée ou couleurs délavées sur un Linux avec xrdp",
        answer: "xrdp est limité à 16 bits par couleur : ce réglage se corrige côté serveur, pas dans le client. L'audit de sécurité de Zenytt le détecte et propose « Passer xrdp en couleurs 32 bits » ; à la main :",
        command: "sed -i -E 's/^[[:space:]]*max_bpp[[:space:]]*=.*/max_bpp=32/' /etc/xrdp/xrdp.ini && systemctl restart xrdp",
      },
      {
        symptom: "VNC : « Authentification refusée »",
        answer: "Le mot de passe VNC classique ne tient compte que des 8 premiers caractères ; un serveur macOS demande en plus l'utilisateur. Vérifie les deux dans la fiche du bureau.",
      },
      {
        symptom: "SPICE : « remote-viewer n'est pas installé »",
        answer: "Installe virt-viewer sur ce PC (virt-manager.org/download sous Windows, « brew install virt-viewer » sous macOS, le paquet virt-viewer sous Linux), puis réessaie.",
      },
    ],
    notes: [
      "N'expose jamais le port 3389 sur Internet : passe par un tunnel (choisis un serveur dans la fiche du bureau).",
      "C'est encore plus vrai en VNC et en SPICE : sans TLS, l'écran et souvent le mot de passe circulent en clair. Zenytt l'indique par « non chiffré » sur la fiche et dans la session tant que la connexion est directe.",
      "Le mot de passe reste dans le coffre-fort du système et ne sert qu'à la session en cours.",
      "Le client intégré est récent : en cas de doute sur un comportement, « Client du système » ouvre la même machine avec mstsc ou FreeRDP et permet de comparer. Signale la différence, avec le message d'erreur affiché.",
      "Une seule session à la fois : ouvrir un autre bureau ferme la précédente, avec son tunnel.",
    ],
  },

  // ---------------------------------------------------------------- partage et réglages
  {
    id: "share",
    title: "Partager un terminal ou une configuration",
    topic: "partage",
    summary: "Montrer un terminal à quelqu'un, en lecture seule ou avec le contrôle, et transmettre un profil de serveur à une autre installation de Zenytt.",
    how: [
      "Le contenu est chiffré côté client : le relais ne voit rien, la clé n'est que dans l'invitation.",
      "« Avec le contrôle » donne à la personne tes droits sur le serveur : à réserver à quelqu'un de confiance.",
      "Le partage s'arrête quand tu le décides, ou à la fermeture de l'onglet.",
    ],
    requirements: ["un serveur de relais (sync-server) joignable par les deux personnes"],
    steps: [
      { text: "Sur le VPS : lancer le relais depuis le dossier sync-server du dépôt", command: "docker compose up -d" },
      { text: "Le publier derrière nginx avec HTTPS (le dépôt fournit nginx.conf.example, qui gère la montée en WebSocket)" },
      { text: "Dans Zenytt : Réglages → Synchronisation, renseigner l'adresse et la phrase de passe" },
      { text: "Terminal → Partage → Partager ce terminal : transmettre l'invitation « zenytt-term:… ». Le destinataire la colle dans Terminal → Partage → Rejoindre un terminal partagé." },
    ],
  },
  {
    id: "sync",
    title: "Synchroniser plusieurs postes",
    topic: "partage",
    section: "settings",
    summary: "Retrouver ses serveurs, identifiants, clés d'hôte, fragments et tunnels sur un autre PC.",
    how: [
      "Deux modes : un fichier chiffré dans un dossier déjà synchronisé, ou le relais sync-server.",
      "Les secrets ne partent que si tu coches l'option ; sinon seuls les profils sont synchronisés.",
      "Le contenu est chiffré avec ta phrase de passe, qui ne quitte jamais tes PC.",
    ],
    steps: [
      { text: "Le plus simple : Réglages → Synchronisation → Fichier, dans un dossier OneDrive, Dropbox ou Syncthing" },
      { text: "Sinon, héberger le relais", command: "docker compose up -d" },
      { text: "Vérifier qu'il répond", command: "curl -fsS https://sync.mondomaine.fr/health" },
    ],
    notes: ["Si tu perds la phrase de passe, les données synchronisées sont irrécupérables."],
  },
  {
    id: "ai",
    title: "Assistant IA",
    topic: "partage",
    summary: "Poser une question sur une erreur, un journal ou une configuration sans copier-coller vers un autre outil.",
    how: [
      "Trois modes : lecture seule, proposition (chaque commande est validée par toi, mode par défaut) et autonome.",
      "Même en mode autonome, les commandes sensibles demandent ton accord.",
      "Ce que l'assistant peut consulter se coche case par case, serveur par serveur.",
      "La clé d'API est rangée dans le coffre-fort du système et chaque appel est inscrit au journal d'actions.",
    ],
    requirements: ["une clé d'API (Claude ou service compatible OpenAI), ou un modèle local (Ollama, LM Studio)"],
    steps: [
      { text: "Réglages → Assistant IA : choisir le fournisseur et coller la clé" },
      { text: "Pour un modèle local, vérifier qu'il répond", command: "curl -fsS http://localhost:11434/api/tags" },
      { text: "Ouvrir le panneau avec Ctrl+I" },
    ],
  },
  {
    id: "settings",
    title: "Réglages : ce qui se règle où",
    topic: "partage",
    section: "settings",
    summary: "Préférences de l'app, verrouillage, synchronisation, assistant IA, accès en lecture pour les assistants, et journal de toutes les actions.",
    how: [
      "Le journal d'actions garde ce que Zenytt a fait sur chaque serveur, y compris via l'assistant et le MCP.",
      "Le verrouillage demande un mot de passe après une durée d'inactivité, ou à la demande (Ctrl+Maj+L).",
      "L'accès IA s'autorise serveur par serveur : un serveur non coché est invisible pour l'assistant et le MCP.",
      "Les raccourcis clavier sont tous modifiables.",
    ],
  },
];

export const guideOf = (id: GuideId): Guide | undefined => GUIDES.find((g) => g.id === id);

