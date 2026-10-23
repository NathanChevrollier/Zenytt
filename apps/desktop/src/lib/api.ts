import { Channel, invoke } from "@tauri-apps/api/core";

export type AuthKind = "password" | "key" | "agent";

/** Protocole d'accès : seul `ssh` ouvre un shell, les autres ne servent qu'aux fichiers. */
export type Protocol = "ssh" | "sftp" | "ftp" | "ftps";

export const PROTOCOL_LABELS: Record<Protocol, string> = { ssh: "SSH complet", sftp: "SFTP seul", ftp: "FTP", ftps: "FTPS" };

/** Ce serveur accepte-t-il des commandes (terminal, Docker, supervision…) ? Les anciens profils sont en SSH. */
export const hasShell = (s?: { protocol?: Protocol } | null) => !s || !s.protocol || s.protocol === "ssh";

/** Pastille « SFTP » / « FTP » / « FTPS » des serveurs sans shell (rien pour le SSH). */
export const protocolBadge = (s?: { protocol?: Protocol } | null) => (hasShell(s) ? null : (s!.protocol as Protocol).toUpperCase());

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  /** Absent des anciens profils : SSH. */
  protocol?: Protocol;
  keyPath?: string | null;
  color?: string | null;
  group?: string | null;
  /** Accessible au serveur MCP (lecture seule). */
  aiAccess?: boolean;
  /** Serveur de rebond (bastion) à traverser pour joindre celui-ci. */
  jumpId?: string | null;
  /** Identifiant de la banque utilisé à la place de l'utilisateur et des secrets du profil. */
  identityId?: string | null;
  /** Se connecter automatiquement au démarrage de Zenytt (une fois déverrouillé). */
  autoConnect?: boolean;
}

/** Identifiant réutilisable (banque de logins). */
export interface Identity {
  id: string;
  name: string;
  username: string;
  authKind: AuthKind;
  keyPath?: string | null;
}

export interface IdentityView extends Identity {
  hasPassword: boolean;
  hasPassphrase: boolean;
  /** Serveurs qui l'utilisent. */
  usedBy: string[];
}

/** Bureau à distance (RDP). */
/** Protocole d'un bureau à distance. */
export type DesktopProtocol = "rdp" | "vnc" | "spice";

export interface RemoteDesktop {
  id: string;
  name: string;
  /** Absent des profils créés avant VNC : ce sont des bureaux RDP. */
  protocol?: DesktopProtocol;
  host: string;
  port: number;
  username: string;
  domain?: string | null;
  identityId?: string | null;
  /** Serveur SSH de Zenytt à traverser (tunnel), sinon connexion directe. */
  viaServerId?: string | null;
  fullscreen: boolean;
  width?: number | null;
  height?: number | null;
  multimon: boolean;
  redirectDrives: boolean;
  color?: string | null;
  group?: string | null;
}

/** Session RDP ouverte dans Zenytt : pont local, identifiants et taille d'écran. */
export interface RdpSessionInfo {
  proxyUrl: string;
  token: string;
  destination: string;
  username: string;
  domain?: string | null;
  password: string;
  width: number;
  height: number;
  viaTunnel: boolean;
}

/** Session VNC ouverte dans Zenytt (client noVNC intégré). */
/** État d'une machine virtuelle (libvirt). */
export type VmState = "running" | "paused" | "shutOff" | "shutdown" | "crashed" | "suspended" | "other";
export type VmAction = "start" | "shutdown" | "reboot" | "forceOff" | "suspend" | "resume" | "autostartOn" | "autostartOff";

export interface Vm {
  uuid: string;
  name: string;
  state: VmState;
  vcpus: number;
  memoryKib: number;
  autostart: boolean;
  persistent: boolean;
}

export interface VmOverview {
  access: "direct" | "sudo" | "unavailable";
  version: string;
  /** Explication quand libvirt est inaccessible (affichée à la place de la liste). */
  reason: string | null;
  vms: Vm[];
}

export type VmGraphics =
  | { kind: "vnc"; port: number | null; listen: string; public: boolean; password: boolean }
  | { kind: "vncSocket" }
  | { kind: "spice"; port: number | null; listen: string; password: boolean }
  | { kind: "none" };

export interface VmDetail {
  /** `shared` : en lecture seule ou partagé avec d'autres VM, jamais supprimé avec la VM. */
  disks: { target: string; device: string; source: string | null; format: string | null; shared: boolean }[];
  nics: { mac: string; source: string; model: string | null }[];
  graphics: VmGraphics;
  os: string;
  machine: string;
  firmware: "bios" | "uefi";
  ips: string[];
}

export interface VmStats {
  uuid: string;
  cpuPercent: number;
  memoryUsedKib: number | null;
}

/** Écran d'une VM ouvert dans le client VNC intégré. */
export interface VmConsole {
  session: VncSessionInfo;
  /** Écran de la VM écouté sur le réseau : fonctionne par le tunnel, mais à corriger. */
  warning: string | null;
}

export interface VncSessionInfo {
  /** Adresse du pont local (WebSocket), jeton compris. */
  url: string;
  /** Mot de passe VNC, ou vide si la machine n'en demande pas. */
  password: string;
  username: string;
  destination: string;
  viaTunnel: boolean;
}

export interface DesktopView extends RemoteDesktop {
  hasPassword: boolean;
}

export interface ServerView extends ServerProfile {
  hasPassword: boolean;
  hasPassphrase: boolean;
  hasSudoPassword: boolean;
  connected: boolean;
}

/** `undefined` = inchangé, `""` = supprimé. */
export interface SecretsInput {
  password?: string;
  passphrase?: string;
  sudoPassword?: string;
}

export interface ConnectInfo {
  fingerprint: string;
  hostname: string;
  os: string;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

/** Partage d'un terminal : les invités regardent, ou peuvent aussi taper. */
export type ShareMode = "view" | "control";

export type ShareEvent = { type: "guestJoined" } | { type: "ended"; reason: string };

export interface ShareInfo {
  termId: number;
  invite: string;
  mode: ShareMode;
}

export type TermEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

export type EntryKind = "dir" | "file" | "symlink" | "other";

export interface FsEntry {
  name: string;
  path: string;
  kind: EntryKind;
  targetIsDir: boolean;
  size: number;
  modified: number | null;
  permissions: string;
  mode: number;
  owner: string | null;
  group: string | null;
}

/** Fichier trouvé par nom sur le serveur. */
export interface FsHit {
  path: string;
  size: number;
  isDir: boolean;
}

/** Ligne trouvée par recherche plein texte (grep distant). */
export interface FsMatch {
  path: string;
  line: number;
  text: string;
}

/** Résultat d'une recherche, tronqué au-delà de 500 éléments. */
export interface FsResults<T> {
  items: T[];
  truncated: boolean;
}

/** Format d'archive proposé côté serveur. */
export type ArchiveFormat = "targz" | "zip" | "tarzst";

/** Extension du fichier produit, par format. */
export const ARCHIVE_EXTENSIONS: Record<ArchiveFormat, string> = { targz: "tar.gz", zip: "zip", tarzst: "tar.zst" };

export interface F2bJail {
  name: string;
  currentlyFailed: number;
  totalFailed: number;
  currentlyBanned: number;
  totalBanned: number;
  banned: string[];
  bantime: number;
  findtime: number;
  maxretry: number;
  ignoreip: string[];
  /** Début et fin des bannissements en cours (heures du serveur ; `until` null : définitif). */
  bans: { ip: string; since: string; until: string | null }[];
}

/** Règles fail2ban ; `null` : réglage du serveur, non écrit par Zenytt. */
export interface F2bRules {
  /** Secondes ; -1 : définitif. */
  bantime: number | null;
  findtime: number | null;
  maxretry: number | null;
}

export interface F2bJailSettings extends F2bRules {
  name: string;
  enabled: boolean | null;
}

/** Réglages écrits par Zenytt dans jail.d/zz-zenytt-settings.local. */
export interface F2bSettings {
  defaults: F2bRules;
  increment: boolean;
  incrementMax: number | null;
  jails: F2bJailSettings[];
}

/** Durée d'un bannissement manuel : celle du jail, ou une jail Zenytt (7 j, 30 j, définitif). */
export type BanDuration = "jail" | "week" | "month" | "forever";

/** Jails créées par Zenytt pour les bannissements manuels. */
export const MANUAL_JAILS: Record<string, string> = { "zenytt-7j": "Bannissement manuel · 7 jours", "zenytt-30j": "Bannissement manuel · 30 jours", "zenytt-definitif": "Bannissement manuel · définitif" };

/** Événement du journal de fail2ban. */
export interface F2bEvent {
  /** Heure du serveur, « 2026-09-30 14:02:11 ». */
  time: string;
  jail: string;
  kind: "found" | "ban" | "unban" | "restore" | "ignore";
  ip: string;
}

export interface IpLabel {
  ip: string;
  label: string;
  note: string;
}

export interface GeoStatus {
  installed: boolean;
  updatedAt: number | null;
  stale: boolean;
}

export interface GeoInfo {
  countryCode: string | null;
  country: string | null;
  asn: number | null;
  /** Opérateur du réseau (hébergeur, FAI…). */
  org: string | null;
}

export interface F2bState {
  installed: boolean;
  running: boolean;
  version: string | null;
  jails: F2bJail[];
}

export interface FwRule {
  num: number;
  to: string;
  action: string;
  from: string;
  v6: boolean;
}

export interface FwExposure {
  port: number;
  proto: string;
  address: string;
  owner: string;
  public: boolean;
  docker: boolean;
  status: "open" | "blocked" | "local";
  note: string;
}

export interface FwState {
  kind: "ufw" | "firewalld" | "none";
  active: boolean;
  defaults: string | null;
  rules: FwRule[];
  raw: string | null;
  exposures: FwExposure[];
  sshPorts: number[];
}

export interface AuthorizedKey {
  line: string;
  algorithm: string;
  fingerprint: string;
  comment: string;
  options: string;
  current: boolean;
}

export interface ServerUser {
  name: string;
  uid: number;
  home: string;
  shell: string;
  groups: string[];
  admin: boolean;
  lastLogin: string;
  keys: AuthorizedKey[];
}

export interface CronJob {
  schedule: string;
  user: string | null;
  command: string;
  human: string | null;
}

export interface CronSource {
  id: string;
  label: string;
  editable: boolean;
  raw: string;
  jobs: CronJob[];
}

export interface SystemdTimer {
  unit: string;
  activates: string;
  next: string;
  last: string;
}

export interface Schedule {
  crontabs: CronSource[];
  timers: SystemdTimer[];
  systemd: boolean;
}

export interface DomainInfo {
  domain: string;
  ips: string[];
  dns: "ok" | "elsewhere" | "missing" | "unknown";
  dnsDetail: string;
  registrable: string;
  expires: string | null;
}

export interface DiagnosisCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface Diagnosis {
  checks: DiagnosisCheck[];
  verdict: string;
  advice: string[];
  probablyBanned: boolean;
  publicIp: string | null;
}

/** Portion d'un gros fichier : `len` octets à partir de `offset`, sur `size` au total. */
export interface TextWindow {
  text: string;
  offset: number;
  len: number;
  size: number;
}

/** Date de modification (s) et taille d'un fichier distant. */
export interface FileStamp {
  mtime: number;
  size: number;
}

export interface Listing {
  path: string;
  entries: FsEntry[];
}

export interface Progress {
  file: string;
  done: number;
  total: number;
}

export interface Disk {
  mount: string;
  device: string;
  total: number;
  used: number;
  /** Lecture seule (ou image figée) : pleine par nature, hors alerte. */
  readOnly?: boolean;
  /** Écarté par l'utilisateur : affiché, sans alerte. */
  ignored?: boolean;
}

/** Compte dans l'alerte « Disque » et la jauge principale. */
export const diskCounts = (d: Disk) => !d.readOnly && !d.ignored;

/** Disque à montrer en jauge principale : `/` s'il compte, sinon le plus gros qui compte. */
export function mainDisk(disks: Disk[] | undefined): Disk | undefined {
  if (!disks?.length) return undefined;
  const counting = disks.filter(diskCounts);
  return counting.find((d) => d.mount === "/") ?? [...counting].sort((a, b) => b.total - a.total)[0] ?? disks.find((d) => d.mount === "/") ?? disks[0];
}

/** Réglage d'un point de montage (supervision). */
export interface DiskRule {
  serverId: string;
  mount: string;
  ignore: boolean;
  /** Octets ; null : valeur lue par df. */
  total: number | null;
  used: number | null;
}

export interface Metrics {
  timestamp: number;
  cpuPercent: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  load: [number, number, number];
  uptimeSecs: number;
  netRxRate: number;
  netTxRate: number;
  disks: Disk[];
}

export interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  disk: number;
  load: number;
  rx: number;
  tx: number;
}

export interface Process {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  elapsed: number;
  name: string;
  command: string;
}

export interface SystemInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptimeSecs: number;
  /** Secondes Unix. */
  bootTime: number;
  timezone: string;
  rebootRequired: boolean;
  scheduled: { at: number; mode: string } | null;
  packageManager: string | null;
  cpuModel: string;
  cpuCount: number;
  /** Octets. */
  memoryTotal: number;
}

export interface SystemUpdate {
  name: string;
  current: string;
  candidate: string;
}

export type ProviderKind = "hetzner" | "scaleway" | "digitalOcean" | "ovh";
export type ProviderAction = "status" | "reboot" | "reset" | "powerOn" | "powerOff";

export interface ProviderLink {
  kind: ProviderKind;
  serverRef: string;
  /** Scaleway : zone ; OVH : région de l'API (ovh-eu, ovh-ca, ovh-us). */
  zone?: string | null;
}

/** Secrets en écriture seule : seule leur présence est renvoyée. */
export interface ProviderView {
  link: ProviderLink | null;
  hasToken: boolean;
  hasSecret: boolean;
  hasConsumer: boolean;
}

export interface ProviderStatus {
  state: "running" | "off" | "starting" | "stopping" | "unknown";
  raw: string;
}

export interface GithubStatus {
  configured: boolean;
  login: string | null;
}

export interface GithubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  openIssues: number;
  description: string | null;
  fork: boolean;
  archived: boolean;
}

/** Clone d'un dépôt GitHub présent sur un serveur. */
export interface GithubClone {
  path: string;
  branch: string;
  /** Fichiers modifiés ou non suivis. */
  dirty: number;
  /** [en avance, en retard] sur la branche suivie ; null sans branche suivie. */
  aheadBehind: [number, number] | null;
  commit: string;
  commitDate: string;
  subject: string;
}

export interface Service {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string;
}

export type AlertMetric = "cpu" | "memory" | "disk" | "load";

export interface AgentConfig {
  serverName?: string | null;
  sampleIntervalSecs: number;
  rules: { metric: AlertMetric; threshold: number; forSecs: number; enabled: boolean }[];
  httpChecks: { name: string; url: string; enabled: boolean }[];
  httpCheckIntervalSecs: number;
  notifiers: { discordWebhook?: string | null; ntfyUrl?: string | null; webhookUrl?: string | null };
}

export interface ActiveAlert {
  key: string;
  title: string;
  message: string;
  since: number;
}

export interface AlertEvent {
  t: number;
  key: string;
  title: string;
  message: string;
  resolved: boolean;
}

export interface AgentStatus {
  version: string;
  protocol: number;
  startedAt: number;
  hostname: string;
  config: AgentConfig;
  configError: string | null;
  activeAlerts: ActiveAlert[];
  recentEvents: AlertEvent[];
  latest: Metrics | null;
}

export interface AgentInfo {
  installed: boolean;
  running: boolean;
  status: AgentStatus | null;
  error: string | null;
}

export type DockerAccess = "direct" | "sudo" | "unavailable";

export interface PortMapping {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: PortMapping[];
  portsRaw: string;
  createdAt: string;
  composeProject: string | null;
  composeService: string | null;
  exitCode: number | null;
  health: string | null;
  oomKilled: boolean;
  condition: ContainerCondition;
}

/** Pourquoi un conteneur n'est pas (ou pas bien) en marche. */
export type ContainerCondition = "ok" | "unhealthy" | "crashLoop" | "crashed" | "outOfMemory" | "stopped" | "finished" | "created" | "paused";

export const isFailure = (c: ContainerCondition) => c === "unhealthy" || c === "crashLoop" || c === "crashed" || c === "outOfMemory";

export interface ComposeProject {
  name: string;
  status: string;
  configFiles: string;
  /** Le fichier compose noté par Docker n'existe plus (dossier renommé, déplacé ou supprimé). */
  missing?: boolean;
}

/** Ce que Docker fait déjà du projet d'un fichier compose choisi dans l'explorateur. */
export type ComposeFileState =
  | { kind: "invalid"; message: string }
  | { kind: "notRunning" }
  | { kind: "same"; project: ComposeProject; running: boolean }
  | { kind: "conflict"; project: ComposeProject };

export interface ComposeFileInfo {
  file: string;
  /** Nom du projet calculé par Docker (clé `name:`, sinon nom du dossier). */
  project: string;
  hasBuild: boolean;
  ports: number[];
  /** Ports publiés déjà occupés sur le serveur (vérifié avant un premier lancement). */
  busyPorts: number[];
  state: ComposeFileState;
}

export interface DockerOverview {
  access: DockerAccess;
  version: string;
  /** « docker » ou « podman ». */
  engine: string;
  containers: Container[];
  projects: ComposeProject[];
  /** Conteneurs ponctuels du serveur (clés `projet/service` ou nom) : leur arrêt n'est pas signalé. */
  occasional: string[];
  /** Conteneurs arrêtés volontairement (depuis Zenytt, ou marqués) : leur arrêt n'est pas une panne. */
  onPurpose: string[];
}

/** Membre d'un réseau privé WireGuard. */
export interface MeshMember {
  serverId: string;
  address: string;
  publicKey: string;
  /** IP ou nom public ; null : serveur derrière un NAT. */
  endpoint: string | null;
  port: number;
}

export interface MeshNetwork {
  id: string;
  name: string;
  cidr: string;
  members: MeshMember[];
}

export interface MeshLink {
  publicKey: string;
  endpoint: string | null;
  /** Horodatage Unix (s) du dernier échange ; null : jamais. */
  lastHandshake: number | null;
  rx: number;
  tx: number;
}

export interface MeshNodeStatus {
  networkId: string | null;
  up: boolean;
  links: MeshLink[];
}

export interface MeshMemberStatus {
  serverId: string;
  error: string | null;
  status: MeshNodeStatus | null;
}

export interface MeshMemberResult {
  serverId: string;
  ok: boolean;
  message: string;
}

export interface MeshReport {
  network: MeshNetwork | null;
  results: MeshMemberResult[];
  warnings: string[];
}

export interface ContainerStats {
  id: string;
  cpu: number;
  memPercent: number;
  memUsage: string;
  netIo: string;
  pids: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdSince: string;
  containers: string;
}

export interface DockerDiskUsage {
  kind: string;
  totalCount: string;
  active: string;
  size: string;
  reclaimable: string;
}

export interface NginxLocation {
  path: string;
  proxyPass: string | null;
  root: string | null;
  returns: string | null;
}

export interface ServerBlock {
  serverNames: string[];
  listen: string[];
  ssl: boolean;
  root: string | null;
  sslCertificate: string | null;
  returns: string | null;
  locations: NginxLocation[];
  line: number;
  upstreamPorts: number[];
}

export interface SiteFile {
  path: string;
  realPath: string;
  enabled: boolean;
  servers: ServerBlock[];
}

export interface Certificate {
  path: string;
  subject: string;
  domains: string[];
  notAfter: number;
  issuer: string;
}

export interface NginxState {
  installed: boolean;
  version: string;
  running: boolean;
  files: SiteFile[];
  disabled: SiteFile[];
  certificates: Certificate[];
  certbot: boolean;
  /** Autres serveurs web détectés (Caddy, Apache, Traefik…). */
  others: string[];
  /** Dossier de configuration (/etc/nginx, /etc/apache2 ou /etc/httpd). */
  confRoot: string;
}

/** Serveur web piloté par la page Sites. */
export type WebEngine = "nginx" | "apache";

export const ENGINE_LABELS: Record<WebEngine, string> = { nginx: "nginx", apache: "Apache" };

export interface ApplyResult {
  ok: boolean;
  backup: string | null;
  log: string;
}

export interface NewSitePlan {
  freePort: number;
  usedPorts: number[];
  publicIp: string | null;
  docker: boolean;
  certbot: boolean;
}

export interface AppSpec {
  name: string;
  image: string;
  hostPort: number;
  containerPort: number;
  env: [string, string][];
}

export interface TunnelDef {
  id: string;
  serverId: string;
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface TunnelView extends TunnelDef {
  running: boolean;
  activeConnections: number;
  totalConnections: number;
  lastError: string | null;
}

export interface LogSource {
  kind: "docker" | "unit" | "file";
  name: string;
}

export type LogEvent = { type: "lines"; lines: { source: number; text: string }[] } | { type: "ended"; source: number; error: string | null };

export type Severity = "critical" | "high" | "medium" | "low" | "ok";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: string | null;
  fixLabel: string | null;
}

/** Constat d'audit mis de côté. */
export interface IgnoredFinding {
  serverId: string;
  findingId: string;
  title: string;
  reason: string;
  at: number;
}

export interface SecurityReport {
  os: string;
  sshPorts: number[];
  findings: Finding[];
}

export interface FixPlan {
  id: string;
  description: string;
  script: string;
  needsVerification: boolean;
}

export type BackupDestination =
  | { kind: "local"; path: string }
  | { kind: "s3"; endpoint: string; bucket: string; prefix: string; accessKeyId: string };

export interface DbSource {
  container: string;
  kind: "mysql" | "postgres";
}

export interface BackupConfig {
  destination: BackupDestination;
  schedule: string;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  paths: string[];
  volumes: string[];
  databases: DbSource[];
}

export interface BackupOverview {
  status: {
    restic: string | null;
    config: BackupConfig | null;
    last: { startedAt: number; finishedAt: number; ok: boolean; message: string } | null;
    nextRun: string | null;
  };
  defaultConfig: BackupConfig;
  volumes: string[];
  databases: DbSource[];
  passwordInKeyring: boolean;
}

export interface Snapshot {
  short_id: string;
  time: string;
  paths: string[];
  hostname: string;
}

export interface SnapshotNode {
  path: string;
  name: string;
  kind: string;
  size: number;
}

export interface DeployKey {
  project: string;
  privateKey: string;
  knownHosts: string;
  user: string;
  workflow: string;
}

/** Ce que la règle sudo de la clé de déploiement ajoute aux droits du compte SSH. */
export interface SudoRisk {
  root: boolean;
  dockerGroup: boolean;
  /** Dossier, fichiers compose et .env du projet modifiables par le compte. */
  writable: string[];
}

export interface McpConfig {
  command: string;
  claudeDesktop: string;
  claudeCode: string;
}

/** Avancement de la copie du dépôt de sauvegarde sur le PC. */
export interface MirrorProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface MirrorResult {
  dir: string;
  downloaded: number;
  deleted: number;
  bytes: number;
  files: number;
  totalBytes: number;
}

function progressChannel(onProgress: (p: Progress) => void) {
  const channel = new Channel<Progress>();
  channel.onmessage = onProgress;
  return channel;
}

export interface DashboardSummary {
  connected: boolean;
  error: string | null;
  metrics: Metrics | null;
  agent: boolean;
  alerts: ActiveAlert[];
  docker: boolean;
  containersRunning: number;
  /** Arrêtés sans erreur, ni ponctuels ni arrêtés volontairement. */
  containersStopped: number;
  stoppedNames: string[];
  /** Clés (`projet/service` ou nom) de tous les conteneurs arrêtés ci-dessus. */
  stoppedKeys: string[];
  /** En panne : planté, manque de mémoire, redémarrage en boucle, healthcheck en échec. */
  failed: { name: string; condition: ContainerCondition; status: string }[];
  certificates: { domains: string[]; notAfter: number }[];
}

/** Bilan d'un import de réglages ou d'un partage reçu. */
export interface ImportSummary {
  servers: number;
  identities: number;
  snippets: number;
  tunnels: number;
  secrets: number;
  /** Serveurs reçus avec l'identifiant d'un serveur existant mais une autre adresse, ajoutés à côté. */
  duplicated: number;
  /** Empreintes de clé d'hôte reçues qui contredisaient une empreinte approuvée : ignorées. */
  hostKeysKept: number;
  /** Bureaux à distance et registres dans le même cas que `duplicated`. */
  duplicatedOther: number;
  /** Liens vers un de tes identifiants retirés : le contenu reçu s'en servait sans son secret. */
  identityLinksRemoved: number;
  /** Bureaux à distance ou registres invalides : ignorés. */
  rejected: number;
}

/** L'import a-t-il écarté ou détourné quelque chose (bilan à afficher en avertissement) ? */
export const importHasWarnings = (r: ImportSummary) => !!(r.duplicated || r.hostKeysKept || r.duplicatedOther || r.identityLinksRemoved || r.rejected);

/** Phrase de bilan, avec les avertissements de sécurité s'il y en a. */
export function importMessage(r: ImportSummary): string {
  let m = `Importé : ${r.servers} serveur(s), ${r.identities} identifiant(s), ${r.snippets} fragment(s), ${r.tunnels} tunnel(s), ${r.secrets} secret(s).`;
  if (r.duplicated) m += ` ${r.duplicated} serveur(s) portaient l'identifiant d'un serveur existant avec une autre adresse : ajoutés comme nouveaux serveurs.`;
  if (r.duplicatedOther) m += ` ${r.duplicatedOther} bureau(x) à distance ou registre(s) dans le même cas : ajoutés à côté des existants.`;
  if (r.hostKeysKept) m += ` ${r.hostKeysKept} empreinte(s) de clé d'hôte différente(s) de celles déjà approuvées : ignorées.`;
  if (r.identityLinksRemoved)
    m += ` ${r.identityLinksRemoved} élément(s) utilisaient un de tes identifiants sans son mot de passe : lien retiré, choisis l'identifiant toi-même si c'est voulu.`;
  if (r.rejected) m += ` ${r.rejected} bureau(x) à distance ou registre(s) invalides : ignorés.`;
  return m;
}

export interface AuditEntry {
  t: number;
  origin: string;
  serverId: string;
  serverName: string;
  action: string;
  detail: string;
  ok: boolean;
  error: string | null;
}

/** Moteur de base de données. */
export type DbEngine = "mysql" | "postgres" | "sqlite";

export interface DbInstance {
  id: string;
  label: string;
  engine: DbEngine;
  /** Conteneur Docker, ou null pour le service installé sur le serveur. */
  container?: string | null;
  version: string;
  /** Chemin du fichier pour SQLite ; chaîne vide pour les autres moteurs. */
  path?: string;
}

/** Colonne d'une table, telle que la décrit le moteur. */
export interface DbColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  /** Fait partie de la clé primaire : c'est ce qui autorise l'édition d'une cellule. */
  primary: boolean;
}

/** Opérateurs acceptés dans un filtre de colonne (liste fermée côté Rust). */
export const DB_FILTER_OPS = ["=", "!=", "<", "<=", ">", ">=", "LIKE", "NOT LIKE", "IS NULL", "IS NOT NULL"] as const;
export type DbFilterOp = (typeof DB_FILTER_OPS)[number];

/** Condition posée sur une colonne depuis l'en-tête du tableau. */
export interface DbFilter {
  column: string;
  op: DbFilterOp;
  value: string;
}

/** Colonne et valeur qui identifient une ligne (sa clé primaire). */
export interface DbKeyPart {
  column: string;
  value: string | null;
}

/** Base ou table, avec sa taille et son nombre (tables ou lignes), estimés par le moteur. */
export interface DbNamed {
  name: string;
  size: number;
  count: number;
}

/** Colonne décrite dans l'éditeur de structure. */
export interface DbColumnDef {
  name: string;
  dataType: string;
  /** « 255 », « 10,2 », ou vide. */
  length: string;
  nullable: boolean;
  /** Vide : aucune ; nombre ou mot-clé (CURRENT_TIMESTAMP, NULL…) tel quel, sinon texte. */
  default: string;
  primary: boolean;
  autoIncrement: boolean;
}

/** Opération de structure : le SQL est construit côté Rust, montré, puis exécuté. */
export type DbSchemaOp =
  | { op: "createTable"; table: string; columns: DbColumnDef[] }
  | { op: "dropTable"; table: string }
  | { op: "truncateTable"; table: string }
  | { op: "renameTable"; table: string; to: string }
  | { op: "addColumn"; table: string; column: DbColumnDef }
  | { op: "dropColumn"; table: string; column: string }
  | { op: "renameColumn"; table: string; column: string; to: string }
  | { op: "dropDatabase"; database: string };

/** Sauvegarde SQL d'une base, dans ~/zenytt-sauvegardes-bdd sur le serveur. */
export interface DbBackupFile {
  name: string;
  path: string;
  size: number;
  /** Secondes Unix. */
  modified: number;
}

export interface DbQueryResult {
  columns: string[];
  /** `null` = valeur NULL. */
  rows: (string | null)[][];
  truncated: boolean;
  durationMs: number;
}

/** Commande retenue dans l'historique du shell distant. */
export interface ShellHistoryEntry {
  command: string;
  /** Nombre d'apparitions dans l'historique : ce qui met en avant les habitudes. */
  count: number;
  /** Dernière exécution connue (epoch en secondes), si le shell l'enregistre. */
  last: number | null;
  /** Durée de la dernière exécution en secondes ; seul zsh en mode étendu la fournit. */
  duration: number | null;
}

/** Nature d'un réglage du catalogue : elle décide du contrôle appliqué et de la saisie. */
export type CatalogVarKind = "text" | "password" | "port" | "domain" | "path" | "email";

export interface CatalogVariable {
  key: string;
  label: string;
  hint: string;
  kind: CatalogVarKind;
  default: string;
}

/** Application du catalogue Docker Compose intégré à Zenytt. */
export interface CatalogApp {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Port du conteneur à servir derrière nginx, ou null si l'application n'a pas d'interface web. */
  httpPort: number | null;
  docsUrl: string;
  variables: CatalogVariable[];
  compose: string;
  env: string;
  notes: string[];
}

/** Fichiers rendus par le catalogue, prêts à être relus avant écriture. */
export interface CatalogRendered {
  compose: string;
  env: string;
  /** Valeurs finales, mots de passe générés compris : à montrer une fois. */
  values: [string, string][];
}

/** Famille de registre d'images privé. */
export type RegistryKind = "dockerhub" | "ghcr" | "gitlab" | "ecr" | "custom";

/** Registre enregistré dans Zenytt ; le jeton reste dans le coffre du système. */
export interface Registry {
  id: string;
  name: string;
  kind: RegistryKind;
  server: string;
  /** Utilisateur, ou identifiant de clé d'accès AWS pour ECR. */
  username: string;
}

export interface RegistryView extends Registry {
  hasSecret: boolean;
  /** Ce qu'il faut demander comme secret, et avec quels droits. */
  secretHint: string;
}

/** Registre auquel un serveur est connecté (lu dans le config.json de Docker, sans le jeton). */
export interface RegistrySession {
  server: string;
  /** Jeton rangé par un « credential helper » plutôt qu'en base64 dans config.json. */
  helper: boolean;
}

/** Volume Docker, avec ce qui l'utilise et l'espace qu'il occupe. */
export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  /** Aucun conteneur, même arrêté, ne l'utilise. */
  orphan: boolean;
  /** Octets mesurés sur le disque ; 0 si la mesure n'a pas abouti. */
  size: number;
  usedBy: string[];
}

/** Serveur Redis / Valkey joignable sur la machine. */
export interface RedisServer {
  id: string;
  label: string;
  container?: string | null;
  version: string;
}

export interface RedisOverview {
  version: string;
  memory: number;
  /** `[numéro de base, nombre de clés]` pour les bases non vides. */
  databases: [number, number][];
  uptimeDays: number;
}

export type RedisKind = "string" | "hash" | "list" | "set" | "zset" | "stream";

export interface RedisKeyInfo {
  key: string;
  kind: RedisKind | string;
  /** Secondes restantes, ou null si la clé n'expire pas. */
  ttl: number | null;
  size: number;
}

export interface RedisKeyPage {
  keys: RedisKeyInfo[];
  /** « 0 » quand le parcours est terminé. */
  cursor: string;
}

export interface RedisKeyValue {
  key: string;
  kind: RedisKind | string;
  ttl: number | null;
  /** `[champ, valeur]` pour un hachage ou un zset ; `[null, valeur]` sinon. */
  entries: [string | null, string][];
  total: number;
  truncated: boolean;
}

/** Assistant IA : fournisseur, autorisations et mode d'exécution. */
export type AiProvider = "anthropic" | "openai";
export type AiExecMode = "off" | "propose" | "auto";

export interface AiCapabilities {
  status: boolean;
  containers: boolean;
  logs: boolean;
  sites: boolean;
  processes: boolean;
  files: boolean;
  security: boolean;
}

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  maxTokens: number;
  capabilities: AiCapabilities;
  execMode: AiExecMode;
}

export interface AiView extends AiSettings {
  hasKey: boolean;
}

export type AiEvent =
  | { type: "text"; text: string }
  | { type: "tool"; callId: string; name: string; detail: string }
  | { type: "toolDone"; callId: string; ok: boolean; summary: string }
  | { type: "proposal"; callId: string; server: string; command: string; why: string; dangerous: boolean }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

export type SyncMode = "off" | "file" | "server";

/** Mode privé : serveur SSH qui héberge zenytt-sync et son port local. */
export interface SyncTunnel {
  serverId: string;
  port: number;
}

export interface SyncServerStatus {
  installed: boolean;
  port: number;
  healthy: boolean;
  docker: boolean;
}

export interface SyncView {
  mode: SyncMode;
  path?: string | null;
  url?: string | null;
  tunnel?: SyncTunnel | null;
  includeSecrets: boolean;
  lastRev: number;
  lastSync?: number | null;
  hasPassphrase: boolean;
  hasToken: boolean;
}

export interface SyncOutcome {
  action: "upToDate" | "pushed" | "pulled" | "merged";
  rev: number;
  removedServers: string[];
  removedTunnels: string[];
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  created: number;
  windows: number;
  command: string;
}

export interface AppNotice {
  kind: "info" | "error" | "success";
  message: string;
}

export const api = {
  version: () => invoke<string>("app_version"),

  uiStateGet: () => invoke<unknown>("ui_state_get"),
  storeWarning: () => invoke<string | null>("store_warning"),
  /** Messages de la reprise automatique d'une installation précédente, produits avant l'ouverture de l'interface. */
  appNotices: () => invoke<AppNotice[]>("app_notices"),
  /** L'interface prend en charge les demandes de fermeture (sinon la fenêtre se ferme directement). */
  appUiReady: () => invoke<void>("app_ui_ready"),
  trayUpdate: (servers: { id: string; name: string; connected: boolean; alerts: number }[]) => invoke<void>("tray_update", { servers }),
  /** Réduit dans la zone de notification. */
  appHide: () => invoke<void>("app_hide"),
  /** Quitte vraiment : tunnels, terminaux et transferts s'arrêtent. */
  appQuit: () => invoke<void>("app_quit"),
  autostartGet: () => invoke<boolean>("autostart_get"),
  autostartSet: (enabled: boolean) => invoke<void>("autostart_set", { enabled }),
  f2bState: (serverId: string) => invoke<F2bState>("f2b_state", { serverId }),
  f2bUnban: (serverId: string, jail: string, ip: string) => invoke<void>("f2b_unban", { serverId, jail, ip }),
  f2bSetIgnore: (serverId: string, addresses: string[]) => invoke<string>("f2b_set_ignore", { serverId, addresses }),
  f2bBan: (serverId: string, jail: string, ip: string, duration: BanDuration) => invoke<void>("f2b_ban", { serverId, jail, ip, duration }),
  f2bSettings: (serverId: string) => invoke<{ settings: F2bSettings; available: string[] }>("f2b_settings", { serverId }),
  f2bSettingsSet: (serverId: string, settings: F2bSettings) => invoke<string>("f2b_settings_set", { serverId, settings }),
  f2bEvents: (serverId: string, ip: string | null, limit = 500) => invoke<F2bEvent[]>("f2b_events", { serverId, ip, limit }),
  f2bAttempts: (serverId: string, ip: string) => invoke<string[]>("f2b_attempts", { serverId, ip }),
  ipLabels: () => invoke<IpLabel[]>("ip_labels_list"),
  /** Étiquette et note vides : l'étiquette est retirée. */
  ipLabelSet: (ip: string, label: string, note: string) => invoke<void>("ip_label_set", { ip, label, note }),
  geoStatus: () => invoke<GeoStatus>("geo_status"),
  geoInstall: () => invoke<GeoStatus>("geo_install"),
  geoLookup: (ips: string[]) => invoke<Record<string, GeoInfo>>("geo_lookup", { ips }),
  myPublicIp: () => invoke<string | null>("my_public_ip"),
  fwState: (serverId: string) => invoke<FwState>("fw_state", { serverId }),
  fwAllow: (serverId: string, port: number, proto: string) => invoke<string>("fw_allow", { serverId, port, proto }),
  fwDelete: (serverId: string, num: number) => invoke<string>("fw_delete", { serverId, num }),
  accessUsers: (serverId: string) => invoke<ServerUser[]>("access_users", { serverId }),
  accessAddKey: (serverId: string, user: string, key: string) => invoke<void>("access_add_key", { serverId, user, key }),
  accessRemoveKey: (serverId: string, user: string, line: string) => invoke<void>("access_remove_key", { serverId, user, line }),
  scheduleList: (serverId: string) => invoke<Schedule>("schedule_list", { serverId }),
  crontabSave: (serverId: string, user: string, content: string) => invoke<void>("crontab_save", { serverId, user, content }),
  timerRun: (serverId: string, service: string) => invoke<void>("timer_run", { serverId, service }),
  domainsCheck: (serverId: string, domains: string[]) => invoke<DomainInfo[]>("domains_check", { serverId, domains }),
  diagnose: (id: string) => invoke<Diagnosis>("ssh_diagnose", { id }),
  settingsExport: (path: string, password: string, includeSecrets: boolean) => invoke<void>("settings_export", { path, password, includeSecrets }),
  settingsImportEncrypted: (path: string) => invoke<boolean>("settings_import_encrypted", { path }),
  settingsImport: (path: string, password: string) =>
    invoke<ImportSummary>("settings_import", { path, password }),
  shellHistory: (serverId: string) => invoke<string[]>("shell_history", { serverId }),
  logsOpenDir: () => invoke<void>("logs_open_dir"),
  appIsLocked: () => invoke<boolean>("app_is_locked"),
  appLockEngage: () => invoke<void>("app_lock_engage"),
  appUnlock: (password: string) => invoke<boolean>("app_unlock", { password }),
  appLockGet: () => invoke<string | null>("app_lock_get"),
  /** Chaîne vide : supprime le mot de passe (verrouillage désactivé). */
  appLockSet: (hash: string) => invoke<void>("app_lock_set", { hash }),
  uiStateSet: (state: unknown) => invoke<void>("ui_state_set", { state }),
  auditList: (limit = 500) => invoke<AuditEntry[]>("audit_list", { limit }),
  tmuxCheck: (serverId: string) => invoke<string | null>("tmux_check", { serverId }),
  tmuxInstall: (serverId: string) => invoke<string>("tmux_install", { serverId }),
  tmuxSessions: (serverId: string) => invoke<TmuxSession[]>("tmux_sessions", { serverId }),
  tmuxKill: (serverId: string, name: string) => invoke<void>("tmux_kill", { serverId, name }),

  servers: () => invoke<ServerView[]>("servers_list"),
  saveServer: (profile: ServerProfile, secretsInput: SecretsInput) =>
    invoke<string>("server_save", { profile, secretsInput }),
  deleteServer: (id: string) => invoke<void>("server_delete", { id }),
  /** Range des serveurs dans un dossier (`null` : hors dossier), sans couper leurs connexions. */
  serversSetGroup: (ids: string[], group: string | null) => invoke<void>("servers_set_group", { ids, group }),
  trustHost: (id: string, fingerprint: string) => invoke<void>("host_trust", { id, fingerprint }),
  connect: (id: string, userInitiated = false) => invoke<ConnectInfo>("ssh_connect", { id, userInitiated }),
  disconnect: (id: string) => invoke<void>("ssh_disconnect", { id }),
  puttySessions: () => invoke<ServerProfile[]>("putty_sessions"),
  sshConfigSessions: () => invoke<ServerProfile[]>("ssh_config_sessions"),
  setAiAccess: (id: string, enabled: boolean) => invoke<void>("server_set_ai_access", { id, enabled }),

  identities: () => invoke<IdentityView[]>("identities_list"),
  identitySave: (identity: Identity, secretsInput: { password?: string; passphrase?: string }) =>
    invoke<string>("identity_save", { identity, secretsInput }),
  identityDelete: (id: string) => invoke<void>("identity_delete", { id }),

  desktops: () => invoke<DesktopView[]>("desktops_list"),
  /** Ouvre une session pour le client RDP intégré (pont local, tunnel si nécessaire). */
  desktopSessionOpen: (id: string) => invoke<RdpSessionInfo>("desktop_session_open", { id }),
  desktopSessionClose: (id: string) => invoke<void>("desktop_session_close", { id }),
  vncSessionOpen: (id: string) => invoke<VncSessionInfo>("vnc_session_open", { id }),
  vmOverview: (serverId: string) => invoke<VmOverview>("vm_overview", { serverId }),
  vmDetail: (serverId: string, uuid: string) => invoke<VmDetail>("vm_detail", { serverId, uuid }),
  vmStats: (serverId: string) => invoke<VmStats[]>("vm_stats", { serverId }),
  vmAction: (serverId: string, vm: Vm, action: VmAction) => invoke<void>("vm_action", { serverId, uuid: vm.uuid, name: vm.name, action }),
  /** Renvoie les fichiers restés sur le serveur (hors d'un pool libvirt, à supprimer à la main). */
  vmDelete: (serverId: string, vm: Vm, withStorage: boolean) => invoke<string[]>("vm_delete", { serverId, uuid: vm.uuid, name: vm.name, withStorage }),
  vmConsoleOpen: (serverId: string, uuid: string, name: string) => invoke<VmConsole>("vm_console_open", { serverId, uuid, name }),
  /** Écran de la VM dans le client du système (remote-viewer), par un tunnel SSH. */
  vmConsoleExternal: (serverId: string, vm: { uuid: string; name: string }) => invoke<string>("vm_console_external", { serverId, uuid: vm.uuid, name: vm.name }),
  vmSerialCommand: (serverId: string, uuid: string) => invoke<string>("vm_serial_command", { serverId, uuid }),
  /** Écran VNC limité à 127.0.0.1, au prochain démarrage de la VM. */
  vmVncRestrict: (serverId: string, vm: Vm) => invoke<void>("vm_vnc_restrict", { serverId, uuid: vm.uuid, name: vm.name }),
  /** `password` : `undefined` = inchangé, `""` = supprimé. */
  desktopSave: (desktop: RemoteDesktop, password?: string) => invoke<string>("desktop_save", { desktop, password }),
  desktopDelete: (id: string) => invoke<void>("desktop_delete", { id }),
  desktopLaunch: (id: string) => invoke<string>("desktop_launch", { id }),

  dbInstances: (serverId: string) => invoke<DbInstance[]>("db_instances", { serverId }),
  dbVersion: (serverId: string, instance: DbInstance) => invoke<string>("db_version", { serverId, instance }),
  dbCreate: (serverId: string, instance: DbInstance, name: string) => invoke<void>("db_create", { serverId, instance, name }),
  dbDatabases: (serverId: string, instance: DbInstance) => invoke<DbNamed[]>("db_databases", { serverId, instance }),
  dbTables: (serverId: string, instance: DbInstance, database: string) => invoke<DbNamed[]>("db_tables", { serverId, instance, database }),
  dbQuery: (serverId: string, instance: DbInstance, database: string | null, sql: string, limit = 500) =>
    invoke<DbQueryResult>("db_query", { serverId, instance, database, sql, limit }),
  dbColumns: (serverId: string, instance: DbInstance, database: string | null, table: string) =>
    invoke<DbColumn[]>("db_columns", { serverId, instance, database, table }),
  dbTableQuery: (engine: DbEngine, table: string, filters: DbFilter[], sortColumn: string | null, sortDesc: boolean, limit: number, offset = 0) =>
    invoke<string>("db_table_query", { engine, table, filters, sortColumn, sortDesc, limit, offset }),
  dbUpdateCellSql: (engine: DbEngine, table: string, column: string, value: string | null, key: DbKeyPart[]) =>
    invoke<string>("db_update_cell_sql", { engine, table, column, value, key }),
  dbDeleteRowSql: (engine: DbEngine, table: string, key: DbKeyPart[]) => invoke<string>("db_delete_row_sql", { engine, table, key }),
  dbInsertRowSql: (engine: DbEngine, table: string, values: [string, string | null][]) => invoke<string>("db_insert_row_sql", { engine, table, values }),
  dbSchemaSql: (engine: DbEngine, op: DbSchemaOp) => invoke<string>("db_schema_sql", { engine, op }),
  dbColumnTypes: (engine: DbEngine) => invoke<string[]>("db_column_types", { engine }),
  /** Utilisateur enregistré pour l'instance (jamais le mot de passe), ou null. */
  dbLoginGet: (serverId: string, instanceId: string) => invoke<string | null>("db_login_get", { serverId, instanceId }),
  /** Utilisateur vide : oublie le compte. */
  dbLoginSet: (serverId: string, instanceId: string, user: string, password: string) => invoke<void>("db_login_set", { serverId, instanceId, user, password }),
  dbBackups: (serverId: string) => invoke<DbBackupFile[]>("db_backups", { serverId }),
  dbImportDir: (serverId: string) => invoke<string>("db_import_dir", { serverId }),
  dbBackup: (serverId: string, instance: DbInstance, database: string, stamp: string) => invoke<DbBackupFile>("db_backup", { serverId, instance, database, stamp }),
  /** Renvoie les avertissements du client (vide si tout s'est bien passé). */
  dbRestore: (serverId: string, instance: DbInstance, database: string, file: string) => invoke<string>("db_restore", { serverId, instance, database, file }),
  dbBackupDelete: (serverId: string, file: string) => invoke<void>("db_backup_delete", { serverId, file }),
  dbUsers: (serverId: string, instance: DbInstance) => invoke<DbQueryResult>("db_users", { serverId, instance }),
  dbUserCreate: (serverId: string, instance: DbInstance, user: string, host: string, password: string, database: string | null) =>
    invoke<void>("db_user_create", { serverId, instance, user, host, password, database }),
  dbUserPassword: (serverId: string, instance: DbInstance, user: string, host: string, password: string) => invoke<void>("db_user_password", { serverId, instance, user, host, password }),
  dbUserDrop: (serverId: string, instance: DbInstance, user: string, host: string) => invoke<void>("db_user_drop", { serverId, instance, user, host }),
  dbActivity: (serverId: string, instance: DbInstance) => invoke<DbQueryResult>("db_activity", { serverId, instance }),
  dbKill: (serverId: string, instance: DbInstance, id: number, whole: boolean) => invoke<void>("db_kill", { serverId, instance, id, whole }),
  dbSqliteFiles: (serverId: string) => invoke<DbInstance[]>("db_sqlite_files", { serverId }),

  dockerCatalog: () => invoke<CatalogApp[]>("docker_catalog"),
  dockerCatalogDefaults: (appId: string) => invoke<[string, string][]>("docker_catalog_defaults", { appId }),
  dockerCatalogRender: (appId: string, values: Record<string, string>) => invoke<CatalogRendered>("docker_catalog_render", { appId, values }),
  dockerVolumes: (serverId: string) => invoke<DockerVolume[]>("docker_volumes", { serverId }),
  dockerRemoveVolume: (serverId: string, name: string) => invoke<void>("docker_remove_volume", { serverId, name }),
  registries: () => invoke<RegistryView[]>("registries_list"),
  registrySave: (registry: Registry, secret: string | null) => invoke<string>("registry_save", { registry, secret }),
  registryDelete: (id: string) => invoke<void>("registry_delete", { id }),
  registrySessions: (serverId: string) => invoke<RegistrySession[]>("registry_sessions", { serverId }),
  registryLogin: (serverId: string, registryId: string) => invoke<string>("registry_login", { serverId, registryId }),
  registryLogout: (serverId: string, server: string) => invoke<void>("registry_logout", { serverId, server }),

  redisServers: (serverId: string) => invoke<RedisServer[]>("redis_servers", { serverId }),
  redisOverview: (serverId: string, server: RedisServer) => invoke<RedisOverview>("redis_overview", { serverId, server }),
  redisScan: (serverId: string, server: RedisServer, database: number, cursor: string, pattern: string, count = 200) =>
    invoke<RedisKeyPage>("redis_scan", { serverId, server, database, cursor, pattern, count }),
  redisKey: (serverId: string, server: RedisServer, database: number, key: string) =>
    invoke<RedisKeyValue>("redis_key", { serverId, server, database, key }),
  redisDelete: (serverId: string, server: RedisServer, database: number, keys: string[]) =>
    invoke<number>("redis_delete", { serverId, server, database, keys }),
  redisSet: (serverId: string, server: RedisServer, database: number, key: string, value: string, ttl: number | null) =>
    invoke<void>("redis_set", { serverId, server, database, key, value, ttl }),
  redisExpire: (serverId: string, server: RedisServer, database: number, key: string, ttl: number | null) =>
    invoke<void>("redis_expire", { serverId, server, database, key, ttl }),
  redisCommand: (serverId: string, server: RedisServer, database: number, command: string) =>
    invoke<string[]>("redis_command", { serverId, server, database, command }),
  redisBlocked: () => invoke<string[]>("redis_blocked"),

  aiGet: () => invoke<AiView>("ai_get"),
  /** `apiKey` : `undefined` = inchangée, `""` = supprimée. */
  aiSet: (settings: AiSettings, apiKey?: string) => invoke<void>("ai_set", { settings, apiKey }),
  aiAsk: (conversation: string, message: string, context: string | undefined, onEvent: (e: AiEvent) => void) => {
    const channel = new Channel<AiEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("ai_ask", { conversation, message, context, onEvent: channel });
  },
  aiAnswerProposal: (callId: string, accepted: boolean) => invoke<void>("ai_answer_proposal", { callId, accepted }),
  aiReset: (conversation: string) => invoke<string>("ai_reset", { conversation }),

  syncGet: () => invoke<SyncView>("sync_get"),
  /** `passphrase` / `token` : `undefined` = inchangé, `""` = supprimé. */
  syncSet: (settings: { mode: SyncMode; path?: string | null; url?: string | null; tunnel?: SyncTunnel | null; includeSecrets: boolean; passphrase?: string; token?: string }) =>
    invoke<void>("sync_set", { settings }),
  syncNow: () => invoke<SyncOutcome>("sync_now"),
  syncServerStatus: (serverId: string) => invoke<SyncServerStatus>("sync_server_status", { serverId }),
  /** Installe ou met à jour zenytt-sync sur le serveur et règle ce PC en mode privé (tunnel SSH). */
  syncServerInstall: (serverId: string) => invoke<{ port: number; log: string }>("sync_server_install", { serverId }),
  syncPairingCode: () => invoke<string>("sync_pairing_code"),
  syncJoin: (code: string, passphrase: string) => invoke<void>("sync_join", { code, passphrase }),

  snippets: () => invoke<Snippet[]>("snippets_list"),
  saveSnippet: (snippet: Snippet) => invoke<void>("snippet_save", { snippet }),
  deleteSnippet: (id: string) => invoke<void>("snippet_delete", { id }),

  termOpen: (
    serverId: string,
    cols: number,
    rows: number,
    onEvent: (e: TermEvent) => void,
    opts: { command?: string; tmuxSession?: string } = {},
  ) => {
    const channel = new Channel<TermEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("term_open", { serverId, cols, rows, command: opts.command, tmuxSession: opts.tmuxSession, onEvent: channel });
  },
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  /** Défilement de l'historique d'une session tmux (molette dans le terminal). */
  tmuxScroll: (serverId: string, session: string, up: boolean, lines: number) =>
    invoke<void>("tmux_scroll", { serverId, session, up, lines }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),
  termShareStart: (termId: number, label: string, mode: ShareMode, onEvent: (e: ShareEvent) => void) => {
    const channel = new Channel<ShareEvent>();
    channel.onmessage = onEvent;
    return invoke<ShareInfo>("term_share_start", { termId, label, mode, onEvent: channel });
  },
  /** Envoie l'écran courant à un invité qui vient d'arriver. */
  termShareSend: (termId: number, data: string) => invoke<void>("term_share_send", { termId, data }),
  termShareStop: (termId: number) => invoke<void>("term_share_stop", { termId }),
  /** Rejoint le terminal partagé d'une invitation. */
  termJoin: (code: string, onEvent: (e: TermEvent) => void) => {
    const channel = new Channel<TermEvent>();
    channel.onmessage = onEvent;
    return invoke<{ id: number; label: string; mode: ShareMode }>("term_join", { code, onEvent: channel });
  },
  termJoinWrite: (id: number, data: string) => invoke<void>("term_join_write", { id, data }),
  termJoinClose: (id: number) => invoke<void>("term_join_close", { id }),

  termCwd: (serverId: string, tmuxSession?: string, pid?: number) => invoke<{ path: string; locked: boolean } | null>("term_cwd", { serverId, tmuxSession, pid }),

  /** Historique du shell distant, dédoublonné et classé (le plus récent d'abord). */
  termHistory: (serverId: string) => invoke<ShellHistoryEntry[]>("term_history", { serverId }),

  fsHome: (serverId: string) => invoke<string>("fs_home", { serverId }),
  fsList: (serverId: string, path: string) => invoke<Listing>("fs_list", { serverId, path }),
  fsExec: (serverId: string, cwd: string, command: string) => invoke<{ stdout: string; stderr: string; exitCode: number }>("fs_exec", { serverId, cwd, command }),
  /** Fichier entier (≤ 50 Mo), reçu en octets bruts. Erreurs `TOO_BIG:<taille>` et `NOT_UTF8` : utiliser `fsReadRange`. */
  fsRead: async (serverId: string, path: string, sudo = false) =>
    new TextDecoder().decode(await invoke<ArrayBuffer>("fs_read", { serverId, path, sudo })),
  /** Portion d'un fichier en lecture seule (au plus 16 Mo). */
  fsReadRange: (serverId: string, path: string, offset: number, len: number, sudo = false) =>
    invoke<TextWindow>("fs_read_range", { serverId, path, offset, len, sudo }),
  /** Écrit un fichier ; avec `expected`, échoue (erreur `CONFLICT…`) s'il a changé entre-temps. Renvoie son nouvel état. */
  fsWrite: (serverId: string, path: string, content: string, sudo = false, expected: FileStamp | null = null) =>
    invoke<FileStamp | null>("fs_write", { serverId, path, content, sudo, expected }),
  fsStat: (serverId: string, path: string, sudo = false) => invoke<FileStamp | null>("fs_stat", { serverId, path, sudo }),
  fsMkdir: (serverId: string, path: string) => invoke<void>("fs_mkdir", { serverId, path }),
  fsCreate: (serverId: string, path: string) => invoke<void>("fs_create", { serverId, path }),
  fsRename: (serverId: string, from: string, to: string) => invoke<void>("fs_rename", { serverId, from, to }),
  fsRemove: (serverId: string, paths: string[]) => invoke<void>("fs_remove", { serverId, paths }),
  fsChmod: (serverId: string, path: string, mode: number) => invoke<void>("fs_chmod", { serverId, path, mode }),
  /** Cherche un fichier par son nom dans l'arborescence de `root` (find distant). */
  fsFind: (serverId: string, root: string, pattern: string, depth = 10) => invoke<FsResults<FsHit>>("fs_find", { serverId, root, pattern, depth }),
  /** Cherche du texte dans les fichiers de `root`, sans les télécharger (grep distant). */
  fsGrep: (serverId: string, root: string, needle: string, glob: string | null = null, caseSensitive = false, regex = false) =>
    invoke<FsResults<FsMatch>>("fs_grep", { serverId, root, needle, glob, caseSensitive, regex }),
  fsArchiveName: (paths: string[], format: ArchiveFormat) => invoke<string>("fs_archive_name", { paths, format }),
  /** Compresse une sélection sur le serveur ; renvoie la taille de l'archive en octets. */
  fsArchive: (serverId: string, paths: string[], dest: string, format: ArchiveFormat) => invoke<number>("fs_archive", { serverId, paths, dest, format }),
  fsArchiveList: (serverId: string, path: string) => invoke<string[]>("fs_archive_list", { serverId, path }),
  fsExtract: (serverId: string, path: string, dest: string) => invoke<void>("fs_extract", { serverId, path, dest }),
  fsDownload: (serverId: string, paths: string[], localDir: string | null, transferId: number, onProgress: (p: Progress) => void) =>
    invoke<string>("fs_download", { serverId, paths, localDir, transferId, onProgress: progressChannel(onProgress) }),
  fsUpload: (serverId: string, localPaths: string[], remoteDir: string, transferId: number, onProgress: (p: Progress) => void) =>
    invoke<void>("fs_upload", { serverId, localPaths, remoteDir, transferId, onProgress: progressChannel(onProgress) }),
  fsCopyBetween: (
    srcServer: string,
    paths: string[],
    dstServer: string,
    dstDir: string,
    overwrite: boolean,
    transferId: number,
    onProgress: (p: Progress) => void,
  ) => invoke<void>("fs_copy_between", { srcServer, paths, dstServer, dstDir, overwrite, transferId, onProgress: progressChannel(onProgress) }),
  fsCancel: (transferId: number) => invoke<void>("fs_cancel", { transferId }),
  dashboardSummary: (serverId: string) => invoke<DashboardSummary>("dashboard_summary", { serverId }),

  metrics: (serverId: string) => invoke<Metrics>("mon_metrics", { serverId }),
  processes: (serverId: string) => invoke<Process[]>("mon_processes", { serverId }),
  kill: (serverId: string, pid: number, force: boolean) => invoke<void>("mon_kill", { serverId, pid, force }),
  services: (serverId: string) => invoke<Service[] | null>("mon_services", { serverId }),
  serviceAction: (serverId: string, unit: string, action: string) => invoke<void>("mon_service_action", { serverId, unit, action }),
  serviceLogs: (serverId: string, unit: string, lines = 300) => invoke<string>("mon_service_logs", { serverId, unit, lines }),

  systemInfo: (serverId: string) => invoke<SystemInfo>("system_info", { serverId }),
  systemPower: (serverId: string, action: "reboot" | "poweroff", delayMinutes: number) => invoke<void>("system_power", { serverId, action, delayMinutes }),
  systemCancelPower: (serverId: string) => invoke<void>("system_cancel_power", { serverId }),
  /** Attend le retour du serveur après un redémarrage ; renvoie la durée en secondes. */
  systemWaitOnline: (serverId: string, bootTime?: number, timeoutSecs = 600) =>
    invoke<number>("system_wait_online", { serverId, timeoutSecs, bootTime }),
  systemSetHostname: (serverId: string, name: string) => invoke<void>("system_set_hostname", { serverId, name }),
  systemTimezones: (serverId: string) => invoke<string[]>("system_timezones", { serverId }),
  systemSetTimezone: (serverId: string, timezone: string) => invoke<void>("system_set_timezone", { serverId, timezone }),
  systemUpdates: (serverId: string, refresh: boolean) => invoke<SystemUpdate[]>("system_updates", { serverId, refresh }),
  systemApplyUpdates: (serverId: string) => invoke<string>("system_apply_updates", { serverId }),
  providerGet: (serverId: string) => invoke<ProviderView>("provider_get", { serverId }),
  /** `undefined` = secret inchangé, `""` = supprimé. Sans `link`, le compte est délié. */
  providerSet: (serverId: string, link: ProviderLink | null, secrets: { token?: string; secret?: string; consumer?: string }) =>
    invoke<void>("provider_set", { serverId, link, ...secrets }),
  providerTest: (serverId: string) => invoke<ProviderStatus>("provider_test", { serverId }),
  providerAction: (serverId: string, action: ProviderAction) => invoke<ProviderStatus>("provider_action", { serverId, action }),
  githubStatus: () => invoke<GithubStatus>("github_status"),
  /** Jeton vide = supprime le compte. Il n'est jamais renvoyé. */
  githubSetToken: (token: string) => invoke<GithubStatus>("github_set_token", { token }),
  githubRepos: () => invoke<GithubRepo[]>("github_repos"),
  githubClones: (serverId: string, owner: string, repo: string) => invoke<GithubClone[]>("github_clones", { serverId, owner, repo }),
  githubCloneState: (serverId: string, owner: string, repo: string, path: string, fetch: boolean) =>
    invoke<GithubClone>("github_clone_state", { serverId, owner, repo, path, fetch }),
  githubClone: (serverId: string, owner: string, repo: string, folder: string) => invoke<string>("github_clone", { serverId, owner, repo, folder }),
  githubPull: (serverId: string, owner: string, repo: string, path: string) => invoke<string>("github_pull", { serverId, owner, repo, path }),
  agentInfo: (serverId: string) => invoke<AgentInfo>("agent_info", { serverId }),
  agentHistory: (serverId: string, rangeSecs: number, points = 400) =>
    invoke<HistoryPoint[]>("agent_history", { serverId, rangeSecs, points }),
  agentInstall: (serverId: string) => invoke<string>("agent_install", { serverId }),
  agentUninstall: (serverId: string) => invoke<void>("agent_uninstall", { serverId }),
  agentSaveConfig: (serverId: string, config: AgentConfig) => invoke<void>("agent_save_config", { serverId, config }),
  agentTestNotify: (serverId: string) => invoke<string>("agent_test_notify", { serverId }),

  dockerOverview: (serverId: string) => invoke<DockerOverview>("docker_overview", { serverId }),
  dockerStats: (serverId: string) => invoke<ContainerStats[]>("docker_stats", { serverId }),
  dockerAction: (serverId: string, id: string, action: string) => invoke<void>("docker_container_action", { serverId, id, action }),
  dockerInspect: (serverId: string, id: string) => invoke<string>("docker_inspect", { serverId, id }),
  dockerLogs: (serverId: string, id: string, tail = 500) => invoke<string>("docker_logs", { serverId, id, tail }),
  composeFileInfo: (serverId: string, file: string) => invoke<ComposeFileInfo>("docker_compose_file_info", { serverId, file }),
  /** Lance le projet d'un fichier ; `replace` : projet du même nom lancé depuis un autre dossier, supprimé d'abord. */
  composeLaunch: (serverId: string, file: string, name: string, build: boolean, replace: string | null) =>
    invoke<string>("docker_compose_launch", { serverId, file, name, build, replace }),
  /** Marque un conteneur comme ponctuel (tâche qui s'arrête normalement) ou le démarque. */
  dockerOnPurposeSet: (serverId: string, keys: string[], on: boolean) => invoke<void>("docker_on_purpose_set", { serverId, keys, on }),
  diskRules: (serverId: string) => invoke<DiskRule[]>("disk_rules_list", { serverId }),
  /** `true` : la configuration de l'agent a suivi (montages ignorés). */
  diskRuleSave: (rule: DiskRule) => invoke<boolean>("disk_rule_save", { rule }),
  dockerOccasionalSet: (serverId: string, key: string, occasional: boolean) => invoke<void>("docker_occasional_set", { serverId, key, occasional }),
  meshList: () => invoke<MeshNetwork[]>("mesh_list"),
  /** `takeover` : retire d'abord les serveurs encore configurés pour un réseau inconnu de ce PC. */
  meshCreate: (name: string, serverIds: string[], takeover = false) => invoke<MeshReport>("mesh_create", { name, serverIds, takeover }),
  meshAdd: (networkId: string, serverId: string, takeover = false) => invoke<MeshReport>("mesh_add", { networkId, serverId, takeover }),
  meshRemove: (networkId: string, serverId: string) => invoke<MeshReport>("mesh_remove", { networkId, serverId }),
  meshRepair: (networkId: string) => invoke<MeshReport>("mesh_repair", { networkId }),
  meshDelete: (networkId: string) => invoke<MeshReport>("mesh_delete", { networkId }),
  meshStatus: (networkId: string) => invoke<MeshMemberStatus[]>("mesh_status", { networkId }),
  dockerProjectsUnder: (serverId: string, dir: string) => invoke<ComposeProject[]>("docker_projects_under", { serverId, dir }),
  /** Déplace un dossier en arrêtant puis relançant les projets compose qu'il contient. */
  dockerMoveFolder: (serverId: string, from: string, to: string) => invoke<string>("docker_move_folder", { serverId, from, to }),
  composeAction: (serverId: string, project: ComposeProject, action: string) =>
    invoke<string>("docker_compose_action", { serverId, project, action }),
  composeCommand: (project: ComposeProject, sub: string) => invoke<string>("docker_compose_command", { project, sub }),
  /** Crée un projet compose (dossier, docker-compose.yml, .env), vérifié puis démarré si demandé. */
  dockerComposeCreate: (serverId: string, name: string, directory: string | null, yaml: string, env: string | null, start: boolean) =>
    invoke<{ file: string; log: string; started: boolean }>("docker_compose_create", { serverId, name, directory, yaml, env, start }),
  dockerComposeTemplate: (name: string, image: string, hostPort: number, containerPort: number) =>
    invoke<string>("docker_compose_template", { name, image, hostPort, containerPort }),
  dockerStorage: (serverId: string) => invoke<{ images: DockerImage[]; usage: DockerDiskUsage[] }>("docker_storage", { serverId }),
  dockerRemoveImage: (serverId: string, id: string) => invoke<void>("docker_remove_image", { serverId, id }),
  dockerPrune: (serverId: string, what: string) => invoke<string>("docker_prune", { serverId, what }),

  sitesState: (serverId: string, engine: WebEngine = "nginx") => invoke<NginxState>("sites_state", { serverId, engine }),
  sitesRead: (serverId: string, path: string, engine: WebEngine = "nginx") => invoke<string>("sites_read", { serverId, path, engine }),
  /** `proxyModules` : active au passage les modules proxy d'Apache (nouveau vhost). */
  sitesWrite: (serverId: string, path: string, content: string, enableLink?: string, engine: WebEngine = "nginx", proxyModules = false) =>
    invoke<ApplyResult>("sites_write", { serverId, path, content, enableLink, engine, proxyModules }),
  sitesSetEnabled: (serverId: string, available: string, link: string, enabled: boolean, engine: WebEngine = "nginx") =>
    invoke<ApplyResult>("sites_set_enabled", { serverId, available, link, enabled, engine }),
  sitesDelete: (serverId: string, available: string, link: string, engine: WebEngine = "nginx") =>
    invoke<ApplyResult>("sites_delete", { serverId, available, link, engine }),
  sitesTest: (serverId: string, engine: WebEngine = "nginx") => invoke<{ ok: boolean; output: string }>("sites_test", { serverId, engine }),
  sitesReload: (serverId: string, engine: WebEngine = "nginx") => invoke<string>("sites_reload", { serverId, engine }),
  sitesPlan: (serverId: string) => invoke<NewSitePlan>("sites_plan", { serverId }),
  sitesResolve: (serverId: string, domain: string) => invoke<string | null>("sites_resolve", { serverId, domain }),
  sitesCreateApp: (serverId: string, spec: AppSpec) => invoke<string>("sites_create_app", { serverId, spec }),
  sitesCertbot: (serverId: string, domain: string, email: string, engine: WebEngine = "nginx") =>
    invoke<string>("sites_certbot", { serverId, domain, email, engine }),
  sitesRenew: (serverId: string) => invoke<string>("sites_renew", { serverId }),
  sitesCheck: (serverId: string, domain: string) => invoke<string>("sites_check", { serverId, domain }),
  sitesPreview: (domain: string, hostPort: number, app?: AppSpec, engine: WebEngine = "nginx", confRoot?: string) =>
    invoke<{ vhost: string; compose: string | null; path: string; link: string | null }>("sites_preview", { domain, hostPort, app, engine, confRoot }),
  tunnels: () => invoke<TunnelView[]>("tunnels_list"),
  tunnelSave: (def: TunnelDef) => invoke<string>("tunnel_save", { def }),
  tunnelDelete: (id: string) => invoke<void>("tunnel_delete", { id }),
  tunnelStart: (id: string) => invoke<void>("tunnel_start", { id }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
  tunnelFreePort: (start: number) => invoke<number>("tunnel_free_port", { start }),

  logSources: (serverId: string) => invoke<{ containers: string[]; units: string[]; files: string[] }>("logs_sources", { serverId }),
  logsStart: (serverId: string, sources: LogSource[], lines: number, onEvent: (e: LogEvent) => void) => {
    const channel = new Channel<LogEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("logs_start", { serverId, sources, lines, onEvent: channel });
  },
  logsStop: (id: number) => invoke<void>("logs_stop", { id }),

  restrictPreview: (serverId: string, project: ComposeProject, hostPort: number) =>
    invoke<{ file: string; before: string; after: string }>("docker_restrict_preview", { serverId, project, hostPort }),
  restrictApply: (serverId: string, project: ComposeProject, hostPort: number) =>
    invoke<string>("docker_restrict_apply", { serverId, project, hostPort }),

  nginxBackups: (serverId: string, engine: WebEngine = "nginx") => invoke<string[]>("nginx_backups", { serverId, engine }),
  nginxBackupDiff: (serverId: string, name: string, engine: WebEngine = "nginx") => invoke<string>("nginx_backup_diff", { serverId, name, engine }),
  nginxBackupRestore: (serverId: string, name: string, engine: WebEngine = "nginx") =>
    invoke<ApplyResult>("nginx_backup_restore", { serverId, name, engine }),

  securityAudit: (serverId: string) => invoke<SecurityReport>("security_audit", { serverId }),
  securityFixPlan: (id: string) => invoke<FixPlan>("security_fix_plan", { id }),
  findingsIgnored: (serverId: string) => invoke<IgnoredFinding[]>("findings_ignored", { serverId }),
  findingIgnore: (serverId: string, findingId: string, title: string, reason: string) =>
    invoke<void>("finding_ignore", { serverId, findingId, title, reason }),
  findingUnignore: (serverId: string, findingId: string) => invoke<void>("finding_unignore", { serverId, findingId }),
  securityFixApply: (serverId: string, id: string) =>
    invoke<{ ok: boolean; output: string; rollback: string | null }>("security_fix_apply", { serverId, id }),

  backupOverview: (serverId: string) => invoke<BackupOverview>("backup_overview", { serverId }),
  backupSave: (serverId: string, config: BackupConfig, resticPassword?: string, s3Secret?: string) =>
    invoke<{ log: string; generatedPassword: string | null }>("backup_save", { serverId, config, resticPassword, s3Secret }),
  backupSnapshots: (serverId: string) => invoke<Snapshot[]>("backup_snapshots", { serverId }),
  backupList: (serverId: string, snapshot: string, path: string) => invoke<SnapshotNode[]>("backup_list", { serverId, snapshot, path }),
  backupRestore: (serverId: string, snapshot: string, path: string) => invoke<string>("backup_restore", { serverId, snapshot, path }),
  backupPutBack: (serverId: string, restored: string, original: string) => invoke<string>("backup_put_back", { serverId, restored, original }),
  backupImportDump: (serverId: string, dump: string, database: DbSource) => invoke<string>("backup_import_dump", { serverId, dump, database }),
  backupStageDownload: (serverId: string, restored: string) => invoke<string>("backup_stage_download", { serverId, restored }),
  backupCheck: (serverId: string) => invoke<string>("backup_check", { serverId }),
  backupInstallRestic: (serverId: string) => invoke<string>("backup_install_restic", { serverId }),
  backupMirror: (serverId: string, dir: string, transferId: number, onProgress: (p: MirrorProgress) => void) => {
    const channel = new Channel<MirrorProgress>();
    channel.onmessage = onProgress;
    return invoke<MirrorResult>("backup_mirror", { serverId, dir, transferId, onProgress: channel });
  },

  deploySuggestHost: (serverId: string, project: string) => invoke<string | null>("deploy_suggest_host", { serverId, project }),
  deployPrepare: (serverId: string, project: ComposeProject, checkHost: string | null) =>
    invoke<string>("deploy_prepare", { serverId, project, checkHost }),
  deployKeys: (serverId: string) => invoke<string[]>("deploy_keys", { serverId }),
  deployKeyCreate: (serverId: string, project: ComposeProject, checkHost: string | null) =>
    invoke<DeployKey>("deploy_key_create", { serverId, project, checkHost }),
  deployKeyRevoke: (serverId: string, project: string) => invoke<void>("deploy_key_revoke", { serverId, project }),
  deploySudoRisk: (serverId: string, project: ComposeProject) => invoke<SudoRisk>("deploy_sudo_risk", { serverId, project }),

  mcpConfig: () => invoke<McpConfig>("mcp_config"),
  saveTextFile: (path: string, content: string) => invoke<void>("save_text_file", { path, content }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  /** Partage d'une sélection de serveurs (texte chiffré à enregistrer). */
  settingsShare: (ids: string[], password: string, includeSecrets: boolean) => invoke<string>("settings_share", { ids, password, includeSecrets }),
  /** Même partage, en code d'une ligne à coller. */
  settingsShareCode: (ids: string[], password: string, includeSecrets: boolean) =>
    invoke<string>("settings_share_code", { ids, password, includeSecrets }),
  settingsImportText: (text: string, password: string) =>
    invoke<ImportSummary>("settings_import_text", { text, password }),
  settingsTextEncrypted: (text: string) => invoke<boolean>("settings_text_encrypted", { text }),
};

export function formatDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (secs < 60) return `${Math.max(0, Math.round(secs))} s`;
  return `${m} min`;
}

/** Il y a combien de temps, en clair (`ms` = durée écoulée en millisecondes). */
export function formatAgo(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Message d'erreur lisible à partir d'une erreur renvoyée par une commande Tauri. */
export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
